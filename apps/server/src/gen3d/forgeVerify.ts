/**
 * Deterministic checks for a generated hack set against the device's verified Driver:
 *   bindings  every command names a driver actionId; values and live params fit the action's kind and range
 *   presentation  controls ask for an archetype that can operate their action kind
 *   safety    <= 3 Hz, >= 340 ms between light changes, the oracle expects an effect the actions can cause,
 *             undo for every reversible action, hold-to-confirm for irreversible ones, banned names
 *   composition  4-8 hacks, ids unique, >= 2 controls and >= 2 actions when the driver allows it
 * Every error goes back to the model in the repair prompt, so messages say what to change.
 */
import type { ForgeAction, ForgeDriver } from './forgeTypes';
import type { ForgeDraft, HackDraft } from './hackset';
import { issue, type Issue } from './issues';

export const BANNED_NAME_WORDS = [
  'quickhack',
  'breach protocol',
  'overheat',
  'short circuit',
  'reboot optics',
  'contagion',
  'system reset',
  'synapse',
  'cyberpsychosis',
  'memory wipe',
  'sonic shock',
  'whistle',
  'ping',
  'netrunner',
  'ice',
  'daemon',
  // public copy never says these (cyber-director, Nov 2)
  'breach',
  'jack in',
  'exploit',
  'payload',
  'inject',
  'crack',
  'attack',
  'bypass',
];

const ARCHETYPE_FOR: Record<ForgeAction['kind'], readonly string[]> = {
  set: ['knob', 'slider', 'ring', 'lever', 'xy'],
  toggle: ['toggle', 'button', 'lever'],
  trigger: ['button', 'pads'],
};

/** Which oracle expectations each driver effect admits. */
const EFFECT_ADMITS: Record<string, readonly string[]> = {
  on: ['on', 'brighter', 'luminance_tracks_param', 'louder', 'screen_changed', 'text_on_screen'],
  off: ['off', 'dimmer', 'silent', 'quieter', 'luminance_tracks_param'],
  brighter: ['brighter', 'on', 'luminance_tracks_param'],
  dimmer: ['dimmer', 'dimmer+warmer', 'off', 'luminance_tracks_param'],
  warmer: ['warmer', 'dimmer+warmer', 'colour_shift'],
  cooler: ['cooler', 'colour_shift'],
  louder: ['louder', 'heard_text', 'tempo_match'],
  quieter: ['quieter', 'silent'],
  'tone-up': ['centroid_up', 'centroid_down'],
  'tone-down': ['centroid_down', 'centroid_up'],
};
/** audio covers the room mic and the device's own USB audio (oracle type wire), cyber-director Nov 2 */
const SENSE_ORACLE: Record<string, readonly string[]> = { camera: ['camera'], audio: ['mic', 'wire'], ack: ['wire', 'serial'], none: ['none'] };
const LIGHT_EFFECTS = new Set(['on', 'off', 'brighter', 'dimmer', 'warmer', 'cooler']);

export const MIN_LIGHT_GAP_MS = 340;

const STEPPER_ARCHETYPES = ['knob', 'slider', 'ring', 'lever'];

/** A control driven by two trigger actions, up then down (learned IR codes): one press per param step. */
export function isStepper(h: HackDraft, byId: Map<string, ForgeAction>): boolean {
  return h.kind === 'control' && h.commands.length === 2 && h.commands.every((c) => !c.param && byId.get(c.action)?.kind === 'trigger');
}

function admits(a: ForgeAction, type: string, expect: string): boolean | undefined {
  if (!a.expect || a.expect.sense === 'none' || a.expect.effect === 'none') return undefined;
  if (type === 'none') return true;
  if (!(SENSE_ORACLE[a.expect.sense] ?? []).includes(type)) return false;
  if (a.expect.effect === 'any') return true;
  return (EFFECT_ADMITS[a.expect.effect] ?? [a.expect.effect]).includes(expect);
}

export function changesLight(a: ForgeAction | undefined): boolean {
  return Boolean(a?.expect && a.expect.sense === 'camera' && LIGHT_EFFECTS.has(a.expect.effect));
}

/**
 * The first banned word in a name or blurb. Words that are the device's own vocabulary (they appear in its
 * driver's action labels, e.g. a synth's envelope "attack") are allowed.
 */
export function bannedWord(name: string, allowed: ReadonlySet<string> = new Set()): string | undefined {
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return BANNED_NAME_WORDS.find((w) => n.includes(` ${w} `) && !w.split(' ').every((x) => allowed.has(x)));
}

export function deviceVocabulary(driver: ForgeDriver): Set<string> {
  return new Set(driver.actions.flatMap((a) => `${a.label} ${a.actionId}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
}

type DraftCommand = HackDraft['commands'][number];

function commandIssues(h: HackDraft, c: DraftCommand, path: string, byId: Map<string, ForgeAction>, allowParam: boolean): Issue[] {
  const out: Issue[] = [];
  const a = byId.get(c.action);
  if (!a) return [issue('bindings', 'unknown_action', `${path}.action`, `"${c.action}" is not a driver action; use one of: ${[...byId.keys()].join(', ')}`)];
  const p = c.param ? h.params.find((x) => x.id === c.param) : undefined;
  if (c.param && !allowParam) out.push(issue('bindings', 'param_in_action', `${path}.param`, 'one-shot hacks and undo commands send fixed values: set param "" and give value'));
  else if (c.param && !p) out.push(issue('bindings', 'unknown_param', `${path}.param`, `no param "${c.param}" in this hack (params: ${h.params.map((x) => x.id).join(', ') || 'none'})`));
  if (a.kind === 'trigger') {
    if (c.param) out.push(issue('bindings', 'trigger_param', `${path}.param`, `${a.actionId} is a trigger: it takes no value (param "")`));
    return out;
  }
  const lo = a.kind === 'toggle' ? 0 : (a.range?.min ?? -Infinity);
  const hi = a.kind === 'toggle' ? 1 : (a.range?.max ?? Infinity);
  if (p) {
    if (p.min < lo || p.max > hi) out.push(issue('bindings', 'param_range', `${path}.param`, `param ${p.id} ${p.min}..${p.max} must lie inside ${a.actionId}'s ${lo}..${hi}`));
  } else if (!c.param) {
    if (c.value < lo || c.value > hi) out.push(issue('bindings', 'value_range', `${path}.value`, `${a.actionId} takes ${lo}..${hi}${a.kind === 'toggle' ? ' (0 = off, 1 = on)' : ''}; got ${c.value}`));
  }
  return out;
}

export function draftIssues(draft: ForgeDraft, driver: ForgeDriver): Issue[] {
  const out: Issue[] = [];
  const byId = new Map(driver.actions.map((a) => [a.actionId, a]));
  const ids = new Set<string>();
  const names = new Set<string>();
  const allParams = new Set(draft.hacks.flatMap((h) => h.params.map((p) => p.id)));
  const vocab = deviceVocabulary(driver);
  draft.hacks.forEach((h, i) => {
    const at = `hacks[${i}]`;
    if (ids.has(h.id)) out.push(issue('schema', 'duplicate_id', `${at}.id`, `hack id "${h.id}" is used twice`));
    ids.add(h.id);
    if (names.has(h.name.toLowerCase())) out.push(issue('safety', 'duplicate_name', `${at}.name`, `two hacks are called "${h.name}"`));
    names.add(h.name.toLowerCase());
    const bad = bannedWord(h.name, vocab);
    if (bad) out.push(issue('safety', 'banned_name', `${at}.name`, `"${h.name}" uses the banned word "${bad}"; pick a plain verb-first name`));
    const badBlurb = bannedWord(h.blurb, vocab);
    if (badBlurb) out.push(issue('safety', 'banned_name', `${at}.blurb`, `the blurb uses the banned word "${badBlurb}"; describe the plain effect`));
    h.params.forEach((p, j) => {
      if (!(p.min < p.max)) out.push(issue('bindings', 'param_range', `${at}.params[${j}]`, `min ${p.min} must be below max ${p.max}`));
      if (p.default < p.min || p.default > p.max) out.push(issue('bindings', 'param_default', `${at}.params[${j}].default`, `default ${p.default} is outside ${p.min}..${p.max}`));
    });
    const isControl = h.kind === 'control';
    h.commands.forEach((c, j) => out.push(...commandIssues(h, c, `${at}.commands[${j}]`, byId, isControl)));
    h.inverse.commands.forEach((c, j) => out.push(...commandIssues(h, c, `${at}.inverse.commands[${j}]`, byId, false)));
    if (isControl) {
      const p = h.params.find((x) => x.id === h.control.param);
      if (!p) out.push(issue('bindings', 'control_param', `${at}.control.param`, `a control must drive one of its params (params: ${h.params.map((x) => x.id).join(', ') || 'none'})`));
      const live = h.commands.filter((c) => c.param);
      const stepper = isStepper(h, byId);
      if (!live.length && !stepper) {
        out.push(issue('bindings', 'control_unbound', `${at}.commands`, 'a control needs a command that sends its param (command.param = the param id), or, for up/down trigger actions, exactly two commands [up, down] and a param with step > 0'));
      }
      if (stepper && !(p?.step && p.step > 0)) out.push(issue('bindings', 'stepper_step', `${at}.params`, 'a stepper control (up/down triggers) needs a param with step > 0: one press per step'));
      if (h.control.archetype === 'none') out.push(issue('presentation', 'control_archetype', `${at}.control.archetype`, 'a control needs an archetype (knob, slider, ring, lever, xy, pads, toggle, button)'));
      else {
        const kinds = new Set((stepper ? [] : live).map((c) => byId.get(c.action)?.kind).filter(Boolean) as ForgeAction['kind'][]);
        if (stepper && !STEPPER_ARCHETYPES.includes(h.control.archetype)) out.push(issue('presentation', 'archetype_kind', `${at}.control.archetype`, `a stepper control needs ${STEPPER_ARCHETYPES.join(' / ')}`));
        for (const k of kinds) {
          if (!ARCHETYPE_FOR[k].includes(h.control.archetype)) out.push(issue('presentation', 'archetype_kind', `${at}.control.archetype`, `a ${h.control.archetype} cannot operate a ${k} action; use ${ARCHETYPE_FOR[k].join(' / ')}`));
        }
        if (h.control.archetype === 'xy' && h.params.length !== 2) out.push(issue('presentation', 'xy_params', `${at}.params`, 'an xy control needs exactly two params'));
      }
    } else if (h.control.archetype !== 'none' && h.control.archetype !== 'button') {
      out.push(issue('presentation', 'action_archetype', `${at}.control.archetype`, 'one-shot hacks live in the hack list: set control.archetype "none" (or make the hack a control)', 'warn'));
    }
    // undo
    if (h.inverse.restore && !allParams.has(h.inverse.restore)) out.push(issue('safety', 'inverse_restore', `${at}.inverse.restore`, `restore must name a param of this hack set (params: ${[...allParams].join(', ') || 'none'})`));
    if (h.reversible && !h.inverse.commands.length && !h.inverse.restore) out.push(issue('safety', 'no_inverse', `${at}.inverse`, 'a reversible hack needs an undo: inverse.commands (actions) or inverse.restore (controls)'));
    if (!h.reversible && h.confirm !== 'hold') out.push(issue('safety', 'irreversible_confirm', `${at}.confirm`, 'an irreversible hack needs confirm "hold"'));
    // oracle
    if (h.oracle.type === 'none' && !h.oracle.reason.trim()) out.push(issue('safety', 'oracle_reason', `${at}.oracle.reason`, 'oracle type "none" needs a reason (shown as unverified)'));
    const verdicts = h.commands.map((c) => byId.get(c.action)).filter(Boolean).map((a) => admits(a!, h.oracle.type, h.oracle.expect));
    if (verdicts.length && verdicts.every((v) => v === false)) {
      const declared = [...new Set(h.commands.map((c) => byId.get(c.action)?.expect).filter(Boolean).map((e) => `${e!.sense}:${e!.effect}`))].join(', ');
      out.push(issue('safety', 'oracle_mismatch', `${at}.oracle`, `${h.oracle.type}:${h.oracle.expect} is not what these actions cause (driver says ${declared})`));
    }
    // photosensitivity (a stepper's two commands are alternatives, not a sequence)
    let t = 0;
    let last = -Infinity;
    if (!isStepper(h, byId)) h.commands.forEach((c, j) => {
      t += c.delayMs;
      if (!changesLight(byId.get(c.action))) return;
      if (t - last < MIN_LIGHT_GAP_MS) out.push(issue('safety', 'photosensitive', `${at}.commands[${j}].delayMs`, `light changes ${Math.round(t - last)} ms apart; keep >= ${MIN_LIGHT_GAP_MS} ms (max 3 Hz)`));
      last = t;
    });
    if (h.commands.some((c) => changesLight(byId.get(c.action))) && h.max_rate_hz > 3) out.push(issue('safety', 'photosensitive', `${at}.max_rate_hz`, 'anything that changes a light runs at <= 3 Hz'));
  });
  // composition
  const n = draft.hacks.length;
  if (n < 4) out.push(issue('composition', 'hack_count', 'hacks', `${n} hacks; generate 4-8`, n >= 2 ? 'warn' : 'error'));
  const controllable = driver.actions.filter((a) => a.kind !== 'trigger').length;
  const wantControls = Math.min(2, controllable);
  const controls = draft.hacks.filter((h) => h.kind === 'control').length;
  if (controls < wantControls) out.push(issue('composition', 'control_count', 'hacks', `${controls} controls; make at least ${wantControls} (this driver has ${controllable} set/toggle actions)`));
  const wantActions = Math.min(2, driver.actions.length);
  const actions = draft.hacks.filter((h) => h.kind === 'action').length;
  if (actions < wantActions) out.push(issue('composition', 'action_count', 'hacks', `${actions} one-shot hacks; make at least ${wantActions}`));
  return out;
}
