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
import { type ControlEventPayload, type Driver, type DriverAction, type Hack, museResponseFormat, newId, type WireAction, type WireProgressPayload, type WireReadyPayload, type WireRequestPayload, type WireStopPayload, type WireStoppedPayload } from '@ce/protocol';
import { isMusicalSynthPort, MUSICAL_SYNTH_MANIFEST } from '../devices/musicalSynth';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';
import { isVisualSynthPort, touchControls } from '../devices/visualSynth';
import type { StreamClient, StreamMessage } from '../gen3d/stream';
import type { Hub } from '../hub';
import { type ChatMessage, ModelCallError, ModelOutputError, type MuseChat, parseModelJson } from '../muse/adapter';
import type { CallLog } from '../muse/callLog';
import { RequestCancelledError } from '../muse/cancellation';
import { isDifferentConnectedOp1ControlRequest } from './connected-peripheral';
import { SMOOTH_VISUAL_CCS } from './control';
import { WONDER_MAX_TOKENS, WONDER_TIMEOUT_MS } from './drive';
import type { TargetStore } from './targets';
import type { Target } from './types';
import { templateWiring, type ActionBrief, type WireDraftData } from './wire-fixture';
import { dryRun, issueLines, resolveNeeds, validateWiring, WIRE_MAX_BYTES, type DryRunResult, type WireCheck, type WireIssue, type WireNeed } from './wire-check';

export const WIRE_EFFORT = 'low' as const;
/** Explicit connector-development work, rather than an ordinary gesture request. */
export function isConnectorDevelopmentRequest(text: string): boolean {
  return /\b(?:debug|develop|implement|fix|repair|build|create|write)\b/i.test(text)
    && /\b(?:bridge|connector|driver)\b/i.test(text)
    && /\b(?:usb|midi|op[- ]?1)\b/i.test(text)
    && !/\b(?:explain|what is|how does)\b/i.test(text);
}
/** New runnable glue is generated after this explicit request; repair tasks keep their review lane. */
export function isFreshConnectorRequest(text: string): boolean {
  return isConnectorDevelopmentRequest(text) && (/\b(?:build|create|write|implement|develop)\b/i.test(text) || /from scratch/i.test(text));
}
/** The whole WIRE model phase (all attempts) is bounded: past this the labelled template stands in. */
export const WIRE_BUDGET_MS = Number(process.env.CE_WIRE_TIMEOUT_MS) > 0 ? Number(process.env.CE_WIRE_TIMEOUT_MS) : 90_000;
const SPARK_TIMEOUT_MS = 50_000;
/** Visual synth parameters that change the whole picture's light or colour: they keep the dials' photosensitivity cap. */
const FLICKER_PARAMETERS = new Set(['brightness', 'hue', 'saturation', 'symmetry']);

/** What Muse returns (json_schema). Keys stream out alphabetically, so `code` arrives first. */
export const WireDraft = z.object({
  title: z.string().min(1).max(60),
  explanation: z.string().min(1).max(200),
  code: z.string().min(1).max(WIRE_MAX_BYTES).describe('Only the executable BODY of wire(s,out,mem). Do not include function wire(...), an arrow-function wrapper, exports or Markdown fences. The host calls this body each frame.'),
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

/** Source refers to the saved driver, independently of the new wiring's own source/model. */
export function libraryDriverNote(driver: Pick<Driver, 'modelId' | 'source'>): string {
  const model = driver.modelId?.slice(0, 64) ?? 'unknown';
  const author = model === 'template' ? 'template (no Meta model)' : `model ${model}`;
  return `driver from your library · ${author} · source ${driver.source ?? 'unknown'} · new wiring for this request`;
}

export interface WireInput {
  cardId: string;
  deviceName: string;
  request: string;
  driver: Pick<Driver, 'actions' | 'executor' | 'transport'>;
  /** Selected-object frame, not a claim that a fresh/live camera frame exists. */
  observation?: { jpeg: string; capturedAt: number; width: number; height: number; label?: string };
}

/** What each action does, as far as the device's own capability manifest says (the visual synth publishes one). */
export function actionBriefs(driver: Pick<Driver, 'actions' | 'executor'>, manifest = VISUAL_SYNTH_MANIFEST): (ActionBrief & { range?: [number, number] })[] {
  const visual = isVisualSynthPort(driver.executor.port);
  const musical = isMusicalSynthPort(driver.executor.port);
  return driver.actions.map((a) => {
    const e = a.encode;
    const control = e.kind === 'midi' && e.msg === 'cc' ? (musical ? MUSICAL_SYNTH_MANIFEST.controls : visual ? manifest.controls : []).find((c) => c.cc === e.number) : undefined;
    const program = e.kind === 'midi' && e.msg === 'pc' ? (musical ? MUSICAL_SYNTH_MANIFEST.programs : visual ? manifest.programs : []).find((p) => p.program === e.number) : undefined;
    const effect = control?.effect ?? (program ? `${musical ? 'selects the' : 'shows the'} ${program.name} ${musical ? 'sound preset' : 'pattern'}: ${program.effect}` : undefined) ?? a.description ?? (a.expect && a.expect.effect !== 'any' ? `expected effect: ${a.expect.effect}` : undefined);
    return { actionId: a.actionId, label: a.label, kind: a.kind, ...(a.range ? { range: [a.range.min, a.range.max] as [number, number], min: a.range.min, max: a.range.max } : {}), ...(effect ? { effect: effect.slice(0, 260) } : {}) };
  });
}

/** Lines of device hints from the capability manifest (the visual synth's touch inputs and what its controls do). */
export function deviceHints(driver: Pick<Driver, 'actions' | 'executor'>, manifest = VISUAL_SYNTH_MANIFEST): string[] {
  if (isMusicalSynthPort(driver.executor.port)) return [
    `Device capability manifest: ${JSON.stringify(MUSICAL_SYNTH_MANIFEST)}`,
    'This is the browser software musical instrument, distinct from the visual water instrument or a physical MIDI device. Numeric values are raw wire units, not normalized UI units.',
    'For a request to play notes, use Scale note (CC16, integer 0..14) together with Note gate (CC17, >=64 on, 0 releases). Gate alone is a single fixed pitch, and pitch alone is silent.',
    'Always send Note gate 0 when the controlling hand disappears, or when the requested play gesture ends. Send it on that edge even when no hands remain, using mem if needed.',
    'A held note stops after eight seconds. The wearer must release and play again to retrigger; repeated identical values are not a heartbeat. Make the explanation honest about how to start and release the note.',
    'Sound is audible by default after the browser accepts the first Mac gesture; the shared master volume/mute controls it. Do not invent code that bypasses autoplay, changes physical ports, or claims a sound was heard.',
    'Choose the hand movement and gesture only from what the wearer asked for; the capability catalog does not prescribe a hand mapping.',
  ];
  if (!isVisualSynthPort(driver.executor.port)) return [];
  const touch = touchControls(manifest.controls);
  const lines = [
    `Device hints from its capability manifest ("${manifest.name}", a visual water instrument with procedural sound feedback on the Mac screen; CC values 0-127 on channel 1):`,
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
  /** The normal Mac bridge uses the bounded native Muse tool loop. */
  harness?: { write(input: WireInput, emit: WireEmit, opts?: { signal?: AbortSignal; budgetMs?: number; wiringTag?: string }): Promise<WireWritten> };
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
  if (deps.harness) return deps.harness.write(input, emit, opts);
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

interface ActiveWiring { cardId: string; wiringId: string; driverId: string; ready: WireReadyPayload; actions: Map<string, WireAction>; at: number; agent?: boolean }

/** What the Muse agent (muse-agent.ts) hands back: a running connector plus AR controls and/or a hand program. */
export interface AgentBuilt {
  ok: boolean; title: string; explanation: string; code: string; needs: ('right' | 'left' | 'screen')[];
  actions: WireAction[]; controls: NonNullable<WireReadyPayload['controls']>; model: string; source: 'live' | 'fixture';
  ui?: WireReadyPayload['ui']; visualizer?: WireReadyPayload['visualizer'];
  /** An XR visualization program for the headset (no connector needed when it is the only output). */
  scene?: WireReadyPayload['scene'];
  connector?: { entry: string; pid?: number }; issues: string[];
}

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
  /** Cancel queued commands and release known held outputs without revoking the verified connection. */
  stopOutputs?(target: Target, reason: string): Promise<{ released: boolean; reason?: string }>;
  agentRelease?(cardId: string): Promise<{ released: boolean; reason?: string }>;
  cardOfSpec(specId: string): string | undefined;
  developConnector?(task: string, onProgress: (note: string) => void, signal: AbortSignal): Promise<{ jobId: string; state: string; reason?: string }>;
  buildConnector?(input: WireInput, emit: WireEmit, opts: { signal: AbortSignal; wiringId: string }): Promise<WireWritten>;
  retireConnector?(cardId?: string): void;
  useAuthoredTransport?(cardId: string): void;
  /**
   * The Muse coding agent: when present it handles every ask. It writes and deploys the connector on the Mac and
   * returns the controls; no separate setup, driver or verification ceremony is needed first.
   */
  agentBuild?(cardId: string, request: string, emit: WireEmit, opts: { signal: AbortSignal; wiringId: string; from: { deviceId: string; name?: string } }): Promise<AgentBuilt>;
  /** Forward one control value to the card's running connector. */
  agentSet?(cardId: string, actionId: string, value: number | boolean): { ok: boolean; reason?: string };
}

export class WireService {
  private readonly jobs = new Map<string, AbortController>();
  private readonly active = new Map<string, ActiveWiring>();
  /** The latest explicit requester owns both its pending job and its published program. */
  private readonly owners = new Map<string, string>();
  private readonly epochs = new Map<string, { requestId?: string; wiringId: string }>();
  private readonly log: (line: string) => void;

  constructor(private readonly d: WireServiceDeps) {
    this.log = d.log ?? (() => {});
  }

  /** The headset that asked for this card's current wiring (it receives the card's runtime warnings). */
  ownerOf(cardId: string): string | undefined {
    return this.owners.get(cardId);
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
    const replacing = this.jobs.has(cardId) || this.active.has(cardId);
    this.jobs.get(cardId)?.abort();
    // Asking again withdraws the previous program immediately. A failed new
    // request must not leave the old hand mapping authorized on the server.
    this.active.delete(cardId);
    this.d.retireConnector?.(cardId);
    const abort = new AbortController();
    this.jobs.set(cardId, abort);
    this.owners.set(cardId, from.deviceId);
    const wiringId = newId('wire-');
    this.epochs.set(cardId, { requestId: p.requestId, wiringId });
    const t0 = Date.now();
    const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s);
    let model: string = this.d.spark.model;
    let source: Source = this.d.spark.mode === 'fixture' ? 'fixture' : 'live';
    const send: WireEmit = (phase, extra = {}) => {
      if (abort.signal.aborted) return;
      model = extra.model ?? model;
      source = extra.source ?? source;
      hub.broadcast('wire.progress', {
        cardId, wiringId, ...(p.requestId ? { requestId: p.requestId } : {}), phase, request: clip(p.text, 500), model: clip(model, 64) ?? 'unknown', source,
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
      // Retiring authority must not strand a held note/pressure while the next model call runs.
      if (replacing && target0) await this.d.stopOutputs?.(target0, 'A new wiring was requested');
      if (abort.signal.aborted) return;
      const freshConnector = !this.d.agentBuild && isFreshConnectorRequest(p.text);
      if (freshConnector && !this.d.buildConnector) return fail('Live connector generation is unavailable. No template or old connector was installed.');
      if (!this.d.agentBuild && target0 && this.d.developConnector && isConnectorDevelopmentRequest(p.text) && !freshConnector) {
        send('writing', { title: 'Muse Code · connector development', note: 'Starting a project coding task on the Mac. No hand wiring is being installed.' });
        const job = await this.d.developConnector(p.text, note => send('writing', { title: 'Muse Code · connector development', note }), abort.signal);
        if (abort.signal.aborted) return;
        // A project patch is not a runnable hand program. Keep WIRE closed and
        // direct the wearer to the actual coding receipt/patch on the Mac.
        send('failed', { title: job.state === 'completed_unverified' ? 'Connector patch awaits review' : 'Connector coding stopped',
          note: job.reason ?? 'Open Connector Workshop on the Mac for the patch and checks. No connector changes were applied.',
          explanation: `Coding task ${job.jobId}. No new hand wiring was installed.` });
        return;
      }
      if (!this.d.agentBuild && target0?.card && isDifferentConnectedOp1ControlRequest(p.text, { name: target0.card.name, category: target0.card.category, port: target0.driver?.executor.port })) {
        const hint = 'Select the OP-1 in Annotate. Use Correct device if its label is wrong, then set it up.';
        this.log(`[wire] ${cardId}: connected OP-1 request belongs to a different target; no model called`);
        send('failed', { model: 'not-called', title: 'Choose the OP-1 first', note: `This card is not the connected OP-1. ${hint}`,
          explanation: 'Use Correct device if its label is wrong. This card is not your connected OP-1.',
          issues: ['Select the OP-1 in Annotate, then set it up.'] });
        return;
      }
      if (this.d.agentBuild) {
        send('writing', { note: 'Muse is looking at the device…' });
        const built = await this.d.agentBuild(cardId, p.text, send, { signal: abort.signal, wiringId, from });
        if (abort.signal.aborted) return;
        if (!built.ok) { this.log(`[wire] ${cardId} agent failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${built.issues[0] ?? ''}`); return; }
        const payload: WireReadyPayload = { cardId, wiringId, ...(p.requestId ? { requestId: p.requestId } : {}), code: built.code.slice(0, 8192),
          title: built.title.slice(0, 80), explanation: built.explanation.slice(0, 300), model: built.model.slice(0, 64), source: built.source,
          actions: built.actions.slice(0, 16), needs: built.needs, controls: built.controls.slice(0, 8), ...(built.ui ? { ui: built.ui, visualizer: built.visualizer } : {}), ...(built.connector ? { connector: built.connector } : {}),
          ...(built.scene ? { scene: { title: built.scene.title.slice(0, 80), code: built.scene.code.slice(0, 8192) } } : {}) };
        this.active.set(cardId, { cardId, wiringId, driverId: 'agent', ready: payload, actions: new Map(payload.actions.map((a) => [a.actionId, a])), at: Date.now(), agent: true });
        send('ready', { code: built.code || undefined, title: payload.title, explanation: payload.explanation, model: built.model, source: built.source, latencyMs: Date.now() - t0,
          note: `ready · ${payload.controls?.length ?? 0} control${payload.controls?.length === 1 ? '' : 's'}${built.code ? ' + hand program' : ''}${built.scene ? ' + 3D scene' : ''}` });
        hub.broadcast('wire.ready', payload);
        this.log(`[wire] ${cardId} ready ${wiringId} "${built.title}" by ${built.model} (${built.source}) · agent · ${payload.actions.map((a) => a.actionId).join(',')} · total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return;
      }
      send('writing', { note: target0?.driver ? 'Getting ready to write…' : 'Setting the device up first (identify · link · driver)…' });
      const ready = await this.d.ensureDriver(cardId, from, abort.signal);
      if (abort.signal.aborted) return;
      if (!ready.ok) return fail(ready.reason);
      const target = targets.get(cardId);
      if (!target?.driver) return fail('The device has no driver yet. Pinch it, then ask again.');
      this.log(`[wire] ${cardId} driver ready${ready.note ? ` (${ready.note})` : ''} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (ready.note) send('writing', { note: ready.note });
      const driver = this.d.prepareDriver(target);

      const detection = target.detection;
      const input: WireInput = { cardId, deviceName: target.card?.name ?? cardId, request: p.text, driver,
        ...(detection ? { observation: { jpeg: detection.jpeg, capturedAt: detection.capturedAt, width: detection.width,
          height: detection.height, label: detection.label } } : {}),
      };
      if (!freshConnector) this.d.useAuthoredTransport?.(cardId);
      const written = freshConnector
        ? await this.d.buildConnector!(input, send, { signal: abort.signal, wiringId })
        : await writeWiring(this.d, input, send, { signal: abort.signal, wiringTag: wiringId });
      if (abort.signal.aborted) return;
      if (!written.ok) return fail('Muse could not write a working wiring this time. Ask again, in other words.', written.issues);

      // the actions this program drives must have passed verification on the device
      const used = written.used.map((id) => driver.actions.find((a) => a.actionId === id)).filter((a): a is DriverAction => !!a).slice(0, 16);
      const pending = used.filter((a) => freshConnector || target.verification[a.actionId] !== 'pass').map((a) => a.actionId);
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
      const payload: WireReadyPayload = { cardId, wiringId, ...(p.requestId ? { requestId: p.requestId } : {}), code: written.code, title: written.title.slice(0, 80), explanation: written.explanation.slice(0, 300), model: written.model.slice(0, 64), source: written.source, actions, needs: written.needs };
      this.active.set(cardId, { cardId, wiringId, driverId: current.driverId, ready: payload, actions: new Map(actions.map((a) => [a.actionId, a])), at: Date.now() });
      send('ready', { code: written.code, title: payload.title, explanation: payload.explanation, model: written.model, source: written.source, latencyMs: Date.now() - t0, note: `${written.dry?.note ?? 'dry-run ✓'} · ready` });
      hub.broadcast('wire.ready', payload);
      this.log(`[wire] ${cardId} ready ${wiringId} "${written.title}" by ${written.model} (${written.source}) · ${actions.length} action${actions.length === 1 ? '' : 's'} (${actions.map((a) => a.actionId).join(',')}) · needs ${written.needs.join('+') || 'nothing'} · total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      if (e instanceof RequestCancelledError || abort.signal.aborted) return;
      fail(`Something went wrong: ${(e as Error).message}`.slice(0, 160));
      throw e;
    } finally {
      if (this.jobs.get(cardId) === abort) {
        this.jobs.delete(cardId);
        if (!this.active.has(cardId)) { this.owners.delete(cardId); this.epochs.delete(cardId); this.d.retireConnector?.(cardId); }
      }
    }
  }

  /** The ControlRouter asks this for a "wire:<actionId>" control.event: only actions of the current wire.ready for that card. */
  resolve(ev: Pick<ControlEventPayload, 'widgetId' | 'specId' | 'requestId' | 'wiringId'>): WireResolve {
    const actionId = ev.widgetId.slice('wire:'.length);
    const fromSpec = ev.specId ? this.d.cardOfSpec(ev.specId) : undefined;
    const cardId = fromSpec && this.active.has(fromSpec) ? fromSpec : this.active.size === 1 ? this.active.keys().next().value : undefined;
    const entry = cardId ? this.active.get(cardId) : undefined;
    if (!entry) return { reason: 'no wiring is active: ask Muse to wire your hands first' };
    if (entry.ready.requestId && (ev.requestId !== entry.ready.requestId || ev.wiringId !== entry.wiringId)) return { reason: 'this output belongs to a retired wiring request' };
    if (!entry.actions.has(actionId)) return { reason: `"${actionId}" is not part of the current wiring` };
    const target = this.d.targets.get(entry.cardId);
    const driver = target?.driver;
    if (!target || !driver || driver.driverId !== entry.driverId) return { reason: 'the wiring is out of date: ask Muse again' };
    const action = driver.actions.find((a) => a.actionId === actionId);
    if (!action) return { reason: `"${actionId}" is not an action of this device` };
    return { target, driver, hack: wireHack(ev.widgetId, action, wireRateHz(driver, action)) };
  }

  /**
   * A "wire:<actionId>" control.event for a Muse-agent wiring goes straight to its connector on the Mac.
   * Returns undefined when the event is not for an agent wiring (the ControlRouter handles it).
   */
  routeAgent(ev: Pick<ControlEventPayload, 'widgetId' | 'specId' | 'requestId' | 'wiringId' | 'value'>, fromDeviceId?: string): { ok: boolean; reason?: string } | undefined {
    if (!ev.widgetId.startsWith('wire:')) return undefined;
    const actionId = ev.widgetId.slice('wire:'.length);
    const agentEntries = [...this.active.values()].filter((a) => a.agent);
    if (!agentEntries.length) return undefined;
    const entry = agentEntries.find((a) => a.wiringId === ev.wiringId) ?? (agentEntries.length === 1 && !ev.wiringId ? agentEntries[0] : undefined);
    if (!entry) return this.active.size > agentEntries.length ? undefined : { ok: false, reason: 'this output belongs to a retired wiring request' };
    if (entry.ready.requestId && ev.requestId && ev.requestId !== entry.ready.requestId) return { ok: false, reason: 'this output belongs to a retired wiring request' };
    // Only the device that asked for this wiring may play it (wire.ready is broadcast to every paired device).
    const owner = this.owners.get(entry.cardId);
    if (fromDeviceId && owner && owner !== fromDeviceId) return { ok: false, reason: 'only the device that asked Muse may play this wiring' };
    const action = entry.actions.get(actionId);
    if (!action) return { ok: false, reason: `"${actionId}" is not part of the current wiring` };
    const raw = ev.value;
    const value = typeof raw === 'boolean' ? raw : typeof raw === 'number' ? Math.min(action.max ?? Infinity, Math.max(action.min ?? -Infinity, raw)) : undefined;
    if (value === undefined) return { ok: false, reason: 'unsupported control value' };
    return this.d.agentSet?.(entry.cardId, actionId, value) ?? { ok: false, reason: 'no connector host' };
  }

  /** The card's agent connector exited on its own: retire the wiring and tell its owner, so no dead controls stay up. */
  connectorExited(cardId: string, lastOutput: string): void {
    const entry = this.active.get(cardId);
    if (!entry?.agent) return;
    const owner = this.owners.get(cardId), epoch = this.epochs.get(cardId);
    this.log(`[wire] ${cardId} connector exited while live: ${lastOutput}`);
    this.clear(cardId);
    if (owner && epoch?.requestId) this.d.hub.sendToDevice(owner, 'wire.stopped', {
      cardId, requestId: epoch.requestId, wiringId: epoch.wiringId, ok: true, releaseConfirmed: false,
      reason: `Muse's connector stopped (${lastOutput}). Ask Muse again.`.slice(0, 200),
    } satisfies WireStoppedPayload);
  }

  /** User's both-palms Stop: retire only this epoch, without disarming the selected verified device. */
  async stop(p: WireStopPayload, from: { deviceId: string }): Promise<WireStoppedPayload> {
    const epoch = this.epochs.get(p.cardId);
    const reply = (payload: WireStoppedPayload) => { this.d.hub.sendToDevice(from.deviceId, 'wire.stopped', payload); return payload; };
    if (this.owners.get(p.cardId) !== from.deviceId || !epoch || epoch.requestId !== p.requestId || (p.wiringId && epoch.wiringId !== p.wiringId)) {
      return reply({ cardId: p.cardId, requestId: p.requestId, ...(p.wiringId ? { wiringId: p.wiringId } : {}), ok: false,
        reason: 'That request is no longer the current wiring owned by this headset.' });
    }
    const target = this.d.targets.get(p.cardId);
    const wasAgent = this.active.get(p.cardId)?.agent || (!!this.d.agentBuild && this.jobs.has(p.cardId));
    const executor = wasAgent ? undefined : target?.driver?.executor.deviceId;
    // Synchronous revocation precedes every await: no old event, queued output or late ready keeps authority.
    this.clear(p.cardId);
    let release: { released: boolean; reason?: string } | undefined;
    // An agent connector releases its own notes/touches in onStop when clear() retires it.
    try { if (wasAgent) release = await this.d.agentRelease?.(p.cardId) ?? { released: false, reason: 'Connector stopped. Device release was not confirmed.' }; else if (target) release = await this.d.stopOutputs?.(target, p.reason ?? 'Both palms out'); }
    catch (e) { this.log(`[wire] release ${p.cardId}: ${(e as Error).message}`); release = { released: false }; }
    const payload: WireStoppedPayload = { cardId: p.cardId, requestId: p.requestId, wiringId: epoch.wiringId, ok: true,
      ...(release ? { releaseConfirmed: release.released } : {}),
      reason: (release?.released === false ? release.reason ?? 'Wiring stopped. Device release was not confirmed; use Stop everything if needed.' : 'Wiring stopped. Ask Muse for another wiring.').slice(0, 200) };
    reply(payload);
    if (executor && executor !== from.deviceId) this.d.hub.sendToDevice(executor, 'wire.stopped', payload);
    return payload;
  }

  /** Revoke only the departing requester's current jobs/programs; a newer requester keeps its authority. */
  disconnectOwner(deviceId: string): string[] {
    const cards = [...this.owners].filter(([, owner]) => owner === deviceId).map(([id]) => id);
    for (const cardId of cards) this.clear(cardId);
    return cards;
  }

  /** An executor reconnect never revives a ready or half-written program. Notify its exact requester. */
  disconnectExecutor(executorDeviceId: string): string[] {
    const cards = [...this.epochs.keys()].filter(cardId => this.d.targets.get(cardId)?.driver?.executor.deviceId === executorDeviceId);
    for (const cardId of cards) {
      const epoch = this.epochs.get(cardId), owner = this.owners.get(cardId);
      this.clear(cardId);
      if (owner && epoch?.requestId) this.d.hub.sendToDevice(owner, 'wire.stopped', {
        cardId, requestId: epoch.requestId, wiringId: epoch.wiringId, ok: true, releaseConfirmed: false,
        reason: 'The Mac disconnected. Wiring stopped; reconnect it and ask Muse again.',
      } satisfies WireStoppedPayload);
    }
    return cards;
  }

  /** Stop, panic, untag, mode change: the program must be asked for again. */
  clear(cardId?: string): void {
    this.d.retireConnector?.(cardId);
    // A first request is not active yet. Include pending jobs so Stop while
    // Muse is writing cannot publish a late ready and restart the interaction.
    for (const id of cardId ? [cardId] : new Set([...this.active.keys(), ...this.jobs.keys()])) {
      this.active.delete(id);
      this.owners.delete(id);
      this.epochs.delete(id);
      this.jobs.get(id)?.abort();
      this.jobs.delete(id);
    }
  }

  /** A device that joins late (the companion) sees the current wiring's code. */
  replayTo(deviceId: string): void {
    for (const a of this.active.values()) this.d.hub.sendToDevice(deviceId, 'wire.ready', a.ready);
  }

  close(): void {
    this.d.retireConnector?.();
    for (const j of this.jobs.values()) j.abort();
    this.jobs.clear();
    this.active.clear();
    this.owners.clear();
    this.epochs.clear();
  }
}

export type { WireDraftData };
