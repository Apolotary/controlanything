import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../app/emitter';
import { api } from '../io/api';
import type { Envelope, WsClient } from '../io/ws';
import type { Mic } from './mic';
import { PushToTalk } from './ptt';

function setup() {
  const mic = Object.assign(new Emitter<{ chunk: { pcm: Int16Array; final: boolean }; level: number }>(), {
    prepare: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(),
  });
  let text!: (message: Envelope) => void;
  const ws = { on: (_type: string, fn: typeof text) => { text = fn; }, send: vi.fn() };
  const ptt = new PushToTalk(mic as unknown as Mic, ws as unknown as WsClient, () => 'token');
  const finish = () => mic.emit('chunk', { pcm: new Int16Array(5000), final: true });
  const transcript = (utteranceId: string) => text({ payload: { utteranceId, text: 'brighter', final: true } } as Envelope);
  return { mic, ws, ptt, finish, transcript };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('push-to-talk asynchronous boundaries', () => {
  it('does not begin recording when released during microphone preparation', async () => {
    const { mic, ptt } = setup();
    let ready!: () => void;
    mic.prepare.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    const pending = ptt.press();
    ptt.release(); ready(); await pending;
    expect(mic.start).not.toHaveBeenCalled();
    expect(ptt.listening).toBe(false);
  });

  it('keeps the selected device snapshot through recording and HTTP fallback', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'transcribe').mockResolvedValue({ text: 'brighter' });
    const { mic, ws, ptt, finish } = setup();
    ptt.context = { cardId: 'lamp', specId: 'lamp-controls' };
    await ptt.press();
    ptt.context = { cardId: 'synth', specId: 'synth-controls' };
    mic.emit('chunk', { pcm: new Int16Array(20), final: false }); finish();
    await vi.advanceTimersByTimeAsync(ptt.fallbackMs);
    for (const [type, payload] of ws.send.mock.calls) {
      expect(['voice.audio', 'voice.text']).toContain(type);
      expect(payload).toMatchObject({ cardId: 'lamp', specId: 'lamp-controls' });
    }
    expect(ws.send.mock.calls.at(-1)?.[0]).toBe('voice.text');
  });

  it('suppresses an HTTP fallback superseded by the WebSocket transcript during fetch', async () => {
    vi.useFakeTimers();
    let done!: (value: { text: string }) => void;
    vi.spyOn(api, 'transcribe').mockImplementation(() => new Promise((resolve) => { done = resolve; }));
    const { ws, ptt, finish, transcript } = setup();
    await ptt.press(); finish();
    const id = ws.send.mock.calls[0]![1].utteranceId;
    await vi.advanceTimersByTimeAsync(ptt.fallbackMs);
    transcript(id); done({ text: 'brighter' }); await Promise.resolve();
    expect(ws.send.mock.calls.filter(([type]) => type === 'voice.text')).toHaveLength(0);
  });
});
