import type { DeviceCardPayload, DeviceInfo } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { MidiProfile } from '../devices/profiles';
import { Dispatcher } from './dispatch';
import { pickExecutor } from './executors';
import { tryLink } from './link';

const card: DeviceCardPayload = { cardId: 'synth', name: 'EP-133', maker: 'Teenage Engineering', model: 'EP-133', category: 'synthesizer', protocols: ['midi'], evidence: [], confidence: 1 };
const reply = [0xf0, 0x7e, 0x33, 6, 2, 0, 0x20, 0x76, 0x20, 0, 2, 0, 0, 0, 0, 0, 0xf7];
const profile: MidiProfile = { id: 'ep-133', device: 'EP-133', manufacturer: 'Teenage Engineering', parameters: [], sources: [], usb: { portNameHint: 'EP-133' }, identity: { respondsToUniversalInquiry: true, replyExample: reply.map((b) => b.toString(16).padStart(2, '0')).join(' ') } };
const device: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'], canApprove: true, online: true, connections: 1, pairedAt: 1, ports: [{ id: 'out', kind: 'midi-out', name: 'EP-133' }] };

describe('selected executor and instrument identity', () => {
  it('does not redirect an offline selected phone to this Mac', () => {
    const roster = { macLocal: true, devices: () => [{ ...device, deviceId: 'phone', kind: 'iphone' as const, capabilities: ['local' as const], online: false }] };
    expect(pickExecutor(roster, 'local', { preferDeviceId: 'phone' })).toBeUndefined();
    expect(pickExecutor(roster, 'local')).toMatchObject({ deviceId: 'mac-local' });
  });
  it.each(['port', 'model', 'manufacturer', 'valid'] as const)('requires non-conflicting port and model evidence: %s', async (change) => {
    const dispatcher = new Dispatcher({ hub: { sendToDevice: () => 0 } });
    const bytes = [...reply];
    if (change === 'model') bytes[10] = 3;
    if (change === 'manufacturer') bytes[7] = 0x3c;
    vi.spyOn(dispatcher, 'exec').mockResolvedValue({ execId: 'probe', ok: true, sentAt: 1, reply: bytes });
    const client = change === 'port' ? { ...device, ports: [{ id: 'out', kind: 'midi-out' as const, name: 'OP-1' }] } : device;
    const selected = change === 'manufacturer' ? { ...card, maker: 'unknown' } : card;
    const result = await tryLink({ roster: { macLocal: false, devices: () => [client] }, dispatcher }, selected, 'midi', { linkId: 'link', profile });
    expect(result.result.verdict).toBe(change === 'valid' ? 'confirmed' : 'mismatch');
    dispatcher.close();
  });
  it('requires a unique instrument when several ports match', async () => {
    const roster = { macLocal: false, devices: () => [device, { ...device, deviceId: 'second' }] };
    expect(pickExecutor(roster, 'midi', { portHint: 'EP-133' })?.port).toBeUndefined();
    expect(pickExecutor(roster, 'midi', { portHint: 'EP-133', preferDeviceId: 'second' })).toMatchObject({ deviceId: 'second', port: { id: 'out' } });
    const oneMac = { macLocal: false, devices: () => [{ ...device, ports: [...device.ports!, { id: 'out-2', name: 'EP-133', kind: 'midi-out' as const }] }] };
    expect(pickExecutor(oneMac, 'midi', { portHint: 'EP-133' })?.port).toBeUndefined();
  });
});
