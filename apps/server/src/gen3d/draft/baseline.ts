/**
 * Hand-written gen3d-draft/0 spec for the OP-1 Field (four colour knobs), the "current spec" of the edit
 * benchmark ("make the resonance control a big red lever") and of the unit tests. Not model output.
 */
import { CATALOG } from './catalog';
import { DRAFT_VERSION, type Spec } from './spec';

const knob = (id: string, label: string, encoder: string, color: string, x: number) => ({
  control: {
    id,
    label,
    kind: 'continuous' as const,
    min: 0,
    max: 127,
    step: 1,
    default: 64,
    unit: '',
    binding: { action: 'encoder.set', args: [{ name: 'encoder', value: encoder }], valueArg: 'value' },
    expect: { sensor: 'mic' as const, effect: 'timbre_change' as const, detail: `${label.toLowerCase()} moves the sound` },
  },
  object: {
    id: `${id}_knob`,
    controlId: id,
    archetype: 'knob' as const,
    label,
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
    material: { color, emissive: '#000000', metalness: 0.2, roughness: 0.5 },
    behaviour: { ...CATALOG.knob.behaviour },
    parts: [],
  },
});

const knobs = [
  knob('cutoff', 'CUTOFF', 'blue', '#2F6BFF', -0.135),
  knob('resonance', 'RESONANCE', 'green', '#39C46A', -0.045),
  knob('attack', 'ATTACK', 'white', '#F2F4F0', 0.045),
  knob('release', 'RELEASE', 'orange', '#FF7A1A', 0.135),
];

export const BASELINE_OP1_SPEC: Spec = {
  version: DRAFT_VERSION,
  title: 'OP-1 Field encoders',
  device: { cardId: 'op1-field', name: 'OP-1 Field' },
  anchor: { target: 'device', side: 'right', offset: { x: 0.06, y: 0, z: 0 }, facing: 'user' },
  hacks: [],
  controls: knobs.map((k) => k.control),
  objects: knobs.map((k) => k.object),
  daemons: [],
  notes: 'Hand-written baseline for the edit benchmark.',
};
