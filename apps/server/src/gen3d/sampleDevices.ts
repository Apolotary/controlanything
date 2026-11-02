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

// --- drivers shaped like the discovery loop's templates (apps/server/src/agent/drive.ts) -------------
// Same action ids, kinds and expectations as the loop produces, so recordings made with them replay for
// any card the loop creates (replay falls back by category/transport and remaps or drops actions).

export const LOOP_LIGHT_DEVICE: ForgeDevice = { cardId: 'card_tpl_light', name: 'Ceiling light', maker: 'KOIZUMI', model: 'KRH-TG-9A', category: 'lighting' };
export const LOOP_LIGHT_DRIVER: ForgeDriver = {
  driverId: 'drv_tpl_light',
  cardId: 'card_tpl_light',
  transport: 'ir',
  executor: { deviceId: 'dev_cardputer_a' },
  actions: [
    { actionId: 'full', label: 'Full on', kind: 'trigger', expect: { sense: 'camera', effect: 'on' }, inverseActionId: 'off' },
    { actionId: 'off', label: 'Lights off', kind: 'trigger', expect: { sense: 'camera', effect: 'off' }, inverseActionId: 'full' },
    { actionId: 'brighter', label: 'Brighter', kind: 'trigger', expect: { sense: 'camera', effect: 'brighter' }, inverseActionId: 'dimmer' },
    { actionId: 'dimmer', label: 'Dimmer', kind: 'trigger', expect: { sense: 'camera', effect: 'dimmer' }, inverseActionId: 'brighter' },
    { actionId: 'night', label: 'Night light', kind: 'trigger', expect: { sense: 'camera', effect: 'dimmer' }, inverseActionId: 'full' },
    { actionId: 'warmer', label: 'Warmer', kind: 'trigger', expect: { sense: 'camera', effect: 'warmer' }, inverseActionId: 'cooler' },
    { actionId: 'cooler', label: 'Cooler', kind: 'trigger', expect: { sense: 'camera', effect: 'cooler' }, inverseActionId: 'warmer' },
    { actionId: 'level', label: 'Brightness', kind: 'set', range: { min: 0, max: 100, step: 10 }, expect: { sense: 'camera', effect: 'any' } },
  ],
};

export const LOOP_OP1_DEVICE: ForgeDevice = { cardId: 'card_tpl_op1f', name: 'OP-1 Field', maker: 'teenage engineering', model: 'OP-1 Field', category: 'synthesizer', accents: ['#2F6BFF', '#39C46A', '#F2F4F0', '#FF7A1A'] };
const cc = (n: number, label: string) => ({ actionId: `cc${n}`, label, kind: 'set' as const, range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', number: n }, expect: { sense: 'audio' as const, effect: 'any' } });
export const LOOP_OP1_DRIVER: ForgeDriver = {
  driverId: 'drv_tpl_op1f',
  cardId: 'card_tpl_op1f',
  transport: 'midi',
  executor: { deviceId: 'dev_mac', port: 'OP-1 Field' },
  actions: [
    cc(46, 'Synth engine parameter 1'),
    cc(47, 'Synth engine parameter 2'),
    cc(48, 'Synth engine parameter 3'),
    cc(49, 'Synth engine parameter 4'),
    cc(54, 'Patch FX parameter 1'),
    cc(55, 'Patch FX parameter 2'),
    { actionId: 'note', label: 'Play a note', kind: 'trigger', encode: { kind: 'midi', msg: 'note', number: 60 }, expect: { sense: 'audio', effect: 'louder' } },
  ],
};

export const LOOP_MAC_DEVICE: ForgeDevice = { cardId: 'card_tpl_mac', name: 'This Mac', maker: 'Apple', model: 'MacBook Pro', category: 'computer' };
export const LOOP_MAC_DRIVER: ForgeDriver = {
  driverId: 'drv_tpl_mac',
  cardId: 'card_tpl_mac',
  transport: 'local',
  executor: { deviceId: 'dev_mac' },
  actions: [
    { actionId: 'volume', label: 'Volume', kind: 'set', range: { min: 0, max: 100, step: 5 }, expect: { sense: 'ack', effect: 'any' } },
    { actionId: 'playpause', label: 'Play / pause', kind: 'toggle', expect: { sense: 'audio', effect: 'any' } },
    { actionId: 'say', label: 'Say hello', kind: 'trigger', expect: { sense: 'audio', effect: 'louder' } },
  ],
};

export const allPass = (d: ForgeDriver): Record<string, VerifyState> => Object.fromEntries(d.actions.map((a) => [a.actionId, 'pass' as VerifyState]));

/** A paired DevTerm as the loop sees it (category "computer", like the Mac; executor actions print + beep). */
export const LOOP_DEVTERM_DEVICE: ForgeDevice = { cardId: 'card_tpl_devterm', name: 'DevTerm', maker: 'ClockworkPi', model: 'devterm', category: 'computer' };
export const LOOP_DEVTERM_DRIVER: ForgeDriver = {
  driverId: 'drv_tpl_devterm',
  cardId: 'card_tpl_devterm',
  transport: 'local',
  executor: { deviceId: 'dev_devterm' },
  actions: [
    { actionId: 'print', label: 'Print receipt', kind: 'trigger', expect: { sense: 'ack', effect: 'any' } },
    { actionId: 'beep', label: 'Beep', kind: 'trigger', expect: { sense: 'audio', effect: 'louder' } },
  ],
};
