import type { Gen3dSpec } from '../schema';

/**
 * "A big red lever for resonance": a novel object composed from primitives with an explicit rotate
 * behaviour and feedback, i.e. what the model emits when no archetype fits.
 */
export const resonanceLever: Gen3dSpec = {
  spec: 'ce.gen3d/1',
  specId: 'ex_resonance_lever',
  rev: 1,
  title: 'Resonance lever',
  source: 'hand',
  device: { cardId: 'card_op1f', name: 'OP-1 Field', transport: 'usb-midi' },
  anchor: { mode: 'device', cardId: 'card_op1f', side: 'right', offset: [0.3, 0.04, 0.05], faceUser: true },
  state: { armed: false, reason: 'verifying CC 2 on the real device…' },
  controls: [{ id: 'res', kind: 'continuous', label: 'RESONANCE', range: { min: 0, max: 127, step: 1 }, default: 30, accent: '#FF5A3C', binding: { action: 'midi.cc', channel: 1, cc: 2 } }],
  parts: [
    { id: 'base', kind: 'primitive', shape: 'box', dims: { w: 0.09, h: 0.03, d: 0.09, radius: 0.006 }, transform: { position: [0, 0.015, 0] }, material: { style: 'holo', color: '#101820', opacity: 0.92, edges: true, edgeColor: '#FF5A3C', scanlines: true } },
    { id: 'pivot', kind: 'primitive', shape: 'cylinder', dims: { rTop: 0.01, rBottom: 0.01, h: 0.1, segments: 32 }, transform: { position: [0, 0.035, 0], rotationDeg: [0, 0, 90] }, material: { style: 'holo', color: '#0C2630', opacity: 0.9, fresnel: 2.5 } },
    { id: 'guide', kind: 'primitive', shape: 'ring', dims: { rInner: 0.158, rOuter: 0.164, arcDeg: 70, startDeg: 55, segments: 48 }, transform: { position: [0, 0.035, 0], rotationDeg: [0, -90, 0] }, material: { style: 'holo', color: '#FF5A3C', opacity: 0.5, glow: 0.3 } },
    { id: 'arm', kind: 'group', role: 'cap', transform: { position: [0, 0.035, 0], rotationDeg: [-20, 0, 0] } },
    { id: 'rod', parentId: 'arm', kind: 'primitive', shape: 'cylinder', dims: { rTop: 0.007, rBottom: 0.009, h: 0.15, segments: 24 }, transform: { position: [0, 0.075, 0] }, material: { style: 'holo', color: '#0C2630', opacity: 0.95, fresnel: 3 } },
    { id: 'ball', parentId: 'arm', kind: 'primitive', shape: 'sphere', dims: { r: 0.028, segments: 32 }, transform: { position: [0, 0.16, 0] }, material: { style: 'solid', color: '#FF5A3C', emissive: '#FF5A3C', emissiveIntensity: 1.2, roughness: 0.35, glow: 1 }, role: 'indicator' },
    { id: 'label', kind: 'text', text: { value: 'RESONANCE', heightM: 0.009, background: '#101820', color: '#F3F7FA' }, transform: { position: [0, -0.012, 0.06] }, role: 'label' },
    { id: 'value', kind: 'text', text: { value: '30', heightM: 0.012, font: 'mono', color: '#FF5A3C', background: '#0A0E12', billboard: true }, transform: { position: [0.09, 0.09, 0] }, role: 'readout' },
  ],
  behaviors: [{ id: 'b_rotate', partId: 'arm', controlId: 'res', type: 'rotate', axis: 'x', sweepDeg: [-35, 35], gestures: ['pinch-drag', 'grab'], dragGain: 0.14, grabRadius: 0.06, detents: 0 }],
  feedback: [
    { id: 'f_glow', controlId: 'res', type: 'glow', partId: 'ball', on: 'hover', color: '#FF5A3C' },
    { id: 'f_read', controlId: 'res', type: 'readout', partId: 'value', format: '{value}' },
    { id: 'f_tick', controlId: 'res', type: 'tick', every: 0.1, sound: 'click' },
  ],
  notes: 'Composed from primitives: a novel object the model can describe without an archetype.',
  modelId: 'muse-spark-1.3',
};
