import type { DeviceCardPayload, DeviceInfo } from '@ce/protocol';
import { MUSICAL_SYNTH_NAME, MUSICAL_SYNTH_PORT_ID } from '../devices/musicalSynth';
export const MUSICAL_SYNTH_CARD_ID = 'musical-synth-mac';
export const MUSICAL_SYNTH_NOTE = 'virtual:musical-synth:';
export const MUSICAL_SYNTH_GUIDANCE = 'On the Mac, open ControlAnything Synth and choose Sound on. Then retry setup.';
export function musicalSynthExecutor(card?: Pick<DeviceCardPayload, 'notes'>): string | undefined {
  return card?.notes?.startsWith(MUSICAL_SYNTH_NOTE) ? card.notes.slice(MUSICAL_SYNTH_NOTE.length) || undefined : undefined;
}
export function musicalSynthHosts(devices: DeviceInfo[], ready = false): DeviceInfo[] {
  return devices.filter(d => d.online && d.capabilities.includes('midi') && d.role === 'companion'
    && d.ports?.some(p => p.id === MUSICAL_SYNTH_PORT_ID && p.kind === 'midi-out' && (!ready || p.state === 'connected')));
}
export function musicalSynthCard(executor: DeviceInfo): DeviceCardPayload {
  const reviewer = /^(reviewer|hands)-software@/.test(executor.app ?? '');
  return { cardId: reviewer ? `musical-synth-reviewer-${executor.deviceId}` : MUSICAL_SYNTH_CARD_ID, name: MUSICAL_SYNTH_NAME, maker: 'ControlAnything', model: 'Synth', category: 'synthesizer',
    confidence: 1, protocols: ['midi'], requires: ['midi'], source: 'live', notes: `${MUSICAL_SYNTH_NOTE}${executor.deviceId}`,
    evidence: ['Authored browser software instrument selected explicitly, not a camera identification.',
      `${executor.name} advertises the exact ${MUSICAL_SYNTH_PORT_ID} output. It cannot send physical MIDI.`,
      'Sound stays locked until the person at the Mac chooses Sound on. Verification samples the software audio graph, not a physical microphone.'] };
}
