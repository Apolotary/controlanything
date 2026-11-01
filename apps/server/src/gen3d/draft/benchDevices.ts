/**
 * BENCHMARK ONLY (research/12): sample cards and pre-SPEC drivers for the two hero devices. Action names and ranges describe what the
 * drivers are expected to expose; they are inputs to the generator, not facts about the hardware.
 */
import type { DeviceCardPayload } from '@ce/protocol';
import type { DeviceDriver } from './driver';

export const OP1_CARD: DeviceCardPayload = {
  cardId: 'op1-field',
  name: 'OP-1 Field',
  maker: 'teenage engineering',
  model: 'OP-1 Field',
  category: 'synthesizer',
  confidence: 0.93,
  protocols: ['midi'],
  evidence: ['camera: grey aluminium synth with four colour encoders (blue, green, white, orange)', 'USB says "OP-1 Field" (class-compliant MIDI)'],
  requires: ['midi'],
  notes: 'Encoder colours: blue #2F6BFF, green #39C46A, white #F2F4F0, orange #FF7A1A.',
};

export const OP1_DRIVER: DeviceDriver = {
  cardId: 'op1-field',
  name: 'OP-1 Field',
  transport: 'usb-midi',
  actions: [
    {
      name: 'encoder.set',
      description: 'Turn one of the four colour encoders of the current synth engine to an absolute value (MIDI CC, channel 1). What each encoder changes depends on the loaded engine.',
      params: [
        { name: 'encoder', type: 'enum', values: ['blue', 'green', 'white', 'orange'] },
        { name: 'value', type: 'int', min: 0, max: 127 },
      ],
      effects: ['mic:timbre_change'],
    },
    {
      name: 'note.play',
      description: 'Play one note for a duration.',
      params: [
        { name: 'note', type: 'int', min: 24, max: 96 },
        { name: 'velocity', type: 'int', min: 1, max: 127 },
        { name: 'durationMs', type: 'int', min: 20, max: 4000 },
      ],
      effects: ['mic:sound_starts'],
    },
    { name: 'notes.off', description: 'Stop every sounding note (panic).', params: [], effects: ['mic:sound_stops'] },
  ],
  signals: [
    { name: 'beat', description: 'One event per quarter note from the OP-1 Field MIDI clock (40-240 BPM).', rateHz: 2 },
    { name: 'note.on', description: 'A key was played on the OP-1 Field keyboard (note, velocity).' },
    { name: 'level', description: 'Output loudness 0..1 measured by the Mac microphone.', rateHz: 10 },
  ],
  notes: 'Label encoders by colour unless the engine is known.',
};

export const LIGHT_CARD: DeviceCardPayload = {
  cardId: 'ceiling-light',
  name: 'Ceiling light',
  maker: 'KOIZUMI',
  model: 'KRH-TG-9A (remote)',
  category: 'lighting',
  confidence: 0.81,
  protocols: ['ir'],
  evidence: ['camera: round LED ceiling light, 2.4 m up', 'remote label: KOIZUMI KRH-TG-9A'],
  requires: ['ir'],
  notes: 'Warm white LED. Controlled by infrared through the Cardputer node.',
};

export const LIGHT_DRIVER: DeviceDriver = {
  cardId: 'ceiling-light',
  name: 'Ceiling light (KOIZUMI IR)',
  transport: 'ir',
  emitsLight: true,
  actions: [
    { name: 'light.power', description: 'On (full brightness) or off.', params: [{ name: 'on', type: 'bool' }], effects: ['camera:light_on', 'camera:light_off'] },
    { name: 'light.on', description: 'Full brightness (remote: 全灯).', params: [], effects: ['camera:light_on', 'camera:brighter'] },
    { name: 'light.off', description: 'Off (remote: 消灯).', params: [], effects: ['camera:light_off'] },
    { name: 'light.night', description: 'Night light, a dim warm glow (remote: 常夜灯).', params: [], effects: ['camera:darker'] },
    { name: 'light.brighter', description: 'One step brighter (remote: 明るく).', params: [], effects: ['camera:brighter'] },
    { name: 'light.dimmer', description: 'One step dimmer (remote: 暗く).', params: [], effects: ['camera:darker'] },
    {
      name: 'light.level',
      description: 'Go to brightness level 1-10; the driver sends the right number of steps from the tracked state.',
      params: [{ name: 'level', type: 'int', min: 1, max: 10 }],
      effects: ['camera:brighter', 'camera:darker'],
    },
  ],
  signals: [],
  notes: 'Mounted on the ceiling, out of reach: float the controls in front of the user.',
};

export const SAMPLE_DRIVERS: DeviceDriver[] = [OP1_DRIVER, LIGHT_DRIVER];
export const SAMPLE_CARDS: DeviceCardPayload[] = [OP1_CARD, LIGHT_CARD];

