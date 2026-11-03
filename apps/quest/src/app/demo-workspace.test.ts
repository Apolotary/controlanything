import { describe, expect, it } from 'vitest';
import { workspaceContext } from './demo-workspace';

describe('Muse workspace context projection', () => {
  it('does not expose a previously selected device in a general question', () => {
    expect(workspaceContext({ scope: 'general', targetId: 'synth', controlsReady: true, setupWorking: true,
      mappingOutcome: 'applied', performance: { enabled: true, live: true, trackingLost: false },
      assistant: { targetId: 'synth', state: 'proposal', proposalKind: 'gesture' } })).toEqual({
      version: 1, scope: 'general', surface: 'menu', stage: 'choose', performance: 'off',
    });
  });
  it('keeps a new proposal distinct from the saved ready mapping', () => {
    expect(workspaceContext({ scope: 'device', targetId: 'synth', controlsReady: true, mappingOutcome: 'review',
      assistant: { targetId: 'synth', state: 'proposal', proposalKind: 'peripheral' } })).toMatchObject({
      stage: 'review', surface: 'assistant', pending: { kind: 'peripheral', state: 'review' }, performance: 'off',
    });
  });
  it('ignores a late conversation belonging to another device', () => {
    expect(workspaceContext({ scope: 'device', targetId: 'synth', controlsReady: true,
      assistant: { targetId: 'mac', state: 'proposal', proposalKind: 'identity' } })).toEqual({
      version: 1, scope: 'device', surface: 'device', stage: 'ready', performance: 'off',
    });
  });
  it('describes the visible menu while preserving a hidden pending proposal separately', () => {
    expect(workspaceContext({ scope: 'device', targetId: 'synth', controlsReady: true,
      presentation: { surface: 'menu', stage: 'choose' },
      assistant: { targetId: 'synth', state: 'proposal', proposalKind: 'gesture' } })).toMatchObject({
      surface: 'menu', stage: 'choose', pending: { kind: 'gesture', state: 'review' },
    });
  });
  it('reports tracking loss separately from a released clutch', () => {
    const input = { scope: 'device' as const, targetId: 'synth', performance: { enabled: true, live: false, trackingLost: true } };
    expect(workspaceContext(input)).toMatchObject({ stage: 'perform', performance: 'tracking-lost' });
    input.performance.trackingLost = false;
    expect(workspaceContext(input)).toMatchObject({ stage: 'perform', performance: 'paused' });
    input.performance.enabled = false;
    expect(workspaceContext(input)).toMatchObject({ performance: 'off' });
  });
  it('reports current setup as work rather than granting readiness', () => {
    expect(workspaceContext({ scope: 'device', targetId: 'synth', setupWorking: true, controlsReady: true })).toMatchObject({
      stage: 'building', pending: { kind: 'setup', state: 'working' }, performance: 'off',
    });
  });
});
