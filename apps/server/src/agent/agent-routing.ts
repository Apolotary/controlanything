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
  const bound = virtualAgentRoute(target)?.owner ?? target?.selection?.preferDeviceId ?? target?.driver?.executor.deviceId;
  // A missing selected browser must never silently fall back to another person's hardware.
  if (bound) return candidates.find(d => d.deviceId === bound);
  const real = candidates.filter(d => d.kind !== 'sim' && !d.app?.startsWith('reviewer-software@'));
  return real.find(d => d.ports?.some(p => p.kind === 'midi-out' && !['ce-visual-synth', MUSICAL_SYNTH_PORT_ID].includes(p.id)))
    ?? real[0] ?? candidates.find(d => d.kind === 'sim');
}

export function agentPortAllowed(target: AgentTargetRoute | undefined, port: string): boolean {
  const route = virtualAgentRoute(target);
  return !route || port === route.portId || port === route.portName;
}
