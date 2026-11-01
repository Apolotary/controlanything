/** The gen3d-draft/0 kit: the draft spec, its checks, patches and tool calls behind the GenKit interface. */
import type { GenKit } from './genkit';
import { catalogTable } from './catalog';
import { applyDraftPatch } from './patch';
import { DRAFT_VERSION, Patch, Spec } from './spec';
import { SpecBuilder, toolDefs } from './tools';
import { semanticIssues } from './verify';

export const draftKit: GenKit<Spec, Patch> = {
  version: DRAFT_VERSION,
  specName: 'gen3d_spec',
  patchName: 'gen3d_patch',
  specSchema: Spec,
  patchSchema: Patch,
  catalogTable,
  verify: (spec, ctx) => semanticIssues(spec, ctx),
  applyPatch: applyDraftPatch,
  items: (spec) => {
    const m = new Map<string, unknown>();
    for (const key of ['controls', 'objects', 'hacks', 'daemons'] as const) for (const x of spec[key]) m.set(`${key}:${x.id}`, x);
    m.set('anchor', spec.anchor);
    m.set('title', spec.title);
    return m;
  },
  normalize: (spec, ctx) => ({ ...spec, version: DRAFT_VERSION, device: { cardId: ctx.target.cardId, name: ctx.cardName.slice(0, 80) } }),
  tools: (task) => toolDefs(task === 'edit' ? undefined : ['add_control', 'bind', 'add_hack', 'add_daemon', 'add_part', 'set_material', 'done']),
  toolSession: (device, current) => {
    const b = new SpecBuilder(device, current);
    return {
      apply: (name, args) => {
        const out = b.apply(name, args);
        return out.item ? { ...out, item: { ...out.item, value: findItem(b.spec, out.item.id) } } : out;
      },
      get done() {
        return b.done;
      },
      current: () => b.spec,
    };
  },
};

function findItem(spec: Spec, id: string): unknown {
  return spec.controls.find((x) => x.id === id) ?? spec.objects.find((x) => x.id === id || x.controlId === id) ?? spec.hacks.find((x) => x.id === id) ?? spec.daemons.find((x) => x.id === id);
}
