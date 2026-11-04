/**
 * DRIVE: a Meta model writes the declarative Driver (json_schema DriverDraft) from the research brief; the
 * server validates it against the allowlists and feeds the issues back for repairs. Model order (measured in
 * research/12: Spark json_schema at low effort was valid 10/10, Wonder json_schema looped on whitespace 3/7):
 * Spark low -> Spark medium (repair) -> Wonder low behind a length guard, then a curated template as the last
 * resort so the loop keeps going (clearly labelled: no Meta model wrote it). Nothing executes until VERIFY.
 */
import { type Driver, DriverDraft, newId } from '@ce/protocol';
import { isVisualSynthPort, visualExpect, visualSynthDraft, VISUAL_SYNTH_ID } from '../devices/visualSynth';
import { musicalSynthDraft, MUSICAL_SYNTH_MANIFEST } from '../devices/musicalSynth';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';
import { osmoDraft, templateBleDraft } from '../devices/osmo/driver';
import { resolveOp } from '../devices/encode';
import type { LearnedCode } from './types';
import type { MidiProfile } from '../devices/profiles';
import { formatIssues, validateDriver, type ValidationContext, type ValidationResult } from '../devices/validate';
import { type ChatMessage, ModelCallError, ModelOutputError, type MuseChat } from '../muse/adapter';
import type { DeviceCardPayload } from '@ce/protocol';
import type { Research } from './types';
import { throwIfCancelled } from '../muse/cancellation';

export const WONDER_MODEL = 'muse-wonder-1.0';
export const DRIVE_EFFORT = 'low' as const;
/** Wonder gets a tight budget: a whitespace loop burns tokens until max_completion_tokens, which this caps. */
export const WONDER_MAX_TOKENS = 4000;
export const WONDER_TIMEOUT_MS = 60_000;

export const DRIVE_SYSTEM =
  'You write a DECLARATIVE driver (data, never code) for one physical device, as JSON matching the given schema. ' +
  'Rules: use only CC numbers, IR codes and local ops that appear in the research brief; MIDI values are 0-127 and "set" actions put "$value" in the op; ' +
  'every action has a short label, a kind (set = continuous, trigger = one shot, toggle), an `expect` (what a camera or microphone should observe: camera brighter/dimmer/on/off/warmer/cooler, audio louder/quieter/tone-up/tone-down/any, ack, none) and an inverseActionId where an undo exists. ' +
  'IR codes are named by ref ("lib:<brand>/ch<n>/<key>" from the brief, or "learned:<id>"), never invented; the server fills bytes and timings. ' +
  'For a dimmable light with brighter/dimmer triggers also add one "set" action with range {"min":0,"max":100,"step":10} whose encode is {"kind":"step","upActionId":...,"downActionId":...,"steps":10}. ' +
  'For a synth prefer the parameters the brief marks as best for a demo: 4-8 "set" actions on the most audible CCs plus one note trigger. MIDI CC action ranges are actual wire values (usually 0-127), never normalized UI ranges. Exception: a reviewed CC-only chart permits only its listed CCs, channel and value ranges, with audio effect verification; do not add notes, program changes or other message types. Never send SysEx other than the identity request, never tempo/record/randomize controls. ' +
  'For a silent visual instrument, design the driver from the capability manifest it publishes: choose its most expressive controls yourself, only messages the manifest accepts, no notes, camera verification. ' +
  'provenance: cite the brief\'s sources. Keep it to at most 12 actions.';

export interface DriveResult {
  draft: DriverDraft;
  validation: ValidationResult;
  model: string;
  effort: string;
  latencyMs: number;
  attempts: number;
  source: 'live' | 'fixture';
  recordedFrom?: string;
}

export function driveMessages(card: DeviceCardPayload, research: Research, transport: Driver['transport'], executorKind: string | undefined, repair?: { draft: DriverDraft; issues: string }): ChatMessage[] {
  const visualContract = transport === 'midi' && research.profile?.id === VISUAL_SYNTH_ID
    ? [
      'This is the silent ControlAnything Visual Synth on the paired Mac screen. Its renderer publishes this capability manifest; it accepts nothing else:',
      JSON.stringify(VISUAL_SYNTH_MANIFEST),
      'You are writing the controller the wearer will play hands-free in AR, seen on a screen about two metres away. The wearer asked for two continuous hand controls (hand height, and forward/back push-pull, which they want to make water ripples) plus a few one-tap pattern buttons. Design it:',
      '- 2 to 4 "set" actions on manifest CCs: msg "cc", channel 1, value "$value", a range of wire values inside 0-127 (narrow it when the extremes look bad), step 1, curve linear or s-curve, and a short label in the wearer\'s words. Pick the parameters that change the picture most visibly.',
      '- up to 3 "trigger" actions on manifest programs: msg "pc", channel 1, number = program, labelled with what appears; inverseActionId may name the trigger that restores the default look.',
      '- actionId is cc<number> for a CC and pattern<program> for a program change. expect is {"sense":"camera","effect":"any"} for every action, except the manifest\'s Touch X and Touch Y (nothing is drawn while the finger is lifted): those take {"sense":"ack","effect":"any"} (the server also sets this). The touch controls are not needed in this driver (a later step adds them when the wearer asks to touch the water). No notes, no other channels, no CCs or programs outside the manifest.',
    ].join('\n') : transport === 'midi' && research.profile?.id === MUSICAL_SYNTH_MANIFEST.id
    ? [
      'This is ControlAnything Synth, an authored browser software instrument. Its capability manifest is the entire message allowlist:',
      JSON.stringify(MUSICAL_SYNTH_MANIFEST),
      'Write declarative capabilities only; a later explicit wearer request asks Muse to write the gesture glue live. No gestures are pre-wired here.',
      'Include CC16 Scale note (integer range 0..14) and CC17 Note gate (0..127, 0 always releases), plus the five filter/envelope/delay controls and up to three preset triggers. No native note triggers or SysEx. Channel 1 only.',
      'Each CC is a set action, value $value, actionId cc<number>, with the exact manifest range and integer step 1. Presets are triggers, actionId preset<program>. Every expectation is audio / any: the browser supplies actual software analyser evidence, never a physical microphone claim.',
      'The Mac must explicitly unlock Sound on before setup or verification; your driver cannot unlock it. The engine caps a held note at eight seconds; release then play again to retrigger.',
    ].join('\n') : transport === 'ble'
    ? [
      'This is a DJI Osmo Mobile gimbal behind the server\'s Osmo bridge. Keep these five actions and their actionIds, kinds, encodes and ranges; you may only improve labels and descriptions. Ranges are degrees inside the brief\'s safe range; never add speed or roll actions.',
      `Required gimbal actions: ${JSON.stringify(osmoDraft(card.cardId, []).actions)}`,
    ].join('\n') : '';
  const msgs: ChatMessage[] = [
    { role: 'system', content: DRIVE_SYSTEM },
    {
      role: 'user',
      content: [
        `Device: ${card.name} (${card.maker} ${card.model}, category ${card.category}, confidence ${card.confidence}). cardId "${card.cardId}". Transport: ${transport}${executorKind ? ` via a ${executorKind}` : ''}.`,
        card.notes ? `Notes: ${card.notes}` : '',
        'Research brief:',
        research.brief,
        visualContract,
        `Write the DriverDraft JSON (cardId "${card.cardId}", transport "${transport}").`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  if (repair) {
    msgs.push({ role: 'assistant', content: JSON.stringify(repair.draft) });
    msgs.push({ role: 'user', content: `The server rejected this driver. Fix every issue and return the whole corrected DriverDraft JSON:\n${repair.issues}` });
  }
  return msgs;
}

export interface DriveDeps {
  /** chat client for Muse Spark (first and second attempt) */
  spark: MuseChat;
  /** chat client for Muse Wonder (guarded last attempt); omit to skip it */
  wonder?: MuseChat;
  log?: (line: string) => void;
}

export interface DriveAttempt {
  attempt: number;
  model: string;
  effort: string;
  ok: boolean;
  issues: string;
  latencyMs: number;
  /** the model call itself failed (timeout, whitespace loop, non-JSON) */
  error?: string;
}

/** Model sequence: Spark low, Spark medium repair, Wonder low (guarded). */
function plan(deps: DriveDeps, maxAttempts: number): { client: MuseChat; effort: 'minimal' | 'low' | 'medium'; maxTokens: number; timeoutMs: number; tag: string }[] {
  const steps = [
    { client: deps.spark, effort: 'low' as const, maxTokens: 6000, timeoutMs: 120_000, tag: 'spark' },
    { client: deps.spark, effort: 'medium' as const, maxTokens: 6000, timeoutMs: 120_000, tag: 'spark' },
  ];
  if (deps.wonder) steps.push({ client: deps.wonder, effort: 'low' as const, maxTokens: WONDER_MAX_TOKENS, timeoutMs: WONDER_TIMEOUT_MS, tag: 'wonder' });
  return steps.slice(0, maxAttempts);
}

export async function drive(
  deps: DriveDeps,
  card: DeviceCardPayload,
  research: Research,
  transport: Driver['transport'],
  ids: { driverId: string; executor: Driver['executor']; executorKind?: string },
  vctx: ValidationContext,
  opts: { signal?: AbortSignal; maxAttempts?: number; onAttempt?: (info: DriveAttempt) => void; firstEffort?: 'minimal' | 'low' | 'medium' } = {},
): Promise<DriveResult | undefined> {
  const started = Date.now();
  let repair: { draft: DriverDraft; issues: string } | undefined;
  let last: DriveResult | undefined;
  const steps = plan(deps, opts.maxAttempts ?? 3);
  // The visual synth's driver is small: the lowest effort that stays valid answers fastest; a repair goes up to low.
  if (opts.firstEffort && steps[0]) steps[0] = { ...steps[0], effort: opts.firstEffort };
  if (opts.firstEffort === 'minimal' && steps[1]) steps[1] = { ...steps[1], effort: 'low' };
  const visual = isVisualSynthPort(ids.executor.port);
  for (const [i, step] of steps.entries()) {
    throwIfCancelled(opts.signal);
    const attempt = i + 1;
    const t0 = Date.now();
    let res: Awaited<ReturnType<MuseChat['chatJson']>> & { data: DriverDraft };
    try {
      res = await step.client.chatJson(driveMessages(card, research, transport, ids.executorKind, repair), DriverDraft, {
        name: 'driver_draft',
        description: 'Declarative device driver (SPEC §3.2)',
        reasoningEffort: step.effort,
        maxTokens: step.maxTokens,
        label: `drive:${transport}`,
        // recordings per transport, chart and attempt ("driver_draft:midi:op-1-field:a1"), so a replay repeats the real
        // session's repairs; the generic fixture is the fallback
        fixture: `driver_draft:${transport}:${research.profile?.id ?? (research.learned?.length ? 'learned' : 'library')}:a${attempt}`,
        signal: opts.signal,
        timeoutMs: step.timeoutMs,
      });
    } catch (e) {
      throwIfCancelled(opts.signal);
      if (!(e instanceof ModelOutputError) && !(e instanceof ModelCallError)) throw e;
      const error = (e as Error).message.slice(0, 200);
      deps.log?.(`[drive] attempt ${attempt} (${step.tag} ${step.effort}) failed: ${error}`);
      opts.onAttempt?.({ attempt, model: step.client.model, effort: step.effort, ok: false, issues: '', latencyMs: Date.now() - t0, error });
      if (e instanceof ModelOutputError && repair === undefined) repair = { draft: { cardId: card.cardId, transport, provenance: [], actions: [] } as DriverDraft, issues: `the previous answer was not valid JSON for the schema: ${e.issues.slice(0, 5).join('; ')}` };
      continue;
    }
    throwIfCancelled(opts.signal);
    const draft = visual ? visualPostProcess(postProcess(res.data, card.cardId, transport)) : postProcess(res.data, card.cardId, transport);
    const validation = validateDriver(draft, ids, { ...vctx, expectedTransport: transport });
    const model = res.recordedFrom ?? res.model;
    last = { draft, validation, model, effort: step.effort, latencyMs: Date.now() - started, attempts: attempt, source: res.source, recordedFrom: res.recordedFrom };
    opts.onAttempt?.({ attempt, model, effort: step.effort, ok: validation.ok, issues: formatIssues(validation.issues), latencyMs: Date.now() - t0 });
    if (validation.ok) return last;
    repair = { draft, issues: formatIssues(validation.issues.filter((x) => x.severity === 'error')) };
    deps.log?.(`[drive] attempt ${attempt} rejected:\n${repair.issues}`);
  }
  return last;
}

/**
 * The visual synth's ids and oracle are the server's: ids follow the wire message (cc<number>, pattern<program>) so
 * gestures, receipts and history line up; every action is checked by the headset camera / renderer receipt.
 * Muse's choices (which controls, labels, ranges, curves, patterns, undo) are kept as written.
 */
export function visualPostProcess(draft: DriverDraft): DriverDraft {
  const rename = new Map<string, string>();
  const actions = draft.actions.map((a) => {
    const e = a.encode;
    const id = e.kind === 'midi' && e.number !== undefined ? (e.msg === 'cc' ? `cc${e.number}` : e.msg === 'pc' ? `pattern${e.number}` : a.actionId) : a.actionId;
    rename.set(a.actionId, id);
    return { ...a, actionId: id, expect: e.kind === 'midi' && e.msg === 'cc' ? visualExpect(e.number) : { sense: 'camera' as const, effect: 'any' as const } };
  });
  return { ...draft, actions: actions.map((a) => (a.inverseActionId ? { ...a, inverseActionId: rename.get(a.inverseActionId) ?? a.inverseActionId } : a)) };
}

/** Server-side normalisation of a model draft: ids present, cardId/transport forced, a step action when brighter/dimmer pairs exist. */
export function postProcess(draft: DriverDraft, cardId: string, transport: Driver['transport']): DriverDraft {
  const out: DriverDraft = {
    ...draft,
    cardId,
    transport,
    actions: draft.actions.map((a) => ({
      ...a,
      actionId: a.actionId || newId('a'),
      // obvious ranges the model may leave out: a step composite is 0-100 %, a MIDI value 0-127, a volume 0-100
      range:
        a.range ??
        (a.kind !== 'set'
          ? undefined
          : a.encode.kind === 'step'
            ? { min: 0, max: 100, step: Math.round(100 / Math.max(1, a.encode.steps - 1)) }
            : a.encode.kind === 'midi'
              ? { min: 0, max: 127, step: 1 }
              : a.encode.kind === 'local' && a.encode.op === 'volume'
                ? { min: 0, max: 100, step: 5 }
                : a.encode.kind === 'local'
                  ? { min: 0, max: 1 }
                  : undefined),
    })),
  };
  if (transport === 'ir' && !out.actions.some((a) => a.encode.kind === 'step')) {
    const up = out.actions.find((a) => a.kind === 'trigger' && /bright|up/i.test(`${a.actionId} ${a.label}`) && !/dim|down|full/i.test(a.label));
    const down = out.actions.find((a) => a.kind === 'trigger' && /dim|dark|down/i.test(`${a.actionId} ${a.label}`) && !/bright|full/i.test(a.label));
    if (up && down) {
      out.actions.push({ actionId: 'level', label: 'Brightness', kind: 'set', range: { min: 0, max: 100, step: 10 }, encode: { kind: 'step', upActionId: up.actionId, downActionId: down.actionId, steps: 10, settleMs: 500 }, expect: { sense: 'camera', effect: 'any' } });
    }
  }
  return out;
}

// --- curated templates (FIXTURE fallback + the deterministic baseline the model is compared against) ------

export function templateMidiDraft(card: DeviceCardPayload, profile: MidiProfile, research: Research): DriverDraft {
  if (profile.id === MUSICAL_SYNTH_MANIFEST.id) return musicalSynthDraft(card.cardId, research.provenance);
  if (profile.id === VISUAL_SYNTH_ID) return visualSynthDraft(card.cardId, research.provenance);
  const best = profile.demo?.bestParameters ?? [];
  const ccs: number[] = [];
  for (const line of best) for (const m of line.matchAll(/CC (\d+)(?:-(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let c = a; c <= Math.min(b, a + 3); c++) if (!ccs.includes(c) && research.allowedCcs?.has(c)) ccs.push(c);
  }
  const picked = ccs.slice(0, 6);
  const channel = profile.reviewedChart?.channel ?? 1;
  const actions: DriverDraft['actions'] = picked.map((cc) => {
    const p = profile.parameters.find((x) => x.cc === cc);
    return { actionId: `cc${cc}`, label: (p?.name ?? `CC ${cc}`).split('/')[0].trim().slice(0, 40), kind: 'set', range: { min: p?.range?.[0] ?? 0, max: p?.range?.[1] ?? 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', channel, number: cc, value: '$value' }, expect: { sense: 'audio', effect: 'any' } };
  });
  if (!profile.reviewedChart) actions.push({ actionId: 'note', label: 'Play a note', kind: 'trigger', encode: { kind: 'midi', msg: 'note', channel: 1, number: 60, velocity: 100, durationMs: 600 }, expect: { sense: 'audio', effect: 'louder' } });
  return { cardId: card.cardId, name: `${card.name} (template)`, transport: 'midi', provenance: research.provenance, actions, notes: 'FIXTURE/template driver built from the stored chart; no Meta model wrote it' };
}

export function templateIrDraft(card: DeviceCardPayload, research: Research): DriverDraft {
  const actions: DriverDraft['actions'] = [];
  const learned = research.learned ?? [];
  if (learned.length) {
    const byHyp = new Map(learned.map((l) => [l.hypothesis, l] as const));
    const add = (l: LearnedCode, id: string, label: string, effect: 'on' | 'off' | 'brighter' | 'dimmer' | 'warmer' | 'cooler' | 'any', inverse?: string) =>
      actions.push({ actionId: id, label, kind: 'trigger', encode: { kind: 'ir', protocol: 'RAW', rawUs: l.rawUs, khz: l.khz ?? 38, ref: `learned:${l.learnId}` }, expect: { sense: 'camera', effect }, inverseActionId: inverse });
    const full = byHyp.get('fullOn');
    const off = byHyp.get('off');
    if (full) add(full, 'full', 'Full on', 'on', off ? 'off' : undefined);
    if (off) add(off, 'off', 'Lights off', 'off', full ? 'full' : undefined);
    const up = byHyp.get('brighter');
    const down = byHyp.get('dimmer');
    if (up) add(up, 'brighter', 'Brighter', 'brighter', down ? 'dimmer' : undefined);
    if (down) add(down, 'dimmer', 'Dimmer', 'dimmer', up ? 'brighter' : undefined);
    const night = byHyp.get('nightLight');
    if (night) add(night, 'night', 'Night light', 'dimmer', full ? 'full' : undefined);
    const warm = byHyp.get('warmer');
    const cool = byHyp.get('cooler');
    if (warm) add(warm, 'warmer', 'Warmer', 'warmer', cool ? 'cooler' : undefined);
    if (cool) add(cool, 'cooler', 'Cooler', 'cooler', warm ? 'warmer' : undefined);
    for (const l of learned.filter((x) => x.hypothesis === 'unknown')) add(l, `learned_${l.learnId}`, l.button.slice(0, 40) || 'Unknown key', 'any');
  } else if (research.irLibrary) {
    // first brand in the search order (Panasonic CH1): VERIFY cycles the other brands when nothing reacts
    const first = research.irLibrary.candidates[0];
    const table = research.irLibrary.candidates.filter((c) => c.brand === first.brand && c.channel === first.channel);
    const labels: Record<string, [string, 'on' | 'off' | 'brighter' | 'dimmer' | 'warmer' | 'cooler', string | undefined]> = {
      off: ['Lights off', 'off', 'fullOn'],
      fullOn: ['Full on', 'on', 'off'],
      brighter: ['Brighter', 'brighter', 'dimmer'],
      dimmer: ['Dimmer', 'dimmer', 'brighter'],
      nightLight: ['Night light', 'dimmer', 'fullOn'],
      warmer: ['Warmer', 'warmer', 'cooler'],
      cooler: ['Cooler', 'cooler', 'warmer'],
    };
    for (const c of table) {
      const l = labels[c.key];
      if (!l) continue;
      actions.push({ actionId: c.key, label: l[0], kind: 'trigger', encode: { ...c.op }, expect: { sense: 'camera', effect: l[1] }, inverseActionId: l[2] && table.some((t) => t.key === l[2]) ? l[2] : undefined });
    }
  }
  const draft: DriverDraft = { cardId: card.cardId, name: `${card.name} (template)`, transport: 'ir', provenance: research.provenance, actions: actions.length ? actions : [{ actionId: 'off', label: 'Lights off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', address: 0x6d82, command: 0xbe }, expect: { sense: 'camera', effect: 'off' } }], notes: 'FIXTURE/template driver built from the stored IR library or learned codes; no Meta model wrote it' };
  return postProcess(draft, card.cardId, 'ir');
}

export function templateLocalDraft(card: DeviceCardPayload, research: Research, executorKind = 'mac'): DriverDraft {
  const actions: DriverDraft['actions'] =
    executorKind === 'iphone'
      ? [
          { actionId: 'torch', label: 'Torch', kind: 'toggle', encode: { kind: 'local', op: 'torch', arg: true }, expect: { sense: 'camera', effect: 'brighter' } },
          { actionId: 'haptic', label: 'Buzz', kind: 'trigger', encode: { kind: 'local', op: 'haptic', arg: 'heavy' }, expect: { sense: 'ack', effect: 'any' } },
        ]
      : executorKind === 'devterm'
        ? [
            { actionId: 'print', label: 'Print receipt', kind: 'trigger', encode: { kind: 'local', op: 'print', arg: { title: 'CONTROLANYTHING', lines: ['link verified'] } }, expect: { sense: 'ack', effect: 'any' } },
            { actionId: 'beep', label: 'Beep', kind: 'trigger', encode: { kind: 'local', op: 'beep', arg: 880 }, expect: { sense: 'audio', effect: 'louder' } },
          ]
        : [
            { actionId: 'volume', label: 'Volume', kind: 'set', range: { min: 0, max: 100, step: 5 }, encode: { kind: 'local', op: 'volume', arg: '$value' }, expect: { sense: 'ack', effect: 'any' } },
            { actionId: 'playpause', label: 'Play / pause', kind: 'toggle', encode: { kind: 'local', op: 'music', arg: 'playpause' }, expect: { sense: 'audio', effect: 'any' } },
            { actionId: 'say', label: 'Say hello', kind: 'trigger', encode: { kind: 'local', op: 'say', arg: 'Control everything is online.' }, expect: { sense: 'audio', effect: 'louder' } },
          ];
  return { cardId: card.cardId, name: `${card.name} (template)`, transport: 'local', provenance: research.provenance, actions, notes: 'FIXTURE/template driver for a local executor; no Meta model wrote it' };
}

/** A FIXTURE answer for chatJson("driver_draft") built from the prompt text (so fixture mode runs the whole loop). */
export function fixtureDriverDraft(messages: ChatMessage[]): DriverDraft {
  const text = messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '))).join('\n');
  const cardId = /cardId "([^"]+)"/.exec(text)?.[1] ?? 'card';
  const transport = (/Transport: (midi|ir|local|ble)/.exec(text)?.[1] ?? 'midi') as Driver['transport'];
  const executorKind = /via a (\w+)/.exec(text)?.[1];
  const card: DeviceCardPayload = { cardId, name: 'FIXTURE device', maker: 'unknown', model: 'unknown', category: transport === 'midi' ? 'synthesizer' : transport === 'ir' ? 'lighting' : 'computer', confidence: 0.5, protocols: [transport === 'local' ? 'other' : transport], evidence: [] };
  const research: Research = { brief: text, provenance: [{ source: 'fixture', ref: 'fixture:driver_draft' }] };
  if (transport === 'midi' && text.includes('ControlAnything Synth')) return musicalSynthDraft(cardId, research.provenance);
  if (transport === 'midi' && text.includes('ControlAnything Visual Synth')) return visualSynthDraft(cardId, research.provenance);
  if (transport === 'ble') return { ...osmoDraft(cardId, research.provenance), name: 'FIXTURE gimbal driver', notes: 'FIXTURE: canned driver, no Meta model was called' };
  if (transport === 'midi') {
    // CCs mentioned in the brief's chart lines "  46: ..." -> allowed set
    const ccs = [...text.matchAll(/^\s+(\d+): /gm)].map((m) => Number(m[1]));
    const best = [...text.matchAll(/CC (\d+)-(\d+)/g)].flatMap((m) => Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i)).filter((c) => ccs.includes(c));
    const pick = (best.length ? best : ccs).slice(0, 4);
    const actions: DriverDraft['actions'] = pick.map((cc) => ({ actionId: `cc${cc}`, label: `CC ${cc}`, kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: cc, value: '$value' }, expect: { sense: 'audio', effect: 'any' } }));
    actions.push({ actionId: 'note', label: 'Play a note', kind: 'trigger', encode: { kind: 'midi', msg: 'note', channel: 1, number: 60, velocity: 100, durationMs: 600 }, expect: { sense: 'audio', effect: 'louder' } });
    return { cardId, name: 'FIXTURE MIDI driver', transport, provenance: research.provenance, actions, notes: 'FIXTURE: canned driver, no Meta model was called' };
  }
  if (transport === 'ir') {
    const learned: LearnedCode[] = [...text.matchAll(/learned:([A-Za-z0-9_-]+): button "([^"]*)" \(hypothesis (\w+)/g)].map((m) => ({ learnId: m[1], button: m[2], hypothesis: m[3] as LearnedCode['hypothesis'], rawUs: [9000, 4500, 560, 560], capturedAt: 0 }));
    const r: Research = { ...research, learned: learned.length ? learned : undefined };
    if (learned.length) {
      // name each learned code by ref; the server fills the timings from the real captures
      const t = templateIrDraft(card, r);
      return {
        ...t,
        name: 'FIXTURE IR driver (learned codes)',
        notes: 'FIXTURE: canned driver from learned codes, no Meta model was called',
        actions: t.actions.map((a) => (a.encode.kind === 'ir' && a.encode.ref?.startsWith('learned:') ? { ...a, encode: { kind: 'ir' as const, protocol: 'RAW' as const, ref: a.encode.ref } } : a)),
      };
    }
    if (!learned.length) {
      // the fixture knows the Panasonic CH1 table (the first library entry)
      const table: [string, string, number[], 'on' | 'off' | 'brighter' | 'dimmer' | 'warmer' | 'cooler', string | undefined][] = [
        ['off', 'Lights off', [0x2c, 0x52, 0x09, 0x2f, 0x26], 'off', 'fullOn'],
        ['fullOn', 'Full on', [0x2c, 0x52, 0x09, 0x2c, 0x25], 'on', 'off'],
        ['brighter', 'Brighter', [0x2c, 0x52, 0x09, 0x2a, 0x23], 'brighter', 'dimmer'],
        ['dimmer', 'Dimmer', [0x2c, 0x52, 0x09, 0x2b, 0x22], 'dimmer', 'brighter'],
        ['warmer', 'Warmer', [0x2c, 0x52, 0x39, 0x91, 0xa8], 'warmer', 'cooler'],
        ['cooler', 'Cooler', [0x2c, 0x52, 0x39, 0x90, 0xa9], 'cooler', 'warmer'],
      ];
      return postProcess(
        { cardId, name: 'FIXTURE IR driver', transport, provenance: research.provenance, actions: table.map(([id, label, bytes, effect, inv]) => ({ actionId: id, label, kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes, unitUs: 432, repeats: 1, frameGapUs: 75_000, ref: `lib:panasonic/ch1/${id}` }, expect: { sense: 'camera', effect }, inverseActionId: inv })), notes: 'FIXTURE: canned driver, no Meta model was called' },
        cardId,
        'ir',
      );
    }
    return templateIrDraft(card, r);
  }
  return { ...templateLocalDraft(card, research, executorKind), name: 'FIXTURE local driver', notes: 'FIXTURE: canned driver, no Meta model was called' };
}

export { templateBleDraft };

/** Sanity: every action of a validated driver resolves to an op (or is a step). */
export function dryResolve(driver: Driver): string[] {
  const problems: string[] = [];
  for (const a of driver.actions) {
    if (a.encode.kind === 'step') continue;
    try {
      resolveOp(a, a.kind === 'set' ? (a.range?.min ?? 0) : undefined);
    } catch (e) {
      problems.push(`${a.actionId}: ${(e as Error).message}`);
    }
  }
  return problems;
}
