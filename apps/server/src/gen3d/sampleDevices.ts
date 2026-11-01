/**
 * Sample verified drivers (SPEC §3.2 shape) for the two hero devices: used by tests, the opt-in live script,
 * the demo route (POST /api/gen3d/generate {cardId: "card_light" | "card_op1f"}) and replay mode, until the
 * discovery loop hands FORGE the real drivers. Action ids, ranges and labels are sample data, not hardware facts.
 */
import type { ForgeDevice, ForgeDriver, VerifyState } from './forgeTypes';


export const FORGE_OP1_DEVICE: ForgeDevice = {
  cardId: 'card_op1f',
  name: 'OP-1 Field',
  maker: 'teenage engineering',
  model: 'OP-1 Field',
  category: 'synthesizer',
  accents: ['#2F6BFF', '#39C46A', '#F2F4F0', '#FF7A1A'],
  notes: 'Four colour encoders (blue, green, white, orange) drive the current synth engine.',
};

/** sample encoder labels (a filter/envelope page); the real map comes from the stored midi.guide chart */
export const FORGE_OP1_DRIVER: ForgeDriver = {
  driverId: 'drv_op1f',
  cardId: 'card_op1f',
  transport: 'midi',
  executor: { deviceId: 'dev_mac', port: 'OP-1 Field' },
  actions: [
    { actionId: 'enc.blue', label: 'Cutoff (blue encoder, CC)', kind: 'set', range: { min: 0, max: 127, step: 1 }, expect: { sense: 'audio', effect: 'tone-up' } },
    { actionId: 'enc.green', label: 'Resonance (green encoder, CC)', kind: 'set', range: { min: 0, max: 127, step: 1 }, expect: { sense: 'audio', effect: 'tone-up' } },
    { actionId: 'enc.white', label: 'Envelope attack (white encoder, CC)', kind: 'set', range: { min: 0, max: 127, step: 1 }, expect: { sense: 'audio', effect: 'tone-up' } },
    { actionId: 'enc.orange', label: 'Envelope release (orange encoder, CC)', kind: 'set', range: { min: 0, max: 127, step: 1 }, expect: { sense: 'audio', effect: 'tone-up' } },
    { actionId: 'note.play', label: 'Play one note (value = MIDI note number, 600 ms)', kind: 'set', range: { min: 36, max: 84, step: 1 }, expect: { sense: 'audio', effect: 'louder' } },
    { actionId: 'notes.off', label: 'All notes off', kind: 'trigger', expect: { sense: 'audio', effect: 'quieter' } },
  ],
  signals: [{ name: 'clock_bpm', description: 'tempo from the MIDI clock' }],
};

export const FORGE_OP1_VERIFIED: Record<string, VerifyState> = { 'enc.blue': 'pass', 'enc.green': 'pass', 'enc.white': 'pass', 'enc.orange': 'pass', 'note.play': 'pass', 'notes.off': 'pass' };

export const FORGE_LIGHT_DEVICE: ForgeDevice = {
  cardId: 'card_light',
  name: 'Ceiling light',
  maker: 'KOIZUMI',
  model: 'remote KRH-TG-9A',
  category: 'lighting',
  notes: 'Japanese LED ceiling light; codes learned from its remote and named by what the camera saw.',
};

export const FORGE_LIGHT_DRIVER: ForgeDriver = {
  driverId: 'drv_light',
  cardId: 'card_light',
  transport: 'ir',
  executor: { deviceId: 'dev_cardputer_a' },
  actions: [
    { actionId: 'ir.full', label: '全灯 full light (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'on' } },
    { actionId: 'ir.off', label: '消灯 off (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'off' } },
    { actionId: 'ir.night', label: '常夜灯 night light (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'dimmer' } },
    { actionId: 'ir.brighter', label: '明るく one step brighter (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'brighter' } },
    { actionId: 'ir.darker', label: '暗く one step darker (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'dimmer' } },
    { actionId: 'ir.warmer', label: '暖かい光 warmer (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'warmer' } },
    { actionId: 'ir.cooler', label: '白い光 cooler (learned)', kind: 'trigger', expect: { sense: 'camera', effect: 'cooler' } },
  ],
};

/** the warmth codes are learned but not yet seen by the camera: their controls render disarmed */
export const FORGE_LIGHT_VERIFIED: Record<string, VerifyState> = { 'ir.full': 'pass', 'ir.off': 'pass', 'ir.night': 'pass', 'ir.brighter': 'pass', 'ir.darker': 'pass', 'ir.warmer': 'untested', 'ir.cooler': 'pending' };
