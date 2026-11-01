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
import type { MidiExecutor } from './midiExec';
import type { CardputerBridge } from './serial/bridge';

export interface TapeRow {
  execId: string;
  at: number;
  /** "CC 46 → 69", "IR NEC 82 6D BE 41", "identity?" */
  what: string;
  target: string;
  actionId?: string;
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

export class Executor {
  leader = false;
  readonly tape: TapeRow[] = [];
  onTape: () => void = () => {};
  onLeader: (leader: boolean) => void = () => {};
  log: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void = () => {};

  constructor(
    private readonly midi: MidiExecutor,
    private readonly bridge: CardputerBridge,
    private readonly oracle: AudioOracle,
  ) {}

  /** Take the executor role (or wait for it while another tab holds it). */
  claim(): void {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      this.leader = true;
      this.onLeader(true);
      return;
    }
    void locks.request('ce.companion.executor', () => {
      this.leader = true;
      this.onLeader(true);
      return new Promise<void>(() => {}); // held until this tab closes
    });
  }

  attach(conn: Connection): void {
    conn.on('exec.command', (m) => {
      if (!this.leader) return;
      void this.exec(m.payload).then((ack) => conn.send('exec.ack', ack, { to: 'server' }));
    });
    conn.on('sense.request', (m) => {
      if (!this.leader) return;
      void this.sense(m.payload).then((r) => conn.send('sense.result', r, { to: 'server' }));
    });
    conn.on('panic', () => {
      if (this.leader) void this.panicLocal('server');
    });
    conn.on('verify.result', (m) => {
      const row = this.tape.find((t) => t.execId === m.payload.execId);
      if (!row) return;
      const o = m.payload.observed;
      const word = o.sense === 'audio' ? 'heard' : o.sense === 'camera' ? 'seen' : 'wired';
      row.verdict = { pass: m.payload.pass, text: m.payload.pass ? `${word} ✓` : 'no reaction ✗' };
      this.onTape();
    });
  }

  private record(cmd: ExecCommandPayload): TapeRow {
    const row: TapeRow = { execId: cmd.execId, at: Date.now(), ...describeOp(cmd), ...(cmd.actionId ? { actionId: cmd.actionId } : {}) };
    this.tape.push(row);
    if (this.tape.length > 200) this.tape.shift();
    this.onTape();
    return row;
  }

  async exec(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const row = this.record(cmd);
    let ack: ExecAckPayload;
    if (cmd.op.kind === 'midi') ack = await this.midi.execute(cmd);
    else if (cmd.op.kind === 'ir') {
      ack = this.bridge.link.ready
        ? await this.bridge.exec(cmd)
        : { execId: cmd.execId, ok: false, sentAt: Date.now(), error: 'no_ir', detail: 'no Cardputer attached to this companion (CONNECT CARDPUTER)' };
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

  /** Stop sound and IR right here, now (the PANIC button and the server's panic fan-out). */
  async panicLocal(from: 'button' | 'server'): Promise<number> {
    const n = this.midi.panic();
    await this.bridge.panic();
    this.log('warn', `PANIC (${from}): ${n} MIDI messages, IR stopped`);
    return n;
  }
}

export { AudioOracle };
