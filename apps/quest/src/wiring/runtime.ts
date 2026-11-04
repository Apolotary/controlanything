/**
 * The wiring sandbox: runs the JavaScript Muse wrote ("function wire(s, out, mem)") against live hand signals.
 *
 *  - The code only ever runs inside a dedicated Web Worker made from a blob. Before it is compiled the worker deletes
 *    or overrides every way out (fetch, XMLHttpRequest, WebSocket, importScripts, indexedDB, caches, Worker, ...) and
 *    wraps postMessage, so the program can compute and call `out`, nothing else. It has no DOM and no storage.
 *  - Each frame the main thread posts the latest Signals and waits for the worker's reply. A reply carries the outputs
 *    and the time the call took; > BUDGET_MS is a strike, a throw is a strike, three strikes stop the program. If a
 *    call does not return within WATCHDOG_MS (a hot loop), the worker is terminated.
 *  - Outputs are untrusted: only actions listed in `wire.ready.actions` pass, values are clamped to the action's range
 *    and rate-limited (`maxRateHz`, default 30 Hz, latest value wins), then sent as `control.event` with
 *    widgetId `wire:<actionId>` by the `send` callback the app gives us (the same path the arc dials use).
 *
 * Generated code never runs on the Mac or the server (the server only dry-runs it in node:vm).
 */
import type { WireAction } from '@ce/protocol';
import type { Signals } from '../gestures/signals';

export const WIRING_LIMITS = {
  /** the server also rejects longer programs (wire.ready.code max) */
  maxCodeChars: 8192,
  budgetMs: 4,
  /** the first few calls include JIT and are allowed this long */
  graceCalls: 3, graceBudgetMs: 25,
  watchdogMs: 50,
  strikesToStop: 3,
  /** a strike is forgiven after this many clean calls in a row (~2 s at 60 Hz) */
  forgiveAfter: 120,
  defaultRateHz: 30,
  /** worker start-up allowance */
  startMs: 4000,
} as const;

export type StopKind = 'user' | 'external' | 'error' | 'overrun' | 'watchdog' | 'refused' | 'unavailable';
export interface WiringProgram {
  wiringId: string; cardId: string; code: string; title: string; explanation: string; model: string;
  source: 'live' | 'fixture' | 'template'; actions: WireAction[];
}
export interface WireEmit { widgetId: string; value: number | boolean; phase: 'move' | 'end' }

// --- static check (defence in depth: the server validator enforces the same list before wire.ready) ---------------------

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bimport\b/, 'import'], [/\brequire\b/, 'require'], [/\bfetch\b/, 'fetch'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest'], [/\bWebSocket\b/, 'WebSocket'],
  [/\beval\b/, 'eval'], [/\bFunction\b/, 'Function'], [/\bglobalThis\b/, 'globalThis'], [/\bself\b/, 'self'], [/\bpostMessage\b/, 'postMessage'],
  [/\bimportScripts\b/, 'importScripts'], [/\bsetTimeout\b/, 'setTimeout'], [/\bsetInterval\b/, 'setInterval'], [/\bdocument\b/, 'document'],
  [/\bwindow\b/, 'window'], [/\bthis\b/, 'this'], [/while\s*\(\s*(?:true|1)\s*\)/, 'while(true)'], [/for\s*\(\s*;\s*;\s*\)/, 'for(;;)'],
];
/** The reason a program is refused before it ever reaches the worker, or null. */
export function checkWiringCode(code: string): string | null {
  if (typeof code !== 'string' || !code.trim()) return 'empty program';
  if (code.length > WIRING_LIMITS.maxCodeChars) return `program is ${code.length} characters (limit ${WIRING_LIMITS.maxCodeChars})`;
  // Comments and string literals may mention words; code may not.
  const bare = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  for (const [pattern, name] of FORBIDDEN) if (pattern.test(bare)) return `uses ${name}`;
  return null;
}

// --- output gate: whitelist, clamp, rate-limit ----------------------------------------------------------------

interface Slot {
  action: WireAction;
  gapMs: number;
  lastSent: number;
  lastValue: number | boolean | undefined;
  pending: number | boolean | undefined;
  epsilon: number;
}
export class OutputGate {
  private readonly slots = new Map<string, Slot>();
  dropped = 0;

  constructor(actions: readonly WireAction[]) {
    for (const action of actions) {
      const range = action.min !== undefined && action.max !== undefined ? Math.abs(action.max - action.min) : 0;
      this.slots.set(action.actionId, {
        action, gapMs: 1000 / Math.min(WIRING_LIMITS.defaultRateHz * 4, action.maxRateHz ?? WIRING_LIMITS.defaultRateHz),
        lastSent: -Infinity, lastValue: undefined, pending: undefined, epsilon: range > 0 ? range / 1000 : 1e-4,
      });
    }
  }

  has(id: string): boolean { return this.slots.has(id); }

  /** A continuous value from `out.set`. Latest wins until the next flush that the rate limit allows. */
  set(id: string, raw: unknown): void {
    const slot = this.slots.get(id);
    if (!slot) { this.dropped++; return; }
    if (slot.action.kind === 'toggle') { slot.pending = Boolean(Number(raw)); return; }
    const n = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (slot.action.kind === 'trigger' || !Number.isFinite(n)) { this.dropped++; return; }
    const { min, max } = slot.action;
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    slot.pending = Math.round(v * 10000) / 10000;
  }

  /** A one-shot from `out.trigger`; fires at most `maxRateHz` times a second. */
  trigger(id: string, nowMs: number): WireEmit | null {
    const slot = this.slots.get(id);
    if (!slot || slot.action.kind === 'set') { this.dropped++; return null; }
    if (nowMs - slot.lastSent < slot.gapMs) { this.dropped++; return null; }
    slot.lastSent = nowMs;
    return { widgetId: `wire:${id}`, value: true, phase: 'end' };
  }

  /** What may go out now. `force` ignores the rate limit (the final lift-off values on stop). */
  flush(nowMs: number, force = false): WireEmit[] {
    const out: WireEmit[] = [];
    for (const [id, slot] of this.slots) {
      const v = slot.pending;
      if (v === undefined) continue;
      if (!force && nowMs - slot.lastSent < slot.gapMs) continue;
      slot.pending = undefined;
      const changed = typeof v === 'boolean' || typeof slot.lastValue !== 'number' ? v !== slot.lastValue : Math.abs(v - slot.lastValue) > slot.epsilon;
      if (!changed) continue;
      slot.lastSent = nowMs; slot.lastValue = v;
      out.push({ widgetId: `wire:${id}`, value: v, phase: typeof v === 'boolean' ? 'end' : force ? 'end' : 'move' });
    }
    return out;
  }
}

// --- the worker --------------------------------------------------------------------------------------------------

/** Source of the worker script (kept as text: it becomes a blob). Exported so a test can run it in a stub scope. */
export const WORKER_SOURCE = String.raw`(function () {
  var post = self.postMessage.bind(self);
  var now = performance.now.bind(performance);
  var BLOCK = ['fetch', 'importScripts', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'indexedDB', 'IDBFactory', 'caches', 'CacheStorage', 'Cache', 'Worker', 'SharedWorker', 'BroadcastChannel', 'openDatabase', 'FileReaderSync', 'Notification'];
  function lock(o, n, v) { try { Object.defineProperty(o, n, { value: v, writable: false, configurable: false }); } catch (e) { try { o[n] = v; } catch (e2) {} } }
  for (var i = 0; i < BLOCK.length; i++) lock(self, BLOCK[i], undefined);
  for (var o = Object.getPrototypeOf(self); o; o = Object.getPrototypeOf(o)) for (var j = 0; j < BLOCK.length; j++) if (Object.prototype.hasOwnProperty.call(o, BLOCK[j])) lock(o, BLOCK[j], undefined);
  try { if (self.navigator) { var np = Object.getPrototypeOf(self.navigator); if (np && Object.prototype.hasOwnProperty.call(np, 'sendBeacon')) lock(np, 'sendBeacon', undefined); } } catch (e) {}
  lock(self, 'postMessage', function postMessage() {});
  var wire = null, mem = {}, allowed = Object.create(null), sets = {}, trigs = [], count = 0;
  var out = Object.freeze({
    set: function (id, v) {
      if (typeof id !== 'string' || !allowed[id]) return;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (typeof v !== 'number' || v !== v || v === Infinity || v === -Infinity) return;
      sets[id] = v;
    },
    trigger: function (id) { if (typeof id === 'string' && allowed[id] && trigs.length < 16) trigs.push(id); },
  });
  function run(s, seq) {
    sets = {}; trigs = [];
    var err = null, t0 = now();
    try { wire(s, out, mem); } catch (e) { err = String(e && e.message ? e.message : e).slice(0, 140); }
    post({ type: 'out', seq: seq, ms: now() - t0, err: err, sets: sets, trigs: trigs });
  }
  self.onmessage = function (e) {
    var m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'init') {
      try {
        for (var k = 0; k < m.actions.length; k++) allowed[m.actions[k]] = true;
        wire = new Function('s', 'out', 'mem', m.code);
        post({ type: 'ready' });
      } catch (err) { post({ type: 'error', reason: 'did not compile: ' + String(err && err.message ? err.message : err).slice(0, 140) }); }
    } else if ((m.type === 'tick' || m.type === 'final') && wire) { count++; run(m.s, m.seq); }
  };
})();`;

export interface RuntimeDeps {
  /** Send one output as control.event; false = not sent (disconnected). */
  send(event: WireEmit): boolean;
  /** The program stopped (or was stopped). Fired once. */
  onStop(reason: string, kind: StopKind): void;
  /** Tests inject a stand-in Worker. */
  createWorker?(source: string): Worker;
  now?(): number;
}
export interface RuntimeStats { ticks: number; sent: number; avgMs: number; maxMs: number; strikes: number; dropped: number }

type State = 'idle' | 'starting' | 'running' | 'stopping';

export class WiringRuntime {
  private state: State = 'idle';
  private worker?: Worker;
  private gate?: OutputGate;
  private watchdog?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private lastTimer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private sentAt = 0;
  private seq = 0;
  private strikes = 0;
  private clean = 0;
  private reason = '';
  private lastSignals: Signals | null = null;
  readonly stats: RuntimeStats = { ticks: 0, sent: 0, avgMs: 0, maxMs: 0, strikes: 0, dropped: 0 };
  program?: WiringProgram;

  constructor(private readonly d: RuntimeDeps) {}

  get running(): boolean { return this.state === 'running' || this.state === 'starting'; }
  get ready(): boolean { return this.state === 'running'; }
  private clock(): number { return this.d.now ? this.d.now() : performance.now(); }

  /** Start a program. Returns the reason when it cannot start (the program is refused or no Worker exists). */
  start(program: WiringProgram): string | null {
    if (this.state === 'stopping') this.finish();
    this.stop('replaced', 'external', false);
    const refusal = checkWiringCode(program.code);
    if (refusal) { this.d.onStop(`refused: ${refusal}`, 'refused'); return `refused: ${refusal}`; }
    try {
      this.worker = this.d.createWorker ? this.d.createWorker(WORKER_SOURCE) : this.makeWorker();
    } catch (e) {
      const reason = `this browser cannot run the sandbox (${(e as Error).message})`;
      this.d.onStop(reason, 'unavailable');
      return reason;
    }
    this.program = program;
    this.gate = new OutputGate(program.actions);
    this.state = 'starting'; this.inFlight = false; this.strikes = this.clean = 0; this.reason = ''; this.lastSignals = null;
    Object.assign(this.stats, { ticks: 0, sent: 0, avgMs: 0, maxMs: 0, strikes: 0, dropped: 0 });
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data as Record<string, unknown>);
    this.worker.onerror = (e: ErrorEvent) => { e.preventDefault?.(); this.fail(`worker error: ${e.message || 'unknown'}`, 'error'); };
    this.worker.postMessage({ type: 'init', code: program.code, actions: program.actions.map((a) => a.actionId) });
    this.startTimer = setTimeout(() => { if (this.state === 'starting') this.fail('the sandbox did not start', 'unavailable'); }, WIRING_LIMITS.startMs);
    return null;
  }

  private makeWorker(): Worker {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    try { return new Worker(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
  }

  /** Once per frame: the latest signals in, due outputs out. Never throws. */
  tick(signals: Signals): void {
    if (this.state !== 'running' || !this.worker) return;
    this.lastSignals = signals;
    this.sendFlush(false);
    if (this.inFlight) return;
    this.inFlight = true; this.sentAt = this.clock();
    try { this.worker.postMessage({ type: 'tick', seq: ++this.seq, s: signals }); } catch (e) { this.fail(`could not reach the sandbox (${(e as Error).message})`, 'error'); }
  }

  /**
   * Stop the program. `lift` runs it one last time with no hands and no screen, so a program that releases things when
   * the hand is gone (pressure 0) does so before the worker is terminated.
   */
  stop(reason: string, kind: StopKind = 'user', lift = true): void {
    if (this.state === 'idle' || this.state === 'stopping') return;
    const wasRunning = this.state === 'running';
    this.reason = reason;
    clearTimeout(this.startTimer);
    clearInterval(this.watchdog); this.watchdog = undefined;
    this.d.onStop(reason, kind);
    if (lift && wasRunning && this.worker && !this.inFlight && kind !== 'watchdog' && kind !== 'overrun') {
      this.state = 'stopping';
      const t = this.lastSignals?.t ?? 0;
      try { this.worker.postMessage({ type: 'final', seq: ++this.seq, s: { t, dt: 1 / 60, right: null, left: null, screen: null } satisfies Signals }); } catch { this.finish(); return; }
      this.lastTimer = setTimeout(() => this.finish(), 60);
    } else this.finish();
  }

  private finish(): void {
    clearTimeout(this.lastTimer);
    this.state = 'idle';
    clearInterval(this.watchdog); this.watchdog = undefined; clearTimeout(this.startTimer);
    const worker = this.worker;
    this.worker = undefined; this.gate = undefined; this.inFlight = false;
    if (worker) { worker.onmessage = null; worker.onerror = null; try { worker.terminate(); } catch { /* already gone */ } }
  }

  private fail(reason: string, kind: StopKind): void {
    if (this.state === 'idle') return;
    this.stop(reason, kind, false);
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'ready':
        if (this.state !== 'starting') return;
        clearTimeout(this.startTimer);
        this.state = 'running';
        this.watchdog = setInterval(() => this.checkWatchdog(), 20);
        return;
      case 'error':
        this.fail(String(m.reason ?? 'the program failed'), 'error');
        return;
      case 'out': {
        const stopping = this.state === 'stopping';
        if (this.state !== 'running' && !stopping) return;
        this.inFlight = false;
        const ms = Number(m.ms) || 0;
        const gate = this.gate;
        if (!gate) return;
        const now = this.clock();
        const sets = (m.sets ?? {}) as Record<string, unknown>;
        for (const id of Object.keys(sets)) gate.set(id, sets[id]);
        const trigs = Array.isArray(m.trigs) ? m.trigs as unknown[] : [];
        for (const id of trigs) if (typeof id === 'string') { const e = gate.trigger(id, now); if (e) this.emit(e); }
        this.sendFlush(stopping);
        if (stopping) { this.finish(); return; }
        const s = this.stats;
        s.ticks++; s.avgMs += (ms - s.avgMs) * 0.05; s.maxMs = Math.max(s.maxMs, ms); s.dropped = gate.dropped;
        const budget = s.ticks <= WIRING_LIMITS.graceCalls ? WIRING_LIMITS.graceBudgetMs : WIRING_LIMITS.budgetMs;
        if (typeof m.err === 'string' && m.err) { if (this.strike(`it threw: ${m.err}`, 'error')) return; }
        else if (ms > budget) { if (this.strike(`it took ${ms.toFixed(1)} ms (limit ${WIRING_LIMITS.budgetMs} ms)`, 'overrun')) return; }
        else if (++this.clean >= WIRING_LIMITS.forgiveAfter) { this.clean = 0; if (this.strikes > 0) this.stats.strikes = --this.strikes; }
        return;
      }
    }
  }

  /** true when this strike stopped the program */
  private strike(why: string, kind: StopKind): boolean {
    this.clean = 0;
    this.stats.strikes = ++this.strikes;
    if (this.strikes < WIRING_LIMITS.strikesToStop) return false;
    this.fail(why, kind);
    return true;
  }

  private checkWatchdog(): void {
    if (this.state !== 'running' || !this.inFlight) return;
    if (this.clock() - this.sentAt <= WIRING_LIMITS.watchdogMs) return;
    // Let any reply already queued on the main thread be handled first.
    const seq = this.seq;
    setTimeout(() => { if (this.state === 'running' && this.inFlight && this.seq === seq) this.fail(`it did not return within ${WIRING_LIMITS.watchdogMs} ms`, 'watchdog'); }, 0);
  }

  private sendFlush(force: boolean): void {
    if (!this.gate) return;
    for (const e of this.gate.flush(this.clock(), force)) this.emit(e);
  }

  private emit(e: WireEmit): void {
    if (this.d.send(e)) this.stats.sent++;
  }

  /** For tests and the debug HUD. */
  get lastReason(): string { return this.reason; }
}
