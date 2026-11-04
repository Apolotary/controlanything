/**
 * Server-side validation of a generated Driver before anything executes (SPEC §3.2): schema (done by the
 * caller with zod), allowlists (CC numbers from the stored chart, IR codes from the library or learned
 * frames, no SysEx beyond the identity request, local ops the executor kind supports), ranges, placeholders
 * and rate limits. Every finding carries a path so the model can repair the draft.
 */
import { type ActionEncode, type Driver, type DriverAction, type DriverDraft, type IrCapture, type IrOp, RATE_LIMITS, VALUE_PLACEHOLDER } from '@ce/protocol';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';
import { isVisualSynthPort, misnamedVisual, touchRoleOfCc, VISUAL_SYNTH_NAME } from './visualSynth';
import { fillRaw, sameCode } from './ir';
import { OSMO_LIMITS } from './osmo/om';
import type { IrLibrary } from './profiles';

export interface DriverIssue {
  severity: 'error' | 'warn';
  code: string;
  path: string;
  message: string;
}

export interface ValidationContext {
  /** Selected connection capability, independent of what a generated draft claims. */
  expectedTransport?: Driver['transport'];
  /** CC numbers the chart allows (undefined = no chart: CC actions are refused) */
  allowedCcs?: Set<number>;
  /** MIDI channels allowed (default any) */
  allowedChannels?: Set<number>;
  /** Imported charts authorize a subset of values for each CC, not all 128 values. */
  ccRanges?: Map<number, { min: number; max: number }>;
  midiCcOnly?: boolean;
  irLibrary?: IrLibrary;
  /** learned IR captures (already labelled or not) */
  learned?: IrCapture[];
  /** executor device kind, for the local-op allowlist */
  executorKind?: string;
  /** the device emits visible light: its rate is capped at RATE_LIMITS.lightChangesPerSec */
  emitsLight?: boolean;
  /** visual synth: continuous controls allowed (default 4 for a fresh driver; WIRE adds the manifest's touch inputs on top) */
  visualMaxSets?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: DriverIssue[];
  /** the driver with ops made executor-ready (IR rawUs filled, defaults applied) */
  driver: Driver;
}

const LOCAL_OPS_BY_KIND: Record<string, Set<string>> = {
  mac: new Set(['volume', 'music', 'say', 'screen']),
  iphone: new Set(['torch', 'haptic', 'screen', 'say']),
  devterm: new Set(['print', 'say', 'beep', 'screen']),
  cardputer: new Set(['beep', 'screen']),
  sim: new Set(['volume', 'music', 'say', 'torch', 'haptic', 'print', 'screen', 'beep']),
};

function hasPlaceholder(encode: ActionEncode): boolean {
  if (encode.kind === 'midi') return encode.value === VALUE_PLACEHOLDER;
  if (encode.kind === 'local') return encode.arg === VALUE_PLACEHOLDER;
  if (encode.kind === 'ble') return encode.arg === VALUE_PLACEHOLDER;
  return false;
}

/** "Panasonic:ch1:off" | "lib:panasonic/ch1/off" | "panasonic ch1 off" -> the library candidate's ref, if any. */
export function matchLibraryRef(ref: string | undefined, lib: IrLibrary | undefined): IrLibrary['candidates'][number] | undefined {
  if (!ref || !lib) return undefined;
  const norm = ref.toLowerCase().replace(/^lib:/, '').replace(/[\s:/._-]+/g, '/');
  return lib.candidates.find((c) => c.ref.slice(4).toLowerCase() === norm) ?? lib.candidates.find((c) => `${c.brand}/ch${c.channel}/${c.key}`.toLowerCase() === norm);
}

/**
 * A model may name a code instead of copying its bytes: `ref: "lib:<brand>/ch<n>/<key>"` (library) or
 * `ref: "learned:<id>"` (a captured frame). Fill the op from that source; unknown refs stay as they are and
 * fail the allowlist below.
 */
export function resolveIrRef(op: IrOp, ctx: ValidationContext): IrOp {
  if (op.bytes?.length || op.rawUs?.length) return op;
  const lib = matchLibraryRef(op.ref, ctx.irLibrary);
  if (lib) return { ...lib.op, ref: lib.ref };
  const learnedId = /^learned:(.+)$/.exec(op.ref ?? '')?.[1];
  const learned = learnedId ? ctx.learned?.find((l) => (l as { learnId?: string }).learnId === learnedId) : undefined;
  if (learned) return { kind: 'ir', protocol: learned.protocol && learned.protocol !== 'UNKNOWN' ? learned.protocol : 'RAW', rawUs: learned.rawUs, khz: learned.khz ?? 38, bytes: learned.bytes, unitUs: learned.unitUs, repeats: 0, ref: op.ref };
  return op;
}

function irInAllowlist(op: IrOp, ctx: ValidationContext): { ok: boolean; why?: string } {
  const bytesEqual = (a: number[] | undefined, b: number[] | undefined) => Boolean(a && b && a.length === b.length && a.every((x, i) => x === b[i]));
  for (const d of ctx.irLibrary?.doNotSend ?? []) {
    if (d.bytes.some((b) => bytesEqual(b, op.bytes))) return { ok: false, why: `code is on the do-not-send list (${d.brand}: ${d.what})` };
  }
  if (op.ref?.startsWith('lib:') && ctx.irLibrary) {
    const c = ctx.irLibrary.candidates.find((x) => x.ref === op.ref);
    if (c && c.op.protocol === op.protocol && bytesEqual(c.op.bytes, op.bytes)) return { ok: true };
  }
  if (ctx.irLibrary?.candidates.some((c) => c.op.protocol === op.protocol && bytesEqual(c.op.bytes, op.bytes))) return { ok: true };
  if (ctx.learned?.length) {
    const probe: IrCapture = { rawUs: op.rawUs ?? [1, 1], protocol: op.protocol === 'RAW' ? 'UNKNOWN' : op.protocol, bytes: op.bytes };
    if (ctx.learned.some((l) => sameCode(l, probe))) return { ok: true };
  }
  return { ok: false, why: 'IR code is neither in the stored library nor among the learned frames' };
}

/** Validate a draft (or a full driver) and return an executor-ready copy. */
export function validateDriver(input: DriverDraft | Driver, ids: { driverId: string; executor: Driver['executor'] }, ctx: ValidationContext = {}): ValidationResult {
  const issues: DriverIssue[] = [];
  const err = (code: string, path: string, message: string) => issues.push({ severity: 'error', code, path, message });
  const warn = (code: string, path: string, message: string) => issues.push({ severity: 'warn', code, path, message });
  const visual = isVisualSynthPort(ids.executor.port);
  if (ctx.expectedTransport && input.transport !== ctx.expectedTransport) err('selected_transport_mismatch', 'transport', `The selected device uses ${ctx.expectedTransport}; a ${input.transport} driver cannot replace it`);
  if (visual && input.transport !== 'midi') err('visual_transport', 'transport', 'The visual synth uses MIDI commands');

  const seen = new Set<string>();
  const byId = new Map<string, DriverAction>();
  for (const a of input.actions as DriverAction[]) {
    if (seen.has(a.actionId)) err('duplicate_action', `actions.${a.actionId}`, `actionId "${a.actionId}" appears twice`);
    seen.add(a.actionId);
    byId.set(a.actionId, a);
  }

  const actions: DriverAction[] = [];
  for (const [i, a0] of (input.actions as DriverAction[]).entries()) {
    const path = `actions[${i}]`;
    const a: DriverAction = { ...a0, encode: { ...a0.encode } as ActionEncode };
    const e = a.encode;
    // transport consistency
    const kindOk = e.kind === 'step' || e.kind === input.transport;
    if (!kindOk) err('transport_mismatch', `${path}.encode.kind`, `a ${input.transport} driver cannot send a ${e.kind} op`);
    // placeholders vs kind
    if (a.kind === 'set') {
      if (!a.range) err('missing_range', `${path}.range`, `"set" action ${a.actionId} needs a range`);
      else if (!(a.range.max > a.range.min)) err('bad_range', `${path}.range`, `range max must be greater than min`);
      if (e.kind !== 'step' && !hasPlaceholder(e)) err('missing_placeholder', `${path}.encode`, `"set" action ${a.actionId} must put "${VALUE_PLACEHOLDER}" in its op (value or arg)`);
    } else if (hasPlaceholder(e)) err('unexpected_placeholder', `${path}.encode`, `"${a.kind}" action ${a.actionId} cannot use "${VALUE_PLACEHOLDER}"`);
    if (visual) {
      // The renderer's published manifest is the allowlist; Muse chooses among it (labels, ranges, curves, patterns).
      // Touch X / Touch Y draw nothing while the finger is lifted: the renderer's receipt (ack) is their evidence.
      const fingerAxis = e.kind === 'midi' && e.msg === 'cc' && ['x', 'y'].includes(touchRoleOfCc(e.number) ?? '');
      if (a.expect?.sense !== 'camera' && !(fingerAxis && a.expect?.sense === 'ack')) err('physical_oracle_required', `${path}.expect`, fingerAxis ? 'Touch X and Y are checked by the renderer receipt: expect {"sense":"ack","effect":"any"}' : 'Visual synth actions require camera evidence');
      if (a.expect?.effect !== 'any') err('visual_effect', `${path}.expect.effect`, 'Visual synth actions verify a visible change with effect any');
      if (e.kind !== 'midi' || e.channel !== 1) err('visual_action', `${path}.encode`, 'The visual synth accepts MIDI on channel 1 only');
      else if (e.msg === 'cc') {
        const control = VISUAL_SYNTH_MANIFEST.controls.find((c) => c.cc === e.number);
        if (!control) err('visual_cc', `${path}.encode.number`, `CC ${e.number} is not in the visual synth manifest (${VISUAL_SYNTH_MANIFEST.controls.map((c) => `${c.cc} ${c.label}`).join(', ')})`);
        if (a.kind !== 'set' || e.value !== VALUE_PLACEHOLDER) err('visual_action', `${path}.encode`, `${a.actionId} must be a set action sending its CC with value $value`);
        if (a.range && (a.range.min < 0 || a.range.max > 127 || !Number.isInteger(a.range.min) || !Number.isInteger(a.range.max) || (a.range.step !== undefined && (!Number.isInteger(a.range.step) || a.range.step < 1)))) {
          err('visual_range', `${path}.range`, 'Visual synth CC ranges are integer wire values inside 0-127 with an integer step');
        }
        if (control && misnamedVisual(a.label, control.parameter)) err('visual_label', `${path}.label`, `"${a.label}" names another parameter; CC ${control.cc} is ${control.label}`);
      } else if (e.msg === 'pc') {
        const program = VISUAL_SYNTH_MANIFEST.programs.find((p) => p.program === e.number);
        if (!program || a.kind !== 'trigger') err('visual_program', `${path}.encode`, `Pattern triggers send a manifest program change (${VISUAL_SYNTH_MANIFEST.programs.map((p) => `${p.program} ${p.name}`).join(', ')})`);
        else if (misnamedVisual(a.label, program.name === 'Water' ? 'ripple' : program.name.toLowerCase())) err('visual_label', `${path}.label`, `"${a.label}" names another pattern; program ${program.program} is ${program.name}`);
      } else err('visual_message', `${path}.encode.msg`, 'The visual synth accepts only manifest CCs and program changes (no notes)');
    }
    // per-op allowlists
    if (e.kind === 'midi') {
      if (ctx.midiCcOnly && e.msg !== 'cc') err('midi_message_not_reviewed', `${path}.encode.msg`, 'The reviewed chart permits only its listed CC messages');
      if (ctx.midiCcOnly && (a.expect?.sense !== 'audio' || !['any', 'louder', 'quieter', 'tone-up', 'tone-down'].includes(a.expect.effect))) {
        err('physical_oracle_required', `${path}.expect`, 'Reviewed synth CC controls require an observed audio effect; an acknowledgment is not verification');
      }
      if (ctx.allowedChannels && !ctx.allowedChannels.has(e.channel)) err('channel_not_allowed', `${path}.encode.channel`, `channel ${e.channel} is not allowed for this device`);
      if (e.msg === 'cc') {
        if (e.number === undefined) err('missing_cc', `${path}.encode.number`, 'cc needs a controller number');
        else if (!ctx.allowedCcs) err('no_chart', `${path}.encode.number`, `CC ${e.number} cannot be allowed: no stored chart for this device`);
        else if (!ctx.allowedCcs.has(e.number)) err('cc_not_in_chart', `${path}.encode.number`, `CC ${e.number} is not in the stored chart (allowed: ${[...ctx.allowedCcs].sort((x, y) => x - y).join(', ')})`);
        const range = e.number === undefined ? undefined : ctx.ccRanges?.get(e.number);
        if (range && ((a.range && (a.range.min < range.min || a.range.max > range.max)) || (typeof e.value === 'number' && (e.value < range.min || e.value > range.max)))) {
          err('cc_range_not_reviewed', `${path}.range`, `CC ${e.number} is reviewed only for values ${range.min}-${range.max}`);
        }
        if (e.value === undefined && a.kind !== 'set') err('missing_value', `${path}.encode.value`, 'cc needs a value');
      } else if (e.msg === 'note') {
        if (e.number === undefined) err('missing_note', `${path}.encode.number`, 'note needs a note number');
        if (e.durationMs === 0) warn('note_no_off', `${path}.encode.durationMs`, 'durationMs 0 leaves the note on; panic will release it');
      } else if (e.msg === 'pc') {
        if (e.number === undefined) err('missing_program', `${path}.encode.number`, 'pc needs a program number');
      }
    } else if (e.kind === 'ir') {
      if (a.expect?.sense !== 'camera') err('physical_oracle_required', `${path}.expect.sense`, 'IR actions require camera evidence of the device response');
      let filled: IrOp;
      try {
        filled = fillRaw(resolveIrRef(e, ctx));
      } catch (x) {
        err('ir_unencodable', `${path}.encode`, `${(x as Error).message}; name a library code as ref "lib:<brand>/ch<n>/<key>" or a learned one as "learned:<id>"`);
        filled = e;
      }
      if (filled.rawUs) {
        const frameUs = filled.rawUs.reduce((s, v) => s + v, 0);
        if (frameUs > 500_000) err('ir_frame_too_long', `${path}.encode.rawUs`, `one frame lasts ${Math.round(frameUs / 1000)} ms (> 500 ms)`);
      }
      const allow = irInAllowlist(filled, ctx);
      if (!allow.ok) err('ir_not_allowed', `${path}.encode`, allow.why ?? 'IR code not allowed');
      a.encode = filled;
    } else if (e.kind === 'local') {
      const allowed = ctx.executorKind ? LOCAL_OPS_BY_KIND[ctx.executorKind] : undefined;
      if (allowed && !allowed.has(e.op)) err('local_op_not_supported', `${path}.encode.op`, `a ${ctx.executorKind} cannot do "${e.op}" (supports ${[...allowed].join(', ')})`);
      if (e.op === 'volume' && typeof e.arg === 'number' && (e.arg < 0 || e.arg > 100)) err('bad_volume', `${path}.encode.arg`, 'volume is 0-100');
    } else if (e.kind === 'ble') {
      // the DJI Osmo bridge clamps again at send time; the driver itself must already stay inside the envelope
      if (ctx.executorKind && ctx.executorKind !== 'gimbal') err('ble_executor', `${path}.encode`, `a ${ctx.executorKind} cannot drive a Bluetooth gimbal`);
      const lim = e.op === 'pan' ? OSMO_LIMITS.yaw : e.op === 'tilt' ? OSMO_LIMITS.pitch : undefined;
      if (lim) {
        if (e.arg !== VALUE_PLACEHOLDER && typeof e.arg !== 'number') err('ble_bad_arg', `${path}.encode.arg`, `${e.op} takes degrees or "${VALUE_PLACEHOLDER}"`);
        if (typeof e.arg === 'number' && (e.arg < lim.min || e.arg > lim.max)) err('ble_out_of_range', `${path}.encode.arg`, `${e.op} ${e.arg}° is outside ${lim.min}..${lim.max}°`);
        if (a.kind === 'set' && a.range && (a.range.min < lim.min || a.range.max > lim.max)) err('ble_range', `${path}.range`, `${e.op} range must stay within ${lim.min}..${lim.max}°`);
      } else if (e.op === 'nudge') {
        const n = e.arg && typeof e.arg === 'object' ? e.arg : undefined;
        if (!n || (n.yaw === undefined && n.pitch === undefined)) err('ble_bad_arg', `${path}.encode.arg`, 'nudge takes {"yaw":deg,"pitch":deg}');
        else if (Math.abs(n.yaw ?? 0) > 60 || Math.abs(n.pitch ?? 0) > 30) err('ble_out_of_range', `${path}.encode.arg`, 'a nudge moves at most 60° pan / 30° tilt');
      } else if (e.arg !== undefined && typeof e.arg !== 'object') err('ble_bad_arg', `${path}.encode.arg`, `${e.op} takes no angle`);
      if (a.kind === 'set' && !lim) err('ble_set_needs_axis', `${path}.encode.op`, 'a "set" gimbal action must be pan or tilt');
    } else if (e.kind === 'step') {
      for (const k of ['upActionId', 'downActionId'] as const) {
        const target = byId.get(e[k]);
        if (!target) err('unknown_action_ref', `${path}.encode.${k}`, `${k} "${e[k]}" is not an action of this driver`);
        else if (target.kind !== 'trigger') err('step_needs_triggers', `${path}.encode.${k}`, `${k} must point at a trigger action`);
      }
      if (a.kind !== 'set') err('step_needs_set', `${path}.kind`, 'a step encode belongs to a "set" action');
    }
    if (a.inverseActionId && !byId.has(a.inverseActionId)) err('unknown_inverse', `${path}.inverseActionId`, `inverse "${a.inverseActionId}" is not an action of this driver`);
    if (a.expect && a.expect.sense === 'none' && a.expect.effect !== 'none' && a.expect.effect !== 'any') warn('expect_without_sense', `${path}.expect`, 'an expected effect with sense "none" can never be verified');
    actions.push(a);
  }

  if (visual) {
    // Muse picks the controls; the card has room for up to four continuous controls and three pattern buttons.
    const sets = actions.filter((a) => a.kind === 'set').length, triggers = actions.filter((a) => a.kind === 'trigger').length;
    const maxSets = ctx.visualMaxSets ?? 4;
    if (sets < 1 || sets > maxSets || triggers > 3) err('visual_controls', 'actions', `Use 1-${maxSets} continuous CC controls and at most 3 pattern triggers (got ${sets} and ${triggers})`);
  }

  // rate limits
  const cap = input.transport === 'midi' ? RATE_LIMITS.midiPerSec : input.transport === 'ir' ? RATE_LIMITS.irPerSec : input.transport === 'ble' ? OSMO_LIMITS.maxRateHz : RATE_LIMITS.lightChangesPerSec;
  const lightCap = ctx.emitsLight ? RATE_LIMITS.lightChangesPerSec : cap;
  let maxRateHz = input.maxRateHz ?? Math.min(cap, lightCap);
  if (maxRateHz > Math.min(cap, lightCap)) {
    warn('rate_clamped', 'maxRateHz', `maxRateHz ${maxRateHz} clamped to ${Math.min(cap, lightCap)} for a ${input.transport} driver${ctx.emitsLight ? ' that changes visible light' : ''}`);
    maxRateHz = Math.min(cap, lightCap);
  }

  const driver: Driver = {
    driverId: ids.driverId,
    cardId: input.cardId,
    name: visual ? VISUAL_SYNTH_NAME : input.name,
    transport: input.transport,
    executor: ids.executor,
    provenance: input.provenance,
    actions,
    maxRateHz,
    notes: input.notes,
    modelId: (input as Driver).modelId,
    source: (input as Driver).source,
    version: (input as Driver).version ?? 1,
  };
  return { ok: !issues.some((i) => i.severity === 'error'), issues, driver };
}

/** One-line summary for logs and the repair prompt. */
export function formatIssues(issues: DriverIssue[]): string {
  return issues.map((i) => `${i.severity}: ${i.path}: ${i.message} [${i.code}]`).join('\n');
}
