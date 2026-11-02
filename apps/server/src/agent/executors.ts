/**
 * Which paired client reaches a device: executors (midi / ir / local) and sensors (camera / mic / ir-capture)
 * are picked by CAPABILITY from presence, never by kind, so the sim room (one device with every capability)
 * and the real room (Mac companion + Cardputer + Quest) go through the same code.
 */
import type { Capability, DeviceInfo, DeviceKind, Port } from '@ce/protocol';
import { pickMidiOutput } from '../devices/midi';
import { MAC_LOCAL_CAPABILITIES, MAC_LOCAL_ID, MAC_LOCAL_NAME } from './maclocal';

export interface ExecutorPick {
  deviceId: string;
  name: string;
  kind: DeviceKind;
  port?: Port;
  /** the executor is the server itself */
  internal?: boolean;
}

export interface Roster {
  devices(): DeviceInfo[];
  /** the in-process Mac executor is available */
  macLocal: boolean;
  /** a sensor whose last sense.request timed out recently (a headset tab that stopped answering) */
  unhealthy?: (deviceId: string) => boolean;
}

export function macLocalInfo(): DeviceInfo {
  return { deviceId: MAC_LOCAL_ID, name: MAC_LOCAL_NAME, kind: 'mac', role: 'device', capabilities: [...MAC_LOCAL_CAPABILITIES], canApprove: false, online: true, connections: 0, pairedAt: 0 };
}

/** Every device that could act, online first, with the internal Mac executor added. */
export function roster(r: Roster): DeviceInfo[] {
  const list = r.devices();
  return r.macLocal ? [...list, macLocalInfo()] : list;
}

export function online(r: Roster, cap: Capability): DeviceInfo[] {
  return roster(r).filter((d) => d.online && d.capabilities.includes(cap));
}

/** Clients the HUD should suggest pairing for a capability. */
export function suggestedClients(cap: Capability): DeviceKind[] {
  switch (cap) {
    case 'midi':
      return ['mac', 'iphone'];
    case 'ir':
      return ['cardputer'];
    case 'camera':
      return ['quest', 'iphone'];
    case 'mic':
      return ['mac', 'iphone'];
    case 'printer':
      return ['devterm'];
    default:
      return ['mac'];
  }
}

/**
 * Pick an executor for a transport. MIDI: the device whose ports include an output matching `portHint`
 * (else the only MIDI device). IR: prefer a Nature Remo bridge, then a Cardputer, then anything with "ir".
 * local: the device the user pointed at (`preferDeviceId`), else the Mac.
 */
export function pickExecutor(r: Roster, cap: 'midi' | 'ir' | 'local', opts: { portHint?: string; preferDeviceId?: string } = {}): ExecutorPick | undefined {
  const cands = online(r, cap);
  if (!cands.length) return undefined;
  const toPick = (d: DeviceInfo, port?: Port): ExecutorPick => ({ deviceId: d.deviceId, name: d.name, kind: d.kind, port, internal: d.deviceId === MAC_LOCAL_ID });
  if (opts.preferDeviceId) {
    const d = cands.find((x) => x.deviceId === opts.preferDeviceId);
    if (d) return toPick(d, cap === 'midi' ? pickMidiOutput(d.ports, opts.portHint) : undefined);
  }
  if (cap === 'midi') {
    for (const d of cands) {
      const port = pickMidiOutput(d.ports, opts.portHint);
      if (port && opts.portHint && port.name.toLowerCase().includes(opts.portHint.toLowerCase())) return toPick(d, port);
    }
    for (const d of cands) {
      const port = pickMidiOutput(d.ports, opts.portHint);
      if (port) return toPick(d, port);
    }
    return toPick(cands[0]);
  }
  if (cap === 'ir') {
    // a Nature Remo on the LAN blasts further than the Cardputer's unit; the Cardputer stays the alternative
    const remo = cands.find((d) => d.kind === 'remo');
    const card = cands.find((d) => d.kind === 'cardputer');
    return toPick(remo ?? card ?? cands[0]);
  }
  const mac = cands.find((d) => d.deviceId === MAC_LOCAL_ID) ?? cands.find((d) => d.kind === 'mac');
  return toPick(mac ?? cands[0]);
}

/** Sensors for a sense kind: the device that saw the target first when it still is online. */
export function pickSensor(r: Roster, cap: 'camera' | 'mic' | 'ir', opts: { preferDeviceId?: string; excludeDeviceId?: string } = {}): DeviceInfo | undefined {
  const all = online(r, cap).filter((d) => d.deviceId !== opts.excludeDeviceId && d.deviceId !== MAC_LOCAL_ID);
  // a sensor that stopped answering yields to a healthy one when there is one (else it is still tried)
  const healthy = all.filter((d) => !r.unhealthy?.(d.deviceId));
  const cands = healthy.length ? healthy : all;
  if (!cands.length) return undefined;
  if (opts.preferDeviceId) {
    const d = cands.find((x) => x.deviceId === opts.preferDeviceId);
    if (d) return d;
  }
  if (cap === 'camera') return cands.find((d) => d.kind === 'quest') ?? cands.find((d) => d.kind === 'sim') ?? cands[0];
  if (cap === 'mic') return cands.find((d) => d.kind === 'mac') ?? cands.find((d) => d.kind === 'sim') ?? cands[0];
  return cands.find((d) => d.kind === 'cardputer') ?? cands.find((d) => d.kind === 'remo') ?? cands[0];
}

/** All paired devices (online or not) that could serve a capability, for link.request.candidates. */
export function candidatesFor(r: Roster, cap: Capability): { deviceId: string; name: string; kind: DeviceKind; online: boolean; port?: string }[] {
  return roster(r)
    .filter((d) => d.capabilities.includes(cap))
    .map((d) => ({ deviceId: d.deviceId, name: d.name, kind: d.kind, online: d.online, port: d.ports?.find((p) => p.kind === 'midi-out')?.name }));
}
