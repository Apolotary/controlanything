import type { Gen3dSpec } from '../schema';

/**
 * The OP-1 Field's four colour-coded encoders as holographic knobs beside the synth.
 * CC numbers are placeholders until device-control confirms the map on hardware [inferred].
 */
export const op1Knobs: Gen3dSpec = {
  spec: 'ce.gen3d/1',
  specId: 'ex_op1_knobs',
  rev: 1,
  title: 'OP-1 Field · encoders',
  source: 'hand',
  device: {
    cardId: 'card_op1f',
    name: 'OP-1 Field',
    category: 'synthesizer',
    transport: 'usb-midi',
    accents: ['#2F6BFF', '#39C46A', '#F2F4F0', '#FF7A1A'],
  },
  anchor: { mode: 'device', cardId: 'card_op1f', side: 'right', offset: [0.26, 0.06, 0], faceUser: true, grabbable: true },
  state: { armed: true, reason: 'USB says OP-1 Field ✓ · CC 1-4 echoed ✓', verifiedBy: ['usb-descriptor', 'cc-echo'] },
  controls: [
    { id: 'blue', kind: 'continuous', label: 'BLUE', range: { min: 0, max: 127, step: 1 }, default: 64, accent: '#2F6BFF', binding: { action: 'midi.cc', channel: 1, cc: 1 } },
    { id: 'green', kind: 'continuous', label: 'GREEN', range: { min: 0, max: 127, step: 1 }, default: 40, accent: '#39C46A', binding: { action: 'midi.cc', channel: 1, cc: 2 } },
    { id: 'white', kind: 'continuous', label: 'WHITE', range: { min: 0, max: 127, step: 1 }, default: 90, accent: '#F2F4F0', binding: { action: 'midi.cc', channel: 1, cc: 3 } },
    { id: 'orange', kind: 'continuous', label: 'ORANGE', range: { min: 0, max: 127, step: 1 }, default: 20, accent: '#FF7A1A', binding: { action: 'midi.cc', channel: 1, cc: 4 } },
  ],
  parts: [
    { id: 'plate', kind: 'primitive', shape: 'box', dims: { w: 0.4, h: 0.15, d: 0.004, radius: 0.006 }, transform: { position: [0, 0, -0.004] }, material: { style: 'holo', color: '#101820', opacity: 0.92, edges: true, edgeColor: '#38F0FF', scanlines: true, fresnel: 3 } },
    { id: 'tag', kind: 'archetype', archetype: 'tag', params: { title: 'OP-1 FIELD', subtitle: 'controlled · 4 encoders', status: 'controlled', channel: 'usb' }, transform: { position: [-0.11, 0.105, 0.002] } },
    { id: 'k1', kind: 'archetype', archetype: 'knob', controlId: 'blue', transform: { position: [-0.14, 0, 0] } },
    { id: 'k2', kind: 'archetype', archetype: 'knob', controlId: 'green', transform: { position: [-0.047, 0, 0] } },
    { id: 'k3', kind: 'archetype', archetype: 'knob', controlId: 'white', transform: { position: [0.047, 0, 0] } },
    { id: 'k4', kind: 'archetype', archetype: 'knob', controlId: 'orange', transform: { position: [0.14, 0, 0] } },
    { id: 'chips', kind: 'archetype', archetype: 'model-chips', params: { models: [{ id: 'muse-spark-1.3', state: 'done' }, { id: 'sam-3.1', state: 'done' }] }, transform: { position: [0.085, 0.105, 0.002] } },
  ],
  modelId: 'muse-spark-1.3',
};
