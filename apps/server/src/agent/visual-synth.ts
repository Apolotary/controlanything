import type { DeviceCardPayload, DeviceInfo } from '@ce/protocol';
import { VISUAL_SYNTH_NAME } from '../devices/visualSynth';

export const VIRTUAL_SCREEN_NOTE = 'virtual:visual-synth:';
export const VIRTUAL_SCREEN_GUIDANCE = 'Mac visuals open. Set up control to play them with your hands.';
/** One card for the Mac's visual synth, whichever companion instance hosts it (re-pairing rebinds it). */
export const VISUAL_SYNTH_CARD_ID = 'visual-synth-mac';
/** A renderer or companion that disappears for less than this keeps its setup and controls. */
export const VISUAL_PRESENCE_GRACE_MS = 15_000;

/** What the on-device detector calls the Mac (or its screen). */
export function isLaptopLabel(label = ''): boolean {
  return /\b(laptop|computer|macbook|notebook|this mac|mac|monitor|tv|television|display|screen|visual[\s-]?synth)\b/i.test(label);
}

/** An advertised virtual output can be launched even while its renderer is closed. */
export function visualSynthHosts(devices: DeviceInfo[]): DeviceInfo[] {
  return devices.filter((device) => device.online && device.capabilities.includes('midi')
    && (device.role === 'companion' || device.kind === 'sim')
    && device.ports?.some((port) => port.id === 'ce-visual-synth' && port.kind === 'midi-out'));
}

/** Explicit selection binds this app's virtual output, never a physical synth with a similar name. */
export function visualSynthCompanions(devices: DeviceInfo[]): DeviceInfo[] {
  return visualSynthHosts(devices).filter((device) => device.ports?.some((port) => port.id === 'ce-visual-synth' && port.kind === 'midi-out' && port.state === 'connected'));
}

export function virtualScreenExecutor(card?: Pick<DeviceCardPayload, 'notes'>): string | undefined {
  return card?.notes?.startsWith(VIRTUAL_SCREEN_NOTE) ? card.notes.slice(VIRTUAL_SCREEN_NOTE.length) || undefined : undefined;
}

export function visualSynthCard(executor: DeviceInfo): DeviceCardPayload {
  return { cardId: VISUAL_SYNTH_CARD_ID, name: VISUAL_SYNTH_NAME, maker: 'ControlAnything', model: 'Visual Synth', category: 'synthesizer',
    confidence: 1, protocols: ['midi'], requires: ['midi'], source: executor.kind === 'sim' ? 'fixture' : 'live',
    notes: `${VIRTUAL_SCREEN_NOTE}${executor.deviceId}`,
    evidence: ['The built-in silent visual instrument on the Mac screen (authored in this repo, not identified).',
      `${executor.name} advertises the ce-visual-synth output. This is not laptop playback.`,
      'Screen placement is user-aimed. Each command is checked by the headset camera, or by the renderer\'s own report.'] };
}
