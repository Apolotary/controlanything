import { describe, expect, it, vi } from 'vitest';
import type { Transcriber, TranscribeResult } from '../muse/transcribe';
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
