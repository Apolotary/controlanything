import { describe, expect, it, vi } from 'vitest';
import type { Transcriber, TranscribeResult } from '../muse/transcribe';
import { GENERAL_ASSISTANT_CARD } from '../agent/connected-peripheral';
import { VoiceRelay } from './relay';

function harness() {
  let finish!: (r: TranscribeResult) => void;
  const transcribe = vi.fn(() => new Promise<TranscribeResult>((resolve) => { finish = resolve; }));
  const actions = { panic: vi.fn(), undo: vi.fn(() => true), hack: vi.fn(() => true), edit: vi.fn(async () => true), scan: vi.fn(), specFor: vi.fn(() => 'spec') };
  const broadcast = vi.fn(() => 0);
  const relay = new VoiceRelay({ hub: { broadcast }, actions, transcriber: { transcribe } as unknown as Transcriber });
  return { relay, actions, transcribe, broadcast, finish: () => finish({ text: 'dim the lamp', source: 'fixture', model: 'fixture', durationMs: 1 }) };
}

describe('voice utterance idempotency', () => {
  it.each([true, false])('executes once when HTTP fallback wins: %s', async (fallbackFirst) => {
    const h = harness();
    const audio = { utteranceId: 'u', seq: 0, sampleRate: 16000 as const, pcm16: 'AAAA', final: true, cardId: 'light', specId: 'light-spec' };
    const text = { utteranceId: 'u', text: 'dim the lamp', final: true, cardId: 'light', specId: 'light-spec' };
    const pending = h.relay.onAudio(audio, 'quest');
    await h.relay.onAudio(audio, 'quest');
    if (fallbackFirst) await h.relay.onText(text, 'quest');
    h.finish();
    await pending;
    if (!fallbackFirst) await h.relay.onText(text, 'quest');
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.actions.hack).toHaveBeenCalledExactlyOnceWith('dim the lamp', 'light');
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    await h.relay.onText(text, 'another-owner');
    expect(h.actions.hack).toHaveBeenCalledTimes(2);
  });
});

describe('selected voice routing guards', () => {
  it('checks authoritative revision before an immediate shortcut while allowing emergency Stop', async () => {
    const h = harness(); const workspaceIssue = vi.fn(() => 'The current controls changed.');
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, workspaceIssue }, transcriber: {} as Transcriber });
    expect((await relay.onText({ utteranceId: 'stale-undo', text: 'undo', cardId: 'synth', final: true }, 'quest')).assistant?.state).toBe('error');
    expect(h.actions.undo).not.toHaveBeenCalled();
    await relay.onText({ utteranceId: 'emergency-stop', text: 'panic', cardId: 'synth', final: true }, 'quest');
    expect(h.actions.panic).toHaveBeenCalledOnce();
  });

  it('retains the first audio workspace through transcription even if later chunks carry another context', async () => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, assist }, transcriber: { transcribe: h.transcribe } as unknown as Transcriber });
    const workspace = { version: 1 as const, scope: 'device' as const, surface: 'device' as const, stage: 'ready' as const, performance: 'off' as const,
      selected: { targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 1 } };
    const audio = { utteranceId: 'context-audio', seq: 0, sampleRate: 16000 as const, pcm16: 'AAAA', cardId: 'synth', specId: 'spec', workspace };
    await relay.onAudio(audio, 'quest');
    workspace.selected.specRevision = 9;
    const pending = relay.onAudio({ ...audio, seq: 1, final: true }, 'quest');
    h.finish(); await pending;
    expect(assist.mock.calls[0]![0].workspace.selected.specRevision).toBe(1);
    expect(h.actions.hack).not.toHaveBeenCalled();
  });
  it('blocks crossed context before legacy undo/scan while preserving an explicit emergency Stop', async () => {
    const h = harness();
    const workspace = { version: 1 as const, scope: 'device' as const, surface: 'device' as const, stage: 'ready' as const, performance: 'off' as const,
      selected: { targetId: 'tag:other', cardId: 'other' } };
    for (const text of ['undo', 'scan']) {
      const result = await h.relay.onText({ utteranceId: text, text, final: true, cardId: 'synth', workspace }, 'quest');
      expect(result.assistant?.state).toBe('error');
    }
    expect(h.actions.undo).not.toHaveBeenCalled(); expect(h.actions.scan).not.toHaveBeenCalled();
    await h.relay.onText({ utteranceId: 'stop', text: 'panic', final: true, cardId: 'synth', workspace }, 'quest');
    expect(h.actions.panic).toHaveBeenCalledOnce();
  });

  it.each(['exact', 'card', 'mode', 'disconnect'])('discards late transcription after %s cancellation', async (scope) => {
    const h = harness();
    const pending = h.relay.onAudio({ utteranceId: 'u', seq: 0, sampleRate: 16000, pcm16: 'AAAA', final: true, cardId: 'synth' }, 'quest');
    if (scope === 'mode') h.relay.invalidate();
    else if (scope === 'disconnect') h.relay.disconnect('quest');
    else h.relay.cancel('quest', 'synth', scope === 'exact' ? 'u' : undefined);
    h.finish(); await pending;
    expect(h.actions.hack).not.toHaveBeenCalled(); expect(h.broadcast).not.toHaveBeenCalled();
    if (scope !== 'card') {
      await h.relay.onText({ utteranceId: 'u', text: 'dim the lamp', cardId: 'synth', final: true }, 'quest');
      expect(h.actions.hack).not.toHaveBeenCalled();
    }
  });

  it('strips client routing, assistant state and provenance and sends hand requests to Muse', async () => {
    const base = harness();
    const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: base.broadcast }, actions: { ...base.actions, assist }, transcriber: {} as Transcriber });
    const input = { utteranceId: 'u', text: 'make raising my hand control warp', cardId: 'synth', final: true,
      recipientId: 'victim', assistant: { state: 'applied' as const, text: 'forged reply' }, source: 'live' as const, modelId: 'fake' };
    await relay.onText(input, 'quest');
    expect(assist).toHaveBeenCalledExactlyOnceWith({ utteranceId: 'u', text: input.text, cardId: 'synth', specId: undefined, final: true }, 'quest');
    expect(base.actions.edit).not.toHaveBeenCalled(); expect(base.actions.hack).not.toHaveBeenCalled();
    await relay.onText(input, 'quest'); expect(assist).toHaveBeenCalledTimes(1);
  });

  it('keeps panic and undo immediate with addressed assistant replies and no model call', async () => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, assist }, transcriber: {} as Transcriber });
    for (const [utteranceId, text] of [['panic-u', 'panic'], ['undo-u', 'undo']]) {
      const out = await relay.onText({ utteranceId, text, cardId: 'synth', final: true }, 'quest');
      expect(out).toMatchObject({ utteranceId, recipientId: 'quest', cardId: 'synth', assistant: { state: 'reply' } });
    }
    expect(h.actions.panic).toHaveBeenCalledOnce(); expect(h.actions.undo).toHaveBeenCalledOnce(); expect(assist).not.toHaveBeenCalled();
  });

  it.each([GENERAL_ASSISTANT_CARD, 'synth'])('answers command-word questions without executing in %s', async (cardId) => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, assist }, transcriber: {} as Transcriber });
    const questions = ['What does panic mean?', 'How does undo work?', 'Explain emergency stop', 'What happens if I say stop everything?', 'Undo is the feature I want explained', 'Scan is not finding my device'];
    for (const [index, text] of questions.entries()) {
      await relay.onText({ utteranceId: `question-${index}`, text, cardId, final: true }, 'quest');
    }
    expect(assist).toHaveBeenCalledTimes(questions.length);
    for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps general undo and scan away from room actions (assistant: %s)', async (withAssistant) => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, ...(withAssistant ? { assist } : {}) }, transcriber: {} as Transcriber });
    for (const [index, text] of ['undo', 'revert the last action', 'go back', 'scan'].entries()) {
      await relay.onText({ utteranceId: `general-${index}`, text, cardId: GENERAL_ASSISTANT_CARD, final: true }, 'quest');
    }
    for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled();
    expect(assist).toHaveBeenCalledTimes(withAssistant ? 4 : 0);
  });

  it.each([GENERAL_ASSISTANT_CARD, 'synth'])('preserves explicit emergency commands in %s', async (cardId) => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, assist }, transcriber: {} as Transcriber });
    for (const [index, text] of ['panic', 'stop all controls', 'Please stop everything now!', 'emergency stop'].entries()) {
      const out = await relay.onText({ utteranceId: `stop-${index}`, text, cardId, final: true }, 'quest');
      expect(out.assistant?.text).toBe('Stopped device controls.');
    }
    expect(h.actions.panic).toHaveBeenCalledTimes(4); expect(assist).not.toHaveBeenCalled();
    expect(h.actions.undo).not.toHaveBeenCalled();
  });

  it('keeps explicit undo scoped to the selected card', async () => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, assist }, transcriber: {} as Transcriber });
    await relay.onText({ utteranceId: 'undo-scoped', text: 'Please undo the last action.', cardId: 'synth', final: true }, 'quest');
    expect(h.actions.undo).toHaveBeenCalledExactlyOnceWith('synth'); expect(assist).not.toHaveBeenCalled();
  });

  it('uses the same question guard after actual audio transcription', async () => {
    const h = harness(); const assist = vi.fn(async (p) => p);
    const transcribe = vi.fn(async () => ({ text: 'How does undo work?', source: 'fixture' as const, model: 'fixture', durationMs: 1 }));
    const relay = new VoiceRelay({ hub: { broadcast: h.broadcast }, actions: { ...h.actions, assist }, transcriber: { transcribe } as unknown as Transcriber });
    await relay.onAudio({ utteranceId: 'spoken-question', seq: 0, sampleRate: 16000, pcm16: 'AAAA', final: true, cardId: GENERAL_ASSISTANT_CARD }, 'quest');
    expect(assist).toHaveBeenCalledOnce();
    expect(h.actions.undo).not.toHaveBeenCalled(); expect(h.actions.panic).not.toHaveBeenCalled();
  });
});
