import { describe, expect, it } from 'vitest';
import type { WireProgressPayload, WireReadyPayload } from '@ce/protocol';
import { deviceLabel, overlayHeading, sourceLabel, WiringState, wiringActive, wiringLine } from './wiring';

const CARD = 'visual-synth-mac';
const progress = (extra: Partial<WireProgressPayload> = {}): WireProgressPayload => ({ cardId: CARD, wiringId: 'w1', phase: 'writing', model: 'muse-spark-1.3', source: 'live', ...extra });
const ready = (extra: Partial<WireReadyPayload> = {}): WireReadyPayload => ({
  cardId: CARD, wiringId: 'w1', code: 'out.set("cc24", 100);', title: 'Touch the water', explanation: 'Your fingertip makes ripples.', model: 'muse-spark-1.3', source: 'live',
  actions: [{ actionId: 'cc24', label: 'Touch pressure', kind: 'set', min: 0, max: 127 }], needs: ['screen'], ...extra,
});
let n = 0;
const msg = <T>(payload: T) => ({ id: `m${n++}`, payload });

describe('wiring state', () => {
  it('streams code deltas into one wiring, then takes wire.ready as the authoritative program', () => {
    const state = new WiringState();
    expect(state.progress(msg(progress({ request: 'Let me touch the water', code: '' })), 1000)).toBe(true);
    for (const part of ['var f = ', 's.screen;\n', 'out.set(1);']) expect(state.progress(msg(progress({ codeDelta: part })), 1100)).toBe(true);
    const w = state.current(CARD)!;
    expect(w).toMatchObject({ phase: 'writing', code: 'var f = s.screen;\nout.set(1);', request: 'Let me touch the water', source: 'live', startedAt: 1000 });
    expect(wiringActive(w)).toBe(true);
    expect(state.progress(msg(progress({ phase: 'validating', code: 'var f = s.screen;\nout.set(2);' })), 1500)).toBe(true);
    expect(state.progress(msg(progress({ phase: 'dry-run', note: 'dry-run ✓ 120 frames · 3 actions' })), 1900)).toBe(true);
    expect(state.ready(msg(ready({ code: 'FINAL' })), 2500)).toBe(true);
    expect(state.current(CARD)).toMatchObject({ phase: 'ready', code: 'FINAL', title: 'Touch the water', needs: ['screen'], endedAt: 2500, latencyMs: 1500 });
    expect(wiringActive(state.current(CARD))).toBe(false);
    expect(state.current(CARD)!.notes.map((note) => note.phase)).toEqual(['writing', 'validating', 'dry-run', 'ready']);
    expect(state.current(CARD)!.notes[2]!.text).toBe('dry-run ✓ 120 frames · 3 actions');
  });

  it('changes nothing for a repeated message, a duplicate state or a late progress after ready', () => {
    const state = new WiringState();
    const first = msg(progress({ codeDelta: 'abc' }));
    expect(state.progress(first)).toBe(true);
    expect(state.progress(first)).toBe(false); // the same message id again: the delta is not appended twice
    expect(state.current(CARD)!.code).toBe('abc');
    expect(state.progress(msg(progress({ code: 'abc' })))).toBe(false); // a new message that leaves the state as it is
    const rev = state.current(CARD)!.rev;
    expect(state.ready(msg(ready()))).toBe(true);
    expect(state.ready(msg(ready()))).toBe(false);
    expect(state.progress(msg(progress({ phase: 'verifying' })))).toBe(false); // ready is final
    expect(state.current(CARD)!.phase).toBe('ready');
    expect(state.current(CARD)!.rev).toBe(rev + 1);
  });

  it('starts a fresh wiring for a new request, keeps one per device and picks the focused one', () => {
    const state = new WiringState();
    state.progress(msg(progress({ codeDelta: 'first' })), 10);
    state.progress(msg(progress({ wiringId: 'w2', cardId: 'op1', codeDelta: 'other device' })), 20);
    expect(state.current(CARD)!.code).toBe('first');
    expect(state.current('op1')!.code).toBe('other device');
    expect(state.current()!.cardId).toBe('op1'); // the latest overall when nothing is focused
    state.progress(msg(progress({ wiringId: 'w3', codeDelta: 'again' })), 30);
    expect(state.current(CARD)).toMatchObject({ wiringId: 'w3', code: 'again' });
    expect(state.get('nope')).toBeUndefined();
    state.clear(CARD); expect(state.get(CARD)).toBeUndefined(); expect(state.get('op1')).toBeDefined();
    state.clear(); expect(state.current()).toBeUndefined();
  });

  it('lets a repair round rewrite the code and a failed wiring say why', () => {
    const state = new WiringState();
    state.progress(msg(progress({ codeDelta: 'bad code' })), 0);
    state.progress(msg(progress({ phase: 'validating', issues: ['uses fetch'] })), 100);
    state.progress(msg(progress({ phase: 'writing', code: 'better code', issues: [] })), 200); // the repair round
    expect(state.current(CARD)).toMatchObject({ phase: 'writing', code: 'better code', issues: [], endedAt: undefined });
    state.progress(msg(progress({ phase: 'failed', issues: ['dry-run threw'] })), 400);
    expect(state.current(CARD)).toMatchObject({ phase: 'failed', endedAt: 400, latencyMs: 400 });
    expect(wiringLine(state.current(CARD)!, 'Visual synth')).toBe('Wiring failed: dry-run threw');
  });

  it('recovers when the first message was missed: wire.ready alone makes a ready wiring', () => {
    const state = new WiringState();
    expect(state.ready(msg(ready()), 5000)).toBe(true);
    expect(state.current(CARD)).toMatchObject({ phase: 'ready', title: 'Touch the water', code: 'out.set("cc24", 100);' });
  });
});

describe('wiring words', () => {
  const base = { model: 'muse-spark-1.3', source: 'live' as const, title: 'Touch the water', note: undefined, issues: [] as string[] };
  it('says what is happening in one calm line, ending in "Wiring ready: <title>"', () => {
    expect(wiringLine({ ...base, phase: 'writing' }, 'Visual synth')).toBe('muse-spark-1.3 is wiring your hands to the Visual synth…');
    expect(wiringLine({ ...base, phase: 'validating' }, 'Visual synth')).toBe('Checking the wiring…');
    expect(wiringLine({ ...base, phase: 'dry-run', note: 'dry-run ✓ 120 frames · 3 actions' }, 'Visual synth')).toBe('Dry-running the wiring · dry-run ✓ 120 frames · 3 actions…');
    expect(wiringLine({ ...base, phase: 'verifying' }, 'Visual synth')).toBe('Verifying the wiring on the Visual synth…');
    expect(wiringLine({ ...base, phase: 'ready' }, 'Visual synth')).toBe('Wiring ready: Touch the water');
    expect(overlayHeading({ ...base, phase: 'writing' }, 'Visual synth')).toBe('muse-spark-1.3 is wiring your hands to the Visual synth');
  });
  it('is honest when no Meta model wrote it', () => {
    expect(wiringLine({ ...base, source: 'template', model: 'template', phase: 'writing' }, 'Visual synth')).toBe('Template wiring for the Visual synth (no Meta model wrote this)…');
    expect([sourceLabel('live'), sourceLabel('fixture'), sourceLabel('template')]).toEqual(['live', 'FIXTURE', 'Template']);
  });
  it('names the device the way the wearer does', () => {
    expect(deviceLabel('ControlAnything Visual Synth')).toBe('Visual synth');
    expect(deviceLabel('OP-1 Field')).toBe('OP-1 Field');
    expect(deviceLabel(undefined)).toBe('your device');
  });
});
