import type { DeviceCardPayload, DeviceInfo } from '@ce/protocol';
import { MUSICAL_SYNTH_NAME, MUSICAL_SYNTH_PORT_ID } from '../devices/musicalSynth';
import { VISUAL_SYNTH_NAME } from '../devices/visualSynth';
import { musicalSynthExecutor } from './musical-synth';
import { virtualScreenExecutor } from './visual-synth';

export interface AgentTargetRoute {
  card?: DeviceCardPayload;
  selection?: { preferDeviceId?: string };
  driver?: { executor: { deviceId: string } };
}

/** A selected software instrument owns exactly one virtual port on exactly one browser. */
export function virtualAgentRoute(target?: AgentTargetRoute): { owner: string; portId: string; portName: string } | undefined {
  const visual = virtualScreenExecutor(target?.card);
  if (visual) return { owner: visual, portId: 'ce-visual-synth', portName: VISUAL_SYNTH_NAME };
  const musical = musicalSynthExecutor(target?.card);
  return musical ? { owner: musical, portId: MUSICAL_SYNTH_PORT_ID, portName: MUSICAL_SYNTH_NAME } : undefined;
}

export function agentCompanion(devices: DeviceInfo[], target?: AgentTargetRoute): DeviceInfo | undefined {
  const candidates = devices.filter(d => d.online && d.capabilities.includes('midi') && (d.role === 'companion' || d.kind === 'sim'));
  // Only a known companion (or the sim Mac) can be bound as the MIDI executor. A tag may remember the headset that
  // selected it, or the server's own `mac-local` helper; treating those as the Mac made every send fail with "not connected".
  // A known Mac companion that went offline still blocks: never silently switch to another Mac.
  const executor = (id?: string) => id && devices.some(d => d.deviceId === id && (d.role === 'companion' || d.kind === 'sim')) ? id : undefined;
  const bound = virtualAgentRoute(target)?.owner ?? executor(target?.selection?.preferDeviceId) ?? executor(target?.driver?.executor.deviceId);
  // A missing selected browser must never silently fall back to another person's hardware.
  if (bound) return candidates.find(d => d.deviceId === bound);
  const real = candidates.filter(d => d.kind !== 'sim' && !/^(reviewer|hands)-software@/.test(d.app ?? ''));
  return real.find(d => d.ports?.some(p => p.kind === 'midi-out' && !['ce-visual-synth', MUSICAL_SYNTH_PORT_ID].includes(p.id)))
    ?? real[0] ?? candidates.find(d => d.kind === 'sim');
}

export function agentPortAllowed(target: AgentTargetRoute | undefined, port: string): boolean {
  const route = virtualAgentRoute(target);
  return !route || port === route.portId || port === route.portName;
}
