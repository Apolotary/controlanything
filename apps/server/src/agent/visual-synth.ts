import { createHash } from 'node:crypto';
import type { DeviceCardPayload, DeviceInfo } from '@ce/protocol';
import { VISUAL_SYNTH_NAME } from '../devices/visualSynth';

export const VIRTUAL_SCREEN_NOTE = 'virtual:visual-synth:';
export const VIRTUAL_SCREEN_GUIDANCE = 'The Mac visuals are open. Keep the visual screen centered in the camera guide, then choose Set up control.';

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
  const cardId = `visual-synth-${createHash('sha256').update(executor.deviceId).digest('hex').slice(0, 20)}`;
  return { cardId, name: VISUAL_SYNTH_NAME, maker: 'ControlAnything', model: 'Visual Synth', category: 'synthesizer',
    confidence: 1, protocols: ['midi'], requires: ['midi'], source: executor.kind === 'sim' ? 'fixture' : 'live',
    notes: `${VIRTUAL_SCREEN_NOTE}${executor.deviceId}`,
    evidence: ['The user explicitly selected the built-in virtual visual instrument.',
      `${executor.name} advertises the ce-visual-synth output. This is not laptop playback.`,
      'Screen placement is user-aimed, not an object detection. Camera verification is still required.'] };
}
