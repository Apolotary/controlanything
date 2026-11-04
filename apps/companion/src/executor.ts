/**
 * Routes work addressed to this companion: exec.command (MIDI here, IR to an attached Cardputer),
 * sense.request (audio features from the oracle) and panic. Only one tab executes: the first to take
 * the Web Locks lock "ce.companion.executor"; other tabs show STANDBY so a second tab never doubles notes.
 */
import type { ExecAckPayload, ExecCommandPayload, SenseRequestPayload } from '@ce/protocol';
import { AudioOracle } from './audio/oracle';
import { wireFeatures } from './audio/features';
import type { Connection } from './connection';
import { describeTimings } from './irCodec';
import { toHex } from './midiDecode';
import { isVisualPort, type VisualSynthExecutor } from './vsynthExecutor';
import type { MidiExecutor } from './midiExec';
import type { CardputerBridge } from './serial/bridge';
import { isMusicalPort, type MusicalSynthPanel } from './musicalSynth';

export interface TapeRow {
  execId: string;
  at: number;
  /** "CC 46 → 69", "IR NEC 82 6D BE 41", "identity?" */
  what: string;
  target: string;
  actionId?: string;
  cardId?: string;
  driverId?: string;
  ack?: ExecAckPayload;
  /** from verify.result: "heard ✓" / "no change ✗" */
  verdict?: { pass: boolean; text: string };
}

export function describeOp(cmd: ExecCommandPayload): { what: string; target: string } {
  const op = cmd.op;
  if (op.kind === 'midi') {
    const target = cmd.port ?? 'MIDI';
    switch (op.msg) {
      case 'cc':
        return { what: `CC ${op.number} → ${op.value} · ch ${op.channel}`, target };
      case 'note':
        return { what: `note ${op.number} v${op.velocity ?? 100} · ${op.durationMs ?? 250} ms · ch ${op.channel}`, target };
      case 'pc':
        return { what: `program ${op.number} · ch ${op.channel}`, target };
      case 'sysex-identity':
        return { what: 'identity request', target };
      case 'panic':
        return { what: 'panic · all notes off', target: cmd.port ?? 'all MIDI' };
    }
  }
  if (op.kind === 'ir') {
    const name = op.ref ? op.ref.replace(/^(lib|learned):/, '') : op.bytes?.length ? `${op.protocol} ${toHex(op.bytes)}` : op.rawUs ? describeTimings(op.rawUs) : op.protocol;
    return { what: `IR ${name}`, target: 'Cardputer' };
  }
  return { what: `${op.op}${op.arg !== undefined ? ` ${JSON.stringify(op.arg).slice(0, 40)}` : ''}`, target: 'local' };
}

export const EXECUTOR_LOCK = 'ce.companion.executor';

export class Executor {
  leader = false;
  /** Another tab holds the role (it took over, or held it first). Unset while the first claim is pending. */
  standby = false;
  readonly tape: TapeRow[] = [];
  onTape: () => void = () => {};
  /** `takenOver`: another tab explicitly took the role from this one ("Use this tab"). */
  onLeader: (leader: boolean, takenOver?: boolean) => void = () => {};
  log: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void = () => {};
  /** A plain (non-stealing) request for the lock is waiting in line. */
  private queued = false;
  private standbyTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly midi: MidiExecutor,
    private readonly bridge: CardputerBridge,
    private readonly oracle: AudioOracle,
    private readonly visual?: VisualSynthExecutor,
    private readonly musical?: MusicalSynthPanel,
  ) {}

  /** Take the executor role (or wait for it while another tab holds it). */
  claim(): void { this.request(false); }

  /**
   * The visible tab's explicit takeover (Open visuals / Use this tab): steal the lock. The previous holder's
   * request rejects with AbortError, so it learns at once, goes to standby, and waits in line again.
   */
  takeOver(): void {
    if (this.leader) return;
    this.request(true);
  }

  private request(steal: boolean): void {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      if (!this.leader) this.setLeader(true);
      return;
    }
    if (!steal) {
      if (this.queued) return;
      this.queued = true;
      // Only call this tab standby once the request has really waited (no flash while the first grant is pending).
      clearTimeout(this.standbyTimer);
      this.standbyTimer = setTimeout(() => {
        if (!this.leader && this.queued && !this.standby) { this.standby = true; this.onLeader(false); }
      }, 300);
    }
    locks.request(EXECUTOR_LOCK, steal ? { steal: true } : {}, () => {
      if (!steal) this.queued = false;
      this.setLeader(true);
      return new Promise<void>(() => {}); // held until this tab closes or another tab takes over
    }).catch(() => {
      if (!steal) this.queued = false;
      if (this.leader) {
        this.leader = false;
        this.standby = true;
        this.log('warn', 'another companion tab took over visuals and devices');
        this.onLeader(false, true);
      }
      this.request(false); // wait in line to get the role back when that tab closes
    });
  }

  private setLeader(leader: boolean): void {
    clearTimeout(this.standbyTimer);
    this.leader = leader;
    this.standby = !leader;
    this.onLeader(leader);
  }

  attach(conn: Connection): void {
    conn.on('exec.command', (m) => {
      if (!this.leader) return;
      // Always answer: a throwing executor must report a failure, not leave the server (and Muse) waiting.
      void this.exec(m.payload).catch((e: unknown) => ({ execId: m.payload.execId, ok: false, sentAt: Date.now(), error: 'device_error' as const,
        detail: `companion error: ${(e as Error)?.message ?? String(e)}`.slice(0, 300) }))
        .then((ack) => conn.send('exec.ack', ack, { to: 'server' }));
    });
    conn.on('sense.request', (m) => {
      if (!this.leader) return;
      void this.sense(m.payload).then((r) => conn.send('sense.result', r, { to: 'server' }))
        .catch((e: unknown) => this.log('warn', `sense failed: ${(e as Error)?.message ?? e}`));
    });
    conn.on('panic', () => {
      if (this.leader) void this.panicLocal('server');
    });
    conn.on('verify.result', (m) => {
      const row = this.tape.find((t) => t.execId === m.payload.execId);
      if (!row) return;
      const o = m.payload.observed;
      const word = o.sense === 'audio' ? 'heard' : o.sense === 'camera' ? 'seen' : 'wired';
      const verdict = { pass: m.payload.pass, text: m.payload.pass ? `${word} ✓` : 'no reaction ✗' };
      // The server re-sends checks on every mode change: an unchanged verdict changes nothing.
      if (row.verdict?.pass === verdict.pass && row.verdict.text === verdict.text) return;
      row.verdict = verdict;
      this.onTape();
    });
  }

  private record(cmd: ExecCommandPayload): TapeRow {
    const row: TapeRow = { execId: cmd.execId, at: Date.now(), ...describeOp(cmd), ...(cmd.actionId ? { actionId: cmd.actionId } : {}), ...(cmd.cardId ? { cardId: cmd.cardId } : {}), ...(cmd.driverId ? { driverId: cmd.driverId } : {}) };
    this.tape.push(row);
    if (this.tape.length > 200) this.tape.shift();
    this.onTape();
    return row;
  }

  async exec(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const row = this.record(cmd);
    let ack: ExecAckPayload;
    if (cmd.op.kind === 'midi') ack = isMusicalPort(cmd.port)
      ? this.musical ? await this.musical.execute(cmd) : { execId: cmd.execId, ok: false, sentAt: Date.now(), error: 'no_port', detail: 'The browser musical instrument is not open.' }
      : this.visual && isVisualPort(cmd.port) ? await this.visual.execute(cmd) : await this.midi.execute(cmd);
    else if (cmd.op.kind === 'ir') {
      ack = this.bridge.online
        ? await this.bridge.exec(cmd)
        : { execId: cmd.execId, ok: false, sentAt: Date.now(), error: 'no_ir', detail: 'connect and approve the Cardputer before sending IR' };
    } else ack = { execId: cmd.execId, ok: false, sentAt: Date.now(), error: 'unsupported', detail: `the companion page does not run local ${cmd.op.op} (the server's Mac executor does)` };
    row.ack = ack;
    this.onTape();
    if (!ack.ok) this.log('warn', `exec ${row.what} → ${ack.error}: ${ack.detail ?? ''}`);
    return ack;
  }

  async sense(req: SenseRequestPayload) {
    const at = Date.now();
    if (req.kind !== 'audio-features') return { senseId: req.senseId, kind: req.kind, at, ok: false, error: `the companion does not sense ${req.kind}` };
    if (this.oracle.state !== 'on') return { senseId: req.senseId, kind: req.kind, at, ok: false, error: 'the audio oracle is off on the companion (press LISTEN)' };
    try {
      const f = await this.oracle.measure(req.durationMs || 600, req.offsetMs ?? 0);
      return { senseId: req.senseId, kind: req.kind, at, ok: true, audio: wireFeatures(f) };
    } catch (e) {
      return { senseId: req.senseId, kind: req.kind, at, ok: false, error: (e as Error).message.slice(0, 300) };
    }
  }

  /** Stop sound and IR right here, now (the Stop all button and the server's panic fan-out). */
  async panicLocal(from: 'button' | 'server'): Promise<number> {
    this.visual?.panic();
    this.musical?.panic();
    const n = this.midi.panic();
    await this.bridge.panic();
    this.log('warn', `Stop all (${from}): ${n} MIDI messages, IR stopped`);
    return n;
  }
}

export { AudioOracle };
