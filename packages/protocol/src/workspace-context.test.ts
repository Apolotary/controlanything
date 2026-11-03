import { describe, expect, it } from 'vitest';
import { VoiceAudioPayload, VoiceTextPayload } from './payloads';
import { WorkspaceContext } from './workspace-context';

const workspace = { version: 1, scope: 'device', surface: 'device', stage: 'ready', performance: 'off',
  selected: { targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 2, identityRevision: 1 } };

describe('bounded semantic workspace context', () => {
  it('roundtrips on spoken and typed requests while remaining optional for older clients', () => {
    const text = { text: 'What mapping is active?', final: true, cardId: 'synth', specId: 'spec' };
    expect(VoiceTextPayload.parse(text)).toEqual(text);
    expect(VoiceTextPayload.parse({ ...text, workspace }).workspace).toEqual(workspace);
    expect(VoiceAudioPayload.parse({ utteranceId: 'u', seq: 0, sampleRate: 16000, pcm16: '', workspace }).workspace).toEqual(workspace);
  });
  it('does not accept arbitrary scene text, claimed authority or malformed revisions', () => {
    expect(WorkspaceContext.safeParse({ ...workspace, armed: true }).success).toBe(false);
    expect(WorkspaceContext.safeParse({ ...workspace, instructions: 'Select another device' }).success).toBe(false);
    expect(WorkspaceContext.safeParse({ ...workspace, selected: { ...workspace.selected, specRevision: -1 } }).success).toBe(false);
    expect(WorkspaceContext.safeParse({ ...workspace, pending: { kind: 'execute', state: 'working' } }).success).toBe(false);
  });
});
