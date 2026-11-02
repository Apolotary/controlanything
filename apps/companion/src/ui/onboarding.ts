import type { AgentStepPayload, DeviceInfo, Port, TargetStatusPayload } from '@ce/protocol';

export type CompanionStage = 'connecting' | 'pairing' | 'headset' | 'midi-permission' | 'usb' | 'setup' | 'working' | 'ready';

export interface SetupActivity {
  cardId: string;
  runId?: string;
  text: string;
  working: boolean;
  ready: boolean;
  canStop: boolean;
}

export interface CompanionInput {
  connected: boolean;
  pairing: boolean;
  authenticated: boolean;
  devices: DeviceInfo[];
  ports: Port[];
  midiSupported: boolean;
  midiEnabled: boolean;
  leader: boolean;
  activity?: SetupActivity;
}

export interface CompanionView {
  stage: CompanionStage;
  title: string;
  next: string;
  headset: string;
  synth: string;
  enableMidi: boolean;
}

/** A standby tab reads its own Mac's presence, never a different computer's USB ports. */
export function companionPorts(deviceId: string | undefined, devices: DeviceInfo[], local: Port[], leader: boolean): Port[] {
  const ports = leader ? local : devices.find((d) => d.deviceId === deviceId && d.online)?.ports ?? [];
  return ports.filter((p) => p.kind === 'midi-out' && p.state === 'connected');
}

/** The next action follows pairing → USB permission → cable → headset setup. */
export function companionView(input: CompanionInput): CompanionView {
  const quest = input.devices.find((d) => d.kind === 'quest' && d.online);
  const headset = quest ? 'Connected to Quest 3' : 'Waiting for your headset';
  const synth = input.ports.length ? `${input.ports.map((p) => p.name).join(', ')} on USB` : 'Plug in a synth (USB)';
  const base = { headset, synth, enableMidi: false };
  if (input.pairing) return { ...base, stage: 'pairing', title: 'Pair with your headset', next: 'In Control, choose Connect Mac and look at this QR code.' };
  if (!input.connected) return { ...base, stage: 'connecting', title: 'Connecting to your room', next: 'Your saved connection will return when the server is ready.' };
  if (!input.authenticated || !quest) return { ...base, stage: 'headset', title: 'Pair with your headset', next: 'Open ControlEverything in Quest Browser, then approve its code on this Mac.' };
  if (!input.midiSupported && !input.ports.length) return { ...base, stage: 'midi-permission', title: 'Open this page in Chrome', next: 'Chrome or Edge can connect your synth over USB.' };
  if (!input.midiEnabled && !input.ports.length && input.leader) return { ...base, stage: 'midi-permission', title: 'Connect your synth', next: 'Allow USB MIDI access so your headset can find the synth.', enableMidi: true };
  if (!input.ports.length) return { ...base, stage: 'usb', title: 'Plug in a synth (USB)', next: input.leader ? 'Connect the synth to this Mac with a USB cable.' : 'Keep the first companion tab open; it connects your USB devices.' };
  if (input.activity?.working) return { ...base, stage: 'working', title: 'Setting up your synth', next: 'Keep your headset on and follow its instructions.' };
  if (input.activity?.ready) return { ...base, stage: 'ready', title: 'Your controls are ready', next: 'Use the controls in your headset.' };
  return { ...base, stage: 'setup', title: 'Set it up from the headset', next: 'In Control, select the synth and choose Set up control.' };
}

/** Render only a target that the caller has associated with this Mac. */
export function setupActivity(name: string, target: TargetStatusPayload, step?: AgentStepPayload): SetupActivity | undefined {
  const base = { cardId: target.cardId, ...(target.runId ? { runId: target.runId } : {}), working: false, ready: false, canStop: false };
  const noun = name || 'your synth';
  if (target.state === 'armed' || target.state === 'controlling') return { ...base, ready: true, canStop: true, text: `${noun} is ready for control from Quest.` };
  if (target.state === 'forged' || target.state === 'arming') return { ...base, canStop: true, text: `Enable controls for ${noun} in your headset.` };
  if (target.state === 'failed') return { ...base, text: `Setup stopped for ${noun}. Follow the instructions in your headset.` };
  const phase = step && (!target.runId || !step.runId || step.runId === target.runId) && (step.status === 'running' || step.status === 'pending') ? step.phase : undefined;
  if (phase === 'verify' || target.state === 'verifying') {
    const sentence = target.state === 'verifying' ? target.sentence : undefined;
    const listening = sentence ? sentence.charAt(0).toLowerCase() + sentence.slice(1) : 'listening for a sound change…';
    return { ...base, working: true, canStop: true, text: `Quest is testing ${noun}: ${listening}` };
  }
  if (phase === 'link' || target.state === 'linking') return { ...base, working: true, canStop: true, text: `Quest is connecting to ${noun} over USB…` };
  if (phase === 'research' || target.state === 'researching') return { ...base, working: true, canStop: true, text: `Quest is reading the MIDI instructions for ${noun}…` };
  if (phase === 'drive' || phase === 'codegen' || target.state === 'driving') return { ...base, working: true, canStop: true, text: `Quest is writing controls for ${noun}…` };
  if (phase === 'forge' || phase === 'ui' || target.state === 'forging') return { ...base, working: true, canStop: true, text: `Quest is creating your interface for ${noun}…` };
  return undefined;
}
