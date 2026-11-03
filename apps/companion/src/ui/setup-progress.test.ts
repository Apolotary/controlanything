import { makeMessage, type DriverSpecPayload, type Message, type MessageType, type PayloadOf, type TargetStatusPayload } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { CompanionSetupProgress } from './setup-progress';

function setup(options: Partial<{ deviceId: string; local: boolean; replay: boolean }> = {}) {
  const context = { deviceId: 'this-mac', local: false, replay: false, ...options };
  const progress = new CompanionSetupProgress(() => context);
  let time = 100;
  const send = <T extends MessageType>(type: T, payload: PayloadOf<T>, ts = ++time) => progress.update(makeMessage(type, payload, { ts, from: 'server' }) as Message);
  const target = (extra: Partial<TargetStatusPayload> = {}) => send('target.status', { cardId: 'synth', runId: 'run-1', state: 'driving', since: time, executorDeviceId: 'this-mac', ...extra });
  const driver = (extra: Partial<DriverSpecPayload> = {}) => send('driver.spec', { driverId: 'driver-1', cardId: 'synth', transport: 'midi', executor: { deviceId: 'this-mac' },
    provenance: [], source: 'live', modelId: 'muse-test', actions: [{ actionId: 'warp', label: 'Warp', kind: 'set',
      range: { min: 0, max: 127 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' } }], ...extra });
  return { progress, context, send, target, driver };
}

describe('companion setup workspace relevance', () => {
  it('waits for an exact executor and never adopts an unrelated Mac or simulator', () => {
    const { progress, send, target } = setup();
    target({ executorDeviceId: undefined });
    expect(progress.get()).toBeUndefined();
    send('link.request', { linkId: 'link', cardId: 'synth', needs: ['midi'], reason: 'Choose a Mac', suggestedClients: ['mac'], status: 'candidates',
      candidates: [{ deviceId: 'this-mac', name: 'This Mac', kind: 'mac', online: true }, { deviceId: 'other-mac', name: 'Other Mac', kind: 'mac', online: true }] });
    expect(progress.get()).toBeUndefined();
    target({ executorDeviceId: 'other-mac' });
    expect(progress.get()).toBeUndefined();
    target({ executorDeviceId: 'sim' });
    expect(progress.get()).toBeUndefined();
    target();
    expect(progress.get()?.cardId).toBe('synth');
  });

  it('accepts an explicit link result after an unassigned linking stage, without overwriting a known owner', () => {
    const { progress, send, target } = setup();
    target({ state: 'linking', executorDeviceId: undefined });
    send('link.result', { linkId: 'link', cardId: 'synth', verdict: 'consistent', channel: 'midi', executorDeviceId: 'this-mac', evidence: [] });
    expect(progress.get()?.cardId).toBe('synth');
    send('link.result', { linkId: 'late', cardId: 'synth', verdict: 'consistent', channel: 'midi', executorDeviceId: 'other-mac', evidence: [] });
    expect(progress.get()?.cardId).toBe('synth');
  });

  it('does not infer that local controls belong to a remote companion', () => {
    const { progress, context, target, driver } = setup();
    target({ executorDeviceId: 'mac-local' });
    driver({ transport: 'local', executor: { deviceId: 'mac-local' } });
    expect(progress.get()).toBeUndefined();
    context.local = true;
    expect(progress.get()?.cardId).toBe('synth');
    target({ executorDeviceId: 'another-mac' });
    expect(progress.get()).toBeUndefined();
  });

  it('does not borrow an old assignment or artifact when a new run is still unassigned', () => {
    const { progress, send, target, driver } = setup();
    target(); driver();
    expect(progress.get()?.artifact?.code).toContain('Warp');
    target({ runId: 'run-2', executorDeviceId: undefined, state: 'linking' });
    expect(progress.get()).toBeUndefined();
    send('link.result', { linkId: 'old', cardId: 'synth', verdict: 'consistent', executorDeviceId: 'this-mac', evidence: [] }, 1);
    driver();
    expect(progress.get()).toBeUndefined();
    target({ runId: 'run-2', executorDeviceId: 'other-mac' });
    expect(progress.get()).toBeUndefined();
  });

  it('hides in Annotate and restores grounded history in Control without generating or enabling anything', () => {
    const { progress, send, target, driver } = setup();
    target(); driver();
    const artifact = progress.get()?.artifact;
    send('mode.state', { mode: 'annotate' });
    expect(progress.get()).toBeUndefined();
    send('mode.state', { mode: 'control' });
    expect(progress.get()?.artifact).toEqual(artifact);
    expect(progress.get()?.stages.find((stage) => stage.id === 'enable')?.status).toBe('pending');
  });

  it('clears cancelled/removed targets and rejects their delayed messages until a new run', () => {
    const { progress, send, target, driver } = setup();
    target(); driver();
    progress.clear('synth');
    driver(); target();
    expect(progress.get()).toBeUndefined();
    target({ runId: 'run-2' });
    expect(progress.get()?.artifact).toBeUndefined();
    send('tags.state', { tags: [] });
    target({ runId: 'run-2' });
    expect(progress.get()).toBeUndefined();
  });

  it('keeps received definitions but stops working during disconnect until an authoritative status arrives', () => {
    const { progress, target, driver } = setup();
    target(); driver();
    const artifact = progress.get()?.artifact;
    progress.disconnect();
    expect(progress.get()).toMatchObject({ title: 'Connection lost', working: false, artifact });
    target();
    expect(progress.get()?.working).toBe(true);
  });

  it('updates previews from actual interface fragments and marks explicit replay as a demo', () => {
    const { progress, send, target, driver } = setup({ replay: true });
    target({ executorDeviceId: 'sim' }); driver();
    send('ui.partial', { cardId: 'synth', runId: 'run-1', specId: 'interface', seq: 1 });
    expect(progress.get()?.artifact?.code).toContain('interface');
    expect(progress.get()?.source).toBe('Recorded demo · no device commands');
    expect(progress.get()?.facts.some((fact) => fact.includes('Write commands: Recorded'))).toBe(true);
    expect(progress.get()?.facts.some((fact) => /:\s*Live\b/.test(fact))).toBe(false);
    expect(progress.get()?.stages.find((stage) => stage.id === 'enable')?.status).toBe('pending');
  });

  it('ignores client-origin progress and high-rate control messages', () => {
    const { progress } = setup();
    expect(progress.update(makeMessage('target.status', { cardId: 'spoof', executorDeviceId: 'this-mac', state: 'driving', since: 0 }, { from: 'other-client' }))).toBe(false);
    expect(progress.get()).toBeUndefined();
    expect(progress.update(makeMessage('presence', { spaceId: 'space', devices: [] }, { from: 'server' }))).toBe(false);
  });
});
