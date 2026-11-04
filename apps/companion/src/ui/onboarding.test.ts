import type { DeviceInfo, Port, TargetStatusPayload } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { companionPorts, companionView, setupActivity, type CompanionInput } from './onboarding';

const usb: Port = { id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' };
const device = (deviceId: string, kind: DeviceInfo['kind'], ports: Port[] = []): DeviceInfo => ({
  deviceId, kind, name: kind === 'quest' ? 'Quest 3' : 'Mac', online: true, role: kind === 'quest' ? 'hmd' : 'companion', capabilities: [], ports, canApprove: true, connections: 1, pairedAt: 0,
});
const quest = device('quest', 'quest');
const initial: CompanionInput = {
  connected: true, pairing: false, authenticated: true, devices: [quest], ports: [], midiSupported: true, midiEnabled: false, leader: true,
};
const target = (state: TargetStatusPayload['state']): TargetStatusPayload => ({ cardId: 'synth', runId: 'run-2', state, since: 0, executorDeviceId: 'mac' });

describe('companion first-run state', () => {
  it('ends pairing with explicit visual-demo steps without requesting USB access', () => {
    expect(companionView({ ...initial, connected: false, authenticated: false, pairing: true })).toMatchObject({ stage: 'pairing', title: 'Pair with your headset', next: 'Scan this QR code with your Quest 3, or enter the code in your headset.', enableMidi: false });
    expect(companionView({ ...initial, devices: [] })).toMatchObject({ stage: 'headset', title: 'Pair with your headset' });
    for (const overrides of [{}, { midiEnabled: true }, { midiSupported: false }, { leader: false }, { ports: [usb] }, { activity: setupActivity('OP-1 Field', target('armed')) }]) {
      const view = companionView({ ...initial, ...overrides });
      expect(view).toMatchObject({ stage: 'paired', title: 'Paired with Quest 3', enableMidi: false });
      expect(view.next).toContain('pinch this Mac');
      expect(view.next).toContain('ask Muse');
      expect(view.next).not.toMatch(/USB|MIDI/);
    }
  });

  it('offers permission, cable and setup help only after a requested synth setup', () => {
    const requested = { ...initial, midiSetupRequested: true };
    expect(companionView(requested)).toMatchObject({ stage: 'midi-permission', headset: 'Connected to Quest 3', enableMidi: true });
    expect(companionView({ ...requested, midiEnabled: true })).toMatchObject({ stage: 'usb', title: 'Plug in a synth (USB)', enableMidi: false });
    expect(companionView({ ...requested, midiEnabled: true, ports: [usb] })).toMatchObject({ stage: 'setup', title: 'Set it up from the headset', synth: 'OP-1 Field on USB' });
    expect(companionView({ ...requested, ports: [usb], activity: setupActivity('OP-1 Field', target('verifying')) })).toMatchObject({ stage: 'working', title: 'Setting up your synth' });
    expect(companionView({ ...requested, ports: [usb], activity: setupActivity('OP-1 Field', target('armed')) })).toMatchObject({ stage: 'ready', title: 'Device checks complete', next: expect.stringContaining('Ask Muse') });
  });

  it('returns to the cable step on unplug during a requested setup', () => {
    expect(companionView({ ...initial, midiSetupRequested: true, midiEnabled: true, activity: setupActivity('OP-1 Field', target('armed')) })).toMatchObject({ stage: 'usb', synth: 'Plug in a synth (USB)' });
  });

  it('retains saved pairing through server and headset reconnection', () => {
    expect(companionView({ ...initial, connected: false })).toMatchObject({ stage: 'connecting', headset: 'Waiting for your headset', enableMidi: false });
    expect(companionView({ ...initial, devices: [{ ...quest, online: false }] })).toMatchObject({ stage: 'headset', title: 'Waiting for Quest 3', headset: 'Waiting for your headset' });
    expect(companionView({ ...initial, devices: [], headsetPaired: true })).toMatchObject({ stage: 'headset', title: 'Waiting for Quest 3' });
    expect(companionView({ ...initial, midiEnabled: true, ports: [usb] }).stage).toBe('paired');
  });

  it('explains unsupported browsers and standby tabs when USB setup is requested', () => {
    expect(companionView({ ...initial, midiSetupRequested: true, midiSupported: false })).toMatchObject({ title: 'Open this page in Chrome', enableMidi: false });
    expect(companionView({ ...initial, midiSetupRequested: true, leader: false })).toMatchObject({ stage: 'usb', enableMidi: false, next: 'Keep the first companion tab open; it connects your USB devices.' });
  });
});

describe('ports belonging to this Mac', () => {
  it('shows current local outputs for the executor and filters inputs and disconnected ports', () => {
    expect(companionPorts('mac', [], [usb, { ...usb, id: 'ce-visual-synth', name: 'ControlAnything Visual Synth' }, { ...usb, id: 'input', kind: 'midi-in' }, { ...usb, id: 'gone', state: 'disconnected' }], true)).toEqual([usb]);
  });

  it('shows the first tab’s ports in another tab with the same saved identity', () => {
    expect(companionPorts('mac', [device('mac', 'mac', [usb])], [], false)).toEqual([usb]);
    expect(companionView({ ...initial, ports: [usb], leader: false }).stage).toBe('paired');
  });

  it('does not borrow another Mac or simulator’s ports or revive stale own ports', () => {
    expect(companionPorts('mac', [device('other', 'mac', [usb]), device('sim', 'sim', [usb])], [], false)).toEqual([]);
    expect(companionPorts('mac', [{ ...device('mac', 'mac', [usb]), online: false }], [], false)).toEqual([]);
    expect(companionPorts('mac', [device('mac', 'mac', [usb])], [], true)).toEqual([]);
  });
});

describe('headset setup activity', () => {
  it('describes testing and puts approval in the headset', () => {
    expect(setupActivity('OP-1 Field', { ...target('verifying'), sentence: 'Listening through the headset mic…' })).toMatchObject({ text: 'Quest is checking OP-1 Field: listening through the headset mic…', working: true, canStop: true });
    expect(setupActivity('OP-1 Field', target('verifying'))?.text).toBe('Quest is checking OP-1 Field: listening for a sound change…');
    expect(setupActivity('OP-1 Field', target('arming'))).toMatchObject({ text: 'Enable controls for OP-1 Field in your headset.', working: false, ready: false, canStop: true });
  });

  it('ignores annotation and a stale step from a previous run', () => {
    expect(setupActivity('OP-1 Field', target('identified'))).toBeUndefined();
    expect(setupActivity('OP-1 Field', target('researching'), { stepId: 'verify', cardId: 'synth', runId: 'run-1', phase: 'verify', status: 'running', title: 'test' })?.text).toBe('Quest is reading the MIDI instructions for OP-1 Field…');
  });

  it('shows a stopped state without retaining a running action', () => {
    expect(setupActivity('OP-1 Field', target('failed'))).toMatchObject({ working: false, ready: false, canStop: false });
  });
});
