import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../app/emitter';
import { api } from '../io/api';
import type { Envelope, WsClient } from '../io/ws';
import type { Mic } from './mic';
import { PushToTalk } from './ptt';

function setup() {
  const mic = Object.assign(new Emitter<{ chunk: { pcm: Int16Array; final: boolean; captureId?: string }; level: number; stopped: { reason: string } }>(), {
    prepare: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(),
  });
  let text!: (message: Envelope) => void;
  const ws = { on: (_type: string, fn: typeof text) => { text = fn; }, send: vi.fn() };
  const ptt = new PushToTalk(mic as unknown as Mic, ws as unknown as WsClient, () => 'token');
  const finish = () => mic.emit('chunk', { pcm: new Int16Array(5000), final: true });
  const transcript = (utteranceId: string) => text({ from: 'server', payload: { utteranceId, text: 'brighter', final: true } } as Envelope);
  return { mic, ws, ptt, finish, transcript };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('push-to-talk asynchronous boundaries', () => {
  it('deep-freezes workspace IDs and revisions across audio and the HTTP fallback', async () => {
    vi.useFakeTimers(); vi.spyOn(api, 'transcribe').mockResolvedValue({ text: 'Which map is active?' });
    const { mic, ws, ptt, finish } = setup();
    ptt.context = { cardId: 'synth', specId: 'spec', workspace: { version: 1, scope: 'device', surface: 'device', stage: 'ready', performance: 'off',
      selected: { targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 2 } } };
    await ptt.press();
    ptt.context.workspace!.selected!.specRevision = 3;
    mic.emit('chunk', { pcm: new Int16Array(20), final: false }); finish();
    await vi.advanceTimersByTimeAsync(ptt.fallbackMs);
    for (const [, payload] of ws.send.mock.calls) expect(payload.workspace.selected.specRevision).toBe(2);
    expect(ws.send.mock.calls.at(-1)?.[0]).toBe('voice.text');
  });

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

  it('cancels capture and pending HTTP fallback without a final command', async () => {
    vi.useFakeTimers(); const transcribe = vi.spyOn(api, 'transcribe').mockResolvedValue({ text: 'connect this' });
    const { mic, ws, ptt, finish } = setup();
    await ptt.press(); ptt.cancel(); finish();
    expect(ws.send).not.toHaveBeenCalled(); expect(mic.stop).toHaveBeenCalledOnce();
    await ptt.press(); finish(); ptt.cancel();
    await vi.advanceTimersByTimeAsync(ptt.fallbackMs);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('ignores queued chunks from an abandoned recording after starting a new one', async () => {
    const { mic, ws, ptt } = setup();
    await ptt.press(); const oldId = mic.start.mock.calls[0]?.[0]; ptt.cancel();
    await ptt.press();
    mic.emit('chunk', { pcm: new Int16Array(5000), final: true, captureId: oldId });
    expect(ws.send).not.toHaveBeenCalled(); expect(ptt.listening).toBe(true);
    ptt.cancel();
  });

  it('does not submit a too-short recording for command execution', async () => {
    const { mic, ws, ptt } = setup(); const error = vi.fn(); ptt.on('error', error);
    await ptt.press(); mic.emit('chunk', { pcm: new Int16Array(500), final: true });
    expect(ws.send).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
    expect(ptt.listening).toBe(false);
  });

  it('reports input loss instead of remaining stuck listening', async () => {
    const { mic, ptt } = setup(); const error = vi.fn(); ptt.on('error', error);
    await ptt.press(); mic.emit('stopped', { reason: 'Input lost' });
    expect(ptt.listening).toBe(false); expect(error).toHaveBeenCalledWith('Input lost');
  });

  it('bounds the wait for a worklet that fails to flush after Send', async () => {
    vi.useFakeTimers(); const { ptt } = setup(); const error = vi.fn(); ptt.on('error', error);
    await ptt.press(); ptt.release(); await vi.advanceTimersByTimeAsync(1500);
    expect(ptt.listening).toBe(false); expect(error).toHaveBeenCalledOnce();
  });

  it('reports empty HTTP transcription instead of leaving the assistant waiting', async () => {
    vi.useFakeTimers(); vi.spyOn(api, 'transcribe').mockResolvedValue({ text: ' ' });
    const { ptt, finish, ws } = setup(); const error = vi.fn(); ptt.on('error', error);
    await ptt.press(); finish(); await vi.advanceTimersByTimeAsync(ptt.fallbackMs);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No speech heard'));
    expect(ws.send.mock.calls.some(([type]) => type === 'voice.text')).toBe(false);
  });
});
