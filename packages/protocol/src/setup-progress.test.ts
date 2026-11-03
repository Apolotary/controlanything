import { beforeEach, describe, expect, it } from 'vitest';
import { makeMessage, type MessageType, type PayloadOf } from './messages';
import { SETUP_ARTIFACT_MAX_CHARS, SetupProgressTracker } from './setup-progress';

let time = 100;
beforeEach(() => { time = 100; });
function send<T extends MessageType>(tracker: SetupProgressTracker, type: T, payload: PayloadOf<T>) {
  tracker.update({ ...makeMessage(type, payload, { from: 'server' }), ts: ++time });
}
function status(tracker: SetupProgressTracker, state: PayloadOf<'target.status'>['state'], runId = 'run-one', cardId = 'screen') {
  send(tracker, 'target.status', { cardId, state, runId, since: time + 1 });
}
const driver: PayloadOf<'driver.spec'> = { cardId: 'screen', driverId: 'driver-one', transport: 'midi', executor: { deviceId: 'mac', port: 'ce-visual-synth' },
  provenance: [], modelId: 'muse-wonder', source: 'live', actions: [
    { actionId: 'warp', label: 'Warp', kind: 'set', range: { min: 0, max: 127 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' }, expect: { sense: 'camera', effect: 'any' } },
  ] };
const ui: PayloadOf<'ui.spec'> = { cardId: 'screen', driverId: driver.driverId, specId: 'screen-ui', rev: 1, source: 'live', modelId: 'muse-spark',
  widgets: [{ id: 'warp', kind: 'fader', label: 'Warp', binding: { action: 'warp' } }] };
const evidence: PayloadOf<'verify.result'> = { cardId: 'screen', driverId: driver.driverId, evidenceId: 'proof', execId: 'exec', actionId: 'warp', attempt: 1,
  sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: 127 }, at: 1 }, expected: { sense: 'camera', effect: 'any' },
  observed: { sense: 'camera', metric: 'luma-abs', before: 0.2, after: 0.6, delta: 0.4, threshold: 0.1 }, pass: true };
const stage = (tracker: SetupProgressTracker, id: string) => tracker.get('screen')!.stages.find(value => value.id === id)!.status;

describe('grounded setup progress', () => {
  it('advances an event-only replay without target.status and preserves enabled presentation on late specs', () => {
    const tracker = new SetupProgressTracker();
    send(tracker, 'agent.step', { cardId: 'screen', stepId: 'drive', phase: 'drive', status: 'running', title: 'DRIVE writing commands', source: 'fixture' });
    send(tracker, 'driver.spec', { ...driver, source: 'fixture' });
    expect(tracker.get('screen')).toMatchObject({ title: 'Commands prepared', working: false });
    expect(tracker.get('screen')?.detail).not.toContain('DRIVE');
    send(tracker, 'driver.status', { cardId: 'screen', driverId: driver.driverId, phase: 'verifying', actions: [{ actionId: 'warp', verified: 'pending' }] });
    expect(tracker.get('screen')).toMatchObject({ title: 'Checking the device response', source: 'Fixture · muse-wonder', working: true });
    expect(stage(tracker, 'check')).toBe('active');
    send(tracker, 'verify.result', evidence);
    send(tracker, 'driver.status', { cardId: 'screen', driverId: driver.driverId, phase: 'verified', actions: [{ actionId: 'warp', verified: 'pass' }] });
    expect(tracker.get('screen')).toMatchObject({ title: 'Device checks completed', working: false });
    send(tracker, 'ui.spec', { ...ui, source: 'fixture' });
    expect(tracker.get('screen')).toMatchObject({ title: 'Interface ready', working: false });
    expect(stage(tracker, 'interface')).toBe('done'); expect(stage(tracker, 'enable')).toBe('pending');
    expect(tracker.get('screen')?.detail).toContain('Confirm Enable');
    send(tracker, 'arm.result', { cardId: 'screen', driverId: driver.driverId, armId: 'arm', armed: true });
    send(tracker, 'ui.spec', { ...ui, rev: 2 });
    send(tracker, 'driver.status', { cardId: 'screen', driverId: driver.driverId, phase: 'verifying' });
    expect(tracker.get('screen')).toMatchObject({ title: 'Controls enabled', working: false });
    expect(stage(tracker, 'enable')).toBe('done');
    expect(JSON.parse(tracker.get('screen')!.artifact!.code).rev).toBe(2);
  });
  it('distinguishes connection, generated commands, camera checks, interface, and explicit Enable', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'linking');
    expect(stage(tracker, 'connect')).toBe('active'); expect(tracker.get('screen')?.working).toBe(true);
    send(tracker, 'link.result', { cardId: 'screen', linkId: 'link', verdict: 'consistent', channel: 'midi', port: { id: 'port', name: 'Visual synth', kind: 'midi-out' }, evidence: [] });
    expect(tracker.get('screen')?.facts.join(' ')).toContain('effects still need checking');
    status(tracker, 'researching'); send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'research', phase: 'research', status: 'ok', title: 'Instructions found' });
    status(tracker, 'driving'); send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'drive', phase: 'drive', status: 'running', title: 'Writing', model: 'muse-wonder', source: 'live' });
    expect(tracker.get('screen')?.title).toContain('Muse is writing');
    send(tracker, 'driver.spec', driver);
    expect(JSON.parse(tracker.get('screen')!.artifact!.code).actions[0]).toMatchObject({ label: 'Warp', encode: { number: 71, value: '$value' } });
    expect(tracker.get('screen')!.artifact!.code).not.toContain('deviceId');
    status(tracker, 'verifying'); send(tracker, 'verify.result', evidence);
    expect(stage(tracker, 'check')).toBe('active'); expect(stage(tracker, 'enable')).toBe('pending');
    send(tracker, 'driver.status', { cardId: 'screen', driverId: driver.driverId, phase: 'verified', actions: [{ actionId: 'warp', verified: 'pass' }] });
    expect(stage(tracker, 'check')).toBe('done');
    status(tracker, 'forging'); send(tracker, 'ui.partial', { cardId: 'screen', runId: 'run-one', specId: ui.specId, seq: 1 });
    send(tracker, 'ui.spec', ui); expect(stage(tracker, 'interface')).toBe('done'); expect(stage(tracker, 'enable')).toBe('pending');
    send(tracker, 'arm.request', { armId: 'arm', cardId: 'screen', driverId: driver.driverId, specId: ui.specId, title: 'Enable?', summary: 'One checked action', actions: [], expiresAt: 999 });
    expect(stage(tracker, 'enable')).toBe('active'); expect(tracker.get('screen')?.working).toBe(false);
    send(tracker, 'arm.result', { armId: 'arm', cardId: 'screen', driverId: driver.driverId, armed: true });
    expect(stage(tracker, 'enable')).toBe('done'); expect(tracker.get('screen')?.title).toBe('Controls enabled');
  });

  it('never treats executor acknowledgements or restored interface data as physical proof or Enable', () => {
    const tracker = new SetupProgressTracker(); send(tracker, 'ui.spec', ui);
    expect(tracker.get('screen')?.stages.filter(value => value.status === 'done').map(value => value.id)).toEqual(['interface']);
    send(tracker, 'verify.result', { ...evidence, observed: { ...evidence.observed, sense: 'ack', metric: 'ack' } });
    expect(tracker.get('screen')?.facts.join(' ')).toContain('no camera or audio proof');
    expect(stage(tracker, 'check')).toBe('pending'); expect(stage(tracker, 'enable')).toBe('pending');
    send(tracker, 'driver.status', { cardId: 'screen', driverId: driver.driverId, phase: 'armed' });
    expect(stage(tracker, 'enable')).toBe('pending');
  });

  it('keeps substep success/failure separate from final checking and interface results', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'forging');
    for (const result of ['ok', 'fail'] as const) send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: `skin-${result}`, phase: 'forge', status: result, title: 'Skin request' });
    expect(stage(tracker, 'interface')).toBe('active'); expect(tracker.get('screen')?.working).toBe(true);
    status(tracker, 'failed'); const failed = tracker.get('screen');
    send(tracker, 'ui.spec', ui); expect(tracker.get('screen')).toEqual(failed);
  });

  it('clears retry artifacts and rejects stale runs, driver IDs, spec IDs and earlier timestamps', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'driving'); send(tracker, 'driver.spec', driver); send(tracker, 'ui.spec', ui);
    status(tracker, 'linking', 'run-two'); expect(tracker.get('screen')?.artifact).toBeUndefined();
    const fresh = tracker.get('screen');
    send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'old', phase: 'forge', status: 'running', title: 'Old result' });
    send(tracker, 'driver.spec', driver); send(tracker, 'ui.spec', ui);
    status(tracker, 'armed', 'run-one');
    expect(tracker.get('screen')).toEqual(fresh);
    send(tracker, 'driver.spec', { ...driver, driverId: 'driver-two' });
    expect(tracker.get('screen')?.artifact).toBeDefined();
  });

  it('rejects late partial components and older revisions after the complete interface', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'forging'); send(tracker, 'ui.spec', { ...ui, rev: 3 }); const complete = tracker.get('screen');
    send(tracker, 'ui.partial', { cardId: 'screen', runId: 'run-one', specId: ui.specId, seq: 90 });
    send(tracker, 'ui.spec', { ...ui, rev: 2 }); expect(tracker.get('screen')).toEqual(complete);
  });

  it('counts driver commands only, while keeping negative-control checks as evidence', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'verifying'); send(tracker, 'driver.spec', driver);
    send(tracker, 'driver.status', { cardId: 'screen', driverId: driver.driverId, phase: 'verifying', actions: [{ actionId: 'warp', verified: 'pending' }] });
    send(tracker, 'verify.result', { ...evidence, actionId: 'negative-control', expected: { sense: 'camera', effect: 'none' } });
    expect(tracker.get('screen')?.facts).toContain('0/1 commands verified');
    expect(tracker.get('screen')?.facts.join(' ')).toContain('negative-control');
    send(tracker, 'verify.result', evidence);
    expect(tracker.get('screen')?.facts).toContain('1/1 commands verified');
  });

  it('re-enables an explicitly reused driver/spec in a new run without inventing generation or accepting old consent', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'forging'); send(tracker, 'driver.spec', driver); send(tracker, 'ui.spec', ui);
    const request: PayloadOf<'arm.request'> = { armId: 'old-arm', cardId: 'screen', driverId: driver.driverId, specId: ui.specId, title: 'Enable?', summary: 'One action', actions: [], expiresAt: 999 };
    send(tracker, 'arm.request', request); send(tracker, 'arm.result', { armId: 'old-arm', cardId: 'screen', driverId: driver.driverId, armed: false, reason: 'expired' });
    const code = tracker.get('screen')?.artifact?.code;
    send(tracker, 'target.status', { cardId: 'screen', runId: 'run-two', state: 'arming', since: time + 1, driverId: driver.driverId, specId: ui.specId });
    expect(tracker.get('screen')).toMatchObject({ title: 'Waiting for Enable', source: 'Reused setup · original driver and interface', working: false });
    expect(tracker.get('screen')?.artifact?.code).toBe(code);
    send(tracker, 'arm.result', { armId: 'old-arm', cardId: 'screen', driverId: driver.driverId, armed: true });
    expect(stage(tracker, 'enable')).toBe('active');
    send(tracker, 'arm.request', { ...request, armId: 'new-arm' });
    send(tracker, 'arm.result', { armId: 'new-arm', cardId: 'screen', driverId: driver.driverId, armed: true });
    expect(stage(tracker, 'enable')).toBe('done');
  });

  it('projects real hackset controls when a replay or legacy interface has no gen3d/widgets', () => {
    const tracker = new SetupProgressTracker();
    send(tracker, 'ui.spec', { specId: 'hack-ui', cardId: 'screen', source: 'fixture', hackset: { spec: 'ce.hackset/1',
      device: { id: 'screen', name: 'Visual synth', channel: { type: 'midi', via: 'Mac' } }, hacks: [
        { id: 'pattern', name: 'Change pattern', kind: 'action', commands: [{ action: 'pattern1' }], oracle: { type: 'camera', expect: 'colour_shift' }, max_rate_hz: 1 },
      ] } });
    const preview = JSON.parse(tracker.get('screen')!.artifact!.code);
    expect(preview.hacks).toEqual([expect.objectContaining({ name: 'Change pattern', commands: [{ action: 'pattern1' }] })]);
    expect(preview.controlCount).toBe(1); expect(stage(tracker, 'enable')).toBe('pending');
    expect(tracker.get('screen')?.source).toBe('Fixture');
  });

  it('retains real evidence on cancellation/disconnect without accepting late progress', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'verifying'); send(tracker, 'driver.spec', driver);
    tracker.disconnect(); expect(tracker.get('screen')).toMatchObject({ title: 'Connection lost', working: false, artifact: expect.any(Object) });
    send(tracker, 'ui.spec', ui); expect(tracker.get('screen')?.title).toBe('Connection lost');
    status(tracker, 'verifying'); expect(tracker.get('screen')?.working).toBe(true);
    send(tracker, 'control.cancel', { cardId: 'screen' });
    status(tracker, 'armed'); expect(tracker.get('screen')?.title).toBe('Setup cancelled');
    status(tracker, 'linking', 'run-two'); expect(tracker.get('screen')?.working).toBe(true);
  });

  it('tombstones removed targets until a fresh run and bounds accumulated cards', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'driving'); tracker.clear('screen');
    send(tracker, 'driver.spec', driver); status(tracker, 'armed'); expect(tracker.get('screen')).toBeUndefined();
    status(tracker, 'linking', 'run-two'); expect(tracker.get('screen')).toBeDefined();
    for (let index = 0; index < 70; index++) status(tracker, 'linking', `run-${index}`, `card-${index}`);
    expect(tracker.get('screen')).toBeUndefined(); expect(tracker.get('card-69')).toBeDefined();
    tracker.clear(); expect(tracker.get('card-69')).toBeUndefined();
  });

  it('labels live, recorded, reused and curated sources without claiming new model generation', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'driving');
    send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'drive', phase: 'drive', status: 'running', title: 'Driver', source: 'fixture', recordedFrom: 'muse-wonder' });
    expect(tracker.get('screen')).toMatchObject({ source: 'Fixture · recorded from muse-wonder', title: 'Loading stored device commands' });
    send(tracker, 'driver.spec', { ...driver, modelId: 'template', source: 'fixture' });
    expect(tracker.get('screen')?.source).toBe('Curated template · no model generation');
    status(tracker, 'verifying');
    expect(tracker.get('screen')).toMatchObject({ title: 'Checking the device response', source: 'Curated template · no model generation' });
    send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'proof-note', phase: 'verify', status: 'ok', title: 'Check received' });
    expect(tracker.get('screen')?.source).toBe('Curated template · no model generation');
    send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'memory', phase: 'research', status: 'ok', title: 'Reused cached research', model: 'muse-spark' });
    expect(tracker.get('screen')?.source).toBe('Curated template · no model generation');
    expect(tracker.get('screen')?.facts.join(' ')).toContain('Reused knowledge · muse-spark');
  });

  it('does not label fresh driver or interface generation as reused research or a template', () => {
    const tracker = new SetupProgressTracker(); status(tracker, 'researching');
    send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'research', phase: 'research', status: 'ok', title: 'Reused cached research', model: 'muse-spark' });
    status(tracker, 'driving');
    send(tracker, 'agent.step', { cardId: 'screen', runId: 'run-one', stepId: 'drive', phase: 'drive', status: 'running', title: 'Writing driver', model: 'muse-wonder' });
    expect(tracker.get('screen')).toMatchObject({ title: 'Preparing device commands', source: undefined });
    expect(tracker.get('screen')?.facts.join(' ')).toContain('Reused knowledge');
    send(tracker, 'driver.spec', { ...driver, modelId: 'template', source: 'fixture' });
    status(tracker, 'forging');
    expect(tracker.get('screen')).toMatchObject({ title: 'Building the controls', source: undefined });
  });

  it('bounds valid JSON previews and detaches returned snapshots', () => {
    const tracker = new SetupProgressTracker(); send(tracker, 'driver.spec', { ...driver, actions: Array.from({ length: 64 }, (_, index) => ({ ...driver.actions[0], actionId: `action-${index}`, label: 'Long label '.repeat(10) })) });
    const result = tracker.get('screen')!;
    expect(result.artifact!.code.length).toBeLessThanOrEqual(SETUP_ARTIFACT_MAX_CHARS);
    expect(() => JSON.parse(result.artifact!.code)).not.toThrow(); expect(result.facts.length).toBeLessThanOrEqual(5);
    result.title = 'mutated'; result.stages[0].status = 'failed';
    expect(tracker.get('screen')?.title).not.toBe('mutated'); expect(stage(tracker, 'connect')).toBe('pending');
  });
});
