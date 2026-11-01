/**
 * ce.hackset/1 lives in @ce/protocol (brain's lane); this file holds only what the MODEL writes and its
 * conversion to the protocol's Hack.
 *
 * HackDraft / ForgeDraft: every key is required, with sentinels ("" / "none" / []) for "not used", because
 * the Meta constrained decoder lets the model skip optional keys (research/12, finding 3) and writes keys
 * in alphabetical order. draftToHack drops the sentinels.
 */
import { type Hack, HackArchetype, HACKSET_VERSION, type HackSet, OracleExpect, OracleType } from '@ce/protocol';
import { z } from 'zod';

export { HACKSET_VERSION, type Hack, type HackSet };

export const HackId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const HACK_ARCHETYPES = HackArchetype.options;
export type HackArchetypeName = (typeof HACK_ARCHETYPES)[number];
export const ORACLE_TYPES = OracleType.options;
export const ORACLE_EXPECTS = OracleExpect.options;

const DraftCommand = z.object({
  action: z.string().max(64),
  delayMs: z.number().int().min(0).max(10_000),
  /** "" = send `value`; otherwise the param id whose live value is sent */
  param: z.string().max(32),
  value: z.number(),
});
export type DraftCommand = z.infer<typeof DraftCommand>;

export const HackDraft = z.object({
  blurb: z.string().max(40),
  commands: z.array(DraftCommand).min(1).max(8),
  confirm: z.enum(['none', 'hold']),
  control: z.object({
    /** "" = the device's own colour or the theme */
    accent: z.string().max(7),
    /** "none" for actions (they appear in the hack list) */
    archetype: z.enum([...HACK_ARCHETYPES, 'none']),
    /** the param this control drives; "" for actions */
    param: z.string().max(32),
    size: z.enum(['s', 'm', 'l']),
  }),
  id: HackId,
  inverse: z.object({ commands: z.array(DraftCommand).max(8), restore: z.string().max(32) }),
  kind: z.enum(['action', 'control']),
  max_rate_hz: z.number().gt(0).max(3),
  name: z.string().min(1).max(14),
  oracle: z.object({ expect: z.enum(ORACLE_EXPECTS), reason: z.string().max(80), type: z.enum(ORACLE_TYPES) }),
  params: z
    .array(z.object({ default: z.number(), id: z.string().max(32), max: z.number(), min: z.number(), name: z.string().min(1).max(16), step: z.number().min(0), unit: z.string().max(8) }))
    .max(2),
  reversible: z.boolean(),
});
export type HackDraft = z.infer<typeof HackDraft>;

export const ForgeDraft = z.object({
  hacks: z.array(HackDraft).min(1).max(8),
  /** short object title, e.g. "Ceiling light" */
  title: z.string().min(1).max(40),
});
export type ForgeDraft = z.infer<typeof ForgeDraft>;

function cmd(c: DraftCommand): Hack['commands'][number] {
  const out: Hack['commands'][number] = { action: c.action };
  if (c.param) out.param = c.param;
  else out.value = c.value;
  if (c.delayMs) out.delayMs = c.delayMs;
  return out;
}

/** Drop the sentinels: the protocol Hack for one draft (no validation here; see forgeVerify). */
export function draftToHack(d: HackDraft): Hack {
  const h: Hack = {
    id: d.id,
    name: d.name,
    kind: d.kind,
    blurb: d.blurb,
    commands: d.commands.map(cmd),
    oracle: d.oracle.type === 'none' ? { type: 'none', expect: d.oracle.expect, reason: (d.oracle.reason || 'no observable effect').slice(0, 120) } : { type: d.oracle.type, expect: d.oracle.expect },
    reversible: d.reversible,
    max_rate_hz: Math.max(0.05, d.max_rate_hz),
  };
  if (d.params.length) h.params = d.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, default: p.default, ...(p.step > 0 ? { step: p.step } : {}), ...(p.unit ? { unit: p.unit } : {}) }));
  if (d.kind === 'control' && d.control.archetype !== 'none') h.control = { archetype: d.control.archetype, size: d.control.size, param: d.control.param };
  if (d.inverse.restore || d.inverse.commands.length) {
    h.inverse = {};
    if (d.inverse.restore) h.inverse.restore = d.inverse.restore;
    if (d.inverse.commands.length) h.inverse.commands = d.inverse.commands.map(cmd);
  }
  if (d.confirm === 'hold') h.confirm = 'hold';
  return h;
}

/** The colour the model asked for on a control ("" = device colours / theme). */
export function draftAccent(d: HackDraft): string | undefined {
  return /^#[0-9a-fA-F]{6}$/.test(d.control.accent) ? d.control.accent : undefined;
}

/** A control driven by two trigger actions, [raise, lower], one press per param step (no StepOp in the driver). */
export function isStepperHack(h: Pick<Hack, 'kind' | 'commands'>, kindOf: (actionId: string) => string | undefined): boolean {
  return h.kind === 'control' && h.commands.length === 2 && h.commands.every((c) => c.param === undefined && kindOf(c.action) === 'trigger');
}
