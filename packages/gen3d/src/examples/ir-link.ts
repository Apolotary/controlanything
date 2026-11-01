import type { Gen3dSpec } from '../schema';

/**
 * LINK: the agent tries IR codes from the Cardputer while the camera verifies the ceiling light.
 * An IR beam (cone) runs from the Cardputer to the light; the matrix shows tried/solved codes; the oracle
 * strip shows sent/expected/seen; the upload bar lights per real step.
 */
export const irLink: Gen3dSpec = {
  spec: 'ce.gen3d/1',
  specId: 'ex_ir_link',
  rev: 1,
  title: 'Link · ceiling light',
  source: 'hand',
  device: { cardId: 'card_light', name: 'Ceiling light', transport: 'ir' },
  anchor: { mode: 'world', position: [0, 1.2, -0.9], rotationDeg: [0, 0, 0], grabbable: false },
  state: { armed: false, reason: 'linking: 3 of 36 codes tried' },
  controls: [],
  parts: [
    {
      id: 'beam',
      kind: 'archetype',
      archetype: 'ping-line',
      params: { channel: 'ir', status: 'linking', from: [0.35, -0.9, 0.3], to: [0, 1.0, -0.2], particles: 16, speed: 0.9, title: 'IR · NEC 38 kHz' },
    },
    {
      id: 'matrix',
      kind: 'archetype',
      archetype: 'link-matrix',
      params: { rows: 6, cols: 6, size: 0.04, title: 'LINK · IR', subtitle: 'camera verifies each code', picked: [0, 7, 14], solved: [14], current: 21 },
      transform: { position: [-0.3, 0, 0] },
    },
    { id: 'oracle', kind: 'archetype', archetype: 'oracle-strip', params: { sent: '0x20DF10EF', expect: 'ON', seen: 'brighter', verdict: 'ok', width: 0.3 }, transform: { position: [0.18, 0.1, 0] } },
    { id: 'upload', kind: 'archetype', archetype: 'upload-bar', params: { title: 'UPLOAD · FULL ON', stepsDone: 3, width: 0.26 }, transform: { position: [0.18, 0.04, 0] } },
    { id: 'tag', kind: 'archetype', archetype: 'tag', params: { title: 'CEILING LIGHT', subtitle: 'linking', status: 'linking', channel: 'ir' }, transform: { position: [0.18, -0.03, 0] } },
    { id: 'chips', kind: 'archetype', archetype: 'model-chips', params: { models: [{ id: 'muse-spark-1.3', state: 'live' }, { id: 'sam-3.1', state: 'done' }, { id: 'muse-voice-transcribe-1.0', state: 'idle' }] }, transform: { position: [0.18, -0.09, 0] } },
  ],
  modelId: 'muse-spark-1.3',
};
