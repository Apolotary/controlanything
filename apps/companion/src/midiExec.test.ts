import { ExecCommandPayload } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { fromHex, IDENTITY_REQUEST } from './midiDecode';
import { type MidiInEvent, type MidiIO, MidiExecutor, type MidiPortLike, resolvePort, unsafeReason } from './midiExec';
import { FakeClock, MidiScheduler } from './midiScheduler';

class FakeMidi implements MidiIO {
  enabled = true;
  sysex = true;
  sent: { port: string; bytes: number[]; ts?: number }[] = [];
  listeners = new Set<(m: MidiInEvent) => void>();
  /** reply to the identity request on this input name */
  identityReply?: { input: string; hex: string };
  constructor(
    public outs: MidiPortLike[] = [{ id: 'o1', name: 'OP-1', state: 'connected' }],
    public ins: MidiPortLike[] = [{ id: 'i1', name: 'OP-1', state: 'connected' }],
  ) {}
  outputs() {
    return this.outs;
  }
  inputs() {
    return this.ins;
  }
  send(port: string, bytes: number[], ts?: number) {
    this.sent.push({ port, bytes: [...bytes], ts });
    if (this.identityReply && bytes[0] === 0xf0) {
      const data = new Uint8Array(fromHex(this.identityReply.hex)!);
      for (const fn of this.listeners) fn({ portId: 'x', portName: this.identityReply.input, data, time: 0 });
    }
  }
  addListener(fn: (m: MidiInEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Build a command through the real protocol schema, so tests only use valid wire shapes. */
const cmd = (op: object, extra: object = {}) => ExecCommandPayload.parse({ execId: 'e1', executorDeviceId: 'mac-1', op, ...extra });

describe('MidiScheduler', () => {
  it('does not send panic messages or cancel pending notes in a dry run', async () => {
    const io = new FakeMidi();
    const clock = new FakeClock();
    const executor = new MidiExecutor(io, { clock });
    await executor.execute(cmd({ kind: 'midi', msg: 'note', channel: 1, number: 60, durationMs: 100 }));
    const before = io.sent.length;
    const ack = await executor.execute(cmd({ kind: 'midi', msg: 'panic', channel: 1 }, { dryRun: true }));
    expect(ack).toMatchObject({ ok: true, detail: 'dry run: panic' });
    expect(io.sent).toHaveLength(before);
    clock.advance(101);
    expect(io.sent.at(-1)?.bytes[0]).toBe(0x80);
  });
  it('never sends more than maxPerSecond in a rolling second', () => {
    const clock = new FakeClock();
    const times: number[] = [];
    const s = new MidiScheduler(() => times.push(clock.now()), { clock, maxPerSecond: 200 });
    for (let i = 0; i < 450; i++) s.enqueue({ portId: 'p', bytes: [0x90, i & 0x7f, 1], kind: 'note-on', done: () => {} });
    expect(times.length).toBe(200);
    clock.advance(999);
    expect(times.length).toBe(200);
    clock.advance(2);
    expect(times.length).toBe(400);
    clock.advance(1000);
    expect(times.length).toBe(450);
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t > times[i] - 1000 && t <= times[i]).length;
      expect(inWindow).toBeLessThanOrEqual(200);
    }
  });

  it('coalesces queued CCs per key, latest value wins, and paces one key at ~66 Hz', () => {
    const clock = new FakeClock();
    const sent: number[][] = [];
    const s = new MidiScheduler((_p, b) => sent.push(b), { clock, keyIntervalMs: 15 });
    const outcomes: string[] = [];
    const push = (v: number) => s.enqueue({ portId: 'p', bytes: [0xb0, 46, v], kind: 'cc', key: 'p|176|46', done: (o) => outcomes.push(o.sent ? `sent ${v}` : `${o.reason} ${v}`) });
    push(10); // sent immediately
    push(20); // waits for the key interval
    push(30); // replaces 20
    push(40); // replaces 30
    expect(sent).toEqual([[0xb0, 46, 10]]);
    clock.advance(15);
    expect(sent).toEqual([
      [0xb0, 46, 10],
      [0xb0, 46, 40],
    ]);
    expect(outcomes).toEqual(['sent 10', 'coalesced 20', 'coalesced 30', 'sent 40']);
  });

  it('keeps note-offs when the queue is full and clears on demand', () => {
    const clock = new FakeClock();
    const s = new MidiScheduler(() => {}, { clock, maxPerSecond: 1, maxQueue: 2 });
    const r: string[] = [];
    const add = (kind: 'note-on' | 'note-off', n: number) => s.enqueue({ portId: 'p', bytes: [kind === 'note-on' ? 0x90 : 0x80, n, 0], kind, done: (o) => r.push(`${kind} ${n} ${o.sent ? 'sent' : o.reason}`) });
    add('note-on', 1); // sent (window now full)
    add('note-on', 2);
    add('note-on', 3);
    add('note-on', 4); // queue full -> refused
    add('note-off', 1); // never refused
    expect(r).toEqual(['note-on 1 sent', 'note-on 4 rate_limited']);
    expect(s.pending).toBe(3);
    expect(s.clear((q) => q.kind === 'note-on')).toBe(2);
    expect(s.pending).toBe(1);
  });
});

describe('resolvePort', () => {
  const ports = [
    { id: 'a', name: 'OP-1', state: 'connected' },
    { id: 'b', name: 'EP-133', state: 'connected' },
    { id: 'c', name: 'Ableton Move Live Port', state: 'connected' },
    { id: 'd', name: 'Ableton Move Standalone Port', state: 'connected' },
    { id: 'e', name: 'Gone', state: 'disconnected' },
  ];
  it('matches id, name, substring, and prefers the Move standalone port', () => {
    expect(resolvePort(ports, 'b').port?.name).toBe('EP-133');
    expect(resolvePort(ports, 'op-1').port?.id).toBe('a');
    expect(resolvePort(ports, 'move').port?.id).toBe('d');
    expect(resolvePort(ports, 'Gone').error).toContain('no MIDI output');
    expect(resolvePort(ports).error).toContain('several');
    expect(resolvePort([ports[0]]).port?.id).toBe('a');
  });
  it('refuses duplicate exact-name matches', () => {
    const dupes = [
      { id: 'a1', name: 'OP-1', state: 'connected' },
      { id: 'a2', name: 'OP-1', state: 'connected' },
    ];
    expect(resolvePort(dupes, 'OP-1').port).toBeUndefined();
    expect(resolvePort(dupes, 'op-1').error).toContain('several');
    // Exact id routing still works despite the duplicate names.
    expect(resolvePort(dupes, 'a2').port?.id).toBe('a2');
    // A disconnected dupe does not create ambiguity.
    const withGone = [...dupes, { id: 'a3', name: 'OP-1', state: 'disconnected' }];
    expect(resolvePort(withGone, 'OP-1').error).toContain('several');
    expect(resolvePort([dupes[0], { id: 'a3', name: 'OP-1', state: 'disconnected' }], 'OP-1').port?.id).toBe('a1');
  });
  it('refuses ambiguous substring matches but keeps unique ones', () => {
    const pair = [
      { id: 'a1', name: 'OP-1 field', state: 'connected' },
      { id: 'a2', name: 'OP-1 drum', state: 'connected' },
    ];
    expect(resolvePort(pair, 'OP-1').port).toBeUndefined();
    expect(resolvePort(pair, 'OP-1').error).toContain('several');
    expect(resolvePort(pair, 'drum').port?.id).toBe('a2');
    // Two standalone ports matching is still ambiguous.
    const moves = [
      { id: 'm1', name: 'Move Standalone A', state: 'connected' },
      { id: 'm2', name: 'Move Standalone B', state: 'connected' },
    ];
    expect(resolvePort(moves, 'move').error).toContain('several');
  });
});

describe('unsafeReason', () => {
  it('refuses non-identity SysEx, SysEx to Move and OP-1 randomize', () => {
    expect(unsafeReason('EP-133', [0xf0, 0x00, 0x20, 0x76, 0x33, 0x40, 0xf7])).toContain('SysEx');
    expect(unsafeReason('EP-133', [...IDENTITY_REQUEST])).toBeUndefined();
    expect(unsafeReason('Ableton Move Standalone Port', [...IDENTITY_REQUEST])).toContain('Move');
    expect(unsafeReason('OP-1', [0xb0, 62, 127])).toContain('randomizes');
    expect(unsafeReason('OP-1', [0xb0, 62, 0])).toBeUndefined();
    expect(unsafeReason('OP-1', [0xb0, 46, 127])).toBeUndefined();
  });
});

describe('MidiExecutor', () => {
  it('sends the checked Muse connector packet to its exact output and records provenance', async () => {
    const io = new FakeMidi(), ex = new MidiExecutor(io, { clock: new FakeClock() });
    const generatedMidi = { connectorId: 'fresh-1', hash: 'a'.repeat(64), portId: 'o1', bytes: [0xb0, 50, 42] };
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 50, value: 42 }, { port: 'o1', generatedMidi }));
    expect(ack).toMatchObject({ ok: true, detail: expect.stringContaining('Muse connector fresh-1 · aaaaaaaaaaaa') });
    expect(io.sent).toEqual([{ port: 'o1', bytes: generatedMidi.bytes, ts: undefined }]);
  });

  it.each(['bytes', 'port', 'note', 'panic'] as const)('refuses an invalid generated %s without using the authored fallback', async failure => {
    const io = new FakeMidi(), ex = new MidiExecutor(io, { clock: new FakeClock() });
    const op = failure === 'note' ? { kind: 'midi', msg: 'note', channel: 1, number: 60 } : failure === 'panic' ? { kind: 'midi', msg: 'panic', channel: 1 } : { kind: 'midi', msg: 'cc', channel: 1, number: 50, value: 42 };
    const generatedMidi = { connectorId: 'fresh-1', hash: 'a'.repeat(64), portId: failure === 'port' ? 'wrong-id' : 'o1', bytes: [0xb0, 50, failure === 'bytes' ? 43 : 42] };
    const ack = await ex.execute(cmd(op, { port: 'o1', generatedMidi }));
    expect(ack).toMatchObject({ ok: false, error: 'refused' });
    expect(io.sent).toHaveLength(0);
  });

  it('sends a CC to the named port and acks with the bytes', async () => {
    const clock = new FakeClock();
    const io = new FakeMidi([
      { id: 'o1', name: 'OP-1', state: 'connected' },
      { id: 'o2', name: 'EP-133', state: 'connected' },
    ]);
    const ex = new MidiExecutor(io, { clock, wallNow: () => 1000 });
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 69 }, { port: 'OP-1' }));
    expect(ack).toMatchObject({ execId: 'e1', ok: true, sentAt: 1000 });
    expect(ack.detail).toBe('B0 2E 45 → OP-1');
    expect(io.sent).toEqual([{ port: 'o1', bytes: [0xb0, 46, 69], ts: undefined }]);
  });

  it('turns a note off after its duration and panic releases what is sounding', async () => {
    const clock = new FakeClock();
    const io = new FakeMidi();
    const ex = new MidiExecutor(io, { clock });
    await ex.execute(cmd({ kind: 'midi', msg: 'note', channel: 2, number: 60, velocity: 90, durationMs: 300 }));
    expect(io.sent.at(-1)?.bytes).toEqual([0x91, 60, 90]);
    expect(ex.soundingNotes).toBe(1);
    clock.advance(300);
    expect(io.sent.at(-1)?.bytes).toEqual([0x81, 60, 0]);
    expect(ex.soundingNotes).toBe(0);

    await ex.execute(cmd({ kind: 'midi', msg: 'note', channel: 1, number: 64, durationMs: 5000 }));
    io.sent = [];
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'panic', channel: 1 }));
    expect(ack.ok).toBe(true);
    expect(io.sent[0].bytes).toEqual([0x80, 64, 0]);
    expect(io.sent).toHaveLength(1 + 16 * 3);
    expect(io.sent.some((s) => s.bytes[0] === 0xbf && s.bytes[1] === 123)).toBe(true);
    expect(ex.soundingNotes).toBe(0);
    clock.advance(6000); // the cancelled timer must not fire a second note-off
    expect(io.sent).toHaveLength(1 + 16 * 3);
  });

  it('refuses unsafe messages, missing ports and unresolved placeholders', async () => {
    const io = new FakeMidi([
      { id: 'o1', name: 'OP-1', state: 'connected' },
      { id: 'o2', name: 'EP-133', state: 'connected' },
    ]);
    const ex = new MidiExecutor(io, { clock: new FakeClock() });
    expect((await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 62, value: 127 }, { port: 'OP-1' }))).error).toBe('refused');
    expect((await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 1 }))).error).toBe('no_port');
    expect((await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: '$value' }, { port: 'OP-1' }))).error).toBe('bad_args');
    expect((await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, value: 3 }, { port: 'OP-1' }))).error).toBe('bad_args');
    expect(ExecCommandPayload.safeParse({ execId: 'x', executorDeviceId: 'd', op: { kind: 'midi', msg: 'cc', channel: 17, number: 46, value: 1 } }).success).toBe(false);
    expect(io.sent).toHaveLength(0);
  });

  it('a note with durationMs 0 stays on until panic', async () => {
    const io = new FakeMidi();
    const clock = new FakeClock();
    const ex = new MidiExecutor(io, { clock });
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'note', channel: 1, number: 48, durationMs: 0 }));
    expect(ack.detail).toContain('held');
    clock.advance(20_000);
    expect(ex.soundingNotes).toBe(1);
    ex.panic();
    expect(io.sent.some((s) => s.bytes[0] === 0x80 && s.bytes[1] === 48)).toBe(true);
    expect(ex.soundingNotes).toBe(0);
  });

  it('dry runs send nothing', async () => {
    const io = new FakeMidi();
    const ex = new MidiExecutor(io, { clock: new FakeClock() });
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'pc', channel: 1, number: 3 }, { dryRun: true }));
    expect(ack.ok).toBe(true);
    expect(ack.detail).toContain('dry run: C0 03');
    expect(io.sent).toHaveLength(0);
  });

  it('reports the identity reply of the device on the same port', async () => {
    const io = new FakeMidi([{ id: 'o2', name: 'EP-133', state: 'connected' }], [{ id: 'i2', name: 'EP-133', state: 'connected' }]);
    io.identityReply = { input: 'EP-133', hex: 'F0 7E 33 06 02 00 20 76 20 00 02 00 00 00 00 00 F7' };
    const ex = new MidiExecutor(io, { clock: new FakeClock() });
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'sysex-identity', channel: 1 }));
    expect(ack.ok).toBe(true);
    expect(ack.reply).toEqual(fromHex('F0 7E 33 06 02 00 20 76 20 00 02 00 00 00 00 00 F7'));
    expect(ack.detail).toContain('Teenage Engineering');
    expect(ack.detail).toContain('family 0x0020');
  });

  it('refuses to send when two OP-1 outputs match', async () => {
    const io = new FakeMidi([
      { id: 'o1', name: 'OP-1', state: 'connected' },
      { id: 'o2', name: 'OP-1', state: 'connected' },
    ]);
    const ex = new MidiExecutor(io, { clock: new FakeClock() });
    const ack = await ex.execute(cmd({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 1 }, { port: 'OP-1' }));
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('no_port');
    expect(io.sent).toHaveLength(0);
  });

  it('times out cleanly when nobody answers the identity request', async () => {
    const clock = new FakeClock();
    const io = new FakeMidi();
    const ex = new MidiExecutor(io, { clock, identityTimeoutMs: 500 });
    const p = ex.execute(cmd({ kind: 'midi', msg: 'sysex-identity', channel: 1 }));
    clock.advance(500);
    const ack = await p;
    expect(ack.ok).toBe(true);
    expect(ack.reply).toBeUndefined();
    expect(ack.detail).toContain('no reply');
  });
});
