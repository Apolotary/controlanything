import type { AgentGuidance, AgentPhase, StepStatus, TargetState } from '@ce/protocol';
import type { LinkCapability } from './link';
import type { Target } from './types';

export const PHASE_SENTENCES: Record<AgentPhase, string> = {
  capture: 'Getting a clear view…',
  scan: 'Look at a device and pinch to choose it',
  identify: 'Working out what this is…',
  link: 'Finding a connection to your device…',
  research: 'Looking up how to control it…',
  plan: 'Planning the controls…',
  drive: 'Preparing commands for your device…',
  codegen: 'Preparing commands for your device…',
  verify: 'Testing the device now…',
  forge: 'Making your controls…',
  arm: 'Tap once to enable the controls',
  deploy: 'Your controls are ready',
  ui: 'Updating your controls…',
  control: 'Your controls are ready',
  other: 'Updating your device…',
};

const DONE: Partial<Record<AgentPhase, string>> = {
  identify: 'Device identified', link: 'Connection checked', research: 'Device instructions found',
  drive: 'Commands prepared', verify: 'Device check complete', forge: 'Your controls are ready',
  arm: 'Controls enabled', control: 'Control sent',
};

export function stepGuidance(phase: AgentPhase, status: StepStatus): AgentGuidance {
  if (status === 'fail') return { sentence: 'This check did not finish', hint: 'You can retry or choose another device', action: 'retry' };
  if (status === 'ok') return { sentence: DONE[phase] ?? PHASE_SENTENCES[phase] };
  if (phase === 'arm') return { sentence: PHASE_SENTENCES.arm, hint: 'Tap to confirm, or cancel', action: 'cancel' };
  return { sentence: PHASE_SENTENCES[phase], hint: 'You can cancel or choose another device', action: 'cancel' };
}

export function synthConnectionGuidance(companionOnline = false): AgentGuidance {
  const sentence = companionOnline ? 'Plug the synth into your Mac' : 'Open ControlEverything on your Mac and plug in the synth';
  return { sentence, hint: sentence, ...(companionOnline ? {} : { action: 'open-companion' as const }) };
}

export function linkGuidance(cap?: LinkCapability, companionOnline = false): AgentGuidance {
  if (cap === 'midi') return synthConnectionGuidance(companionOnline);
  if (cap === 'ir') return { sentence: 'Connect your Remo or IR receiver', hint: 'Pair it in the Mac app and keep it near the device', action: 'pair-device' };
  return { sentence: 'Open the Mac app to connect this device', hint: 'Keep the Mac app open and pair this device', action: 'open-companion' };
}

export function learnGuidance(receiver = 'IR receiver'): AgentGuidance {
  return { sentence: `Point your remote at the ${receiver} and press each button once`.slice(0, 200), hint: 'Follow the button prompts; keep the remote pointed at the receiver', action: 'cancel' };
}

export function stateGuidance(t: Target, state: TargetState): AgentGuidance {
  const ready = `Ready: ${t.controlCount ?? Object.values(t.verification).filter((v) => v === 'pass').length} controls`;
  switch (state) {
    case 'scanned': return stepGuidance('scan', 'running');
    case 'identifying': return stepGuidance('identify', 'running');
    case 'identified': return { sentence: `Found ${t.card?.name ?? 'your device'}`.slice(0, 200) };
    case 'linking': return stepGuidance('link', 'running');
    case 'needs-companion': return linkGuidance(t.card?.requires?.includes('midi') ? 'midi' : t.card?.requires?.includes('ir') ? 'ir' : 'local');
    case 'linked': return { sentence: 'Connected to your device' };
    case 'researching': return stepGuidance('research', 'running');
    case 'driving': return stepGuidance('drive', 'running');
    case 'verifying': return { sentence: t.driver?.transport === 'ir' ? 'Testing the light: keep it in view' : 'Testing the device now…', hint: 'Keep the device in view and its sensors connected; you can cancel', action: 'cancel' };
    case 'verified': return { sentence: 'Device checks complete' };
    case 'forging': return stepGuidance('forge', 'running');
    case 'forged': return { sentence: ready, hint: 'Tap once to enable the controls', action: 'cancel' };
    case 'arming': return stepGuidance('arm', 'running');
    case 'armed': case 'controlling': return { sentence: ready };
    case 'failed': return { sentence: 'Setup stopped', hint: 'Retry, cancel, or choose another device', action: 'retry' };
  }
}

export type TimedPhase = 'identify' | 'link' | 'learn' | 'research' | 'drive' | 'verify' | 'forge';
export const PHASE_TIMEOUT_MS: Record<TimedPhase, number> = {
  identify: 20_000, link: 45_000, learn: 60_000, research: 20_000, drive: 45_000, verify: 40_000, forge: 45_000,
};
const FAILURES: Record<TimedPhase, [string, string]> = {
  identify: ['I could not identify this device', 'Keep it in view and retry, or cancel and choose another device'],
  link: ['The device is not connected yet', 'Check the cable and pairing in the Mac app, then retry or cancel'],
  learn: ['No remote codes were learned in time', 'Point the remote at the receiver and retry, or cancel'],
  research: ['I could not find the device instructions', 'Check your connection and retry, or cancel'],
  drive: ['I could not prepare the device commands', 'Retry, or cancel and choose another device'],
  verify: ['I could not verify the device', 'Keep it in view and check its camera or microphone, then retry or cancel'],
  forge: ['I could not make the controls', 'Retry to make the controls again, or cancel'],
};
export function failureGuidance(phase: TimedPhase, timeout = false): AgentGuidance {
  const [sentence, hint] = FAILURES[phase];
  return { sentence: timeout ? `${sentence} — time ran out` : sentence, hint, action: 'retry' };
}
export const CANCELLED_GUIDANCE: AgentGuidance = {
  sentence: 'Setup cancelled', hint: 'Choose another device or retry this one', action: 'retry',
};
