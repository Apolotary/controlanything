/**
 * WIRE: Muse writes the glue between the wearer's hands and a device, live, after the wearer asks.
 * Nothing is pre-wired: no wire.request, no interaction (research/36-muse-wiring-contract.md).
 *
 *   wire.request -> (setup if the card has no driver) -> Muse Spark writes a JSON {title, explanation, code, needs}
 *   -> validate (size, forbidden tokens, syntax, driver-only action ids) -> dry-run in node:vm on synthetic traces
 *   -> one repair round with the issues -> Wonder behind the length guard -> a labelled template, last of all
 *   -> verify the driver actions the program uses -> wire.ready (code, actions, needs) to the headset and the companion.
 *
 * The code streams to the wearer while Muse writes it (wire.progress codeDelta); the runtime in the headset sends its
 * outputs back as control.event widgetId "wire:<actionId>", which the ControlRouter dispatches through the driver exactly
 * like dial events (range clamp, rate limit, latest wins, armed + verified only).
 */
import { z } from 'zod';
import { type ControlEventPayload, type Driver, type DriverAction, type Hack, museResponseFormat, newId, type WireAction, type WireProgressPayload, type WireReadyPayload, type WireRequestPayload } from '@ce/protocol';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';
import { isVisualSynthPort, touchControls } from '../devices/visualSynth';
import type { StreamClient, StreamMessage } from '../gen3d/stream';
import type { Hub } from '../hub';
import { type ChatMessage, ModelCallError, ModelOutputError, type MuseChat, parseModelJson } from '../muse/adapter';
import type { CallLog } from '../muse/callLog';
import { RequestCancelledError } from '../muse/cancellation';
import { SMOOTH_VISUAL_CCS } from './control';
import { WONDER_MAX_TOKENS, WONDER_TIMEOUT_MS } from './drive';
import type { TargetStore } from './targets';
import type { Target } from './types';
import { templateWiring, type ActionBrief, type WireDraftData } from './wire-fixture';
import { dryRun, issueLines, resolveNeeds, validateWiring, WIRE_MAX_BYTES, type DryRunResult, type WireCheck, type WireIssue, type WireNeed } from './wire-check';

export const WIRE_EFFORT = 'low' as const;
/** The whole WIRE model phase (all attempts) is bounded: past this the labelled template stands in. */
export const WIRE_BUDGET_MS = Number(process.env.CE_WIRE_TIMEOUT_MS) > 0 ? Number(process.env.CE_WIRE_TIMEOUT_MS) : 90_000;
const SPARK_TIMEOUT_MS = 50_000;
/** Visual synth parameters that change the whole picture's light or colour: they keep the dials' photosensitivity cap. */
const FLICKER_PARAMETERS = new Set(['brightness', 'hue', 'saturation', 'symmetry']);

/** What Muse returns (json_schema). Keys stream out alphabetically, so `code` arrives first. */
export const WireDraft = z.object({
  title: z.string().min(1).max(60),
  explanation: z.string().min(1).max(200),
  code: z.string().min(1).max(WIRE_MAX_BYTES),
  needs: z.array(z.enum(['right', 'left', 'screen'])).max(3),
});

// --- the prompt -------------------------------------------------------------------------------------------------

/** The Signals API, verbatim from research/36-muse-wiring-contract.md. */
export const SIGNALS_API = `interface Signals {
  t: number;                 // seconds since armed
  dt: number;
  right: HandSignals | null; left: HandSignals | null;   // null while not tracked
  screen: ScreenSignals | null;                          // null unless a calibrated screen device is selected
}
interface HandSignals {
  height: number;            // 0..1, palm height in the comfortable play zone (chest→above the head)
  push: number;              // 0..1, palm forward distance from the body (pulled in→arm extended)
  side: number;              // 0..1, left→right across the body
  pinch: number;             // 0..1, thumb–index closeness
  pinchTap: boolean;         // true for one frame on a quick pinch+release (<350 ms, little motion)
  fist: boolean; open: boolean; palmOut: boolean;
  speed: number;             // m/s of the palm
}
interface ScreenSignals {     // the index fingertip nearest the calibrated screen of the selected device
  u: number; v: number;      // 0..1 on the screen (0,0 = top-left); clamped, valid when inside
  inside: boolean;
  distance: number;          // metres from the screen plane (≥0 in front)
  touching: boolean;         // distance < 0.02 and inside
  hover: number;             // 0..1, 1 at contact, 0 at ≥15 cm
  vu: number; vv: number;    // screen-space finger velocity per second
  hand: 'left' | 'right';
}`;

export const WIRE_SYSTEM =
  'You write the glue between a wearer\'s hands and a device, live, as a small JavaScript program for a mixed-reality headset. ' +
  'The wearer watches the code appear as you write it, so write readable code with short plain-words comments (one per idea). ' +
  'Answer with one JSON object matching the schema: title (at most 60 characters, what the wearer will recognise), explanation (ONE sentence for the wearer, at most 200 characters: what their hands do now), ' +
  'code (the BODY of function wire(s, out, mem): no function header, no export), needs (the signals the code reads: "right", "left" and/or "screen"). ' +
  'Use only the device actions you are given; never invent one. Keep the program short (under 40 lines). ' +
  'Do exactly what the wearer asked and nothing more: read only the signals the request needs (a hands-as-knobs or ' +
  'mid-air request reads hand signals and never the screen; a touch request reads the screen), drive only the actions ' +
  'that request needs, and make the title name what they asked for.';

export const FORBIDDEN_LIST =
  '`import`, `require`, `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `Function`, `globalThis`, `self`, `postMessage`, `setTimeout`, `setInterval`, `while(true)` / `for(;;)`, `document`, `window`, `this`, `constructor`, `__proto__`, `prototype` ' +
  '(also `Promise`, `async`, `await`, `console`, `process`, `Reflect`, `Proxy`, regular expression literals and property names built from strings)';

export interface WireInput {
  cardId: string;
  deviceName: string;
  request: string;
  driver: Pick<Driver, 'actions' | 'executor' | 'transport'>;
}

/** What each action does, as far as the device's own capability manifest says (the visual synth publishes one). */
export function actionBriefs(driver: Pick<Driver, 'actions' | 'executor'>, manifest = VISUAL_SYNTH_MANIFEST): (ActionBrief & { range?: [number, number] })[] {
  const visual = isVisualSynthPort(driver.executor.port);
  return driver.actions.map((a) => {
    const e = a.encode;
    const control = visual && e.kind === 'midi' && e.msg === 'cc' ? manifest.controls.find((c) => c.cc === e.number) : undefined;
    const program = visual && e.kind === 'midi' && e.msg === 'pc' ? manifest.programs.find((p) => p.program === e.number) : undefined;
    const effect = control?.effect ?? (program ? `shows the ${program.name} pattern: ${program.effect}` : undefined) ?? a.description ?? (a.expect && a.expect.effect !== 'any' ? `expected effect: ${a.expect.effect}` : undefined);
    return { actionId: a.actionId, label: a.label, kind: a.kind, ...(a.range ? { range: [a.range.min, a.range.max] as [number, number], min: a.range.min, max: a.range.max } : {}), ...(effect ? { effect: effect.slice(0, 260) } : {}) };
  });
}

/** Lines of device hints from the capability manifest (the visual synth's touch inputs and what its controls do). */
export function deviceHints(driver: Pick<Driver, 'actions' | 'executor'>, manifest = VISUAL_SYNTH_MANIFEST): string[] {
  if (!isVisualSynthPort(driver.executor.port)) return [];
  const touch = touchControls(manifest.controls);
  const lines = [
    `Device hints from its capability manifest ("${manifest.name}", a silent visual instrument on the Mac screen; CC values 0-127 on channel 1):`,
    ...manifest.controls.filter((c) => driver.actions.some((a) => a.encode.kind === 'midi' && a.encode.msg === 'cc' && a.encode.number === c.cc)).map((c) => `- cc${c.cc} "${c.label}"${touch.includes(c) ? ' [touch input]' : ''}: ${c.effect}`),
  ];
  if (touch.length) {
    if (manifest.touch) lines.push(`How the touch controls work together (from the manifest): ${manifest.touch}`);
    lines.push(
      'Touch recipe: the touch controls follow the wearer\'s fingertip on the Mac screen (s.screen.u / v / touching / hover). The screen signal needs the wearer to calibrate the screen first, so list "screen" in needs when you read it.',
      '- While s.screen is inside: every frame send X and Y (u and v scaled to 0-127) BEFORE pressure; while touching, send X and Y at 20-60 Hz (every frame is fine, the server limits the rate).',
      '- Pressure: 0 = lifted; hovering = 1-20 from s.screen.hover (for example 1 + hover * 19); touching = above 20 (for example 60-127: harder = stronger splash).',
      '- Send pressure 0 once when the finger lifts away, the hand is lost or s.screen is null (use mem to send it only on that edge).',
    );
  }
  return lines;
}

export function wireMessages(input: WireInput, repair?: { previous: string; issues: string[] }): ChatMessage[] {
  const briefs = actionBriefs(input.driver);
  const msgs: ChatMessage[] = [
    { role: 'system', content: WIRE_SYSTEM },
    {
      role: 'user',
      content: [
        `Wearer request: ${input.request.replace(/\s+/g, ' ').trim()}`,
        `Device: ${input.deviceName}.`,
        'Signals the program receives as `s`, every frame at about 60 Hz (read-only):',
        SIGNALS_API,
        `Driver actions (JSON): ${JSON.stringify(briefs.map((b) => ({ actionId: b.actionId, label: b.label, kind: b.kind, ...(b.range ? { range: b.range } : {}), ...(b.effect ? { effect: b.effect } : {}) })))}`,
        ...deviceHints(input.driver),
        'Rules (the server checks all of them and dry-runs the program on recorded hand and screen traces before the wearer can use it):',
        '- `out.set(\'<actionId>\', value)` drives a "set" action: value inside its range (the runtime clamps it and limits the rate to the action\'s rate). `out.trigger(\'<actionId>\')` fires a "trigger" action once. The action id must be a plain string literal from the list above.',
        '- `mem` is a plain object that persists between frames: use it for smoothing, previous values and edge detection.',
        '- `s.right`, `s.left` and `s.screen` can be null: always check them before reading. With no hands the program should do nothing (or put things back to neutral once).',
        '- Map 0..1 signals into each action\'s own range (for example `lo + x * (hi - lo)`), not 0..1.',
        '- Available globals: Math, Number, Boolean, Array, Object, isFinite, isNaN, parseFloat, plus s, out, mem.',
        `- Forbidden: ${FORBIDDEN_LIST}.`,
        `- At most ${WIRE_MAX_BYTES} bytes, under 2 ms per frame, no loops that wait.`,
        'Write readable code with short comments: the wearer reads it as it streams in.',
      ].join('\n'),
    },
  ];
  if (repair) {
    msgs.push({ role: 'assistant', content: repair.previous });
    msgs.push({ role: 'user', content: `The server rejected this program. Fix every issue and return the whole corrected JSON:\n${repair.issues.map((i) => `- ${i}`).join('\n')}` });
  }
  return msgs;
}

// --- streaming helpers --------------------------------------------------------------------------------------------

/** The `code` string decoded so far from a JSON object that is still streaming in ('' until the key appears). */
export function extractCodeSoFar(json: string): string {
  const m = /"code"\s*:\s*"/.exec(json);
  if (!m) return '';
  let out = '';
  let i = m.index + m[0].length;
  while (i < json.length) {
    const c = json[i]!;
    if (c === '"') return out;
    if (c === '\\') {
      const n = json[i + 1];
      if (n === undefined) break;
      if (n === 'u') {
        const hex = json.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'b' ? '\b' : n === 'f' ? '\f' : n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** About `n` pieces at line boundaries whose concatenation is `code` (for models that cannot stream). */
export function chunkCode(code: string, n = 8): string[] {
  if (!code) return [];
  const target = Math.max(1, Math.ceil(code.length / n));
  const out: string[] = [];
  let cur = '';
  for (const line of code.split(/(?<=\n)/)) {
    if (cur && cur.length + line.length > target * 1.4) { out.push(cur); cur = ''; }
    cur += line;
    while (cur.length > target * 1.8) { out.push(cur.slice(0, target)); cur = cur.slice(target); }
  }
  if (cur) out.push(cur);
  return out;
}

// --- the model phase ------------------------------------------------------------------------------------------------

export interface WireDeps {
  spark: MuseChat;
  /** guarded last attempt (live mode only) */
  wonder?: MuseChat;
  /** live Spark with token streaming (omit in fixture mode: the code is replayed in chunks) */
  stream?: { model: string; stream: StreamClient['stream'] };
  callLog?: CallLog;
  log?: (line: string) => void;
  /** pause between replayed chunks */
  chunkDelayMs?: number;
}

type Source = WireProgressPayload['source'];
export type WireEmit = (phase: WireProgressPayload['phase'], extra?: Partial<WireProgressPayload>) => void;

export interface WireWritten {
  ok: boolean;
  title: string;
  explanation: string;
  code: string;
  needs: WireNeed[];
  model: string;
  source: Source;
  latencyMs: number;
  attempts: number;
  /** literal action ids the program uses, plus those it emitted in the dry-run */
  used: string[];
  dry?: DryRunResult;
  check?: WireCheck;
  issues: string[];
}

interface Attempt { client: MuseChat; tag: 'spark' | 'wonder'; maxTokens: number; timeoutMs: number; stream: boolean }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export async function writeWiring(deps: WireDeps, input: WireInput, emit: WireEmit, opts: { signal?: AbortSignal; budgetMs?: number; wiringTag?: string } = {}): Promise<WireWritten> {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  const job = opts.signal;
  const budget = AbortSignal.timeout(opts.budgetMs ?? WIRE_BUDGET_MS);
  const both = job ? AbortSignal.any([job, budget]) : budget;
  const tag = opts.wiringTag ?? input.cardId;
  const attempts: Attempt[] = [
    { client: deps.spark, tag: 'spark', maxTokens: 4000, timeoutMs: SPARK_TIMEOUT_MS, stream: !!deps.stream },
    { client: deps.spark, tag: 'spark', maxTokens: 4000, timeoutMs: SPARK_TIMEOUT_MS, stream: !!deps.stream },
  ];
  if (deps.wonder) attempts.push({ client: deps.wonder, tag: 'wonder', maxTokens: WONDER_MAX_TOKENS, timeoutMs: WONDER_TIMEOUT_MS, stream: false });
  let repair: { previous: string; issues: string[] } | undefined;
  let lastIssues: string[] = [];
  let tries = 0;

  for (const [i, step] of attempts.entries()) {
    if (job?.aborted) throw new RequestCancelledError();
    if (budget.aborted) break;
    // the second attempt only exists to repair the first; Wonder takes whatever is left, with or without issues
    if (i === 1 && !repair) continue;
    tries++;
    const model = step.stream && deps.stream ? deps.stream.model : step.client.model;
    const source: Source = step.client.mode === 'fixture' ? 'fixture' : 'live';
    const t0 = Date.now();
    emit('writing', repair
      ? { code: '', model, source, note: `${i === 1 ? 'repairing' : 'trying again with the other model'}: ${repair.issues[0] ?? ''}`.slice(0, 160), issues: repair.issues.slice(0, 12).map((s) => s.slice(0, 200)) }
      : { model, source, note: `${model} is writing…` });

    // best-effort token streaming: send what has arrived at most every 60 ms
    let sent = 0;
    let lastFlush = 0;
    const flush = (soFar: string, force = false) => {
      if (soFar.length <= sent) return;
      if (!force && Date.now() - lastFlush < 60) return;
      emit('writing', { codeDelta: soFar.slice(sent), model, source });
      sent = soFar.length;
      lastFlush = Date.now();
    };
    let data: z.infer<typeof WireDraft>;
    let resModel = model;
    let resSource = source;
    let recorded: string | undefined;
    try {
      if (step.stream && deps.stream) {
        const messages = wireMessages(input, repair) as StreamMessage[];
        try {
          const res = await deps.stream.stream(
            { model: deps.stream.model, messages, responseFormat: museResponseFormat('wire_program', WireDraft, { description: 'Hand-to-device wiring program' }) as unknown as Record<string, unknown>, reasoningEffort: WIRE_EFFORT, maxTokens: step.maxTokens },
            { onContent: (_delta, soFar) => flush(extractCodeSoFar(soFar)) },
            { signal: both, timeoutMs: step.timeoutMs },
          );
          let parsed: unknown;
          try { parsed = parseModelJson(res.content); } catch { throw new ModelOutputError('wire_program: the model\'s answer is not JSON', res.content, ['(root): not valid JSON']); }
          const v = WireDraft.safeParse(parsed);
          if (!v.success) throw new ModelOutputError('wire_program: the answer does not match the schema', res.content, v.error.issues.slice(0, 8).map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`));
          data = v.data;
          resModel = res.model;
          deps.callLog?.add({ at: t0, label: 'wire_program', model: res.model, source: 'live', ok: true, latencyMs: res.latencyMs, format: 'json_schema', effort: WIRE_EFFORT, finishReason: res.finishReason,
            usage: res.usage ? { promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, totalTokens: res.usage.promptTokens + res.usage.completionTokens, reasoningTokens: res.usage.reasoningTokens, cachedTokens: res.usage.cachedTokens } : undefined });
        } catch (e) {
          // a refused or broken stream still gets one plain (non-streamed) call for this attempt
          if (job?.aborted || budget.aborted || e instanceof ModelOutputError || !(e instanceof ModelCallError)) throw e;
          log(`[wire] ${tag} streaming failed (${e.message.slice(0, 120)}); asking without streaming`);
          const res = await step.client.chatJson(wireMessages(input, repair), WireDraft, { name: 'wire_program', reasoningEffort: WIRE_EFFORT, maxTokens: step.maxTokens, label: 'wire', fixture: `wire_program:a${tries}`, signal: both, timeoutMs: step.timeoutMs });
          data = res.data; resModel = res.recordedFrom ?? res.model; resSource = res.source; recorded = res.recordedFrom;
        }
      } else {
        const res = await step.client.chatJson(wireMessages(input, repair), WireDraft, { name: 'wire_program', description: 'Hand-to-device wiring program', reasoningEffort: WIRE_EFFORT, maxTokens: step.maxTokens, label: 'wire', fixture: `wire_program:a${tries}`, signal: both, timeoutMs: step.timeoutMs });
        data = res.data; resModel = res.recordedFrom ?? res.model; resSource = res.source; recorded = res.recordedFrom;
      }
    } catch (e) {
      if (job?.aborted) throw new RequestCancelledError();
      if (budget.aborted) break;
      if (e instanceof RequestCancelledError) throw e;
      const msg = (e as Error).message.slice(0, 160);
      log(`[wire] ${tag} attempt ${tries} (${step.tag}) failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${msg}`);
      lastIssues = e instanceof ModelOutputError ? e.issues.slice(0, 6) : [`the model call failed: ${msg}`];
      repair = { previous: e instanceof ModelOutputError ? e.text.slice(0, 3000) : '{}', issues: e instanceof ModelOutputError ? [`the answer was not valid JSON for the schema: ${e.issues.slice(0, 5).join('; ')}`] : ['the previous answer did not arrive; answer again with the JSON object'] };
      emit('validating', { model: resModel, source: resSource, issues: lastIssues.map((s) => s.slice(0, 200)), note: 'no usable answer' });
      continue;
    }

    // a model that cannot stream is replayed in chunks so the wearer still watches the code appear
    if (!step.stream || !deps.stream) {
      const chunks = chunkCode(data.code, 8);
      for (const c of chunks) {
        if (job?.aborted) throw new RequestCancelledError();
        emit('writing', { codeDelta: c, model: resModel, source: resSource });
        await sleep(deps.chunkDelayMs ?? 70, job);
      }
    } else flush(data.code, true);

    // validate
    const check = validateWiring(data.code, input.driver);
    const needs = resolveNeeds(data.needs, check.reads);
    emit('validating', { code: data.code, title: data.title, explanation: data.explanation, model: resModel, source: resSource, ...(check.issues.length ? { issues: issueLines(check.issues).map((s) => s.slice(0, 200)) } : {}), note: check.ok ? `valid · ${Buffer.byteLength(data.code)} bytes` : 'the server found problems' });
    const tv = Date.now();
    let dry: DryRunResult | undefined;
    let issues: WireIssue[] = check.issues;
    if (check.ok) {
      emit('dry-run', { model: resModel, source: resSource, note: 'running it on recorded hand and screen traces…' });
      dry = dryRun(data.code, input.driver, needs);
      issues = dry.issues;
      emit('dry-run', { code: data.code, model: resModel, source: resSource, note: dry.note, ...(dry.ok ? {} : { issues: issueLines(dry.issues).map((s) => s.slice(0, 200)) }) });
    }
    log(`[wire] ${tag} attempt ${tries} (${step.tag} ${step.stream ? 'streamed' : 'chunked'}) ${((tv - t0) / 1000).toFixed(1)} s · ${Buffer.byteLength(data.code)} B · validate ${check.ok ? '✓' : '✗'}${dry ? ` · ${dry.note} (${dry.perFrameMs.toFixed(3)} ms/frame, ${Date.now() - tv} ms)` : ''}${recorded ? ` · recorded from ${recorded}` : ''}`);
    if (issues.length === 0 && dry?.ok) {
      const used = [...new Set([...check.used, ...dry.actions])];
      return { ok: true, title: data.title, explanation: data.explanation, code: data.code, needs, model: resModel, source: resSource, latencyMs: Date.now() - started, attempts: tries, used, dry, check, issues: [] };
    }
    lastIssues = issueLines(issues);
    log(`[wire] ${tag} attempt ${tries} rejected: ${lastIssues.join(' | ').slice(0, 400)}`);
    repair = { previous: JSON.stringify(data), issues: lastIssues };
  }

  // Everything failed (or the budget ran out): the labelled template, validated like any other program.
  const briefs = actionBriefs(input.driver);
  const t = templateWiring(briefs, input.request);
  const check = validateWiring(t.code, input.driver);
  const needs = resolveNeeds(t.needs, check.reads);
  const dry = check.ok ? dryRun(t.code, input.driver, needs) : undefined;
  const why = job?.aborted ? 'cancelled' : budget.aborted ? `Muse did not finish within ${Math.round((opts.budgetMs ?? WIRE_BUDGET_MS) / 1000)} s` : lastIssues.join('; ');
  log(`[wire] ${tag} template wiring (no Meta model wrote it) after ${((Date.now() - started) / 1000).toFixed(1)} s: ${why.slice(0, 200)}`);
  if (job?.aborted) throw new RequestCancelledError();
  const issues = [...(check.ok ? [] : issueLines(check.issues)), ...(dry && !dry.ok ? issueLines(dry.issues) : [])];
  const ok = check.ok && !!dry?.ok;
  emit('writing', { code: '', model: 'template', source: 'template', note: `template wiring: no Meta model wrote this (${why})`.slice(0, 160) });
  for (const c of chunkCode(t.code, 8)) { emit('writing', { codeDelta: c, model: 'template', source: 'template' }); await sleep(deps.chunkDelayMs ?? 70, job); }
  emit('validating', { code: t.code, title: t.title, explanation: t.explanation, model: 'template', source: 'template', ...(check.ok ? {} : { issues: issues.slice(0, 12).map((s) => s.slice(0, 200)) }), note: 'template wiring: no Meta model wrote this' });
  if (dry) emit('dry-run', { code: t.code, model: 'template', source: 'template', note: dry.note, ...(dry.ok ? {} : { issues: issues.slice(0, 12).map((s) => s.slice(0, 200)) }) });
  return { ok, title: t.title, explanation: t.explanation, code: t.code, needs, model: 'template', source: 'template', latencyMs: Date.now() - started, attempts: tries, used: dry ? [...new Set([...check.used, ...dry.actions])] : [], dry, check, issues };
}

// --- rate, hack and registry -----------------------------------------------------------------------------------------

/**
 * Per-action send rate (events past it are coalesced, latest wins). The visual synth's smooth geometry (Warp, Ripples, Zoom,
 * Speed) and its fingertip inputs (the manifest's touch controls) follow the hand at 30 Hz; its brightness, colour and symmetry
 * keep the dials' <= 3 Hz (photosensitivity), as do pattern buttons. Physical devices keep their caps (gestures.ts axisCap).
 */
export function wireRateHz(driver: Pick<Driver, 'transport' | 'maxRateHz' | 'executor'>, action: DriverAction): number {
  const e = action.encode;
  const visualCc = isVisualSynthPort(driver.executor.port) && e.kind === 'midi' && e.msg === 'cc' && e.number !== undefined ? e.number : undefined;
  const flicker = visualCc !== undefined && !SMOOTH_VISUAL_CCS.has(visualCc) && VISUAL_SYNTH_MANIFEST.controls.some((c) => c.cc === visualCc && FLICKER_PARAMETERS.has(c.parameter));
  const light = action.expect?.sense === 'camera' && ['on', 'off', 'brighter', 'dimmer', 'warmer', 'cooler'].includes(action.expect.effect);
  const cap = driver.transport === 'ir' || action.encode.kind === 'step' ? 2 : light || flicker ? 3 : driver.transport === 'local' || driver.transport === 'ble' ? 10 : 30;
  const hz = Math.min(30, driver.maxRateHz ?? 30, cap);
  return action.kind === 'set' ? hz : Math.min(3, hz);
}

export function toWireAction(driver: Pick<Driver, 'transport' | 'maxRateHz' | 'executor'>, a: DriverAction): WireAction {
  return { actionId: a.actionId, label: a.label.slice(0, 64), kind: a.kind, ...(a.range ? { min: a.range.min, max: a.range.max } : {}), maxRateHz: wireRateHz(driver, a) };
}

/** The Hack the ControlRouter fires for one wire:<actionId> event (like gestureHack does for gesture:<axis>). */
export function wireHack(widgetId: string, a: DriverAction, hz: number): Hack {
  const set = a.kind === 'set';
  return {
    id: widgetId, name: a.label.slice(0, 24), kind: set ? 'control' : 'action',
    commands: [{ action: a.actionId, ...(set ? { param: widgetId } : {}) }],
    ...(set ? { params: [{ id: widgetId, name: a.label.slice(0, 24), min: a.range?.min ?? 0, max: a.range?.max ?? 1, ...(a.range?.step ? { step: a.range.step } : {}) }], control: { archetype: 'slider' as const, param: widgetId } } : {}),
    max_rate_hz: hz, oracle: { type: 'wire', expect: 'serial_ack' }, status: 'verified',
  } as Hack;
}

interface ActiveWiring { cardId: string; wiringId: string; driverId: string; ready: WireReadyPayload; actions: Map<string, WireAction>; at: number }

export type WireResolve = { target: Target; hack: Hack; driver: Driver } | { reason: string };

export interface WireServiceDeps extends WireDeps {
  hub: Pick<Hub, 'broadcast' | 'sendToDevice'>;
  targets: TargetStore;
  /** Setup as on a pinch when the card has no armed driver; resolves once it has one (or says why not). */
  ensureDriver(cardId: string, from: { deviceId: string; name?: string }, signal: AbortSignal): Promise<{ ok: true; note?: string } | { ok: false; reason: string }>;
  /** The target's driver plus the manifest's touch inputs (added to the target, unverified), for the prompt. */
  prepareDriver(target: Target): Driver;
  /** Verify the actions that have not passed yet; resolves with the ids that failed. */
  verifyActions(target: Target, ids: string[], signal: AbortSignal): Promise<string[]>;
  cardOfSpec(specId: string): string | undefined;
}

export class WireService {
  private readonly jobs = new Map<string, AbortController>();
  private readonly active = new Map<string, ActiveWiring>();
  private readonly log: (line: string) => void;

  constructor(private readonly d: WireServiceDeps) {
    this.log = d.log ?? (() => {});
  }

  /** Cards with a wiring the headset may drive right now. */
  activeCards(): string[] {
    return [...this.active.keys()];
  }

  readyFor(cardId: string): WireReadyPayload | undefined {
    return this.active.get(cardId)?.ready;
  }

  /** wire.request from the headset: fire and forget; progress and the result go out as messages. */
  request(p: WireRequestPayload, from: { deviceId: string; name?: string }): void {
    void this.run(p, from).catch((e) => {
      if (!(e instanceof RequestCancelledError)) this.log(`[wire] ${p.cardId}: ${(e as Error).stack ?? (e as Error).message}`);
    });
  }

  private async run(p: WireRequestPayload, from: { deviceId: string; name?: string }): Promise<void> {
    const { hub, targets } = this.d;
    const cardId = p.cardId;
    this.jobs.get(cardId)?.abort();
    // Asking again withdraws the previous program immediately. A failed new
    // request must not leave the old hand mapping authorized on the server.
    this.active.delete(cardId);
    const abort = new AbortController();
    this.jobs.set(cardId, abort);
    const wiringId = newId('wire-');
    const t0 = Date.now();
    const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s);
    let model: string = this.d.spark.model;
    let source: Source = this.d.spark.mode === 'fixture' ? 'fixture' : 'live';
    const send: WireEmit = (phase, extra = {}) => {
      if (abort.signal.aborted) return;
      model = extra.model ?? model;
      source = extra.source ?? source;
      hub.broadcast('wire.progress', {
        cardId, wiringId, phase, request: clip(p.text, 500), model: clip(model, 64) ?? 'unknown', source,
        ...(extra.codeDelta !== undefined ? { codeDelta: extra.codeDelta.slice(0, 8192) } : {}),
        ...(extra.code !== undefined ? { code: extra.code.slice(0, 8192) } : {}),
        ...(extra.title ? { title: clip(extra.title, 80) } : {}),
        ...(extra.explanation ? { explanation: clip(extra.explanation, 300) } : {}),
        ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
        ...(extra.issues?.length ? { issues: extra.issues.slice(0, 12).map((s) => s.slice(0, 200)) } : {}),
        ...(extra.note ? { note: clip(extra.note, 160) } : {}),
      } satisfies WireProgressPayload);
    };
    const fail = (note: string, issues?: string[]) => {
      this.log(`[wire] ${cardId} failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${note}`);
      send('failed', { note, latencyMs: Date.now() - t0, ...(issues?.length ? { issues } : {}) });
    };
    try {
      this.log(`[wire] ${cardId} request "${p.text.slice(0, 80)}" (${p.source}) from ${from.name ?? from.deviceId}`);
      const target0 = targets.get(cardId);
      send('writing', { note: target0?.driver ? 'Getting ready to write…' : 'Setting the device up first (identify · link · driver)…' });
      const ready = await this.d.ensureDriver(cardId, from, abort.signal);
      if (abort.signal.aborted) return;
      if (!ready.ok) return fail(ready.reason);
      const target = targets.get(cardId);
      if (!target?.driver) return fail('The device has no driver yet. Pinch it, then ask again.');
      this.log(`[wire] ${cardId} driver ready${ready.note ? ` (${ready.note})` : ''} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (ready.note) send('writing', { note: ready.note });
      const driver = this.d.prepareDriver(target);

      const written = await writeWiring(this.d, { cardId, deviceName: target.card?.name ?? cardId, request: p.text, driver }, send, { signal: abort.signal, wiringTag: cardId });
      if (abort.signal.aborted) return;
      if (!written.ok) return fail('Muse could not write a working wiring this time. Ask again, in other words.', written.issues);

      // the actions this program drives must have passed verification on the device
      const used = written.used.map((id) => driver.actions.find((a) => a.actionId === id)).filter((a): a is DriverAction => !!a).slice(0, 16);
      const pending = used.filter((a) => target.verification[a.actionId] !== 'pass').map((a) => a.actionId);
      if (pending.length) {
        const tv = Date.now();
        send('verifying', { code: written.code, model: written.model, source: written.source, note: `checking ${pending.map((id) => used.find((a) => a.actionId === id)?.label ?? id).join(', ')} on the device…` });
        const failed = await this.d.verifyActions(target, pending, abort.signal);
        this.log(`[wire] ${cardId} verify ${pending.join(',')} ${failed.length ? `✗ ${failed.join(',')}` : '✓'} ${((Date.now() - tv) / 1000).toFixed(1)} s`);
        if (abort.signal.aborted) return;
        if (failed.length) return fail(`The device did not confirm ${failed.join(', ')}, so this wiring cannot run.`, failed.map((id) => `${id} was not verified`));
      }
      const current = targets.get(cardId)?.driver;
      if (!current || current.driverId !== driver.driverId) return fail('The device was set up again while Muse was writing. Ask again.');

      const actions = used.map((a) => toWireAction(current, a));
      if (!actions.length) return fail('The wiring drives no verified action.');
      const payload: WireReadyPayload = { cardId, wiringId, code: written.code, title: written.title.slice(0, 80), explanation: written.explanation.slice(0, 300), model: written.model.slice(0, 64), source: written.source, actions, needs: written.needs };
      this.active.set(cardId, { cardId, wiringId, driverId: current.driverId, ready: payload, actions: new Map(actions.map((a) => [a.actionId, a])), at: Date.now() });
      send('ready', { code: written.code, title: payload.title, explanation: payload.explanation, model: written.model, source: written.source, latencyMs: Date.now() - t0, note: `${written.dry?.note ?? 'dry-run ✓'} · ready` });
      hub.broadcast('wire.ready', payload);
      this.log(`[wire] ${cardId} ready ${wiringId} "${written.title}" by ${written.model} (${written.source}) · ${actions.length} action${actions.length === 1 ? '' : 's'} (${actions.map((a) => a.actionId).join(',')}) · needs ${written.needs.join('+') || 'nothing'} · total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      if (e instanceof RequestCancelledError || abort.signal.aborted) return;
      fail(`Something went wrong: ${(e as Error).message}`.slice(0, 160));
      throw e;
    } finally {
      if (this.jobs.get(cardId) === abort) this.jobs.delete(cardId);
    }
  }

  /** The ControlRouter asks this for a "wire:<actionId>" control.event: only actions of the current wire.ready for that card. */
  resolve(ev: Pick<ControlEventPayload, 'widgetId' | 'specId'>): WireResolve {
    const actionId = ev.widgetId.slice('wire:'.length);
    const fromSpec = ev.specId ? this.d.cardOfSpec(ev.specId) : undefined;
    const cardId = fromSpec && this.active.has(fromSpec) ? fromSpec : this.active.size === 1 ? this.active.keys().next().value : undefined;
    const entry = cardId ? this.active.get(cardId) : undefined;
    if (!entry) return { reason: 'no wiring is active: ask Muse to wire your hands first' };
    if (!entry.actions.has(actionId)) return { reason: `"${actionId}" is not part of the current wiring` };
    const target = this.d.targets.get(entry.cardId);
    const driver = target?.driver;
    if (!target || !driver || driver.driverId !== entry.driverId) return { reason: 'the wiring is out of date: ask Muse again' };
    const action = driver.actions.find((a) => a.actionId === actionId);
    if (!action) return { reason: `"${actionId}" is not an action of this device` };
    return { target, driver, hack: wireHack(ev.widgetId, action, wireRateHz(driver, action)) };
  }

  /** Stop, panic, untag, mode change: the program must be asked for again. */
  clear(cardId?: string): void {
    // A first request is not active yet. Include pending jobs so Stop while
    // Muse is writing cannot publish a late ready and restart the interaction.
    for (const id of cardId ? [cardId] : new Set([...this.active.keys(), ...this.jobs.keys()])) {
      this.active.delete(id);
      this.jobs.get(id)?.abort();
      this.jobs.delete(id);
    }
  }

  /** A device that joins late (the companion) sees the current wiring's code. */
  replayTo(deviceId: string): void {
    for (const a of this.active.values()) this.d.hub.sendToDevice(deviceId, 'wire.ready', a.ready);
  }

  close(): void {
    for (const j of this.jobs.values()) j.abort();
    this.jobs.clear();
    this.active.clear();
  }
}

export type { WireDraftData };
