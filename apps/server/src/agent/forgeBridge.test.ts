import type { Driver } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeEvent, ForgeProgress, UiSpec } from '../gen3d/forge';
import { subscribeForge } from './forgeBridge';
import { TargetStore } from './targets';

const driver: Driver = { driverId: 'driver-light', cardId: 'light', transport: 'ir', executor: { deviceId: 'remo' }, provenance: [], actions: [] };
// The bridge forwards spec contents unchanged; only these identifiers affect routing.
const spec = { specId: 'spec_light', cardId: 'light', driverId: driver.driverId } as UiSpec;
const progress: ForgeProgress = {
  stepId: 'run-light.1', runId: 'run-light', cardId: 'light', phase: 'forge', status: 'running',
  title: 'Building controls', kind: 'opinion', model: 'muse-spark', source: 'fixture', startedAt: 1,
};
const item = {
  kind: 'hack', seq: 0,
  hack: { id: 'off', name: 'Off', kind: 'action', commands: [{ action: 'off' }], max_rate_hz: 1 },
  control: { id: 'off' }, part: { id: 'off-part' }, hackItem: { id: 'off-item' },
} as NonNullable<ForgeProgress['item']>;

function setup(withTarget = true, allowed?: (cardId: string) => boolean) {
  const listeners = new Set<(event: ForgeEvent) => void>();
  const forge = {
    subscribe(listener: (event: ForgeEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    specIdFor: (cardId: string) => `spec_${cardId}`,
  };
  const hub = { broadcast: vi.fn(() => 1) };
  const targets = new TargetStore(hub);
  const target = withTarget ? targets.create({ cardId: 'light', runId: 'run-light', state: 'forging', driver, abort: new AbortController() }) : undefined;
  const unsubscribe = subscribeForge(forge, hub, targets, allowed);
  const emit = (event: ForgeEvent) => { for (const listener of listeners) listener(event); };
  return { hub, target, targets, listeners, unsubscribe, emit };
}

describe('guided forge publishing', () => {
  it('forwards active progress and streamed controls with guidance', () => {
    const { hub, emit } = setup();
    emit({ type: 'progress', progress: { ...progress, item } });
    expect(hub.broadcast).toHaveBeenNthCalledWith(1, 'agent.step', expect.objectContaining({
      sentence: 'Making your controls…', hint: expect.any(String), action: 'cancel',
      stepId: progress.stepId, runId: progress.runId, cardId: progress.cardId,
    }));
    expect(hub.broadcast).toHaveBeenNthCalledWith(2, 'ui.partial', {
      specId: 'spec_light', cardId: 'light', runId: 'run-light', seq: 0,
      control: item.control, hack: item.hack, part: item.part, hackItem: item.hackItem,
    });
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).toHaveBeenLastCalledWith('ui.spec', spec);
  });

  it.each(['abort', 'failed'] as const)('drops internal spec, progress and partial publishes after %s', (reason) => {
    const { hub, target, emit } = setup();
    if (reason === 'abort') target!.abort!.abort();
    else {
      target!.state = 'failed';
      target!.abort = undefined;
    }
    emit({ type: 'progress', progress: { ...progress, item } });
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).not.toHaveBeenCalled();
  });

  it('drops previous-run progress and controls after retry, including before a new driver exists', () => {
    const { hub, target, emit } = setup();
    target!.runId = 'run-retry';
    target!.state = 'identifying';
    target!.driver = undefined;
    emit({ type: 'progress', progress: { ...progress, item } });
    emit({ type: 'spec', uiSpec: spec });
    target!.driver = { ...driver, driverId: 'driver-retry' };
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).not.toHaveBeenCalled();
    emit({ type: 'spec', uiSpec: { ...spec, driverId: 'driver-retry' } });
    expect(hub.broadcast).toHaveBeenCalledExactlyOnceWith('ui.spec', { ...spec, driverId: 'driver-retry' });
  });

  it.each(['ok', 'fail'] as const)('adds guidance to a skin %s published after discovery completes', (status) => {
    const { hub, target, emit } = setup();
    target!.state = 'armed';
    target!.abort = undefined;
    emit({ type: 'progress', progress: { ...progress, stepId: 'run-light.skin', title: 'Panel image', status } });
    expect(hub.broadcast).toHaveBeenCalledExactlyOnceWith('agent.step', expect.objectContaining({
      stepId: 'run-light.skin', sentence: expect.any(String),
      ...(status === 'fail' ? { hint: expect.any(String), action: 'retry' } : {}),
    }));
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).toHaveBeenLastCalledWith('ui.spec', spec);
  });

  it('preserves explicit edit progress when its run identifier is independent of discovery', () => {
    const { hub, target, emit } = setup();
    target!.runId = 'run-retry';
    emit({ type: 'progress', progress: { ...progress, runId: 'edit-owner-request' } });
    expect(hub.broadcast).toHaveBeenCalledExactlyOnceWith('agent.step', expect.objectContaining({
      runId: 'edit-owner-request', sentence: 'Making your controls…',
    }));
  });

  it('continues forwarding external generation with no discovery target', () => {
    const { hub, emit } = setup(false);
    emit({ type: 'progress', progress: { ...progress, item } });
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).toHaveBeenCalledTimes(3);
    expect(hub.broadcast).toHaveBeenLastCalledWith('ui.spec', spec);
  });

  it('drops progress, streamed controls and finished specs when the mode stops allowing them', () => {
    let controlMode = true;
    const { hub, emit } = setup(true, () => controlMode);
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).toHaveBeenCalledExactlyOnceWith('ui.spec', spec);
    hub.broadcast.mockClear();
    controlMode = false;
    emit({ type: 'progress', progress: { ...progress, item } });
    emit({ type: 'progress', progress: { ...progress, runId: 'edit-owner-request', item } });
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).not.toHaveBeenCalled();
    controlMode = true;
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).toHaveBeenCalledExactlyOnceWith('ui.spec', spec);
  });

  it('drops late generation after a tag and its discovery target are removed', () => {
    const tagged = new Set(['light']);
    const { hub, targets, emit } = setup(true, (cardId) => tagged.has(cardId));
    tagged.delete('light');
    targets.remove('light');
    emit({ type: 'progress', progress: { ...progress, item } });
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).not.toHaveBeenCalled();
  });

  it('removes the forge listener when the agent closes', () => {
    const { hub, listeners, unsubscribe, emit } = setup();
    expect(listeners.size).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(listeners.size).toBe(0);
    emit({ type: 'progress', progress });
    emit({ type: 'spec', uiSpec: spec });
    expect(hub.broadcast).not.toHaveBeenCalled();
  });
});
