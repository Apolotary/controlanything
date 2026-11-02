import { isMessageType, type AgentPhase, type AgentStepPayload, type AnyMessage, type Message, type TargetState, type UiSpecPayload } from '@ce/protocol';

export interface CalmStatus {
  text: string;
  working: boolean;
}

const phaseText: Record<AgentPhase, [string, string]> = {
  capture: ['Looking at the room', 'Room captured'],
  scan: ['Scanning the room', 'Room scanned'],
  identify: ['Identifying your device', 'Device identified'],
  link: ['Connecting your device', 'Device connected'],
  research: ['Learning how your device works', 'Device instructions found'],
  plan: ['Planning your controls', 'Controls planned'],
  drive: ['Writing your device driver', 'Device driver written'],
  codegen: ['Writing your device driver', 'Device driver written'],
  verify: ['Testing your device', 'Testing complete'],
  forge: ['Creating your controls', 'Controls created'],
  arm: ['Open Details to approve your controls', 'Approval received'],
  deploy: ['Preparing your device', 'Device prepared'],
  ui: ['Creating your controls', 'Controls created'],
  control: ['Updating your device', 'Device updated'],
  other: ['Working on your device', 'Idle'],
};

const targetText: Record<TargetState, CalmStatus> = {
  scanned: { text: 'Room scanned', working: false },
  identifying: { text: 'Identifying your device', working: true },
  identified: { text: 'Device identified', working: false },
  linking: { text: 'Connecting your device', working: true },
  'needs-companion': { text: 'Connect a bridge to continue', working: false },
  linked: { text: 'Device connected', working: false },
  researching: { text: 'Learning how your device works', working: true },
  driving: { text: 'Writing your device driver', working: true },
  verifying: { text: 'Testing your device', working: true },
  verified: { text: 'Testing complete', working: false },
  forging: { text: 'Creating your controls', working: true },
  forged: { text: 'Controls created: open Details', working: false },
  arming: { text: 'Open Details to approve your controls', working: false },
  armed: { text: 'Ready: controls armed', working: false },
  controlling: { text: 'Ready: controls armed', working: false },
  failed: { text: 'Could not finish: open Details', working: false },
};

function stepStatus(step: AgentStepPayload): CalmStatus {
  const prompt = step.title.match(/^learn:\s*(.+)$/i)?.[1];
  const learning = prompt || /learning (?:the|your|its own) remote/i.test(step.title);
  if (learning) {
    if (step.status === 'fail') return { text: 'No button received: try pressing it again', working: false };
    if (step.status === 'ok') return { text: 'Remote button learned', working: false };
    return { text: `Learning your remote: ${prompt ?? 'press each button once'}`, working: true };
  }
  if (step.status === 'fail') {
    return { text: step.phase === 'verify' ? 'Test did not pass: open Details' : 'Could not finish: open Details', working: false };
  }
  const working = step.status === 'running' || step.status === 'pending';
  return { text: phaseText[step.phase][working ? 0 : 1], working: working && step.phase !== 'arm' };
}

/** Map server progress to plain words without exposing model titles or technical details. */
export function statusForMessage(message: AnyMessage): CalmStatus | undefined {
  if (!isMessageType(message.type)) return undefined;
  const m = message as Message;
  switch (m.type) {
    case 'agent.step':
      return stepStatus(m.payload);
    case 'target.status':
      return { ...targetText[m.payload.state] };
    case 'sense.request':
      if (m.payload.kind === 'ir-capture') return { text: `Learning your remote: ${m.payload.prompt ?? 'press each button once'}`, working: true };
      if (m.payload.kind === 'frame') return { text: 'Testing: did the light change?', working: true };
      return { text: 'Testing: listening for a change', working: true };
    case 'verify.result': {
      const { pass, expected, observed } = m.payload;
      if (!pass) return { text: 'Test did not pass: no expected change detected', working: false };
      if (expected.effect === 'none') return { text: 'Test passed: no change, as expected', working: false };
      return { text: observed.sense === 'camera' ? 'Test passed: the light changed' : observed.sense === 'audio' ? 'Test passed: a change was heard' : 'Test passed', working: false };
    }
    case 'ui.spec':
      return { text: 'Controls created: open Details', working: false };
    case 'arm.request':
      return { text: 'Open Details to approve your controls', working: false };
    case 'arm.result':
      return { text: m.payload.armed ? 'Ready: controls armed' : 'Controls are not armed', working: false };
    case 'panic':
      return { text: 'Stopped: controls are not armed', working: false };
    default:
      return undefined;
  }
}

/** Remember each device separately so counts never come from a different target. */
export function createStatusPresenter() {
  const specs = new Map<string, UiSpecPayload>();
  const actions = new Map<string, Set<string>>();
  const armed = new Set<string>();

  function ready(cardId: string): CalmStatus {
    const spec = specs.get(cardId);
    const passed = actions.get(cardId);
    let count: number | undefined;
    if (spec?.hackset) {
      count = spec.hackset.hacks.filter((h) => {
        if (h.status === 'locked' || h.status === 'failed') return false;
        return passed ? h.commands.every((c) => passed.has(c.action)) : h.status === 'verified' || h.status === 'ready';
      }).length;
    } else if (spec) {
      const controls = spec.gen3d?.controls ?? spec.widgets;
      if (controls) count = controls.filter((c) => !('armed' in c && c.armed === false) && (!passed || passed.has(c.binding.action))).length;
    }
    return { text: count === undefined ? 'Ready: controls armed' : `Ready: ${count} ${count === 1 ? 'control' : 'controls'} armed`, working: false };
  }

  return {
    update(message: AnyMessage): CalmStatus | undefined {
      if (!isMessageType(message.type)) return undefined;
      const m = message as Message;
      switch (m.type) {
        case 'ui.spec':
          if (m.payload.cardId) {
            specs.set(m.payload.cardId, m.payload);
            if (armed.has(m.payload.cardId)) return ready(m.payload.cardId);
          }
          break;
        case 'driver.spec':
          actions.set(m.payload.cardId, new Set(m.payload.actions.filter((a) => a.verified === 'pass').map((a) => a.actionId)));
          return undefined;
        case 'arm.request':
          actions.set(m.payload.cardId, new Set(m.payload.actions.filter((a) => a.verified === 'pass').map((a) => a.actionId)));
          break;
        case 'driver.status':
          if (m.payload.cardId && m.payload.actions) actions.set(m.payload.cardId, new Set(m.payload.actions.filter((a) => a.verified === 'pass').map((a) => a.actionId)));
          if (m.payload.phase === 'disarmed') {
            if (m.payload.cardId) armed.delete(m.payload.cardId);
            return { text: 'Controls are not armed', working: false };
          }
          return undefined;
        case 'arm.result':
          if (m.payload.armed) {
            armed.add(m.payload.cardId);
            return ready(m.payload.cardId);
          }
          armed.delete(m.payload.cardId);
          break;
        case 'target.status':
          if (m.payload.state === 'armed' || m.payload.state === 'controlling') {
            armed.add(m.payload.cardId);
            return ready(m.payload.cardId);
          }
          armed.delete(m.payload.cardId);
          break;
        case 'agent.step':
          if (m.payload.cardId && armed.has(m.payload.cardId) && m.payload.phase === 'arm' && m.payload.status === 'ok') return ready(m.payload.cardId);
          break;
        case 'panic':
          armed.clear();
          break;
      }
      return statusForMessage(m);
    },
    reset(): void {
      specs.clear();
      actions.clear();
      armed.clear();
    },
  };
}
