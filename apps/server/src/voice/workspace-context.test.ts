import { describe, expect, it } from 'vitest';
import type { VoiceTextPayload, WorkspaceContext } from '@ce/protocol';
import type { AssistantDevice } from './assistant';
import { assistantWorkspaceFacts, workspaceRevisionIssue, workspaceScopeIssue } from './workspace-context';

const workspace: WorkspaceContext = { version: 1, scope: 'device', surface: 'assistant', stage: 'building', performance: 'paused',
  selected: { targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 2, identityRevision: 1 },
  pending: { kind: 'gesture', state: 'working' }, mappingOutcome: 'working' };
const input: VoiceTextPayload = { text: 'What is ready?', final: true, cardId: 'synth', specId: 'spec', workspace };
const device: AssistantDevice = { cardId: 'synth', name: 'Visual synth', mode: 'control', connection: 'ready', armed: false,
  setupRunning: false, identityRevision: 1, verification: { warp: 'pass', flow: 'fail' }, spec: { specId: 'spec', rev: 2 } };

describe('Muse workspace grounding', () => {
  it('checks the context against the request envelope instead of retargeting it', () => {
    expect(workspaceScopeIssue(input)).toBeUndefined();
    expect(workspaceScopeIssue({ ...input, cardId: 'mac' })).toContain('no longer matches');
    expect(workspaceScopeIssue({ ...input, specId: 'another-spec' })).toContain('no longer matches');
    expect(workspaceScopeIssue({ ...input, cardId: 'muse-general' })).toContain('no longer matches');
    expect(workspaceScopeIssue({ ...input, workspace: undefined })).toBeUndefined();
  });
  it('keeps general questions free of hidden target, pending action and mapping claims', () => {
    const general: WorkspaceContext = { version: 1, scope: 'general', surface: 'menu', stage: 'choose', performance: 'off' };
    expect(workspaceScopeIssue({ cardId: 'muse-general', workspace: general })).toBeUndefined();
    for (const extra of [{ selected: workspace.selected }, { pending: workspace.pending }, { mappingOutcome: 'applied' as const }, { performance: 'live' as const }]) {
      expect(workspaceScopeIssue({ cardId: 'muse-general', workspace: { ...general, ...extra } })).toContain('no longer matches');
    }
  });
  it('rejects both changed identity and changed/missing controls', () => {
    expect(workspaceRevisionIssue(input, device)).toBeUndefined();
    expect(workspaceRevisionIssue(input, { ...device, identityRevision: 2 })).toContain('identity changed');
    expect(workspaceRevisionIssue(input, { ...device, spec: { ...device.spec!, rev: 3 } })).toContain('controls changed');
    expect(workspaceRevisionIssue(input, { ...device, spec: undefined })).toContain('controls changed');
    expect(workspaceRevisionIssue({ ...input, specId: undefined, workspace: { ...workspace, selected: { targetId: 'tag:synth', cardId: 'synth' } } }, device)).toBeUndefined();
    expect(workspaceRevisionIssue({ ...input, workspace: { ...workspace, selected: { ...workspace.selected!, specRevision: 1 } } }, { ...device, spec: { specId: 'spec' } })).toBeUndefined();
  });
  it('labels snapshot provenance and supplies actual current map and verification separately', () => {
    const facts = assistantWorkspaceFacts(input, device)!;
    expect(facts.observedAtRequestStart).toMatchObject({ source: 'requesting-client', stage: 'building', mappingOutcome: 'working' });
    expect(facts.selectedDevice).toMatchObject({ source: 'server', name: 'Visual synth', identityRevision: 1 });
    expect(facts.currentControls).toEqual({ source: 'server', specId: 'spec', revision: 2, gestureMap: null, verifiedActionIds: ['warp'], armed: false });
    expect(assistantWorkspaceFacts(input)?.selectedDevice).toBeNull();
    expect(assistantWorkspaceFacts({ ...input, workspace: undefined }, device)).toBeUndefined();
  });
});
