import type { DeviceInfo } from '@ce/protocol';

/** A browser companion or the simulated room can provide the helper connection. */
export function isHelperDevice(device: Pick<DeviceInfo, 'kind' | 'role'>): boolean {
  return device.kind === 'sim' || (device.kind === 'mac' && device.role === 'companion');
}

export function helperDevices(devices: DeviceInfo[]): Pick<DeviceInfo, 'deviceId' | 'name' | 'kind' | 'online'>[] {
  return devices.filter(isHelperDevice).map(({ deviceId, name, kind, online }) => ({ deviceId, name, kind, online }));
}
