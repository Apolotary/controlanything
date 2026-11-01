import type { Gen3dSpec } from '../schema';

/**
 * The ceiling light: a dimmer ring, a 5-step warmth bar, a pull cord for power and a hack list of
 * one-shot actions, all driven over IR through the Cardputer. Floats at a comfortable height
 * (the light itself is outside the comfort zone).
 */
export const ceilingDimmer: Gen3dSpec = {
  spec: 'ce.gen3d/1',
  specId: 'ex_ceiling_dimmer',
  rev: 1,
  title: 'Ceiling light',
  source: 'hand',
  device: { cardId: 'card_light', name: 'Ceiling light', category: 'lighting', transport: 'ir' },
  anchor: { mode: 'floating', distance: 0.6, pitchDeg: -10, faceUser: true, grabbable: true },
  state: { armed: true, reason: 'IR 0x20DF10EF · seen: brighter ✓', verifiedBy: ['camera-oracle'] },
  controls: [
    { id: 'brightness', kind: 'continuous', label: 'BRIGHTNESS', range: { min: 0, max: 100, step: 5 }, default: 70, unit: '%', binding: { action: 'ir.send', args: { device: 'koizumi-krh-tg-9a', param: 'brightness' } } },
    { id: 'warmth', kind: 'stepped', label: 'WARMTH', range: { min: 0, max: 4, step: 1 }, default: 1, stepLabels: ['WARM', 'SOFT', 'NEUTRAL', 'COOL', 'DAY'], binding: { action: 'ir.send', args: { device: 'koizumi-krh-tg-9a', param: 'warmth' } } },
    { id: 'power', kind: 'toggle', label: 'POWER', default: true, binding: { action: 'ir.send', args: { device: 'koizumi-krh-tg-9a', param: 'power' } } },
    { id: 'full', kind: 'trigger', label: 'FULL ON', binding: { action: 'ir.send', args: { device: 'koizumi-krh-tg-9a', code: 'zento' } } },
    { id: 'night', kind: 'trigger', label: 'NIGHT LIGHT', binding: { action: 'ir.send', args: { device: 'koizumi-krh-tg-9a', code: 'joyato' } } },
    { id: 'off', kind: 'trigger', label: 'OFF', binding: { action: 'ir.send', args: { device: 'koizumi-krh-tg-9a', code: 'shoto' } } },
  ],
  parts: [
    { id: 'tag', kind: 'archetype', archetype: 'tag', params: { title: 'CEILING LIGHT', subtitle: 'controlled · IR via Cardputer', status: 'controlled', channel: 'ir' }, transform: { position: [-0.08, 0.15, 0] } },
    { id: 'ring', kind: 'archetype', archetype: 'dimmer-ring', controlId: 'brightness', params: { size: 0.14 }, transform: { position: [-0.08, 0, 0] } },
    { id: 'warm', kind: 'archetype', archetype: 'wheel', controlId: 'warmth', params: { mode: 'warmth', width: 0.16 }, transform: { position: [-0.08, -0.13, 0] } },
    { id: 'cord', kind: 'archetype', archetype: 'pull-cord', controlId: 'power', params: { length: 0.14 }, transform: { position: [0.06, 0.12, 0] } },
    {
      id: 'hacks',
      kind: 'archetype',
      archetype: 'hack-list',
      params: {
        title: 'HACKS',
        subtitle: 'IR · verified by camera',
        width: 0.22,
        items: [
          { id: 'h1', label: 'FULL ON', detail: '全灯 · 0x20DF10EF', kind: 'action', channel: 'ir', controlId: 'full', status: 'verified' },
          { id: 'h2', label: 'NIGHT LIGHT', detail: '常夜灯', kind: 'action', channel: 'ir', controlId: 'night', status: 'verified' },
          { id: 'h3', label: 'OFF', detail: '消灯', kind: 'action', channel: 'ir', controlId: 'off', status: 'ready' },
        ],
      },
      transform: { position: [0.2, -0.04, 0] },
    },
  ],
  modelId: 'muse-spark-1.3',
};
