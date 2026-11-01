import { describe, expect, it } from 'vitest';
import { Driver, DriverDraft, Evidence, ExecOp, type HackSet, HackSet as HackSetSchema, MAX_HACK_RATE_HZ, museResponseFormat, RATE_LIMITS } from './index';

/** A Driver as Muse Wonder would write it for the Panasonic-coded ceiling light (library candidates). */
export const SAMPLE_DRIVER: Driver = {
  driverId: 'drv-light-1',
  cardId: 'light',
  name: 'Ceiling light (IR)',
  transport: 'ir',
  executor: { deviceId: 'cardputer-1' },
  provenance: [{ source: 'curated', ref: 'data/devices/jp-ceiling-light-ir.json#Panasonic.CH1' }],
  actions: [
    { actionId: 'off', label: 'Lights off', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], unitUs: 432, repeats: 2, frameGapUs: 75000, ref: 'lib:panasonic/ceiling/CH1/off' }, expect: { sense: 'camera', effect: 'off' }, inverseActionId: 'full' },
    { actionId: 'full', label: 'Full on', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2c, 0x25], unitUs: 432, repeats: 2, ref: 'lib:panasonic/ceiling/CH1/fullOn' }, expect: { sense: 'camera', effect: 'on' }, inverseActionId: 'off' },
    { actionId: 'brighter', label: 'Brighter', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2a, 0x23], unitUs: 432, repeats: 2, ref: 'lib:panasonic/ceiling/CH1/brighter' }, expect: { sense: 'camera', effect: 'brighter' }, inverseActionId: 'dimmer' },
    { actionId: 'dimmer', label: 'Dimmer', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2b, 0x22], unitUs: 432, repeats: 2, ref: 'lib:panasonic/ceiling/CH1/dimmer' }, expect: { sense: 'camera', effect: 'dimmer' }, inverseActionId: 'brighter' },
    { actionId: 'level', label: 'Brightness', kind: 'set', range: { min: 0, max: 100, step: 10 }, encode: { kind: 'step', upActionId: 'brighter', downActionId: 'dimmer', steps: 10, settleMs: 400 }, expect: { sense: 'camera', effect: 'any' } },
  ],
  maxRateHz: 3,
  modelId: 'muse-wonder-1.0',
  source: 'live',
};

export const SAMPLE_HACKSET: HackSet = {
  spec: 'ce.hackset/1',
  device: { id: 'light', name: 'Ceiling light', kind: 'light', channel: { type: 'ir', via: 'cardputer-1' } },
  hacks: [
    {
      id: 'h_dim',
      name: 'Dim room',
      kind: 'control',
      blurb: 'brightness 0-100',
      params: [{ id: 'p_lvl', name: 'Level', min: 0, max: 100, default: 70, unit: '%', step: 10 }],
      control: { archetype: 'ring', size: 'm', param: 'p_lvl' },
      commands: [{ action: 'level', param: 'p_lvl' }],
      oracle: { type: 'camera', region: 'mask', expect: 'luminance_tracks_param' },
      reversible: true,
      inverse: { restore: 'p_lvl' },
      max_rate_hz: 2,
    },
    {
      id: 'h_off',
      name: 'Lights off',
      kind: 'action',
      blurb: 'room goes dark',
      commands: [{ action: 'off' }],
      oracle: { type: 'camera', region: 'mask', expect: 'off' },
      reversible: true,
      inverse: { commands: [{ action: 'full' }] },
      max_rate_hz: 1,
    },
  ],
  daemons: [
    { id: 'd_breathe', name: 'Breathe to tempo', trigger: { source: 'device.op1.clock_bpm' }, map: { curve: 'sine', range: [40, 100], period_bars: 2 }, targets: [{ hack: 'h_dim', param: 'p_lvl' }], max_rate_hz: 2 },
  ],
};

describe('Driver (SPEC §3.2)', () => {
  it('accepts the sample driver and rejects unsafe or malformed ops', () => {
    expect(Driver.safeParse(SAMPLE_DRIVER).success).toBe(true);
    const bad = (patch: Partial<Driver['actions'][number]>) => Driver.safeParse({ ...SAMPLE_DRIVER, actions: [{ ...SAMPLE_DRIVER.actions[0], ...patch }] }).success;
    // only the universal identity request and panic are allowed as non-channel messages
    expect(bad({ encode: { kind: 'midi', msg: 'sysex' as never, channel: 1 } })).toBe(false);
    expect(bad({ encode: { kind: 'midi', msg: 'cc', channel: 1, number: 200 } })).toBe(false);
    expect(bad({ encode: { kind: 'ir', protocol: 'AEHA', bytes: [300] } })).toBe(false);
    expect(bad({ encode: { kind: 'ir', protocol: 'NEC', rawUs: Array.from({ length: 1025 }, () => 500) } })).toBe(false);
    expect(bad({ encode: { kind: 'local', op: 'rm -rf' as never } })).toBe(false);
    expect(Driver.safeParse({ ...SAMPLE_DRIVER, actions: [] }).success).toBe(false);
    expect(Driver.safeParse({ ...SAMPLE_DRIVER, maxRateHz: 1000 }).success).toBe(false);
  });

  it('"$value" is allowed in set encodes and ExecOp excludes step composites', () => {
    expect(ExecOp.safeParse({ kind: 'midi', msg: 'cc', channel: 1, number: 46, value: '$value' }).success).toBe(true);
    expect(ExecOp.safeParse({ kind: 'local', op: 'volume', arg: '$value' }).success).toBe(true);
    expect(ExecOp.safeParse({ kind: 'local', op: 'torch', arg: true }).success).toBe(true);
    expect(ExecOp.safeParse({ kind: 'step', upActionId: 'a', downActionId: 'b', steps: 4 }).success).toBe(false);
    expect(RATE_LIMITS.irPerSec).toBe(4);
    expect(RATE_LIMITS.midiPerSec).toBe(200);
    expect(RATE_LIMITS.lightChangesPerSec).toBe(3);
  });

  it('DriverDraft is what the model writes: no ids, executor or verified flags, and it is a valid Muse json_schema', () => {
    const { driverId: _a, executor: _b, modelId: _c, source: _d, ...draft } = SAMPLE_DRIVER;
    expect(DriverDraft.safeParse(draft).success).toBe(true);
    expect(DriverDraft.safeParse({ ...draft, driverId: 'x' }).success).toBe(true); // extra keys are stripped, not fatal
    const rf = museResponseFormat('driver_draft', DriverDraft);
    expect(rf.json_schema.schema.type).toBe('object');
    expect(JSON.stringify(rf.json_schema.schema)).not.toContain('$ref');
  });

  it('Evidence records sent / expected / observed with a verdict', () => {
    const ev: Evidence = {
      evidenceId: 'ev1',
      cardId: 'light',
      driverId: 'drv-light-1',
      actionId: 'off',
      execId: 'e1',
      attempt: 1,
      sent: { op: SAMPLE_DRIVER.actions[0].encode as ExecOp, at: 1 },
      expected: { sense: 'camera', effect: 'off' },
      observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 1.9, after: 0.6, delta: -1.3, threshold: 0.15, sensorDeviceId: 'quest-1' },
      pass: true,
    };
    expect(Evidence.safeParse(ev).success).toBe(true);
    expect(Evidence.safeParse({ ...ev, observed: { ...ev.observed, metric: 'vibes' } }).success).toBe(false);
  });
});

describe('HackSet (ce.hackset/1)', () => {
  it('accepts the sample and enforces the 3 Hz cap, name lengths and non-empty commands', () => {
    expect(HackSetSchema.safeParse(SAMPLE_HACKSET).success).toBe(true);
    const h = SAMPLE_HACKSET.hacks[1];
    const withHack = (patch: Record<string, unknown>) => HackSetSchema.safeParse({ ...SAMPLE_HACKSET, hacks: [{ ...h, ...patch }] }).success;
    expect(withHack({ max_rate_hz: MAX_HACK_RATE_HZ + 0.1 })).toBe(false);
    expect(withHack({ name: 'a name that is far too long for a hack menu row' })).toBe(false);
    expect(withHack({ commands: [] })).toBe(false);
    expect(withHack({ oracle: { type: 'none', expect: 'none', reason: 'nothing to sense' } })).toBe(true);
    expect(HackSetSchema.safeParse({ ...SAMPLE_HACKSET, daemons: [{ ...SAMPLE_HACKSET.daemons![0], max_rate_hz: 4 }] }).success).toBe(false);
    expect(HackSetSchema.safeParse({ ...SAMPLE_HACKSET, spec: 'ce.hackset/2' }).success).toBe(false);
  });

  it('is a valid Muse json_schema', () => {
    const rf = museResponseFormat('hackset', HackSetSchema);
    expect(rf.json_schema.schema.type).toBe('object');
  });
});
