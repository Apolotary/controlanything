import type { ChatMessage, MuseChat } from '../muse/adapter';
import { ModelCallError } from '../muse/adapter';
import type { Driver, DriverAction, PayloadOf } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { extendWithTouch, touchActions, touchControls, touchRoleOfCc, visualExpect } from '../devices/visualSynth';
import { validateDriver } from '../devices/validate';
import { verifyDriver } from './verify';
import { applyVisualSynthMidi, createVisualSynthState } from '../../../../packages/vsynth/src/state';
import { Dispatcher } from './dispatch';
import { ControlRouter } from './control';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { chunkCode, isConnectorDevelopmentRequest, libraryDriverNote, deviceHints, extractCodeSoFar, SIGNALS_API, WireService, wireHack, wireMessages, wireRateHz, writeWiring, type WireDeps, type WireServiceDeps, type WireEmit } from './wire';
import { buildWiring, fixtureWireDraft, parseBriefs, templateWiring, type WireDraftData } from './wire-fixture';
import { isDifferentConnectedOp1ControlRequest } from './connected-peripheral';
import { dryRun, validateWiring } from './wire-check';

const set = (id: string, label: string, n: number): DriverAction => ({ actionId: id, label, kind: 'set', range: { min: 0, max: 127, step: 1 }, curve: 'linear', encode: { kind: 'midi', msg: 'cc', channel: 1, number: n, value: '$value' }, expect: { sense: 'camera', effect: 'any' } });
const pc = (n: number): DriverAction => ({ actionId: `pattern${n}`, label: ['Flow', 'Rings', 'Prism'][n]!, kind: 'trigger', encode: { kind: 'midi', msg: 'pc', channel: 1, number: n }, expect: { sense: 'camera', effect: 'any' } });
// a manifest that has the touch inputs gp-mac is adding (the real one is read at run time)
const MANIFEST = {
  id: 'controlanything-visual-synth' as const, name: 'ControlAnything Visual Synth', port: { id: 'ce-visual-synth', name: 'ControlAnything Visual Synth' }, channel: 1 as const, silent: false as const,
  controls: [
    { cc: 71, parameter: 'warp', label: 'Warp', effect: 'how strongly the field bends', rendererRange: [0, 1] as [number, number], curve: 'linear' as const },
    { cc: 21, parameter: 'ripple', label: 'Water ripples', effect: 'ripple depth', rendererRange: [0, 1] as [number, number], curve: 'linear' as const },
    { cc: 22, parameter: 'touchX', label: 'Touch X', effect: 'x of the fingertip on the water, left to right', rendererRange: [0, 1] as [number, number], curve: 'linear' as const },
    { cc: 23, parameter: 'touchY', label: 'Touch Y', effect: 'y of the fingertip on the water, top to bottom', rendererRange: [0, 1] as [number, number], curve: 'linear' as const },
    { cc: 24, parameter: 'touchPressure', label: 'Touch pressure', effect: '0 = lifted, above 0 = touching; also a soft hover glow', rendererRange: [0, 1] as [number, number], curve: 'linear' as const },
  ],
  programs: [{ program: 0, name: 'Flow', effect: 'flowing field' }],
  touch: 'Touch the water: CC22 X and CC23 Y place the fingertip, CC24 is its pressure (0 lifted, 1-20 hover, 21-127 touching). Send X and Y before pressure.',
  resets: '', rejects: [], receipt: '',
};
const base: Driver = {
  driverId: 'drv-1', cardId: 'visual-synth-mac', transport: 'midi', executor: { deviceId: 'mac', port: 'ce-visual-synth' }, provenance: [],
  actions: [set('cc71', 'Warp', 71), set('cc21', 'Water ripples', 21), pc(0)], maxRateHz: 200, modelId: 'muse-spark-1.3',
};
const extended = extendWithTouch(base, MANIFEST.controls).driver;
const TOUCH = "// Touch the water\nconst t = s.screen;\nif (t && t.inside) {\n  out.set('cc22', t.u * 127);\n  out.set('cc23', t.v * 127);\n  out.set('cc24', t.touching ? 100 : t.hover * 30);\n  mem.on = true;\n} else if (mem.on) {\n  out.set('cc24', 0);\n  mem.on = false;\n}";

function fakeChat(replies: (WireDraftData | Error | ((m: ChatMessage[]) => WireDraftData))[], mode: 'live' | 'fixture' = 'live', model = 'muse-spark-1.3') {
  const seen: ChatMessage[][] = [];
  const chat = {
    mode, model, totals: () => ({}), calls: () => [], chat: vi.fn(),
    chatJson: vi.fn(async (messages: ChatMessage[]) => {
      seen.push(messages);
      const next = replies.shift();
      if (!next) throw new ModelCallError('no more replies');
      if (next instanceof Error) throw next;
      const data = typeof next === 'function' ? next(messages) : next;
      return { data, text: JSON.stringify(data), model, source: mode, format: 'json_schema', latencyMs: 5, attempts: 1 };
    }),
  };
  return Object.assign(chat as unknown as MuseChat, { seen });
}
const draft = (code: string, over: Partial<WireDraftData> = {}): WireDraftData => ({ title: 'Touch the water', explanation: 'Your fingertip makes ripples.', code, needs: ['screen'], ...over });

describe('prompt', () => {
  it('labels saved driver reuse separately from fresh wiring, including authored fixtures and templates', () => {
    expect(libraryDriverNote({ modelId: 'muse-spark-1.3', source: 'live' })).toContain('from your library · model muse-spark-1.3 · source live');
    expect(libraryDriverNote({ modelId: 'fixture', source: 'fixture' })).toContain('model fixture · source fixture');
    const template = libraryDriverNote({ modelId: 'template', source: 'fixture' });
    expect(template).toContain('template (no Meta model) · source fixture');
    expect(template).not.toContain('written live');
  });

  it('carries the request, the Signals API verbatim, the driver actions, manifest hints and the rules', () => {
    const msgs = wireMessages({ cardId: 'c', deviceName: 'MacBook', request: 'Touch the water', driver: extended });
    const text = msgs.map((m) => m.content).join('\n');
    expect(text).toContain('Wearer request: Touch the water');
    expect(text).toContain(SIGNALS_API);
    expect(SIGNALS_API).toContain('pinchTap: boolean;         // true for one frame on a quick pinch+release (<350 ms, little motion)');
    const briefs = parseBriefs(text);
    expect(briefs.map((b) => b.actionId)).toEqual(['cc71', 'cc21', 'pattern0', 'cc22', 'cc23', 'cc24']);
    expect(briefs.find((b) => b.actionId === 'cc71')).toMatchObject({ kind: 'set', min: 0, max: 127 });
    for (const token of ['import', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'eval', 'Function', 'globalThis', 'self', 'postMessage', 'setTimeout', 'setInterval', 'while(true)', 'for(;;)', 'document', 'window', 'this', 'constructor', '__proto__', 'prototype']) expect(text).toContain(token);
    expect(text).toMatch(/out\.set\('<actionId>', value\)/);
    expect(text).toMatch(/out\.trigger\('<actionId>'\)/);
    expect(text).toMatch(/`mem`/);
    expect(text).toMatch(/4096 bytes/);
  });

  it('reads the touch hints from the capability manifest, not from a constant', () => {
    const hints = deviceHints(extended, MANIFEST).join('\n');
    expect(hints).toContain('cc22 "Touch X" [touch input]: x of the fingertip on the water');
    expect(hints).toContain('cc24 "Touch pressure" [touch input]: 0 = lifted');
    expect(hints).toMatch(/calibrate/);
    expect(hints).toContain('How the touch controls work together (from the manifest): Touch the water: CC22 X and CC23 Y');
    expect(hints).toMatch(/BEFORE pressure/);
    expect(hints).toMatch(/at 20-60 Hz/);
    expect(hints).toMatch(/hovering = 1-20 from s\.screen\.hover/);
    expect(hints).toMatch(/Send pressure 0 once when the finger lifts away, the hand is lost or s\.screen is null/);
    // a manifest with no touch controls says nothing about touch
    expect(deviceHints(base, { ...MANIFEST, controls: MANIFEST.controls.slice(0, 2) }).join('\n')).not.toMatch(/touch/i);
    // a physical device gets no visual synth hints
    expect(deviceHints({ ...base, executor: { deviceId: 'mac', port: 'OP-1 Field' } }, MANIFEST)).toEqual([]);
  });

  it('a repair round replays the rejected answer and lists the issues', () => {
    const msgs = wireMessages({ cardId: 'c', deviceName: 'MacBook', request: 'x', driver: base }, { previous: '{"code":"bad"}', issues: ['"fetch" is not allowed'] });
    expect(msgs.at(-2)).toMatchObject({ role: 'assistant', content: '{"code":"bad"}' });
    expect(String(msgs.at(-1)!.content)).toContain('- "fetch" is not allowed');
  });
});

describe('the manifest touch inputs', () => {
  it('become driver actions only when the driver lacks them', () => {
    expect(touchControls(MANIFEST.controls).map((c) => c.cc)).toEqual([22, 23, 24]);
    expect(touchActions(touchControls(MANIFEST.controls)).map((a) => a.actionId)).toEqual(['cc22', 'cc23', 'cc24']);
    const r = extendWithTouch(base, MANIFEST.controls);
    expect(r.added).toEqual(['cc22', 'cc23', 'cc24']);
    expect(extendWithTouch(r.driver, MANIFEST.controls).added).toEqual([]);
    expect(extendWithTouch({ ...base, executor: { deviceId: 'x', port: 'OP-1' } }, MANIFEST.controls).added).toEqual([]);
  });

  it('Touch X / Y are ack-checked (nothing is drawn while lifted), pressure is camera/renderer checked', () => {
    const byId = Object.fromEntries(extended.actions.map((a) => [a.actionId, a.expect]));
    expect(byId.cc22).toEqual({ sense: 'ack', effect: 'any' });
    expect(byId.cc23).toEqual({ sense: 'ack', effect: 'any' });
    expect(byId.cc24).toEqual({ sense: 'camera', effect: 'any' });
    expect(byId.cc71).toEqual({ sense: 'camera', effect: 'any' });
    // against the live manifest too (CC22-24 are in it now)
    expect(touchRoleOfCc(22)).toBe('x');
    expect(touchRoleOfCc(23)).toBe('y');
    expect(touchRoleOfCc(24)).toBe('pressure');
    expect(touchRoleOfCc(71)).toBeUndefined();
    expect(visualExpect(23)).toEqual({ sense: 'ack', effect: 'any' });
    expect(visualExpect(21)).toEqual({ sense: 'camera', effect: 'any' });
  });

  it('the driver validator accepts ack for Touch X / Y only, and the extended visual driver as a whole', () => {
    const ids = { driverId: base.driverId, executor: base.executor };
    const ctx = { expectedTransport: 'midi' as const, allowedCcs: new Set([71, 21, 22, 23, 24]), visualMaxSets: 12 };
    const live = extendWithTouch(base).driver;
    const ok = validateDriver(live, ids, ctx);
    expect(ok.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const badPressure = { ...live, actions: live.actions.map((a) => (a.actionId === 'cc24' ? { ...a, expect: { sense: 'ack' as const, effect: 'any' as const } } : a)) };
    expect(validateDriver(badPressure, ids, ctx).issues.map((i) => i.code)).toContain('physical_oracle_required');
    const badWarp = { ...live, actions: live.actions.map((a) => (a.actionId === 'cc71' ? { ...a, expect: { sense: 'ack' as const, effect: 'any' as const } } : a)) };
    expect(validateDriver(badWarp, ids, ctx).issues.map((i) => i.code)).toContain('physical_oracle_required');
    // a setup driver may still carry camera on Touch X (the old rule), and the default cap of four continuous controls stands
    const cameraX = { ...live, actions: live.actions.map((a) => (a.actionId === 'cc22' ? { ...a, expect: { sense: 'camera' as const, effect: 'any' as const } } : a)) };
    expect(validateDriver(cameraX, ids, ctx).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateDriver(live, ids, { ...ctx, visualMaxSets: undefined }).issues.map((i) => i.code)).toContain('visual_controls');
  });

  it('verifying them never touches down: X/Y at the middle, pressure only as a hover, strict renderer check', async () => {
    const live = extendWithTouch(base).driver;
    let state = createVisualSynthState();
    const ops: { actionId?: string; op: Record<string, unknown> }[] = [];
    const exec = vi.fn(async (deviceId: string, op: Record<string, unknown>, opts: { actionId?: string }) => {
      ops.push({ op, actionId: opts.actionId });
      const bytes = op.msg === 'cc' ? [0xb0, Number(op.number), Number(op.value)] : op.msg === 'pc' ? [0xc0, Number(op.number)] : [];
      const change = bytes.length ? applyVisualSynthMidi(state, bytes) : null;
      if (change) state = change.parameters;
      return { execId: 'e', ok: true, sentAt: Date.now(), applied: change ? { source: 'renderer' as const, params: { ...state }, visible: true } : undefined };
    });
    const target = { cardId: 'visual-synth-mac', verification: {}, evidence: [], runId: 'r' } as never;
    const summary = await verifyDriver({ dispatcher: { exec } as never, sam: {} as never, settleMs: () => 0 }, target, live, { actionIds: ['cc22', 'cc23', 'cc24'] });
    expect(summary.verification).toMatchObject({ cc22: 'pass', cc23: 'pass', cc24: 'pass' });
    const pressure = ops.filter((o) => o.op.number === 24).map((o) => o.op.value as number);
    expect(pressure.length).toBeGreaterThan(0);
    expect(Math.max(...pressure)).toBeLessThanOrEqual(20);
    expect(ops.find((o) => o.actionId === 'cc22')!.op.value).toBe(64);
    expect(ops.find((o) => o.actionId === 'cc23')!.op.value).toBe(64);
    expect(ops.find((o) => o.actionId === 'cc24')!.op.value).toBe(10);
    // X and Y are checked by the renderer receipt, with no freeze and no baseline
    expect(ops.filter((o) => o.actionId?.startsWith('cc22:') || o.actionId?.startsWith('cc23:'))).toEqual([]);
    expect(summary.evidence.find((e) => e.actionId === 'cc22')!.note).toMatch(/verified by renderer: touchX 0\.50/);
    expect(summary.evidence.find((e) => e.actionId === 'cc24')!.note).toMatch(/touchPressure/);
  });
});

describe('streaming helpers', () => {
  it('decodes the growing code string out of partial JSON', () => {
    const json = JSON.stringify({ code: "a = 1;\n// \"quoted\" \\ é\nb()", explanation: 'e', needs: [], title: 't' });
    for (let n = 1; n <= json.length; n++) {
      const part = extractCodeSoFar(json.slice(0, n));
      expect(JSON.parse(json).code.startsWith(part)).toBe(true);
    }
    expect(extractCodeSoFar(json)).toBe(JSON.parse(json).code);
    expect(extractCodeSoFar('{"title":"x"')).toBe('');
    expect(extractCodeSoFar('{"code":"abc\\u00')).toBe('abc');
  });

  it('chunks code into about eight pieces that add up', () => {
    const chunks = chunkCode(TOUCH, 8);
    expect(chunks.join('')).toBe(TOUCH);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.length).toBeLessThanOrEqual(12);
    expect(chunkCode('')).toEqual([]);
  });
});

describe('fixtures and templates', () => {
  it('FIXTURE wirings for "Touch the water" and "Hands as knobs" pass the validator and the dry-run', () => {
    const briefs = parseBriefs(wireMessages({ cardId: 'c', deviceName: 'Mac', request: 'x', driver: extended }).map((m) => m.content).join('\n'));
    const touch = buildWiring(briefs, 'Touch the water', 'FIXTURE', 'Recorded.', MANIFEST.controls);
    expect(touch.title).toBe('FIXTURE: Touch the water');
    expect(touch.needs).toEqual(['screen']);
    expect(validateWiring(touch.code, extended).ok).toBe(true);
    expect(dryRun(touch.code, extended, ['screen']).actions.sort()).toEqual(['cc22', 'cc23', 'cc24']);
    const knobs = buildWiring(briefs, 'Hands as knobs', 'FIXTURE', 'Recorded.', MANIFEST.controls);
    expect(knobs.code).not.toMatch(/cc22|cc23|cc24/);
    expect(knobs.title).toBe('FIXTURE: Hands as knobs');
    expect(validateWiring(knobs.code, extended).ok).toBe(true);
    expect(dryRun(knobs.code, extended, knobs.needs).ok).toBe(true);
    const fx = fixtureWireDraft(wireMessages({ cardId: 'c', deviceName: 'Mac', request: 'Surprise me', driver: base }));
    expect(fx.title).toBe('FIXTURE: Hands as knobs');
  });

  it('the template is labelled, valid, and works on a device without touch inputs too', () => {
    for (const request of ['Touch the water', 'Hands as knobs']) {
      for (const driver of [base, extended]) {
        const t = templateWiring(parseBriefs(wireMessages({ cardId: 'c', deviceName: 'Mac', request, driver }).map((m) => m.content).join('\n')), request);
        expect(t.title.startsWith('Template: ')).toBe(true);
        expect(t.title.length).toBeLessThanOrEqual(60);
        expect(t.explanation).toMatch(/No Meta model wrote this/);
        expect(validateWiring(t.code, driver).issues).toEqual([]);
        expect(dryRun(t.code, driver, t.needs).issues).toEqual([]);
      }
    }
  });
});

describe('writeWiring', () => {
  const run = async (deps: Partial<WireDeps> & { spark: MuseChat }, driver: Driver = extended) => {
    const events: { phase: string; extra: Record<string, unknown> }[] = [];
    const emit: WireEmit = (phase, extra = {}) => events.push({ phase, extra: extra as never });
    const result = await writeWiring({ chunkDelayMs: 0, ...deps }, { cardId: 'c', deviceName: 'Mac', request: 'Touch the water', driver }, emit);
    return { result, events };
  };

  it('accepts a valid first answer, chunks the code in and reports the dry-run', async () => {
    const spark = fakeChat([draft(TOUCH)]);
    const { result, events } = await run({ spark });
    expect(result).toMatchObject({ ok: true, source: 'live', model: 'muse-spark-1.3', attempts: 1, needs: ['screen'] });
    expect(result.used.sort()).toEqual(['cc22', 'cc23', 'cc24']);
    expect(events.filter((e) => e.extra.codeDelta).map((e) => e.extra.codeDelta).join('')).toBe(TOUCH);
    expect(events.map((e) => e.phase)).toEqual(expect.arrayContaining(['writing', 'validating', 'dry-run']));
    expect(events.find((e) => e.phase === 'dry-run' && e.extra.note && /dry-run ✓ 480 frames · 3 actions/.test(String(e.extra.note)))).toBeTruthy();
    expect(spark.chatJson).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spark.chatJson).mock.calls[0]![2]).toMatchObject({ name: 'wire_program', reasoningEffort: 'low' });
  });

  it('repairs once with the validator issues, then accepts', async () => {
    const spark = fakeChat([draft("fetch('/x');\nout.set('cc22', 1);"), draft(TOUCH)]);
    const { result, events } = await run({ spark });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    const repair = spark.seen[1]!;
    expect(String(repair.at(-1)!.content)).toMatch(/"fetch" is not allowed/);
    // the wearer's code display is reset for the repair
    expect(events.some((e) => e.phase === 'writing' && e.extra.code === '' && /repairing/.test(String(e.extra.note)))).toBe(true);
    expect(events.some((e) => e.phase === 'validating' && Array.isArray(e.extra.issues))).toBe(true);
  });

  it('feeds dry-run failures back too (a program that throws without hands)', async () => {
    const spark = fakeChat([draft("out.set('cc22', s.screen.u * 127);"), draft(TOUCH)]);
    const { result } = await run({ spark });
    expect(result.ok).toBe(true);
    expect(String(spark.seen[1]!.at(-1)!.content)).toMatch(/threw on the/);
  });

  it('falls back to Wonder after a failed repair, then to the labelled template', async () => {
    const bad = draft("eval('1');\nout.set('cc22', 1);");
    const spark = fakeChat([bad, bad]);
    const wonder = fakeChat([draft(TOUCH)], 'live', 'muse-wonder-1.0');
    const viaWonder = await run({ spark, wonder });
    expect(viaWonder.result).toMatchObject({ ok: true, attempts: 3, model: 'muse-wonder-1.0', source: 'live' });
    expect(vi.mocked(wonder.chatJson).mock.calls[0]![2]).toMatchObject({ maxTokens: 4000, timeoutMs: 60_000 });

    const spark2 = fakeChat([bad, bad]);
    const wonder2 = fakeChat([bad]);
    const { result, events } = await run({ spark: spark2, wonder: wonder2 });
    expect(result).toMatchObject({ ok: true, model: 'template', source: 'template' });
    expect(result.title.startsWith('Template: ')).toBe(true);
    expect(events.some((e) => e.extra.source === 'template' && /template wiring: no Meta model wrote this/.test(String(e.extra.note)))).toBe(true);
  });

  it('a Muse call that errors counts as a failed attempt (and the template still keeps the demo alive)', async () => {
    const spark = fakeChat([new ModelCallError('Muse did not answer within 50s'), new ModelCallError('HTTP 500')]);
    const { result } = await run({ spark });
    expect(result).toMatchObject({ ok: true, source: 'template' });
  });

  it('never makes the template the default: a valid live answer is used as is', async () => {
    const { result } = await run({ spark: fakeChat([draft(TOUCH)]) });
    expect(result.source).toBe('live');
    expect(result.model).not.toBe('template');
  });

  it('declared needs are merged with what the code reads', async () => {
    const { result } = await run({ spark: fakeChat([draft(TOUCH, { needs: [] })]) });
    expect(result.needs).toEqual(['screen']);
    const knob = await run({ spark: fakeChat([draft("const r = s.right;\nif (r) out.set('cc71', r.height * 127);", { needs: ['left'] })]) });
    expect(knob.result.needs).toEqual(['right', 'left']);
  });

  it('stops quietly when the request is superseded', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(writeWiring({ spark: fakeChat([draft(TOUCH)]), chunkDelayMs: 0 }, { cardId: 'c', deviceName: 'Mac', request: 'x', driver: extended }, () => {}, { signal: abort.signal })).rejects.toThrow(/cancelled/i);
  });

  it('streams tokens when the live client can: deltas as they arrive, final code flushed', async () => {
    const full = JSON.stringify({ code: TOUCH, explanation: 'Your fingertip makes ripples.', needs: ['screen'], title: 'Touch the water' });
    const stream = vi.fn(async (_req: unknown, handlers: { onContent?: (d: string, soFar: string) => void }) => {
      let soFar = '';
      for (let i = 0; i < full.length; i += 25) { const d = full.slice(i, i + 25); soFar += d; handlers.onContent?.(d, soFar); await new Promise((r) => setTimeout(r, 4)); }
      return { content: full, toolCalls: [], model: 'muse-spark-1.3', latencyMs: 120, chunks: 10, finishReason: 'stop' };
    });
    const spark = fakeChat([]);
    const { result, events } = await run({ spark, stream: { model: 'muse-spark-1.3', stream: stream as never } });
    expect(result).toMatchObject({ ok: true, source: 'live', model: 'muse-spark-1.3' });
    const deltas = events.filter((e) => e.extra.codeDelta).map((e) => e.extra.codeDelta as string);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.join('')).toBe(TOUCH);
    expect(spark.chatJson).not.toHaveBeenCalled();
    expect(stream.mock.calls[0]![0]).toMatchObject({ model: 'muse-spark-1.3', reasoningEffort: 'low' });
  });

  it('a stream that cannot be opened falls back to one plain call', async () => {
    const stream = vi.fn(async () => { throw new ModelCallError('Meta Model API HTTP 400: stream not supported'); });
    const spark = fakeChat([draft(TOUCH)]);
    const { result } = await run({ spark, stream: { model: 'muse-spark-1.3', stream: stream as never } });
    expect(result.ok).toBe(true);
    expect(spark.chatJson).toHaveBeenCalledTimes(1);
  });
});

describe('rates and hacks', () => {
  it('visual synth CCs run at 30 Hz, triggers at <= 3 Hz, physical devices keep their caps', () => {
    const exec = { deviceId: 'x' };
    const d = { transport: 'midi' as const, maxRateHz: 200, executor: { deviceId: 'mac', port: 'ce-visual-synth' } };
    expect(wireRateHz(d, set('cc22', 'Touch X', 22))).toBe(30);
    expect(wireRateHz(d, set('cc71', 'Warp', 71))).toBe(30);
    // whole-picture light and colour keep the dials' photosensitivity cap
    expect(wireRateHz(d, set('cc7', 'Brightness', 7))).toBe(3);
    expect(wireRateHz(d, set('cc10', 'Hue', 10))).toBe(3);
    expect(wireRateHz(d, pc(0))).toBe(3);
    expect(wireRateHz({ transport: 'midi', maxRateHz: 10, executor: exec }, set('cc22', 'x', 22))).toBe(10);
    expect(wireRateHz({ transport: 'ir', executor: exec }, { ...set('level', 'Level', 1), encode: { kind: 'step', upActionId: 'a', downActionId: 'b', steps: 10 } })).toBe(2);
    expect(wireRateHz({ transport: 'local', executor: exec }, { ...set('volume', 'Volume', 1), encode: { kind: 'local', op: 'volume', arg: '$value' }, expect: { sense: 'ack', effect: 'any' } })).toBe(10);
    expect(wireRateHz({ transport: 'midi', executor: exec }, { ...set('l', 'Lamp', 1), expect: { sense: 'camera', effect: 'brighter' } })).toBe(3);
  });

  it('a wire hack clamps through its param range and is latest-wins "control" for set actions', () => {
    const h = wireHack('wire:cc22', set('cc22', 'Touch X', 22), 30);
    expect(h).toMatchObject({ id: 'wire:cc22', kind: 'control', max_rate_hz: 30, commands: [{ action: 'cc22', param: 'wire:cc22' }], params: [{ id: 'wire:cc22', min: 0, max: 127 }] });
    expect(wireHack('wire:pattern0', pc(0), 3)).toMatchObject({ kind: 'action', commands: [{ action: 'pattern0' }] });
  });
});

// --- the service: request -> progress -> ready -> control events -> exec ---------------------------------------------------------
function service(over: { spark?: MuseChat; verifyFails?: string[]; driver?: Driver; ensure?: 'ok' | 'fail'; stopOutputs?: WireServiceDeps['stopOutputs']; developConnector?: WireServiceDeps['developConnector']; buildConnector?: WireServiceDeps['buildConnector']; retireConnector?: WireServiceDeps['retireConnector'] } = {}) {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const hub = { broadcast: vi.fn((type: string, payload: Record<string, unknown>) => { sent.push({ type, payload }); return 1; }), sendToDevice: vi.fn((_device: string, _type: string, _payload: Record<string, unknown>) => 1) };
  const targets = new TargetStore(hub as never);
  const t = targets.create({ cardId: 'visual-synth-mac', state: 'armed', armed: true, driver: over.driver ?? base,
    verification: { cc71: 'pass', cc21: 'pass', pattern0: 'pass' }, card: { cardId: 'visual-synth-mac', name: 'ControlAnything Visual Synth', maker: 'x', model: 'x', category: 'synthesizer', confidence: 1, protocols: ['midi'], evidence: [] } });
  const verify = vi.fn(async (target: typeof t, ids: string[]) => { for (const id of ids) target.verification[id] = over.verifyFails?.includes(id) ? 'fail' : 'pass'; return ids.filter((id) => target.verification[id] !== 'pass'); });
  const svc = new WireService({
    hub: hub as never, targets, spark: over.spark ?? fakeChat([draft(TOUCH)]), chunkDelayMs: 0, log: () => {},
    ensureDriver: async () => (over.ensure === 'fail' ? { ok: false, reason: 'Pinch the device first.' } : { ok: true, note: 'driver from your library, written by muse-spark-1.3' }),
    prepareDriver: (target) => { const e = extendWithTouch(target.driver!, MANIFEST.controls); target.driver = e.driver; return e.driver; },
    verifyActions: verify as never, stopOutputs: over.stopOutputs, cardOfSpec: (id) => (id === 'spec-1' ? 'visual-synth-mac' : undefined), developConnector: over.developConnector,
    buildConnector: over.buildConnector, retireConnector: over.retireConnector,
  });
  const done = async (type: string, timeout = 3000) => { const end = Date.now() + timeout; while (Date.now() < end) { const m = sent.find((x) => x.type === type); if (m) return m; await new Promise((r) => setTimeout(r, 5)); } throw new Error(`no ${type}; got ${sent.map((s) => s.type + ':' + s.payload.phase).join(',')}`); };
  return { svc, sent, hub, targets, t, verify, done };
}

describe('WireService', () => {
  it('fails closed instead of substituting a patch or ordinary hand program when fresh generation is unavailable', async () => {
    const spark = fakeChat([]), developConnector = vi.fn();
    const f = service({ spark, developConnector });
    f.svc.request({ cardId: f.t.cardId, requestId: 'fresh-missing', text: 'Build a MIDI connector from scratch. My forward/back hand movement makes ripples.', source: 'voice' }, { deviceId: 'quest' });
    await vi.waitFor(() => expect(f.sent.some(m => m.payload.phase === 'failed')).toBe(true));
    expect(developConnector).not.toHaveBeenCalled(); expect(spark.chatJson).not.toHaveBeenCalled();
    expect(f.sent.some(m => m.type === 'wire.ready')).toBe(false);
  });

  it('checks a fresh connector through device verification and retires it on Stop', async () => {
    const code = "if (s.right) out.set('cc21', s.right.push * 127);";
    const spark = fakeChat([]), retireConnector = vi.fn(), developConnector = vi.fn();
    const buildConnector = vi.fn(async () => ({ ok: true, code, title: 'Forward/back ripples', explanation: 'Push your right hand to deepen the ripples.', needs: ['right'] as ('right')[],
      model: 'fixture-native-writer', source: 'fixture' as const, latencyMs: 1, attempts: 1, used: ['cc21'], issues: [] }));
    const f = service({ spark, buildConnector, retireConnector, developConnector });
    f.svc.request({ cardId: f.t.cardId, requestId: 'fresh-ask', text: 'Build a MIDI connector from scratch for this visual synth. Forward/back movement makes ripples.', source: 'voice' }, { deviceId: 'quest' });
    const ready = await f.done('wire.ready');
    expect(buildConnector).toHaveBeenCalledOnce(); expect(developConnector).not.toHaveBeenCalled(); expect(spark.chatJson).not.toHaveBeenCalled();
    expect(f.verify).toHaveBeenCalledWith(f.t, ['cc21'], expect.any(AbortSignal));
    expect(f.svc.resolve({ widgetId: 'wire:cc21', requestId: 'fresh-ask', wiringId: String(ready.payload.wiringId) })).toHaveProperty('target');
    await f.svc.stop({ cardId: f.t.cardId, requestId: 'fresh-ask', wiringId: String(ready.payload.wiringId) }, { deviceId: 'quest' });
    expect(retireConnector).toHaveBeenLastCalledWith(f.t.cardId); expect(f.svc.activeCards()).toEqual([]);
  });

  it('routes an explicit USB-MIDI bridge coding request without installing a gesture program', async () => {
    expect(isConnectorDevelopmentRequest('Debug and develop the USB MIDI bridge for OP-1 Field.')).toBe(true);
    for (const text of ['Write gesture controls for the OP-1.', 'Touch the water', 'How does the MIDI bridge work?']) expect(isConnectorDevelopmentRequest(text)).toBe(false);
    const developConnector = vi.fn(async (_task, progress) => { progress('Muse Code running.'); return { jobId: 'code-task', state: 'completed_unverified' }; });
    const spark = fakeChat([]), f = service({ spark, developConnector });
    f.svc.request({ cardId: f.t.cardId, text: 'Debug the USB MIDI bridge for OP-1 Field.', source: 'voice', requestId: 'code-ask' }, { deviceId: 'quest' });
    await vi.waitFor(() => expect(f.sent.some(m => m.payload.title === 'Connector patch awaits review')).toBe(true));
    expect(developConnector).toHaveBeenCalledOnce(); expect(spark.chatJson).not.toHaveBeenCalled();
    expect(f.sent.some(m => m.type === 'wire.ready')).toBe(false); expect(f.svc.activeCards()).toEqual([]);
    f.svc.clear();
  });

  it('declines a connected physical OP-1 request on the visual card before any model, template or action verification', async () => {
    const spark = fakeChat([]); const { svc, sent, verify, t } = service({ spark });
    svc.request({ cardId: t.cardId, requestId: 'op1-wrong-target', text: 'I have an OP-1 Field connected to this laptop. Can you create gesture control for it?', source: 'voice' }, { deviceId: 'quest' });
    await vi.waitFor(() => expect(sent.some(m => m.payload.phase === 'failed')).toBe(true));
    expect(spark.chatJson).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(svc.activeCards()).toEqual([]);
    const failed = sent.find(m => m.payload.phase === 'failed')!;
    expect(failed.payload.model).toBe('not-called');
    expect(String(failed.payload.note)).toContain('Select the OP-1 in Annotate. Use Correct device');
    expect(sent.some(m => m.type === 'wire.ready' || m.payload.source === 'template' || m.payload.codeDelta)).toBe(false);
  });

  it('retires and releases an old visual program before declining a different physical target', async () => {
    const spark = fakeChat([draft(TOUCH)]), stopOutputs = vi.fn(async () => ({ released: true }));
    const { svc, done, sent, t } = service({ spark, stopOutputs });
    svc.request({ cardId: t.cardId, requestId: 'visual-first', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    const ready = await done('wire.ready');
    svc.request({ cardId: t.cardId, requestId: 'physical-next', text: 'Control my OP-1 Field connected to the paired Mac with my hands.', source: 'voice' }, { deviceId: 'quest' });
    await vi.waitFor(() => expect(sent.some(m => m.payload.requestId === 'physical-next' && m.payload.phase === 'failed')).toBe(true));
    expect(stopOutputs).toHaveBeenCalledTimes(1); expect(spark.chatJson).toHaveBeenCalledTimes(1);
    expect(svc.activeCards()).toEqual([]); expect(t.armed).toBe(true);
    expect(svc.resolve({ widgetId: 'wire:cc24', requestId: 'visual-first', wiringId: String(ready.payload.wiringId) })).toHaveProperty('reason');
  });

  it('preserves requests for OP-1-inspired visuals and for an actually selected OP-1', async () => {
    const inspired = service({ spark: fakeChat([draft(TOUCH)]) });
    inspired.svc.request({ cardId: inspired.t.cardId, text: 'Create OP-1-inspired gesture controls for this Visual Synth. My OP-1 Field is connected to this Mac.', source: 'voice' }, { deviceId: 'quest' });
    await inspired.done('wire.ready'); expect(inspired.svc.activeCards()).toEqual([inspired.t.cardId]); inspired.svc.clear();
    const physicalDriver: Driver = { ...base, executor: { deviceId: 'mac', port: 'OP-1 Field' }, actions: [{ ...set('cc50', 'Attack', 50), expect: { sense: 'audio', effect: 'any' } }] };
    const physical = service({ driver: physicalDriver, spark: fakeChat([draft("if (s.right) out.set('cc50', s.right.height * 127);", { title: 'Hand attack', explanation: 'Hand height controls attack.', needs: ['right'] })]) });
    physical.t.card = { ...physical.t.card!, name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field' };
    physical.svc.request({ cardId: physical.t.cardId, text: 'I have an OP-1 Field connected to this Mac. Create gesture control for it.', source: 'voice' }, { deviceId: 'quest' });
    await physical.done('wire.ready'); expect(physical.svc.activeCards()).toEqual([physical.t.cardId]); physical.svc.clear();
  });

  it('keeps the different-device guard narrow to an explicit physical destination through a selected host', () => {
    const selected = { name: 'ControlAnything Visual Synth', category: 'synthesizer', port: 'ce-visual-synth' };
    expect(isDifferentConnectedOp1ControlRequest('What is an OP-1 Field?', selected)).toBe(false);
    expect(isDifferentConnectedOp1ControlRequest('Make water look like my OP-1 Field connected to my Mac.', selected)).toBe(false);
    expect(isDifferentConnectedOp1ControlRequest('Create hand controls for this Visual Synth while my OP-1 Field is connected to my Mac.', selected)).toBe(false);
    expect(isDifferentConnectedOp1ControlRequest('Control my OP-1 Field connected by USB to the Mac like a theremin.', selected)).toBe(true);
  });

  it('scoped stop preserves the driver/arm and sends only the matching requester/executor a stopped epoch', async () => {
    const stopOutputs = vi.fn(async () => ({ released: true }));
    const { svc, done, hub, sent, t } = service({ stopOutputs });
    svc.request({ cardId: t.cardId, requestId: 'ask-1', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    const ready = await done('wire.ready');
    const wiringId = String(ready.payload.wiringId);
    expect(ready.payload.requestId).toBe('ask-1');
    const driver = t.driver;
    const result = await svc.stop({ cardId: t.cardId, requestId: 'ask-1', wiringId }, { deviceId: 'quest' });
    expect(result).toMatchObject({ ok: true, requestId: 'ask-1', wiringId, releaseConfirmed: true });
    expect(t.armed).toBe(true); expect(t.driver).toBe(driver); expect(stopOutputs).toHaveBeenCalledTimes(1);
    expect(svc.readyFor(t.cardId)).toBeUndefined();
    expect(svc.resolve({ widgetId: 'wire:cc24', requestId: 'ask-1', wiringId })).toHaveProperty('reason');
    expect(hub.sendToDevice.mock.calls.filter(c => c[1] === 'wire.stopped').map(c => c[0])).toEqual(['quest', 'mac']);
    expect(sent.some(m => m.type === 'wire.stopped' || m.type === 'panic')).toBe(false);
    svc.replayTo('late-quest');
    expect(hub.sendToDevice.mock.calls.some(c => c[0] === 'late-quest' && c[1] === 'wire.ready')).toBe(false);
  });

  it('rejects a foreign owner, stale request epoch or wrong wiring ID without cancelling the current program', async () => {
    const stopOutputs = vi.fn(async () => ({ released: true }));
    const { svc, done, t } = service({ stopOutputs });
    svc.request({ cardId: t.cardId, requestId: 'ask-current', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    const ready = await done('wire.ready'); const wiringId = String(ready.payload.wiringId);
    for (const [requestId, id, owner] of [['ask-current', wiringId, 'other-headset'], ['ask-old', wiringId, 'quest'], ['ask-current', 'old-wiring', 'quest']]) {
      expect((await svc.stop({ cardId: t.cardId, requestId, wiringId: id }, { deviceId: owner })).ok).toBe(false);
      expect(svc.readyFor(t.cardId)?.requestId).toBe('ask-current');
    }
    expect(stopOutputs).not.toHaveBeenCalled();
    expect(svc.resolve({ widgetId: 'wire:cc24', requestId: 'ask-old', wiringId })).toHaveProperty('reason');
    expect(svc.resolve({ widgetId: 'wire:cc24', requestId: 'ask-current', wiringId })).toHaveProperty('hack');
    svc.clear();
  });

  it('stops a pending first request and cannot publish its late ready after Ask again', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const spark = fakeChat([draft(TOUCH)]), reply = fakeChat([draft(TOUCH)]);
    vi.mocked(spark.chatJson).mockImplementationOnce(async (...args) => { await waiting; return reply.chatJson(...args); });
    const { svc, sent, t } = service({ spark });
    svc.request({ cardId: t.cardId, requestId: 'pending-ask', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await svc.stop({ cardId: t.cardId, requestId: 'pending-ask' }, { deviceId: 'quest' })).ok).toBe(true);
    svc.request({ cardId: t.cardId, requestId: 'new-ask', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await vi.waitFor(() => expect(svc.readyFor(t.cardId)?.requestId).toBe('new-ask'));
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(sent.filter(m => m.type === 'wire.ready').map(m => m.payload.requestId)).toEqual(['new-ask']);
    expect(svc.resolve({ widgetId: 'wire:cc24', requestId: 'pending-ask', wiringId: String(sent.find(m => m.payload.requestId === 'pending-ask')?.payload.wiringId) })).toHaveProperty('reason');
    svc.clear();
  });

  it('a delayed stopped acknowledgement cannot clear the next accepted request', async () => {
    let finishRelease!: () => void;
    const release = new Promise<void>(resolve => { finishRelease = resolve; });
    const { svc, done, t } = service({ spark: fakeChat([draft(TOUCH), draft(TOUCH)]), stopOutputs: async () => { await release; return { released: true }; } });
    svc.request({ cardId: t.cardId, requestId: 'first', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    const ready = await done('wire.ready');
    const stopped = svc.stop({ cardId: t.cardId, requestId: 'first', wiringId: String(ready.payload.wiringId) }, { deviceId: 'quest' });
    expect(svc.readyFor(t.cardId)).toBeUndefined();
    svc.request({ cardId: t.cardId, requestId: 'second', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await vi.waitFor(() => expect(svc.readyFor(t.cardId)?.requestId).toBe('second'));
    finishRelease(); expect((await stopped).requestId).toBe('first');
    expect(svc.readyFor(t.cardId)?.requestId).toBe('second'); svc.clear();
  });

  it('a disconnected owner revokes its pending request before any late ready can arrive', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const spark = fakeChat([draft(TOUCH)]), reply = fakeChat([draft(TOUCH)]);
    vi.mocked(spark.chatJson).mockImplementationOnce(async (...args) => { await waiting; return reply.chatJson(...args); });
    const { svc, sent } = service({ spark });
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(svc.disconnectOwner('quest')).toEqual(['visual-synth-mac']);
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(svc.activeCards()).toEqual([]); expect(sent.some(m => m.type === 'wire.ready')).toBe(false);
  });

  it('an older departing owner cannot revoke the newer owner, but its current owner can', async () => {
    const { svc, done } = service();
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest-new' });
    await done('wire.ready');
    expect(svc.disconnectOwner('quest-old')).toEqual([]);
    expect(svc.activeCards()).toEqual(['visual-synth-mac']);
    expect(svc.disconnectOwner('quest-new')).toEqual(['visual-synth-mac']);
    expect(svc.activeCards()).toEqual([]);
  });

  it('request -> progress -> verify the touch actions -> wire.ready to everyone', async () => {
    const { svc, sent, verify, done, t } = service();
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    const ready = await done('wire.ready');
    expect(ready.payload).toMatchObject({ cardId: 'visual-synth-mac', source: 'live', model: 'muse-spark-1.3', title: 'Touch the water', needs: ['screen'] });
    expect((ready.payload.actions as { actionId: string; maxRateHz: number }[]).map((a) => [a.actionId, a.maxRateHz])).toEqual([['cc22', 30], ['cc23', 30], ['cc24', 30]]);
    expect(verify).toHaveBeenCalledWith(t, ['cc22', 'cc23', 'cc24'], expect.anything());
    const phases = sent.filter((m) => m.type === 'wire.progress').map((m) => m.payload.phase);
    expect(phases).toEqual(expect.arrayContaining(['writing', 'validating', 'dry-run', 'verifying', 'ready']));
    expect(phases.indexOf('verifying')).toBeGreaterThan(phases.indexOf('dry-run'));
    expect(sent.some((m) => m.type === 'wire.progress' && /from your library/.test(String(m.payload.note)))).toBe(true);
    expect(sent.find((m) => m.type === 'wire.progress')!.payload.request).toBe('Touch the water');
    expect(svc.activeCards()).toEqual(['visual-synth-mac']);
  });

  it('does not verify what already passed, and sends the template label when Muse fails', async () => {
    const bad = draft("eval('1');\nout.set('cc71', 1);");
    const { svc, verify, done } = service({ spark: fakeChat([bad, bad]), driver: base });
    svc.request({ cardId: 'visual-synth-mac', text: 'Hands as knobs', source: 'voice' }, { deviceId: 'quest' });
    const ready = await done('wire.ready');
    expect(ready.payload).toMatchObject({ source: 'template', model: 'template' });
    expect(String(ready.payload.title)).toMatch(/^Template: /);
    // cc71 / cc21 / pattern0 were verified at setup: only the touch actions would ever be new
    expect(verify).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['cc71']), expect.anything());
  });

  it('fails clearly when an action cannot be verified or the card is not ready', async () => {
    const a = service({ verifyFails: ['cc24'] });
    a.svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    const failed = await a.done('wire.progress', 1000).then(() => new Promise<{ payload: Record<string, unknown> }>((ok) => { const i = setInterval(() => { const f = a.sent.find((m) => m.payload.phase === 'failed'); if (f) { clearInterval(i); ok(f); } }, 5); }));
    expect(String(failed.payload.note)).toMatch(/cc24/);
    expect(a.sent.some((m) => m.type === 'wire.ready')).toBe(false);
    expect(a.svc.activeCards()).toEqual([]);

    const b = service({ ensure: 'fail' });
    b.svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.sent.find((m) => m.payload.phase === 'failed')!.payload.note).toBe('Pinch the device first.');
  });

  it('Stop cancels a first request still being written, before any active wiring exists', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const spark = fakeChat([draft(TOUCH)]);
    const reply = fakeChat([draft(TOUCH)]);
    vi.mocked(spark.chatJson).mockImplementationOnce(async (...args) => { await waiting; return reply.chatJson(...args); });
    const { svc, sent } = service({ spark });
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    svc.clear();
    release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(svc.activeCards()).toEqual([]);
    expect(sent.some((m) => m.type === 'wire.ready')).toBe(false);
  });

  it('asking again immediately withdraws old control authority, even when the new setup fails', async () => {
    const options: { ensure?: 'ok' | 'fail' } = {};
    const { svc, done, sent } = service(options);
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await done('wire.ready');
    options.ensure = 'fail';
    svc.request({ cardId: 'visual-synth-mac', text: 'Hands as knobs', source: 'chip' }, { deviceId: 'quest' });
    expect(svc.resolve({ widgetId: 'wire:cc22' })).toMatchObject({ reason: expect.stringContaining('no wiring is active') });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.some((m) => m.type === 'wire.progress' && m.payload.phase === 'failed')).toBe(true);
    expect(svc.activeCards()).toEqual([]);
  });

  it('resolves wire events only for actions of the current wire.ready, and drops everything on clear', async () => {
    const { svc, done } = service();
    expect(svc.resolve({ widgetId: 'wire:cc22' })).toEqual({ reason: expect.stringMatching(/no wiring is active/) });
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await done('wire.ready');
    const ok = svc.resolve({ widgetId: 'wire:cc22', specId: 'spec-1' });
    expect('hack' in ok && ok.hack.id).toBe('wire:cc22');
    expect('hack' in svc.resolve({ widgetId: 'wire:cc22' })).toBe(true);
    expect(svc.resolve({ widgetId: 'wire:cc71' })).toEqual({ reason: expect.stringMatching(/not part of the current wiring/) });
    svc.clear('visual-synth-mac');
    expect(svc.resolve({ widgetId: 'wire:cc22' })).toEqual({ reason: expect.stringMatching(/no wiring is active/) });
  });

  it('a driver replaced after the wiring was written makes the wiring stale', async () => {
    const { svc, done, t } = service();
    svc.request({ cardId: 'visual-synth-mac', text: 'Touch the water', source: 'chip' }, { deviceId: 'quest' });
    await done('wire.ready');
    t.driver = { ...t.driver!, driverId: 'drv-2' };
    expect(svc.resolve({ widgetId: 'wire:cc22' })).toEqual({ reason: expect.stringMatching(/out of date/) });
  });
});

// --- the control path ------------------------------------------------------------------------------------------------------
describe('wire events through the ControlRouter', () => {
  function rig(policy = { ready: true }) {
    const hub = { broadcast: vi.fn(() => 1), sendToDevice: vi.fn(() => 1) };
    
    const targets = new TargetStore(hub as never);
    const t = targets.create({ cardId: 'visual-synth-mac', state: 'armed', armed: true, driver: extended, verification: { cc71: 'pass', cc21: 'pass', pattern0: 'pass', cc22: 'pass', cc23: 'pass', cc24: 'pass' } });
    const dispatcher = new Dispatcher({ hub, now: () => Date.now() });
    const fire = vi.spyOn(dispatcher, 'fire').mockReturnValue(true);
    const results: PayloadOf<'control.result'>[] = [];
    const svc = new WireService({ hub: hub as never, targets, spark: fakeChat([]), ensureDriver: async () => ({ ok: true }), prepareDriver: (x) => x.driver!, verifyActions: async () => [], cardOfSpec: () => undefined, log: () => {} });
    (svc as unknown as { active: Map<string, unknown> }).active.set('visual-synth-mac', {
      cardId: 'visual-synth-mac', wiringId: 'w1', driverId: extended.driverId, at: 0, ready: {},
      actions: new Map(['cc22', 'cc23', 'cc24', 'pattern0'].map((id) => [id, { actionId: id }])),
    });
    const router = new ControlRouter({ targets, dispatcher, specs: { get: () => undefined, list: () => [] }, steps: new StepLog(hub as never), hub: hub as never, now: () => Date.now(), wire: (ev) => svc.resolve(ev), manualReady: () => policy.ready, onResult: (r) => results.push(r) });
    return { router, fire, t, results };
  }
  const ev = (widgetId: string, value: number | boolean, specId = 'spec-1') => ({ widgetId, value, ts: 1, specId, phase: 'move' as const });

  it('keeps optional manual controls inert until a wiring exists while generated outputs still use their own gate', () => {
    const policy = { ready: false };
    const { router, t, fire } = rig(policy);
    const resolve = vi.spyOn(router, 'resolve');
    resolve.mockReturnValue({ target: t, driver: t.driver!, hack: wireHack('manual-warp', t.driver!.actions[0]!, 30) });
    expect(router.onControlEvent(ev('manual-warp', 80))).toMatchObject({ ok: false, fired: 0, reason: 'Ask Muse what your hands should do first' });
    expect(fire).not.toHaveBeenCalled();
    policy.ready = true;
    expect(router.onControlEvent(ev('manual-warp', 80))).toMatchObject({ ok: true, fired: 1 });
    resolve.mockRestore();
    policy.ready = false;
    expect(router.onControlEvent(ev('wire:cc22', 90))).toMatchObject({ ok: true, fired: 1 });
  });

  it('fires the driver op with the value clamped to the action range', () => {
    const { router, fire } = rig();
    expect(router.onControlEvent(ev('wire:cc22', 9999)).ok).toBe(true);
    expect(fire).toHaveBeenCalledTimes(1);
    const [exec, op, opts] = fire.mock.calls[0]!;
    expect(exec).toBe('mac');
    expect(op).toMatchObject({ kind: 'midi', msg: 'cc', number: 22, value: 127 });
    expect(opts).toMatchObject({ actionId: 'cc22', cardId: 'visual-synth-mac', driverId: 'drv-1', port: 'ce-visual-synth', dropIfLimited: true });
    router.onControlEvent(ev('wire:cc22', -50));
  });

  it('refuses actions outside the wiring, an unarmed card and an unverified action', () => {
    const { router, fire, t } = rig();
    expect(router.onControlEvent(ev('wire:cc71', 5))).toMatchObject({ ok: false, reason: expect.stringMatching(/not part of the current wiring/) });
    t.verification.cc23 = 'fail';
    expect(router.onControlEvent(ev('wire:cc23', 5))).toMatchObject({ ok: false, reason: expect.stringMatching(/unverified/) });
    t.armed = false;
    expect(router.onControlEvent(ev('wire:cc22', 5))).toMatchObject({ ok: false, reason: 'not armed' });
    expect(fire).not.toHaveBeenCalled();
  });

  it('coalesces a fast stream to 30 Hz, latest value wins, with no per-event result chatter', () => {
    vi.useFakeTimers();
    try {
      const { router, fire, results } = rig();
      let sent = 0;
      for (let i = 0; i < 120; i++) { router.onControlEvent(ev('wire:cc22', i % 128)); vi.advanceTimersByTime(8); sent++; }
      vi.advanceTimersByTime(100);
      const values = fire.mock.calls.map((c) => (c[1] as { value: number }).value);
      expect(sent).toBe(120);
      // 120 events over ~0.96 s: at most ~31 CCs, and the last event's value is the last one sent
      expect(values.length).toBeLessThanOrEqual(34);
      expect(values.length).toBeGreaterThan(15);
      expect(values.at(-1)).toBe(119 % 128);
      expect(results.filter((r) => r.widgetId === 'wire:cc22' && /Superseded/.test(r.detail ?? '')).length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a trigger action fires once per event', () => {
    const { router, fire } = rig();
    expect(router.onControlEvent({ widgetId: 'wire:pattern0', value: true, ts: 1, specId: 'spec-1' }).ok).toBe(true);
    expect(fire.mock.calls[0]![1]).toMatchObject({ kind: 'midi', msg: 'pc', number: 0 });
  });
});
