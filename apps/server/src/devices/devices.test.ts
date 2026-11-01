import type { Driver, DriverDraft, IrCapture } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { clamp, mapRange, planSteps, resolveOp, stepIndex } from './encode';
import { aehaParityOk, analyseCapture, bytesToHex, decodeFrame, encodeFrame, fillRaw, hexToBytes, necBytes, necCommandOk, sameCode, splitFrames } from './ir';
import { makerMatches, parseIdentityReply, pickMidiOutput, portMatches } from './midi';
import { allowedCcs, irBrief, loadProfiles, matchMidiProfile, midiBrief } from './profiles';
import { validateDriver } from './validate';

const PANA_OFF = hexToBytes('2C 52 09 2F 26');

describe('IR codec', () => {
  it('round-trips AEHA and NEC frames through timings', () => {
    const us = encodeFrame({ protocol: 'AEHA', bytes: PANA_OFF, unitUs: 432 });
    expect(us[0]).toBe(3456);
    expect(us[1]).toBe(1728);
    expect(us.length).toBe(2 + PANA_OFF.length * 16 + 1);
    const back = decodeFrame(us);
    expect(back).toMatchObject({ protocol: 'AEHA', bytes: PANA_OFF });
    const nec = necBytes(0x6d82, 0xbe); // NEC/HotaluX CH1 off = 82 6D BE 41
    expect(bytesToHex(nec)).toBe('82 6D BE 41');
    expect(necCommandOk(nec)).toBe(true);
    expect(decodeFrame(encodeFrame({ protocol: 'NEC', bytes: nec, unitUs: 562.5 }))).toMatchObject({ protocol: 'NEC', bytes: nec });
  });

  it('tolerates the 10% stretch real receivers add and rejects unknown leaders', () => {
    const us = encodeFrame({ protocol: 'NEC', bytes: [0x82, 0x6d, 0xbe, 0x41], unitUs: 562.5 }).map((v) => Math.round(v * 1.1));
    expect(decodeFrame(us)?.bytes).toEqual([0x82, 0x6d, 0xbe, 0x41]);
    expect(decodeFrame([500, 500, 500, 500])).toBeNull();
  });

  it('parity and complement checks hold for the library codes', () => {
    expect(aehaParityOk(PANA_OFF)).toBe(true);
    expect(aehaParityOk(hexToBytes('01 10 30 50'))).toBe(true);
    expect(aehaParityOk(hexToBytes('2C 52 08 2F'))).toBe(false);
    expect(necCommandOk(hexToBytes('E7 0C 8B 74'))).toBe(true);
    expect(necCommandOk(hexToBytes('E7 0C 8B 75'))).toBe(false);
  });

  it('splits a two-frame press, analyses it and compares codes', () => {
    const frame = encodeFrame({ protocol: 'AEHA', bytes: PANA_OFF, unitUs: 432 });
    const press = [...frame, 75_000, ...frame];
    const { frames, gapsUs } = splitFrames(press);
    expect(frames).toHaveLength(2);
    expect(gapsUs).toEqual([75_000]);
    const cap = analyseCapture({ rawUs: press, khz: 38 });
    expect(cap).toMatchObject({ protocol: 'AEHA', bytes: PANA_OFF, frames: 2, frameGapUs: 75_000, repeats: 0 });
    const other = analyseCapture({ rawUs: encodeFrame({ protocol: 'AEHA', bytes: hexToBytes('2C 52 09 2C 25'), unitUs: 432 }) });
    expect(sameCode(cap, other)).toBe(false);
    expect(sameCode(cap, analyseCapture({ rawUs: frame }))).toBe(true);
    const raw: IrCapture = { rawUs: [3000, 1500, 400, 1200, 400, 400, 400] };
    expect(analyseCapture(raw).protocol).toBe('UNKNOWN');
    expect(sameCode(raw, { rawUs: [3100, 1550, 420, 1250, 410, 420, 410] })).toBe(true);
  });

  it('fillRaw synthesises timings for NEC/AEHA and refuses RAW without timings', () => {
    const op = fillRaw({ kind: 'ir', protocol: 'NEC', address: 0x6d82, command: 0xbe });
    expect(op.bytes).toEqual([0x82, 0x6d, 0xbe, 0x41]);
    expect(op.rawUs?.length).toBe(2 + 32 * 2 + 1);
    expect(op.khz).toBe(38);
    expect(() => fillRaw({ kind: 'ir', protocol: 'RAW' })).toThrow(/rawUs/);
  });
});

describe('MIDI identity and ports', () => {
  it('parses the EP-133 identity reply and matches makers', () => {
    const reply = parseIdentityReply([0xf0, 0x7e, 0x33, 0x06, 0x02, 0x00, 0x20, 0x76, 0x20, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf7]);
    expect(reply).toMatchObject({ deviceId: 0x33, manufacturer: 'Teenage Engineering', family: 0x20, model: 2 });
    expect(makerMatches(reply!.manufacturer, 'teenage engineering')).toBe(true);
    expect(makerMatches(reply!.manufacturer, 'Elektron')).toBe(false);
    expect(parseIdentityReply([0xb0, 0x2e, 0x40])).toBeNull();
    const sim = parseIdentityReply([0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x7d, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0xf7]);
    expect(sim?.manufacturer).toMatch(/non-commercial/);
  });

  it('picks the MIDI output by hint, else the only one', () => {
    const ports = [
      { id: 'in1', kind: 'midi-in' as const, name: 'OP-1' },
      { id: 'out1', kind: 'midi-out' as const, name: 'OP-1' },
      { id: 'out2', kind: 'midi-out' as const, name: 'EP-133' },
    ];
    expect(pickMidiOutput(ports, 'op-1')?.id).toBe('out1');
    expect(pickMidiOutput(ports, 'ep-133')?.id).toBe('out2');
    expect(pickMidiOutput(ports, 'digitakt')).toBeUndefined();
    expect(pickMidiOutput(ports.slice(0, 2), 'digitakt')?.id).toBe('out1');
    expect(portMatches(ports[1], 'OP-1')).toBe(true);
  });
});

describe('curated profiles', () => {
  const profiles = loadProfiles();

  it('loads the MIDI charts and the IR library from apps/server/data/devices', () => {
    expect(profiles.files.length).toBeGreaterThanOrEqual(6);
    const op1 = profiles.midi.get('op-1-field')!;
    expect(op1.device).toMatch(/OP-1/);
    const ccs = allowedCcs(op1);
    expect(ccs.has(46)).toBe(true);
    expect(ccs.has(54)).toBe(true);
    expect(ccs.has(62)).toBe(false); // randomize: irreversible, dropped
    expect(midiBrief(op1)).toMatch(/46: Synth engine parameter 1/);
    expect(matchMidiProfile(profiles, { maker: 'teenage engineering', model: 'OP-1 Field', name: 'synth' })?.id).toBe('op-1-field');
    expect(matchMidiProfile(profiles, { maker: 'Ableton', model: 'Move', name: 'groovebox' })?.id).toBe('ableton-move');
    expect(matchMidiProfile(profiles, { maker: 'Korg', model: 'Volca', name: 'synth' })).toBeUndefined();
  });

  it('builds an ordered IR candidate list with Panasonic off first and the do-not-send codes', () => {
    const lib = profiles.ir!;
    expect(lib.candidates.length).toBeGreaterThan(20);
    const first = lib.candidates[0];
    expect(first).toMatchObject({ brand: 'Panasonic', channel: 1, key: 'off' });
    expect(first.op).toMatchObject({ protocol: 'AEHA', bytes: PANA_OFF, repeats: 1, frameGapUs: 75_000 });
    expect(lib.candidates.some((c) => c.brand === 'NEC' && c.key === 'off' && c.op.bytes?.join() === [0x82, 0x6d, 0xbe, 0x41].join())).toBe(true);
    expect(lib.doNotSend.some((d) => d.bytes.some((b) => bytesToHex(b) === '2C 52 39 DA E3'))).toBe(true);
    expect(irBrief(lib)).toMatch(/Panasonic/);
    expect(profiles.koizumi).toBeDefined();
  });
});

describe('driver validation and encode', () => {
  const profiles = loadProfiles();
  const op1 = profiles.midi.get('op-1-field')!;
  const midiDraft: DriverDraft = {
    cardId: 'op1',
    transport: 'midi',
    provenance: [{ source: 'curated', ref: 'data/devices/op-1-field.json' }],
    actions: [
      { actionId: 'blue', label: 'Blue encoder', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: '$value' }, expect: { sense: 'audio', effect: 'any' } },
      { actionId: 'note', label: 'Play C3', kind: 'trigger', encode: { kind: 'midi', msg: 'note', channel: 1, number: 48, velocity: 100, durationMs: 400 }, expect: { sense: 'audio', effect: 'louder' } },
      { actionId: 'identity', label: 'Who are you', kind: 'trigger', encode: { kind: 'midi', msg: 'sysex-identity', channel: 1 }, expect: { sense: 'ack', effect: 'any' } },
    ],
  };
  const ids = { driverId: 'd1', executor: { deviceId: 'mac-1', port: 'OP-1' } };

  it('accepts a chart-backed MIDI draft and rejects CCs outside the chart or without a chart', () => {
    const ok = validateDriver(midiDraft, ids, { allowedCcs: allowedCcs(op1) });
    expect(ok.ok, JSON.stringify(ok.issues)).toBe(true);
    expect(ok.driver.maxRateHz).toBe(200);
    const bad = validateDriver({ ...midiDraft, actions: [{ ...midiDraft.actions[0], encode: { kind: 'midi', msg: 'cc', channel: 1, number: 62, value: '$value' } }] }, ids, { allowedCcs: allowedCcs(op1) });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0].code).toBe('cc_not_in_chart');
    expect(validateDriver(midiDraft, ids, {}).issues.some((i) => i.code === 'no_chart')).toBe(true);
    const noPlaceholder = validateDriver({ ...midiDraft, actions: [{ ...midiDraft.actions[0], encode: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 64 } }] }, ids, { allowedCcs: allowedCcs(op1) });
    expect(noPlaceholder.issues.some((i) => i.code === 'missing_placeholder')).toBe(true);
    const mixed = validateDriver({ ...midiDraft, actions: [{ ...midiDraft.actions[1], encode: { kind: 'local', op: 'say', arg: 'hi' } }] }, ids, { allowedCcs: allowedCcs(op1) });
    expect(mixed.issues.some((i) => i.code === 'transport_mismatch')).toBe(true);
  });

  it('allows IR codes only from the library or learned frames, never do-not-send ones, and fills rawUs', () => {
    const lib = profiles.ir!;
    const irDraft: DriverDraft = {
      cardId: 'light',
      transport: 'ir',
      provenance: [{ source: 'curated', ref: 'data/devices/jp-ceiling-light-ir.json' }],
      actions: [
        { actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: PANA_OFF, unitUs: 432, repeats: 1, frameGapUs: 75_000 }, expect: { sense: 'camera', effect: 'off' } },
        { actionId: 'up', label: 'Brighter', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: hexToBytes('2C 52 09 2A 23'), unitUs: 432 }, expect: { sense: 'camera', effect: 'brighter' } },
        { actionId: 'down', label: 'Dimmer', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: hexToBytes('2C 52 09 2B 22'), unitUs: 432 }, expect: { sense: 'camera', effect: 'dimmer' } },
        { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10 } },
      ],
    };
    const r = validateDriver(irDraft, { driverId: 'd2', executor: { deviceId: 'card-1' } }, { irLibrary: lib, emitsLight: true });
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    expect(r.driver.maxRateHz).toBe(3);
    const off = r.driver.actions[0].encode;
    expect(off.kind === 'ir' && off.rawUs?.length).toBe(2 + 40 * 2 + 1);
    const unknown = validateDriver({ ...irDraft, actions: [{ ...irDraft.actions[0], encode: { kind: 'ir', protocol: 'NEC', bytes: [0x12, 0x34, 0x56, 0xa9] } }] }, { driverId: 'd', executor: { deviceId: 'c' } }, { irLibrary: lib });
    expect(unknown.issues.map((i) => i.code)).toContain('ir_not_allowed');
    const forbidden = validateDriver({ ...irDraft, actions: [{ ...irDraft.actions[0], encode: { kind: 'ir', protocol: 'AEHA', bytes: hexToBytes('2C 52 39 DA E3') } }] }, { driverId: 'd', executor: { deviceId: 'c' } }, { irLibrary: lib });
    expect(forbidden.issues.some((i) => /do-not-send/.test(i.message))).toBe(true);
    const learned: IrCapture = analyseCapture({ rawUs: encodeFrame({ protocol: 'AEHA', bytes: [0x11, 0x22, 0x33, 0x44, 0x77], unitUs: 425 }) });
    const viaLearned = validateDriver({ ...irDraft, actions: [{ ...irDraft.actions[0], encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x11, 0x22, 0x33, 0x44, 0x77], unitUs: 425, ref: 'learned:1' } }] }, { driverId: 'd', executor: { deviceId: 'c' } }, { irLibrary: lib, learned: [learned] });
    expect(viaLearned.ok, JSON.stringify(viaLearned.issues)).toBe(true);
    const rawLearned = validateDriver({ ...irDraft, actions: [{ ...irDraft.actions[0], encode: { kind: 'ir', protocol: 'RAW', rawUs: learned.rawUs, ref: 'learned:1' } }] }, { driverId: 'd', executor: { deviceId: 'c' } }, { learned: [learned] });
    expect(rawLearned.ok, JSON.stringify(rawLearned.issues)).toBe(true);
  });

  it('checks local ops against the executor kind', () => {
    const local: DriverDraft = {
      cardId: 'mac',
      transport: 'local',
      provenance: [{ source: 'curated', ref: 'builtin' }],
      actions: [
        { actionId: 'vol', label: 'Volume', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'local', op: 'volume', arg: '$value' } },
        { actionId: 'play', label: 'Play/pause', kind: 'toggle', encode: { kind: 'local', op: 'music', arg: 'playpause' } },
      ],
    };
    expect(validateDriver(local, { driverId: 'd', executor: { deviceId: 'mac-local' } }, { executorKind: 'mac' }).ok).toBe(true);
    const r = validateDriver(local, { driverId: 'd', executor: { deviceId: 'dt' } }, { executorKind: 'devterm' });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('local_op_not_supported');
  });

  it('resolves control values into ops deterministically', () => {
    expect(mapRange(50, { min: 0, max: 100 }, { min: 0, max: 127 }, true)).toBe(64);
    expect(clamp(5, 0, 1)).toBe(1);
    const a = midiDraft.actions[0] as Driver['actions'][number];
    expect(resolveOp(a, 127)).toMatchObject({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: 127 });
    expect(resolveOp(a, 0)).toMatchObject({ value: 0 });
    expect(resolveOp(a, 200)).toMatchObject({ value: 127 });
    expect(() => resolveOp(a)).toThrow(/needs a value/);
    const note = resolveOp(midiDraft.actions[1] as Driver['actions'][number]);
    expect(note).toMatchObject({ msg: 'note', number: 48, durationMs: 400 });
    const vol: Driver['actions'][number] = { actionId: 'vol', label: 'Volume', kind: 'set', range: { min: 0, max: 1 }, encode: { kind: 'local', op: 'volume', arg: '$value' } };
    expect(resolveOp(vol, 0.5)).toMatchObject({ kind: 'local', op: 'volume', arg: 50 });
    const torch: Driver['actions'][number] = { actionId: 't', label: 'Torch', kind: 'set', range: { min: 0, max: 1 }, encode: { kind: 'local', op: 'torch', arg: '$value' } };
    expect(resolveOp(torch, 0.9)).toMatchObject({ arg: true });
  });

  it('plans step sequences for an IR dimmer', () => {
    const level: Driver['actions'][number] = { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10, settleMs: 400 } };
    const driver: Driver = {
      driverId: 'd',
      cardId: 'light',
      transport: 'ir',
      executor: { deviceId: 'c' },
      provenance: [],
      actions: [
        { actionId: 'up', label: 'Up', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [1, 2, 3] } },
        { actionId: 'down', label: 'Down', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [1, 2, 4] } },
        level,
      ],
    };
    expect(stepIndex(level, 100)).toBe(9);
    expect(stepIndex(level, 0)).toBe(0);
    expect(planSteps(driver, level, 9, 50)).toMatchObject({ actionIds: ['down', 'down', 'down', 'down'], index: 5, settleMs: 400 });
    expect(planSteps(driver, level, 2, 50).actionIds).toEqual(['up', 'up', 'up']);
    expect(planSteps(driver, level, 4, 44).actionIds).toEqual([]);
  });
});
