import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '@ce/protocol';
import { helperDevices } from './helpers';

const device = (deviceId: string, kind: DeviceInfo['kind'], role: DeviceInfo['role'], online = true): DeviceInfo => ({
  deviceId, name: deviceId, kind, role, online, capabilities: [], canApprove: true, connections: online ? 1 : 0, pairedAt: 1,
});

describe('helper presence', () => {
  it('includes companion Macs and the simulated room with current presence, without other device fields', () => {
    expect(helperDevices([
      device('Laptop', 'mac', 'companion'), device('Offline laptop', 'mac', 'companion', false),
      device('Room', 'sim', 'device'), device('Headset', 'quest', 'hmd'), device('Server', 'mac', 'device'),
      device('IR node', 'cardputer', 'device'),
    ])).toEqual([
      { deviceId: 'Laptop', name: 'Laptop', kind: 'mac', online: true },
      { deviceId: 'Offline laptop', name: 'Offline laptop', kind: 'mac', online: false },
      { deviceId: 'Room', name: 'Room', kind: 'sim', online: true },
    ]);
  });
});
