import type { Gen3dSpec } from '../schema';

/**
 * SCAN: what the HUD draws when SAM 3.1 has returned a mask for the synth on the desk: the mask contour as
 * a two-tone outline on the desk plane, lock brackets around the box, a 2.5D hologram twin, and a tag.
 * The archetypes lie flat (rotated -90° about x) because the anchor plane is the table.
 */
const synthContour: number[][] = [
  [-0.144, -0.051], [-0.138, -0.051], [0.138, -0.051], [0.144, -0.049], [0.144, 0.049], [0.138, 0.051], [-0.138, 0.051], [-0.144, 0.049],
];

export const scanScene: Gen3dSpec = {
  spec: 'ce.gen3d/1',
  specId: 'ex_scan_scene',
  rev: 1,
  title: 'Scan · OP-1 Field',
  source: 'hand',
  device: { cardId: 'card_op1f', name: 'OP-1 Field', category: 'synthesizer', transport: 'usb-midi' },
  anchor: { mode: 'device', cardId: 'card_op1f', offset: [0, 0, 0], grabbable: false },
  controls: [],
  parts: [
    { id: 'desk', kind: 'group', transform: { position: [0, 0, 0], rotationDeg: [-90, 0, 0] } },
    { id: 'outline', parentId: 'desk', kind: 'archetype', archetype: 'outline', params: { contour: synthContour, status: 'locked' } },
    { id: 'twin', parentId: 'desk', kind: 'archetype', archetype: 'twin', params: { contour: synthContour, depth: 0.029, status: 'locked' }, transform: { position: [0, 0, 0.029] } },
    { id: 'brackets', kind: 'archetype', archetype: 'brackets', params: { boxSize: [0.3, 0.04, 0.11], status: 'locked' }, transform: { position: [0, 0.02, 0] } },
    { id: 'tag', kind: 'archetype', archetype: 'tag', params: { title: 'OP-1 FIELD', subtitle: 'synthesizer · locked', status: 'locked', channel: 'usb' }, transform: { position: [-0.06, 0.1, 0] } },
    { id: 'lead', kind: 'path', path: { from: [-0.14, 0.03, 0.05], to: [-0.14, 0.082, 0.0], width: 0.0015, color: '#EEFF41', keyline: true } },
    { id: 'reticle', kind: 'archetype', archetype: 'reticle', params: { reticleState: 'locked' }, transform: { position: [0.22, 0.08, 0.02] } },
  ],
  modelId: 'sam-3.1',
};
