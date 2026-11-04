/**
 * Runs the connectors Muse writes. A connector is a small Node program in the Muse workspace. The server starts it
 * with `node <entry>` and talks to it over stdin/stdout, one JSON object per line:
 *
 *   server -> connector   {"type":"set","id":"cutoff","value":0.4}   {"type":"trigger","id":"next"}   {"type":"stop"}
 *   connector -> server   {"type":"midi","port":"OP-1 Field","op":{"msg":"cc","channel":1,"number":74,"value":51}}
 *                         {"type":"log","text":"..."}   {"type":"ready","text":"..."}
 *
 * MIDI goes out through the paired Mac companion (Chrome Web MIDI), which also hosts the visual and musical synths.
 * Anything else (HTTP to a lamp, a serial port, `say`) the connector does itself: it is ordinary Node on the Mac.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BleOp, MidiOp, type ExecOp } from '@ce/protocol';

export interface ConnectorAction {
  id: string;
  label: string;
  kind: 'set' | 'trigger' | 'toggle';
  min?: number;
  max?: number;
}

/** One device command from a connector: MIDI through the Mac companion, or a DJI gimbal move through the Osmo bridge. */
export type ConnectorOut = ({ cardId: string; target: 'midi'; port: string; op: MidiOp } | { cardId: string; target: 'gimbal'; op: BleOp }) & { generation: number; release?: true };
const GIMBAL_OPS = new Set(['pan', 'tilt', 'nudge', 'recenter', 'stop']);
export type OpResult = (ok: boolean, detail?: string) => void;

interface Running {
  cardId: string;
  entry: string;
  child: ChildProcess;
  actions: Map<string, ConnectorAction>;
  logs: string[];
  startedAt: number;
  exited?: { code: number | null; signal: string | null };
  ready?: string;
  ops: number;
  failures: number;
  /** Log every acknowledgement until this time (tests); otherwise successes are sampled. */
  verboseUntil: number;
  processGroup?: number;
  terminating?: boolean;
  generation: number;
  midi: Map<string, { port: string; channel: number; notes: boolean; sustain: boolean; controls: Set<number> }>;
  gimbal: boolean;
  releaseUntil?: number;
  releaseResult?: Promise<{ released: boolean; reason?: string }>;
}

/** Only these exact neutral commands may outlive a retired connector's normal authority. */
export function isNeutralConnectorRelease({ op, port }: { op: ExecOp; port?: string }): boolean {
  if (op.kind === 'ble') return op.op === 'stop';
  if (op.kind !== 'midi') return false;
  if (op.msg === 'panic') return true;
  return op.msg === 'cc' && op.value === 0 && (op.number === 64 || op.channel === 1
    && (['ce-musical-synth', 'ControlAnything Synth'].includes(port ?? '') && op.number === 17
      || ['ce-visual-synth', 'ControlAnything Visual Synth'].includes(port ?? '') && op.number === 24));
}

const MAX_LOG_LINES = 200;
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];

export function connectorEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (source[key]) env[key] = source[key];
  return { ...env, CE_CONNECTOR: '1', NODE_NO_WARNINGS: '1' };
}

export class ConnectorHost {
  private readonly running = new Map<string, Running>();
  private readonly releasing = new Map<string, Running>();
  private generation = 0;

  constructor(private readonly o: {
    /** Send one MIDI op through the companion; `done` gets the executor's ack. */
    send: (out: ConnectorOut, done: OpResult) => void;
    log?: (line: string) => void;
    /** The card's live connector exited by itself (crash/exit), not through Stop or a redeploy. */
    onExit?: (cardId: string, lastOutput: string) => void;
    /** The connector acted on this Mac (mac.key/open/activate) and reported the result; failures reach the wearer. */
    onMac?: (cardId: string, report: { what: string; ok: boolean; error?: string }) => void;
  }) {}

  /** Cards with a connector process (running or just exited). */
  cards(): string[] {
    return [...this.running.keys()];
  }

  has(cardId: string): boolean {
    const r = this.running.get(cardId);
    return !!r && !r.exited;
  }

  /** Rechecked at the dispatcher boundary so a queued old command cannot inherit a replacement's authority. */
  allows(cardId: string, generation: number, release = false): boolean {
    const current = this.running.get(cardId);
    if (!release) return current?.generation === generation && !current.exited;
    const retiring = this.releasing.get(cardId);
    return !current && retiring?.generation === generation && Date.now() <= (retiring.releaseUntil ?? 0);
  }

  async waitForRelease(cardId: string): Promise<{ released: boolean; reason?: string }> {
    return this.releasing.get(cardId)?.releaseResult ?? { released: true };
  }

  actions(cardId: string): ConnectorAction[] {
    return [...(this.running.get(cardId)?.actions.values() ?? [])];
  }

  info(cardId: string): { entry: string; pid?: number; alive: boolean; ops: number; failures: number; startedAt: number } | undefined {
    const r = this.running.get(cardId);
    return r && { entry: r.entry, pid: r.child.pid, alive: !r.exited, ops: r.ops, failures: r.failures, startedAt: r.startedAt };
  }

  /** The latest log lines (newest last). */
  logs(cardId: string, since = 0): string[] {
    return (this.running.get(cardId)?.logs ?? []).slice(since);
  }

  logCount(cardId: string): number {
    return this.running.get(cardId)?.logs.length ?? 0;
  }

  /**
   * Start (or restart) the card's connector. Resolves after `settleMs` with its first output, or as soon as it
   * exits (a crash on start is the most common bug, so the agent sees the stack trace right away).
   */
  async deploy(cardId: string, entry: string, cwd: string, actions: ConnectorAction[], settleMs = 1200): Promise<{ ok: boolean; pid?: number; output: string[]; reason?: string }> {
    this.stop(cardId, 'redeployed');
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, [entry], { cwd, env: connectorEnv(), detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    const run: Running = { cardId, entry, child, actions: new Map(actions.map((a) => [a.id, a])), logs: [], startedAt: Date.now(), ops: 0, failures: 0, verboseUntil: Date.now() + 5000,
      generation: ++this.generation, midi: new Map(), gimbal: false,
      ...(grouped && child.pid ? { processGroup: child.pid } : {}) };
    this.running.set(cardId, run);
    const push = (line: string) => {
      run.logs.push(line.slice(0, 400));
      if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
    };
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(run, line, push));
    createInterface({ input: child.stderr! }).on('line', (line) => push(`stderr: ${line}`));
    child.stdin!.on('error', () => {});
    const exited = new Promise<void>((resolve) => child.once('exit', (code, signal) => {
      run.exited = { code, signal };
      // Died on its own while it was the card's live connector (not Stop/redeploy): tell the wiring.
      const unexpected = this.running.get(cardId) === run && !run.terminating;
      // A connector's own exit must not spare forked helpers from Stop.
      this.terminate(run);
      push(`exited (${signal ?? `code ${code}`})`);
      this.o.log?.(`[connector] ${cardId} ${entry} exited (${signal ?? `code ${code}`})`);
      if (unexpected) this.o.onExit?.(cardId, run.logs.slice(-3).join(' | ').slice(0, 160) || `exit ${signal ?? code}`);
      resolve();
    }));
    child.once('error', (e) => push(`spawn error: ${e.message}`));
    await Promise.race([exited, new Promise((r) => setTimeout(r, settleMs))]);
    if (run.exited) return { ok: false, output: [...run.logs], reason: `the connector exited on start (${run.exited.signal ?? `code ${run.exited.code}`})` };
    this.o.log?.(`[connector] ${cardId} running ${entry} pid ${child.pid} · ${actions.map((a) => a.id).join(',')}`);
    return { ok: true, pid: child.pid, output: [...run.logs] };
  }

  private onLine(run: Running, line: string, push: (l: string) => void): void {
    const active = this.running.get(run.cardId) === run && !run.exited;
    const release = !active && this.allows(run.cardId, run.generation, true);
    if (!active && !release) return;
    let m: any;
    try { m = JSON.parse(line); } catch { push(line); return; }
    if (!m || typeof m !== 'object') { push(line); return; }
    if (m.type === 'log') { push(String(m.text ?? '')); return; }
    if (m.type === 'ready') { run.ready = String(m.text ?? 'ready'); push(`ready ${run.ready}`); return; }
    // The connector acted on the Mac itself (a key press, an opened page): its own report is the receipt.
    if (m.type === 'mac') {
      run.ops++; push(`${m.ok === false ? '✗' : '→'} mac ${String(m.what ?? '').slice(0, 120)}${m.ok === false && m.error ? `: ${String(m.error).slice(0, 200)}` : ''}`);
      if (active) this.o.onMac?.(run.cardId, { what: String(m.what ?? '').slice(0, 120), ok: m.ok !== false, ...(m.ok === false && m.error ? { error: String(m.error).slice(0, 200) } : {}) });
      return;
    }
    if (m.type === 'midi') {
      const parsed = MidiOp.safeParse({ ...m.op, kind: m.op?.kind ?? 'midi' });
      if (typeof m.port !== 'string' || !m.port.trim() || m.port.length > 200 || !parsed.success
        || parsed.data.value === '$value'
        || (['cc', 'note', 'pc'].includes(parsed.data.msg) && parsed.data.number === undefined)
        || (parsed.data.msg === 'cc' && typeof parsed.data.value !== 'number')) {
        run.failures++; push('✗ invalid MIDI output from connector (check port, kind and numeric MIDI ranges)'); return;
      }
      const op = parsed.data;
      const key = `${m.port}\0${op.channel}`;
      let endpoint = run.midi.get(key);
      if (release && (!endpoint || !isNeutralConnectorRelease({ op, port: m.port }))) return;
      if (!endpoint) {
        if (run.midi.size >= 64) { run.failures++; push('✗ too many MIDI endpoints in one connector'); return; }
        endpoint = { port: m.port, channel: op.channel, notes: false, sustain: false, controls: new Set() }; run.midi.set(key, endpoint);
      }
      if (op.msg === 'note') endpoint.notes = true;
      if (op.msg === 'panic') { endpoint.notes = false; endpoint.sustain = false; }
      if (op.msg === 'cc' && op.number === 64) endpoint.sustain = op.value !== 0;
      if (op.msg === 'cc' && isNeutralConnectorRelease({ op: { ...op, value: 0 }, port: m.port }) && op.number !== 64) {
        if (op.value === 0) endpoint.controls.delete(op.number!); else endpoint.controls.add(op.number!);
      }
      run.ops++;
      const what = describeMidi(op);
      this.o.send({ cardId: run.cardId, generation: run.generation, ...(release ? { release: true as const } : {}), target: 'midi', port: m.port, op }, (ok, detail) => {
        if (!ok) run.failures++;
        // Keep the log readable at 30 Hz: every failure, and successes only now and then.
        if (!ok || op.msg === 'note' || Date.now() < run.verboseUntil || run.ops % 15 === 1) push(`${ok ? '→' : '✗'} ${what} on ${m.port}${ok ? '' : `: ${detail ?? 'refused'}`}`);
      });
      return;
    }
    if (m.type === 'gimbal') {
      const parsed = BleOp.safeParse({ kind: 'ble', profile: 'dji-osmo', op: m.op, ...(m.arg !== undefined ? { arg: m.arg } : {}) });
      if (!GIMBAL_OPS.has(m.op) || !parsed.success || parsed.data.arg === '$value'
        || (['pan', 'tilt'].includes(m.op) && typeof parsed.data.arg !== 'number')
        || (m.op === 'nudge' && (!parsed.data.arg || typeof parsed.data.arg !== 'object'))) {
        run.failures++; push('✗ invalid gimbal output from connector (check operation and bounded numeric angles)'); return;
      }
      const op = parsed.data;
      if (release && (!run.gimbal || !isNeutralConnectorRelease({ op }))) return;
      if (op.op !== 'stop') run.gimbal = true;
      run.ops++;
      const what = `gimbal ${op.op}${typeof op.arg === 'number' ? ` ${Math.round(op.arg)}°` : op.arg && typeof op.arg === 'object' ? ` ${JSON.stringify(op.arg)}` : ''}`;
      this.o.send({ cardId: run.cardId, generation: run.generation, ...(release ? { release: true as const } : {}), target: 'gimbal', op }, (ok, detail) => {
        if (!ok) run.failures++;
        if (!ok || Date.now() < run.verboseUntil || run.ops % 10 === 1) push(`${ok ? '→' : '✗'} ${what}${ok ? detail ? ` (${detail.slice(0, 80)})` : '' : `: ${detail ?? 'refused'}`}`);
      });
      return;
    }
    push(line);
  }

  /** Log every device acknowledgement for the next `ms` (the agent's test_action reads them). */
  verbose(cardId: string, ms = 1500): void {
    const r = this.running.get(cardId);
    if (r) r.verboseUntil = Date.now() + ms;
  }

  set(cardId: string, id: string, value: number | boolean): { ok: boolean; reason?: string } {
    const r = this.running.get(cardId);
    if (!r || r.exited) return { ok: false, reason: 'the connector is not running' };
    if (!r.actions.has(id)) return { ok: false, reason: `"${id}" is not an action of this connector` };
    const a = r.actions.get(id)!;
    const msg = a.kind === 'trigger' ? { type: 'trigger', id } : { type: 'set', id, value };
    r.child.stdin!.write(`${JSON.stringify(msg)}\n`);
    return { ok: true };
  }

  stop(cardId: string, reason = 'stopped'): boolean {
    const r = this.running.get(cardId);
    if (!r) return false;
    this.running.delete(cardId);
    r.releaseUntil = Date.now() + 1700;
    this.releasing.set(cardId, r);
    const cleanup: ConnectorOut[] = [];
    for (const endpoint of r.midi.values()) {
      const make = (op: MidiOp): ConnectorOut => ({ cardId, generation: r.generation, release: true, target: 'midi', port: endpoint.port, op });
      if (endpoint.notes) cleanup.push(make({ kind: 'midi', msg: 'panic', channel: endpoint.channel }));
      if (endpoint.sustain) cleanup.push(make({ kind: 'midi', msg: 'cc', channel: endpoint.channel, number: 64, value: 0 }));
      for (const number of endpoint.controls) cleanup.push(make({ kind: 'midi', msg: 'cc', channel: endpoint.channel, number, value: 0 }));
    }
    if (r.gimbal) cleanup.push({ cardId, generation: r.generation, release: true, target: 'gimbal', op: { kind: 'ble', profile: 'dji-osmo', op: 'stop' } });
    r.releaseResult = Promise.all(cleanup.map(output => new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 1500); timer.unref?.();
      try { this.o.send(output, ok => { clearTimeout(timer); resolve(ok); }); } catch { clearTimeout(timer); resolve(false); }
    }))).then(results => results.every(Boolean) ? { released: true } : { released: false, reason: 'Connector stopped. A device did not confirm its note/touch release; use Stop all if needed.' });
    setTimeout(() => { if (this.releasing.get(cardId) === r) this.releasing.delete(cardId); }, 1800).unref?.();
    if (!r.exited) {
      try { r.child.stdin!.write(`${JSON.stringify({ type: 'stop', reason })}\n`); } catch { /* already closed */ }
    }
    this.terminate(r);
    this.o.log?.(`[connector] ${cardId} stopped (${reason})`);
    return true;
  }

  private terminate(run: Running): void {
    if (run.terminating) return;
    run.terminating = true;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (run.processGroup) process.kill(-run.processGroup, name);
        else if (!run.exited) run.child.kill(name);
      } catch { /* The owned process group already ended. */ }
    };
    setTimeout(() => signal('SIGTERM'), 250).unref?.();
    setTimeout(() => signal('SIGKILL'), 600).unref?.();
  }

  stopAll(reason = 'stopped', immediate = false): void {
    const runs = [...this.running.values()];
    for (const cardId of [...this.running.keys()]) this.stop(cardId, reason);
    // Server shutdown: the delayed kill timers are unref'd and would never fire before exit.
    if (immediate) for (const r of runs) { try { if (r.processGroup) process.kill(-r.processGroup, 'SIGKILL'); else r.child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

export function describeMidi(op: MidiOp): string {
  switch (op.msg) {
    case 'cc': return `CC${op.number} ${op.value} ch${op.channel}`;
    case 'note': return `note ${op.number} vel ${op.velocity ?? 100} ch${op.channel}`;
    case 'pc': return `program ${op.number} ch${op.channel}`;
    case 'panic': return `all notes off ch${op.channel}`;
    default: return op.msg;
  }
}

/** The runtime file every connector imports (written into the workspace by the server). */
export const CONNECTOR_SDK = `// ControlAnything connector runtime: the bridge between AR controls and your code.
// The server runs your connector with \`node <entry>\` and talks to it over stdin/stdout (one JSON per line).
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
const listeners = { set: [], trigger: [], stop: [] };
const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
export const log = (...a) => emit({ type: 'log', text: a.map(String).join(' ').slice(0, 500) });
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  for (const fn of listeners[m.type] ?? []) {
    try {
      const r = m.type === 'set' ? fn(m.id, m.value) : m.type === 'trigger' ? fn(m.id) : fn();
      if (r && typeof r.then === 'function') r.catch((e) => log('handler error: ' + (e && e.stack || e)));
    } catch (e) { log('handler error: ' + (e && e.stack || e)); }
  }
  if (m.type === 'stop') setTimeout(() => process.exit(0), 50);
});
/** A control moved: id is your action id, value is in the min..max range you declared for it. */
// Each registrar takes a handler function, or a map like { next: () => ..., prev: () => ... } keyed by action id.
const handler = (fn) => typeof fn === 'function' ? fn : fn && typeof fn === 'object' ? (id, v) => (typeof fn[id] === 'function' ? fn[id](v) : undefined) : () => {};
export const onSet = (fn) => { listeners.set.push(handler(fn)); };
/** A button was pressed. */
export const onTrigger = (fn) => { listeners.trigger.push(handler(fn)); };
/** Stop / disconnect: release held notes here. */
export const onStop = (fn) => { listeners.stop.push(typeof fn === 'function' ? fn : () => {}); };
const b7 = (v) => Math.max(0, Math.min(127, Math.round(Number(v) || 0)));
/** MIDI out through the paired Mac companion (Chrome Web MIDI: USB synths, the visual synth, the musical synth). */
export const midi = {
  cc: (port, channel, number, value) => emit({ type: 'midi', port, op: { msg: 'cc', channel, number: b7(number), value: b7(value) } }),
  note: (port, channel, note, velocity = 100, durationMs = 250) => emit({ type: 'midi', port, op: { msg: 'note', channel, number: b7(note), velocity: Math.max(1, b7(velocity)), durationMs: Math.max(0, Math.min(10000, Math.round(durationMs))) } }),
  program: (port, channel, program) => emit({ type: 'midi', port, op: { msg: 'pc', channel, number: b7(program) } }),
  allNotesOff: (port, channel = 1) => emit({ type: 'midi', port, op: { msg: 'panic', channel } }),
};
const deg = (v) => Math.max(-180, Math.min(180, Number(v) || 0));
/**
 * A DJI Osmo Mobile gimbal over Bluetooth (via the server's Osmo bridge). Angles are degrees from centre.
 * The bridge clamps to pan ±120°, tilt ±45° and limits speed to 90°/s, at most 10 moves a second (latest wins).
 */
export const gimbal = {
  pan: (yaw) => emit({ type: 'gimbal', op: 'pan', arg: deg(yaw) }),
  tilt: (pitch) => emit({ type: 'gimbal', op: 'tilt', arg: deg(pitch) }),
  nudge: (yaw = 0, pitch = 0, durationMs) => emit({ type: 'gimbal', op: 'nudge', arg: { yaw: deg(yaw), pitch: deg(pitch), ...(durationMs ? { durationMs: Math.round(durationMs) } : {}) } }),
  recenter: () => emit({ type: 'gimbal', op: 'recenter' }),
  stop: () => emit({ type: 'gimbal', op: 'stop' }),
};
/**
 * This Mac itself: press keys in the front app (scroll Instagram Reels, next slide, play/pause) and open pages/apps.
 * Key presses need macOS Accessibility permission for the app that runs the ControlAnything server; without it they
 * fail with a clear error (shown to Muse and the wearer). Opening a URL needs no permission.
 */
const KEY_CODES = { down: 125, up: 126, left: 123, right: 124, space: 49, return: 36, enter: 36, escape: 53, tab: 48, pagedown: 121, pageup: 116, home: 115, end: 119 };
const osa = (script) => new Promise((done) => execFile('osascript', ['-e', script], { timeout: 4000 }, (e, _out, err) => done(e ? String(err || e.message).trim() : '')));
export const mac = {
  /** Press one key ('down', 'up', 'left', 'right', 'space', 'return', 'escape', 'pagedown', … or a single character). */
  key: async (name) => {
    const k = String(name).toLowerCase(), code = KEY_CODES[k];
    const err = code !== undefined ? await osa('tell application "System Events" to key code ' + code)
      : k.length === 1 ? await osa('tell application "System Events" to keystroke ' + JSON.stringify(k)) : 'unknown key ' + name;
    emit({ type: 'mac', what: 'key ' + k, ok: !err, ...(err ? { error: /not allowed|1002|assistive/i.test(err) ? 'macOS blocked key presses: allow Accessibility for the app running ControlAnything (System Settings > Privacy & Security > Accessibility)' : err } : {}) });
    return !err;
  },
  /** Open a URL (or file) on the Mac, optionally in a given app, e.g. mac.open('https://www.instagram.com/reels/', 'Google Chrome'). */
  open: (target, app) => new Promise((done) => execFile('open', app ? ['-a', String(app), String(target)] : [String(target)], { timeout: 8000 }, (e) => {
    emit({ type: 'mac', what: 'open ' + String(target).slice(0, 80), ok: !e, ...(e ? { error: e.message } : {}) }); done(!e);
  })),
  /** Bring an app to the front (so key presses go to it). */
  activate: async (app) => { const err = await osa('tell application ' + JSON.stringify(String(app)) + ' to activate'); emit({ type: 'mac', what: 'activate ' + app, ok: !err, ...(err ? { error: err } : {}) }); return !err; },
};
/** Tell the server you are up (optional). */
export const ready = (text = '') => emit({ type: 'ready', text: String(text).slice(0, 200) });
// Keep the connector alive through one bad callback: the wearer's controls stay usable and the log says why.
process.on('uncaughtException', (e) => { log('error: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { log('async error: ' + (e && e.stack || e)); });
`;
