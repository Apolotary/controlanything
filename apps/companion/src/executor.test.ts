import { makeMessage, type MessageType } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { AudioOracle } from './audio/oracle';
import type { Connection } from './connection';
import { Executor } from './executor';
import { type MidiInEvent, type MidiIO, MidiExecutor } from './midiExec';
import { FakeClock } from './midiScheduler';
import type { CardputerBridge } from './serial/bridge';

class FakeConn {
  handlers = new Map<string, ((m: unknown) => void)[]>();
  sent: { type: string; payload: Record<string, unknown>; to?: string }[] = [];
  on(type: string, fn: (m: unknown) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
    return () => {};
  }
  send(type: string, payload: Record<string, unknown>, opts: { to?: string } = {}) {
    this.sent.push({ type, payload, to: opts.to });
    return true;
  }
  emit<T extends MessageType>(type: T, payload: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn(makeMessage(type, payload as never, { from: 'server', to: 'mac-1' }));
  }
}

const io: MidiIO = {
  enabled: true,
  sysex: true,
  outputs: () => [{ id: 'o1', name: 'OP-1', state: 'connected' }],
  inputs: () => [],
  send: () => {},
  addListener: (_fn: (m: MidiInEvent) => void) => () => {},
};

function setup(leader = true) {
  const midi = new MidiExecutor(io, { clock: new FakeClock(), wallNow: () => 42 });
  const bridge = { link: { ready: false }, exec: async () => ({}), panic: async () => {} } as unknown as CardputerBridge;
  const ex = new Executor(midi, bridge, new AudioOracle());
  ex.leader = leader;
  const conn = new FakeConn();
  ex.attach(conn as unknown as Connection);
  return { ex, conn };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Executor', () => {
  it('never routes a missing browser musical instrument to physical MIDI', async () => {
    const { ex } = setup();
    const execute = vi.spyOn((ex as unknown as { midi: MidiExecutor }).midi, 'execute');
    for (const port of ['ce-musical-synth', 'ControlAnything Synth']) {
      const ack = await ex.exec({ execId: port, executorDeviceId: 'mac-1', port, op: { kind: 'midi', msg: 'cc', channel: 1, number: 17, value: 127 } });
      expect(ack).toMatchObject({ ok: false, error: 'no_port' });
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not route IR through an attached but unapproved Cardputer', async () => {
    const bridge = { link: { ready: true }, online: false, exec: vi.fn() } as unknown as CardputerBridge;
    const ex = new Executor(new MidiExecutor(io, { clock: new FakeClock() }), bridge, new AudioOracle());
    const ack = await ex.exec({ execId: 'ir1', executorDeviceId: 'mac-1', op: { kind: 'ir', protocol: 'RAW', rawUs: [9000, 4500] } });
    expect(ack).toMatchObject({ ok: false, error: 'no_ir' });
    expect(bridge.exec).not.toHaveBeenCalled();
  });
  it('runs a MIDI exec.command and acks it to the server', async () => {
    const { ex, conn } = setup();
    conn.emit('exec.command', { execId: 'x1', executorDeviceId: 'mac-1', op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 69 }, port: 'OP-1', actionId: 'a-cut', cardId: 'synth', driverId: 'driver-synth' });
    await tick();
    expect(conn.sent).toEqual([{ type: 'exec.ack', to: 'server', payload: expect.objectContaining({ execId: 'x1', ok: true, sentAt: 42 }) }]);
    expect(ex.tape[0]).toMatchObject({ execId: 'x1', what: 'CC 46 → 69 · ch 1', target: 'OP-1', actionId: 'a-cut', cardId: 'synth', driverId: 'driver-synth' });
  });

  it('a standby tab ignores commands', async () => {
    const { conn } = setup(false);
    conn.emit('exec.command', { execId: 'x2', executorDeviceId: 'mac-1', op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 1 }, port: 'OP-1' });
    await tick();
    expect(conn.sent).toHaveLength(0);
  });

  it('answers IR without a Cardputer with no_ir, and audio with the oracle off with an error', async () => {
    const { conn } = setup();
    conn.emit('exec.command', { execId: 'x3', executorDeviceId: 'mac-1', op: { kind: 'ir', protocol: 'RAW', rawUs: [9000, 4500, 560, 560] } });
    conn.emit('sense.request', { senseId: 's1', sensorDeviceId: 'mac-1', kind: 'audio-features', durationMs: 500 });
    await tick();
    expect(conn.sent.find((s) => s.type === 'exec.ack')?.payload).toMatchObject({ execId: 'x3', ok: false, error: 'no_ir' });
    expect(conn.sent.find((s) => s.type === 'sense.result')).toMatchObject({ to: 'server', payload: { senseId: 's1', kind: 'audio-features', ok: false } });
  });

  it('marks the tape row with the oracle verdict', async () => {
    const { ex, conn } = setup();
    conn.emit('exec.command', { execId: 'x4', executorDeviceId: 'mac-1', op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 90 }, port: 'OP-1' });
    await tick();
    conn.emit('verify.result', {
      evidenceId: 'e1',
      actionId: 'a-cut',
      execId: 'x4',
      attempt: 1,
      sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 90 }, at: 1 },
      expected: { sense: 'audio', effect: 'tone-up' },
      observed: { sense: 'audio', metric: 'centroid', before: 400, after: 600, delta: 200, threshold: 0.3 },
      pass: true,
    });
    expect(ex.tape.find((t) => t.execId === 'x4')?.verdict).toEqual({ pass: true, text: 'heard ✓' });
  });
});

/** Web Locks with Chrome's steal semantics: a stolen holder's request rejects; queued requests keep waiting. */
class FakeLocks {
  holder?: { reject: (e: Error) => void };
  queue: (() => void)[] = [];
  request(_name: string, options: { steal?: boolean } | (() => Promise<void>), cb?: () => Promise<void>): Promise<void> {
    const steal = typeof options === 'object' && !!options.steal;
    const callback = (cb ?? options) as () => Promise<void>;
    return new Promise<void>((_resolve, reject) => {
      const grant = () => { this.holder = { reject }; void callback(); };
      if (steal && this.holder) { const old = this.holder; this.holder = undefined; old.reject(new DOMException('stolen', 'AbortError')); grant(); }
      else if (!this.holder) grant();
      else this.queue.push(grant);
    });
  }
}

describe('Executor leadership', () => {
  it('lets the visible tab take over; the old tab goes to standby and queues to get the role back', async () => {
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    try {
      const make = () => new Executor(new MidiExecutor(io, { clock: new FakeClock() }), { panic: async () => {} } as unknown as CardputerBridge, new AudioOracle());
      const a = make(), b = make();
      const aEvents: [boolean, boolean | undefined][] = [];
      a.onLeader = (leader, takenOver) => aEvents.push([leader, takenOver]);
      a.claim(); b.claim();
      await tick();
      expect([a.leader, b.leader]).toEqual([true, false]);
      b.takeOver();
      await tick();
      expect([a.leader, a.standby, b.leader]).toEqual([false, true, true]);
      expect(aEvents.at(-1)).toEqual([false, true]);
      a.takeOver();
      await tick();
      expect([a.leader, b.leader, b.standby]).toEqual([true, false, true]);
    } finally { vi.unstubAllGlobals(); }
  });
});
