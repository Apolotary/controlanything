import { makeMessage, type AgentPhase, type PayloadOf, type TargetState } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { createStatusPresenter, statusForMessage } from './status';

const step = (phase: AgentPhase, status: PayloadOf<'agent.step'>['status'] = 'running', title = 'Internal title') =>
  makeMessage('agent.step', { stepId: 'step-1', cardId: 'light', phase, status, title, model: 'model-id', detail: 'Technical log' });
const target = (state: TargetState, cardId = 'light') => makeMessage('target.status', { cardId, state, since: 0 });
const arm = (armed: boolean, cardId = 'light') => makeMessage('arm.result', { armId: 'arm-1', cardId, driverId: 'driver-1', armed });
const spec = (cardId = 'light', count = 6) => makeMessage('ui.spec', {
  specId: `spec-${cardId}`,
  cardId,
  widgets: Array.from({ length: count }, (_, i) => ({ id: `control-${i}`, kind: 'button' as const, label: `Control ${i}`, binding: { action: `action-${i}` } })),
});
const evidence: PayloadOf<'verify.result'> = {
  evidenceId: 'e1', cardId: 'light', driverId: 'driver-1', actionId: 'action-0', execId: 'exec-1', attempt: 1,
  sent: { op: { kind: 'ir', protocol: 'RAW', rawUs: [9000, 4500] }, at: 0 },
  expected: { sense: 'camera', effect: 'brighter' },
  observed: { sense: 'camera', metric: 'luma-abs', before: 10, after: 30, delta: 20, threshold: 5 },
  pass: true,
};

describe('plain companion status', () => {
  it.each([
    ['scan', 'Scanning the room'],
    ['identify', 'Identifying your device'],
    ['research', 'Learning how your device works'],
    ['drive', 'Writing your device driver'],
    ['verify', 'Testing your device'],
    ['forge', 'Creating your controls'],
    ['control', 'Updating your device'],
  ] as const)('describes a running %s step without technical metadata', (phase, text) => {
    expect(statusForMessage(step(phase))).toEqual({ text, working: true });
  });

  it.each(['scan', 'drive', 'verify', 'forge', 'control'] as const)('stops pulsing when %s completes or fails', (phase) => {
    expect(statusForMessage(step(phase, 'ok'))?.working).toBe(false);
    expect(statusForMessage(step(phase, 'fail'))?.working).toBe(false);
  });

  it('shows both the remote introduction and the current button prompt', () => {
    expect(statusForMessage(step('link', 'running', 'learning the remote with Cardputer'))).toEqual({ text: 'Learning your remote: press each button once', working: true });
    expect(statusForMessage(step('link', 'running', 'learn: Press 消灯 (off) once'))).toEqual({ text: 'Learning your remote: Press 消灯 (off) once', working: true });
    expect(statusForMessage(makeMessage('sense.request', { senseId: 's1', sensorDeviceId: 'mac', kind: 'ir-capture', prompt: 'Press Full on once' }))?.text).toBe('Learning your remote: Press Full on once');
    expect(statusForMessage(step('link', 'ok', 'learn: Press Full on once'))).toEqual({ text: 'Remote button learned', working: false });
  });

  it('keeps missed remote presses actionable without claiming they were learned', () => {
    expect(statusForMessage(step('link', 'fail', 'learn: Press Full on once'))).toEqual({ text: 'No button received: try pressing it again', working: false });
  });

  it('describes observed evidence and preserves a failed verdict', () => {
    expect(statusForMessage(makeMessage('verify.result', evidence))).toEqual({ text: 'Test passed: the light changed', working: false });
    expect(statusForMessage(makeMessage('verify.result', { ...evidence, pass: false }))?.text).toBe('Test did not pass: no expected change detected');
    expect(statusForMessage(makeMessage('verify.result', { ...evidence, expected: { sense: 'camera', effect: 'none' } }))?.text).toBe('Test passed: no change, as expected');
  });

  it.each(['verified', 'forged', 'arming'] as const)('does not claim %s controls are armed', (state) => {
    expect(statusForMessage(target(state))?.text).not.toMatch(/armed/);
    expect(statusForMessage(target(state))?.working).toBe(false);
  });

  it('points approval requests to the drawer without claiming all controls passed', () => {
    const request = makeMessage('arm.request', {
      armId: 'arm-1', cardId: 'light', driverId: 'driver-1', title: 'Approve controls', summary: 'Review before approving', expiresAt: 1000,
      actions: [{ actionId: 'action-0', label: 'Full on', verified: 'pass' }, { actionId: 'action-1', label: 'Off', verified: 'fail' }],
    });
    expect(statusForMessage(request)).toEqual({ text: 'Open Details to approve your controls', working: false });
    expect(statusForMessage(target('arming'))).toEqual(statusForMessage(request));
    expect(statusForMessage(step('arm'))).toEqual(statusForMessage(request));
    expect(statusForMessage(spec())?.text).toBe('Controls created: open Details');
  });

  it('ignores unrelated and experimental messages', () => {
    expect(statusForMessage(makeMessage('presence', { spaceId: 'room', devices: [] }))).toBeUndefined();
    expect(statusForMessage({ v: 1, type: 'x.status', id: 'x1', from: 'server', ts: 0, payload: {} })).toBeUndefined();
  });
});

describe('status presenter', () => {
  it('counts generated controls only after explicit arming', () => {
    const presenter = createStatusPresenter();
    expect(presenter.update(spec())).toEqual({ text: 'Controls created: open Details', working: false });
    expect(presenter.update(arm(true))).toEqual({ text: 'Ready: 6 controls armed', working: false });
    expect(presenter.update(step('arm', 'ok', 'armed by the owner'))?.text).toBe('Ready: 6 controls armed');
    expect(presenter.update(target('controlling'))?.text).toBe('Ready: 6 controls armed');
  });

  it('uses verified actions from the approval request to exclude unavailable controls', () => {
    const presenter = createStatusPresenter();
    presenter.update(spec());
    presenter.update(makeMessage('arm.request', {
      armId: 'arm-1', cardId: 'light', driverId: 'driver-1', title: 'Approve controls', summary: 'One control passed', expiresAt: 1000,
      actions: [{ actionId: 'action-0', label: 'Full on', verified: 'pass' }, { actionId: 'action-1', label: 'Off', verified: 'fail' }],
    }));
    expect(presenter.update(arm(true))?.text).toBe('Ready: 1 control armed');
  });

  it('keeps each device count separate, including unknown counts', () => {
    const presenter = createStatusPresenter();
    presenter.update(spec('light', 6));
    presenter.update(spec('synth', 4));
    expect(presenter.update(target('armed', 'light'))?.text).toBe('Ready: 6 controls armed');
    expect(presenter.update(arm(true, 'synth'))?.text).toBe('Ready: 4 controls armed');
    expect(presenter.update(arm(true, 'laptop'))?.text).toBe('Ready: controls armed');
  });

  it('counts verified generated actions and excludes locked ones', () => {
    const presenter = createStatusPresenter();
    presenter.update(makeMessage('ui.spec', {
      specId: 'spec-light', cardId: 'light', hackset: {
        spec: 'ce.hackset/1', device: { id: 'light', name: 'Light', kind: 'light', channel: { type: 'ir' } },
        hacks: [
          { id: 'on', name: 'Turn on', kind: 'action', commands: [{ action: 'action-0' }], oracle: { type: 'camera', expect: 'brighter' }, max_rate_hz: 1, status: 'verified' },
          { id: 'off', name: 'Turn off', kind: 'action', commands: [{ action: 'action-1' }], oracle: { type: 'camera', expect: 'dimmer' }, max_rate_hz: 1, status: 'locked' },
        ],
      },
    }));
    expect(presenter.update(arm(true))?.text).toBe('Ready: 1 control armed');
  });

  it('clears armed status after denial, a stopped driver, or an earlier target state', () => {
    const presenter = createStatusPresenter();
    presenter.update(spec());
    presenter.update(arm(true));
    expect(presenter.update(arm(false))?.text).toBe('Controls are not armed');
    expect(presenter.update(spec())?.text).toBe('Controls created: open Details');
    presenter.update(arm(true));
    expect(presenter.update(makeMessage('driver.status', { driverId: 'driver-1', cardId: 'light', phase: 'disarmed' }))?.text).toBe('Controls are not armed');
    expect(presenter.update(spec())?.text).toBe('Controls created: open Details');
    presenter.update(arm(true));
    presenter.update(target('driving'));
    expect(presenter.update(spec())?.text).toBe('Controls created: open Details');
  });

  it('clears armed state on panic and all remembered state on reset', () => {
    const presenter = createStatusPresenter();
    presenter.update(spec());
    presenter.update(arm(true));
    expect(presenter.update(makeMessage('panic', { reason: 'stop' }))?.text).toBe('Stopped: controls are not armed');
    expect(presenter.update(spec())?.text).toBe('Controls created: open Details');
    presenter.reset();
    expect(presenter.update(arm(true))?.text).toBe('Ready: controls armed');
  });
});
