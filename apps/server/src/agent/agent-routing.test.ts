import type { DeviceInfo } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { agentCompanion, agentPortAllowed, virtualAgentRoute } from './agent-routing';
import { musicalSynthCard } from './musical-synth';
import { visualSynthCard } from './visual-synth';

const device = (deviceId: string, app: string, ports: string[]): DeviceInfo => ({ deviceId, name: deviceId, app, kind: 'web', role: 'companion', online: true,
  capabilities: ['midi'], ports: ports.map(id => ({ id, name: id, kind: 'midi-out', state: 'connected' })) } as DeviceInfo);
const mac = device('physical-mac', 'companion', ['OP-1', 'ce-visual-synth']);
const web = device('reviewer-browser', 'reviewer-software@1', ['ce-visual-synth', 'ce-musical-synth']);

describe('selected Muse connector routing', () => {
  it('keeps virtual instruments on their exact owner even alongside physical outputs', () => {
    for (const card of [visualSynthCard(web), musicalSynthCard(web)]) {
      const target = { card }, route = virtualAgentRoute(target)!;
      expect(agentCompanion([mac, web], target)?.deviceId).toBe(web.deviceId);
      expect(agentPortAllowed(target, route.portId)).toBe(true);
      expect(agentPortAllowed(target, route.portName)).toBe(true);
      expect(agentPortAllowed(target, 'OP-1')).toBe(false);
      expect(agentCompanion([mac], target)).toBeUndefined();
    }
  });

  it('honors exact physical selection and never picks a reviewer as the default Mac', () => {
    expect(agentCompanion([web, mac])?.deviceId).toBe(mac.deviceId);
    expect(agentCompanion([web])).toBeUndefined();
    expect(agentCompanion([mac, web], { selection: { preferDeviceId: 'missing' } })).toBeUndefined();
    expect(agentCompanion([mac, web], { selection: { preferDeviceId: mac.deviceId } })?.deviceId).toBe(mac.deviceId);
  });

  it('separates reviewer cards from the canonical Quest demo cards', () => {
    expect(visualSynthCard(web).cardId).not.toBe(visualSynthCard(mac).cardId);
    expect(musicalSynthCard(web).cardId).not.toBe(musicalSynthCard(mac).cardId);
  });
});
