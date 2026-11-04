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
import type { BleOp, MidiOp } from '@ce/protocol';

export interface ConnectorAction {
  id: string;
  label: string;
  kind: 'set' | 'trigger' | 'toggle';
  min?: number;
  max?: number;
}

/** One device command from a connector: MIDI through the Mac companion, or a DJI gimbal move through the Osmo bridge. */
export type ConnectorOut = { cardId: string; target: 'midi'; port: string; op: MidiOp } | { cardId: string; target: 'gimbal'; op: BleOp };
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

  constructor(private readonly o: {
    /** Send one MIDI op through the companion; `done` gets the executor's ack. */
    send: (out: ConnectorOut, done: OpResult) => void;
    log?: (line: string) => void;
  }) {}

  /** Cards with a connector process (running or just exited). */
  cards(): string[] {
    return [...this.running.keys()];
  }

  has(cardId: string): boolean {
    const r = this.running.get(cardId);
    return !!r && !r.exited;
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
    const child = spawn(process.execPath, [entry], { cwd, env: connectorEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const run: Running = { cardId, entry, child, actions: new Map(actions.map((a) => [a.id, a])), logs: [], startedAt: Date.now(), ops: 0, failures: 0, verboseUntil: Date.now() + 5000 };
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
      push(`exited (${signal ?? `code ${code}`})`);
      this.o.log?.(`[connector] ${cardId} ${entry} exited (${signal ?? `code ${code}`})`);
      resolve();
    }));
    child.once('error', (e) => push(`spawn error: ${e.message}`));
    await Promise.race([exited, new Promise((r) => setTimeout(r, settleMs))]);
    if (run.exited) return { ok: false, output: [...run.logs], reason: `the connector exited on start (${run.exited.signal ?? `code ${run.exited.code}`})` };
    this.o.log?.(`[connector] ${cardId} running ${entry} pid ${child.pid} · ${actions.map((a) => a.id).join(',')}`);
    return { ok: true, pid: child.pid, output: [...run.logs] };
  }

  private onLine(run: Running, line: string, push: (l: string) => void): void {
    let m: any;
    try { m = JSON.parse(line); } catch { push(line); return; }
    if (!m || typeof m !== 'object') { push(line); return; }
    if (m.type === 'log') { push(String(m.text ?? '')); return; }
    if (m.type === 'ready') { run.ready = String(m.text ?? 'ready'); push(`ready ${run.ready}`); return; }
    if (m.type === 'midi' && typeof m.port === 'string' && m.op && typeof m.op === 'object') {
      const op = { kind: 'midi', ...m.op } as MidiOp;
      run.ops++;
      const what = describeMidi(op);
      this.o.send({ cardId: run.cardId, target: 'midi', port: m.port, op }, (ok, detail) => {
        if (!ok) run.failures++;
        // Keep the log readable at 30 Hz: every failure, and successes only now and then.
        if (!ok || Date.now() < run.verboseUntil || run.ops % 15 === 1) push(`${ok ? '→' : '✗'} ${what} on ${m.port}${ok ? '' : `: ${detail ?? 'refused'}`}`);
      });
      return;
    }
    if (m.type === 'gimbal' && GIMBAL_OPS.has(m.op)) {
      const op = { kind: 'ble', profile: 'dji-osmo', op: m.op, ...(m.arg !== undefined ? { arg: m.arg } : {}) } as BleOp;
      run.ops++;
      const what = `gimbal ${m.op}${typeof m.arg === 'number' ? ` ${Math.round(m.arg)}°` : m.arg && typeof m.arg === 'object' ? ` ${JSON.stringify(m.arg)}` : ''}`;
      this.o.send({ cardId: run.cardId, target: 'gimbal', op }, (ok, detail) => {
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
    if (!r.exited) {
      try { r.child.stdin!.write(`${JSON.stringify({ type: 'stop', reason })}\n`); } catch { /* already closed */ }
      const kill = setTimeout(() => { if (!r.exited) r.child.kill('SIGKILL'); }, 600);
      kill.unref?.();
      setTimeout(() => { if (!r.exited) r.child.kill('SIGTERM'); }, 250).unref?.();
    }
    this.o.log?.(`[connector] ${cardId} stopped (${reason})`);
    return true;
  }

  stopAll(reason = 'stopped'): void {
    for (const cardId of [...this.running.keys()]) this.stop(cardId, reason);
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
const listeners = { set: [], trigger: [], stop: [] };
const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
export const log = (...a) => emit({ type: 'log', text: a.map(String).join(' ').slice(0, 500) });
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  for (const fn of listeners[m.type] ?? []) {
    try { m.type === 'set' ? fn(m.id, m.value) : m.type === 'trigger' ? fn(m.id) : fn(); }
    catch (e) { log('handler error: ' + (e && e.stack || e)); }
  }
  if (m.type === 'stop') setTimeout(() => process.exit(0), 50);
});
/** A control moved: id is your action id, value is in the min..max range you declared for it. */
export const onSet = (fn) => { listeners.set.push(fn); };
/** A button was pressed. */
export const onTrigger = (fn) => { listeners.trigger.push(fn); };
/** Stop / disconnect: release held notes here. */
export const onStop = (fn) => { listeners.stop.push(fn); };
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
/** Tell the server you are up (optional). */
export const ready = (text = '') => emit({ type: 'ready', text: String(text).slice(0, 200) });
process.on('uncaughtException', (e) => { log('crash: ' + (e && e.stack || e)); process.exit(1); });
`;
