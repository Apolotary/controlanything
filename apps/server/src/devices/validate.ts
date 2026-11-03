/**
 * Server-side validation of a generated Driver before anything executes (SPEC §3.2): schema (done by the
 * caller with zod), allowlists (CC numbers from the stored chart, IR codes from the library or learned
 * frames, no SysEx beyond the identity request, local ops the executor kind supports), ranges, placeholders
 * and rate limits. Every finding carries a path so the model can repair the draft.
 */
import { type ActionEncode, type Driver, type DriverAction, type DriverDraft, type IrCapture, type IrOp, RATE_LIMITS, VALUE_PLACEHOLDER } from '@ce/protocol';
import { isVisualSynthPort, VISUAL_SYNTH_NAME } from './visualSynth';
import { fillRaw, sameCode } from './ir';
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
      if (a.expect?.sense !== 'camera') err('physical_oracle_required', `${path}.expect`, 'Visual synth actions require camera evidence');
      if (a.expect?.effect !== 'any') err('visual_effect', `${path}.expect.effect`, 'Visual synth actions verify a visible change with effect any');
      if (a.actionId === 'cc71' || a.actionId === 'cc21') {
        const cc = a.actionId === 'cc71' ? 71 : 21;
        const label = cc === 71 ? 'Warp' : 'Water ripples';
        // This virtual instrument has a fixed semantic contract. A generated
        // label must not make the old Warp action masquerade as Water ripples.
        a.label = label;
        if (a.kind !== 'set' || e.kind !== 'midi' || e.channel !== 1 || e.msg !== 'cc' || e.number !== cc || e.value !== VALUE_PLACEHOLDER) {
          err('visual_action', `${path}.encode`, `${a.actionId} must be a set action sending ${label} CC${cc} with value $value on channel 1`);
        }
        if (a.range?.min !== 0 || a.range.max !== 127 || a.range.step !== 1) {
          err('visual_range', `${path}.range`, `${label} uses range 0-127 with step 1`);
        }
        a.curve = 'linear';
      } else {
        const pattern = /^pattern([0-2])$/.exec(a.actionId);
        if (!pattern || a.kind !== 'trigger' || e.kind !== 'midi' || e.channel !== 1 || e.msg !== 'pc' || e.number !== Number(pattern[1])) {
          err('visual_action', `${path}.encode`, 'Each pattern0, pattern1, pattern2 trigger must send its matching program change 0, 1, 2 on channel 1');
        }
      }
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
    const expected = ['cc71', 'cc21', 'pattern0', 'pattern1', 'pattern2'];
    if (actions.length !== expected.length || expected.some((id) => !actions.some((a) => a.actionId === id))) {
      err('visual_controls', 'actions', 'The visual demo uses exactly cc71 Warp, cc21 Water ripples and pattern0, pattern1, pattern2');
    }
  }

  // rate limits
  const cap = input.transport === 'midi' ? RATE_LIMITS.midiPerSec : input.transport === 'ir' ? RATE_LIMITS.irPerSec : RATE_LIMITS.lightChangesPerSec;
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
