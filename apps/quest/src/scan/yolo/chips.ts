/**
 * The category chips (research/06 "Category chips"): Everything · Electronics · Instruments · Lights · Remotes.
 * Built as an ordinary gen3d spec and shown with hud.renderSpec, so they use the HUD's own plates, type and
 * pinch/poke behaviour; the shell catches their control events (specId CHIPS_SPEC_ID) and filters live boxes.
 * Pure: unit-tested against the gen3d validator.
 */
import type { Gen3dSpec, Part } from '@ce/gen3d';
import { NEON } from '@ce/gen3d';
import { CATEGORIES, type Category } from './classes';

export const CHIPS_SPEC_ID = 'yolo-chips';
const W = 0.074;
const H = 0.03;
const GAP = 0.006;

export function chipControlId(c: Category): string {
  return `cat_${c}`;
}

export function categoryFromControl(controlId: string): Category | null {
  const c = CATEGORIES.find((x) => chipControlId(x.id) === controlId);
  return c ? c.id : null;
}

export function chipsSpec(active: Category, note?: string): Gen3dSpec {
  const n = CATEGORIES.length;
  const total = n * W + (n - 1) * GAP;
  const parts: Part[] = [
    { id: 'title', kind: 'text', text: { value: 'LIVE BOXES · TRACK', heightM: 0.0055, color: NEON.dim, align: 'left' }, transform: { position: [-total / 2, H / 2 + 0.012, 0.002] } },
  ];
  if (note) parts.push({ id: 'note', kind: 'text', text: { value: note.slice(0, 48), heightM: 0.005, color: NEON.dim, align: 'right', uppercase: false }, transform: { position: [total / 2, H / 2 + 0.012, 0.002] } });
  CATEGORIES.forEach((c, i) => {
    const on = c.id === active;
    const x = -total / 2 + W / 2 + i * (W + GAP);
    parts.push(
      { id: `chip_${c.id}`, kind: 'primitive', shape: 'box', dims: { w: W, h: H, d: 0.003, radius: 0.006 }, transform: { position: [x, 0, 0] }, material: { style: 'holo', color: on ? NEON.holo : NEON.plate, opacity: 0.92, edges: true, edgeColor: on ? NEON.volt : NEON.dim, scanlines: on }, role: 'cap' },
      { id: `label_${c.id}`, kind: 'text', text: { value: c.label, heightM: 0.0068, color: on ? NEON.volt : NEON.bone, align: 'center' }, transform: { position: [x, 0, 0.003] } },
    );
  });
  return {
    spec: 'ce.gen3d/1',
    specId: CHIPS_SPEC_ID,
    rev: 1,
    title: 'Live boxes: categories',
    anchor: { mode: 'floating', grabbable: false, distance: 0.55, pitchDeg: -28, faceUser: true },
    controls: CATEGORIES.map((c) => ({ id: chipControlId(c.id), kind: 'trigger' as const, label: c.label.slice(0, 16), binding: { action: 'hud.live.category', args: { category: c.id } } })),
    behaviors: CATEGORIES.map((c) => ({ id: `b_${c.id}`, partId: `chip_${c.id}`, controlId: chipControlId(c.id), type: 'press' as const, axis: 'z' as const, depth: 0.003, gestures: ['poke' as const, 'pinch' as const], grabRadius: 0.02 })),
    parts,
  };
}
