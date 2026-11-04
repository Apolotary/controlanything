/** Compact, bounded instrument composer. Muse chooses semantics; trusted code owns geometry. */
import { z } from 'zod';
import { GEN3D_SPEC_VERSION, repairSpec, validateSpec, type Control, type Gen3dSpec, type Part } from '@ce/gen3d';
import type { ConnectorAction } from './connector-host';

export const InstrumentDesign = z.object({
  style: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), mood: z.enum(['calm', 'playful', 'electric']).optional() }),
  widgets: z.array(z.object({
    type: z.enum(['keys', 'pads', 'xy-orb', 'fader', 'knob', 'wheel', 'dimmer-ring', 'lever', 'button', 'toggle']),
    label: z.string().min(1).max(16),
    action: z.string().min(1).max(41).optional(),
    actions: z.array(z.string().min(1).max(41)).min(1).max(8).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    count: z.number().int().min(1).max(12).optional(),
    range: z.object({ min: z.number(), max: z.number() }).optional(),
  })).min(1).max(8),
  visualizer: z.object({ kind: z.enum(['notes', 'trail', 'pulse', 'ripple']), actions: z.array(z.string().min(1).max(41)).min(1).max(16) }).optional(),
});
export type InstrumentDesign = z.infer<typeof InstrumentDesign>;

export function compileInstrument(design: InstrumentDesign, actions: ConnectorAction[], context: { cardId: string; title: string; source: 'fixture' | 'live'; model: string }): { spec?: Gen3dSpec; visualizer?: InstrumentDesign['visualizer']; used: string[]; issues: string[] } {
  const issues: string[] = [], controls: Control[] = [], parts: Part[] = [];
  const byId = new Map(actions.map(a => [a.id, a]));
  const used = new Set<string>();
  const top: { part: Part; width: number }[] = [], bottom: { part: Part; width: number }[] = [];
  for (const [i, w] of design.widgets.entries()) {
    const ids = w.actions ?? (w.action ? [w.action] : []);
    const aa = ids.map(id => byId.get(id));
    if (!ids.length || aa.some(a => !a)) { issues.push(`${w.label}: use deployed actions only (${ids.join(', ') || 'no action supplied'}).`); continue; }
    const a = aa[0]!;
    const xy = w.type === 'xy-orb', bank = w.type === 'keys' || w.type === 'pads';
    if (xy && (ids.length !== 2 || aa.some(a => a?.kind !== 'set'))) { issues.push(`${w.label}: xy-orb needs exactly two set actions.`); continue; }
    if (!xy && ids.length > 1 && (!bank || aa.some(a => a?.kind !== 'trigger'))) { issues.push(`${w.label}: multiple actions are only supported for a pad/key bank of triggers.`); continue; }
    if ((bank || !['button', 'toggle'].includes(w.type)) && !(ids.length > 1) && a.kind !== 'set' && !(bank && a.kind === 'trigger')) { issues.push(`${w.label}: ${w.type} needs a set action.`); continue; }
    if (w.type === 'toggle' && a.kind !== 'toggle' || w.type === 'button' && a.kind !== 'trigger') { issues.push(`${w.label}: widget kind must match the connector action.`); continue; }
    for (const id of ids) used.add(id);
    const accent = w.color ?? design.style.accent;
    const id = `widget${i}`;
    if (bank && aa.every(a => a?.kind === 'trigger')) {
      // A separate press target per trigger keeps the action map explicit.
      for (let n = 0; n < ids.length; n++) {
        const cid = `${id}_${n}`;
        controls.push({ id: cid, kind: 'trigger', label: aa[n]!.label.slice(0, 16), binding: { action: ids[n]! }, armed: true, accent });
        bottom.push({ part: { id: `part_${cid}`, kind: 'archetype', archetype: 'button', controlId: cid, params: { size: .064, showLabel: true, accent } }, width: .09 });
      }
      continue;
    }
    const min = w.range?.min ?? a.min ?? 0, max = w.range?.max ?? a.max ?? 1;
    if (min >= max || min < (a.min ?? 0) || max > (a.max ?? 1)) { issues.push(`${w.label}: range must stay inside the deployed action's range.`); continue; }
    if (w.type === 'wheel' && (!Number.isInteger(min) || !Number.isInteger(max))) { issues.push(`${w.label}: wheel range uses integer steps.`); continue; }
    const count = w.type === 'keys' ? 12 : w.count ?? 8;
    if (bank && max - min < count - 1) { issues.push(`${w.label}: range needs room for ${count} distinct keys/pads.`); continue; }
    const range = { min, max: bank ? Math.min(max, min + Math.max(1, count - 1)) : max, ...(bank || w.type === 'wheel' ? { step: 1 } : {}) };
    const b = xy ? aa[1]! : undefined;
    controls.push({ id, label: w.label, kind: xy ? 'xy' : bank || w.type === 'wheel' ? 'stepped' : a.kind === 'trigger' ? 'trigger' : a.kind === 'toggle' ? 'toggle' : 'continuous', binding: { action: a.id }, armed: true, accent,
      ...(a.kind === 'set' ? { range, default: xy ? { x: (min + max) / 2, y: ((b?.min ?? 0) + (b?.max ?? 1)) / 2 } : bank ? min : (min + max) / 2 } : {}),
      ...(xy ? { yBinding: { action: b!.id }, yRange: { min: b!.min ?? 0, max: b!.max ?? 1 } } : {}),
      hint: bank ? 'poke or press to play' : xy ? 'touch or move the orb' : 'twist or tap to adjust',
    });
    const part: Part = { id: `part_${id}`, kind: 'archetype', archetype: w.type, controlId: id, params: { accent, showLabel: true, showValue: !bank, size: xy ? .18 : .076 } };
    if (w.type === 'keys') { part.params = { accent, showLabel: true, octaves: 1 }; part.transform = { scale: 2.2 }; bottom.push({ part, width: .56 }); }
    else if (w.type === 'pads') { part.params = { accent, showLabel: true, size: .064, rows: 1, cols: count }; bottom.push({ part, width: count * .076 + .02 }); }
    else top.push({ part, width: xy ? .23 : w.type === 'dimmer-ring' ? .18 : .12 });
  }
  for (const [row, y] of [[top, .13], [bottom, -.14]] as const) {
    const width = row.reduce((sum, x) => sum + x.width, 0);
    if (width > 1.1) issues.push('The instrument is too wide. Use fewer widgets or pads.');
    let x = -width / 2;
    for (const item of row) { item.part.transform = { ...item.part.transform, position: [x + item.width / 2, y, 0] }; parts.push(item.part); x += item.width; }
  }
  if (design.visualizer) for (const id of design.visualizer.actions) { if (!byId.has(id)) issues.push(`Visualizer action ${id} is not deployed.`); else used.add(id); }
  if (issues.length) return { used: [...used], issues };
  const input: Gen3dSpec = { spec: GEN3D_SPEC_VERSION, specId: `instrument:${context.cardId.replace(/[^A-Za-z0-9_.:-]/g, '_')}`.slice(0, 64), rev: 1, title: context.title.slice(0, 40), controls, parts,
    state: { armed: true, reason: 'Connector running; instrument requested by wearer' }, source: context.source, modelId: context.model,
    anchor: { mode: 'floating', distance: .65, faceUser: true, grabbable: false } };
  const result = validateSpec(repairSpec(input).spec);
  if (!result.ok) return { used: [...used], issues: result.errors.map(x => `${x.path}: ${x.message}`) };
  return { spec: result.spec, visualizer: design.visualizer, used: [...used], issues: [] };
}
