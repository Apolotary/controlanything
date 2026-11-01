/**
 * DRAFT archetype catalog: what each 3D archetype is for, its default footprint and its default behaviour.
 * The prompt shows it to the model; the geometry check uses the footprints. Replaced by packages/gen3d's catalog.
 */
import type { Archetype, Behaviour, ControlKind, Material } from './spec';

export interface ArchetypeInfo {
  suits: ControlKind[];
  /** default extents in metres (w = x, h = y, d = z) at scale 1 */
  size: { w: number; h: number; d: number };
  behaviour: Behaviour;
  use: string;
}

const b = (motion: Behaviour['motion'], axis: Behaviour['axis'], from: number, to: number, detents = 0, springBack = false): Behaviour => ({
  motion,
  axis,
  from,
  to,
  detents,
  springBack,
});

export const CATALOG: Record<Archetype, ArchetypeInfo> = {
  knob: { suits: ['continuous', 'stepped'], size: { w: 0.06, h: 0.035, d: 0.06 }, behaviour: b('rotate', 'y', -135, 135), use: 'synth parameters, fine values' },
  slider: { suits: ['continuous', 'stepped'], size: { w: 0.04, h: 0.02, d: 0.18 }, behaviour: b('slide', 'z', -0.07, 0.07), use: 'levels, mixes' },
  lever: { suits: ['continuous', 'toggle'], size: { w: 0.06, h: 0.18, d: 0.06 }, behaviour: b('rotate', 'x', -35, 35), use: 'big throwable control, pulled toward the user' },
  button: { suits: ['momentary'], size: { w: 0.05, h: 0.025, d: 0.05 }, behaviour: b('press', 'y', 0, -0.008, 0, true), use: 'one-shot actions' },
  switch: { suits: ['toggle'], size: { w: 0.06, h: 0.03, d: 0.04 }, behaviour: b('flip', 'x', -20, 20, 2), use: 'on/off' },
  ring: { suits: ['continuous', 'stepped'], size: { w: 0.14, h: 0.025, d: 0.14 }, behaviour: b('rotate', 'y', -150, 150), use: 'dimmers, volume' },
  dial: { suits: ['stepped'], size: { w: 0.08, h: 0.03, d: 0.08 }, behaviour: b('rotate', 'y', -120, 120, 8), use: 'modes, channels, presets' },
  pad: { suits: ['momentary'], size: { w: 0.06, h: 0.015, d: 0.06 }, behaviour: b('press', 'y', 0, -0.006, 0, true), use: 'notes, triggers' },
  wheel: { suits: ['continuous', 'stepped'], size: { w: 0.14, h: 0.025, d: 0.14 }, behaviour: b('rotate', 'y', -180, 180), use: 'colour, warmth' },
  readout: { suits: ['continuous', 'stepped', 'toggle', 'momentary'], size: { w: 0.08, h: 0.03, d: 0.01 }, behaviour: b('none', 'y', 0, 0), use: 'display only' },
};

export const DEFAULT_MATERIAL: Material = { color: '#E8E4D8', emissive: '#000000', metalness: 0.1, roughness: 0.6 };

/** Layout bounds (anchor frame, metres) the geometry check enforces. */
export const BOUNDS = { x: [-0.3, 0.3], y: [0, 0.35], z: [-0.2, 0.2] } as const;
export const MIN_GAP_M = 0.02;

export function catalogTable(): string {
  const rows = (Object.entries(CATALOG) as [Archetype, ArchetypeInfo][]).map(([name, a]) => {
    const s = a.size;
    const bh = a.behaviour;
    const travel = bh.motion === 'none' ? 'none' : `${bh.motion} ${bh.axis} ${bh.from}..${bh.to}${bh.detents ? `, ${bh.detents} detents` : ''}${bh.springBack ? ', springBack' : ''}`;
    return `| ${name} | ${a.suits.join(', ')} | ${s.w}×${s.h}×${s.d} | ${travel} | ${a.use} |`;
  });
  return ['| archetype | suits kinds | size w×h×d (m) | default behaviour | use for |', '|---|---|---|---|---|', ...rows].join('\n');
}
