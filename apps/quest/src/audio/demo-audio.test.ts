import { afterEach, expect, it, vi } from 'vitest';
import { demoAudioMaster } from '@ce/protocol';
import { QuestDemoAudio } from './demo-audio';

afterEach(() => { demoAudioMaster.forceMute(false); demoAudioMaster.receive({ volume: .35, muted: false }); vi.unstubAllGlobals(); });

it('queues Mac OS speech when the headset lacks browser speech, respecting master and local test mute', () => {
  // No browser/OS audio is available or invoked by this routing check.
  vi.stubGlobal('speechSynthesis', undefined); vi.stubGlobal('AudioContext', undefined);
  const fallback = vi.fn(() => true), audio = new QuestDemoAudio(new URLSearchParams(), fallback);
  const quiet = new QuestDemoAudio(new URLSearchParams('mute=1'), fallback);
  try {
    demoAudioMaster.forceMute(false); demoAudioMaster.receive({ volume: .4, muted: false });
    audio.speak('Before a gesture'); expect(fallback).not.toHaveBeenCalled();
    demoAudioMaster.unlock();
    audio.speak('Hello from Buddy');
    expect(fallback).toHaveBeenCalledExactlyOnceWith('Hello from Buddy');
    expect(audio.snapshot().stats).toMatchObject({ speechAvailable: false, speechProvider: 'mac-os', macSpeechQueued: 1, speechStarted: 0 });
    quiet.speak('Muted automated test'); expect(fallback).toHaveBeenCalledTimes(1);
    demoAudioMaster.receive({ volume: .4, muted: true }); audio.speak('Master muted'); expect(fallback).toHaveBeenCalledTimes(1);
  } finally { audio.dispose(); quiet.dispose(); }
});

it('does not enqueue new OS speech from a hidden page', () => {
  vi.stubGlobal('speechSynthesis', undefined); vi.stubGlobal('AudioContext', undefined);
  const page = { hidden: false }; vi.stubGlobal('document', page);
  const fallback = vi.fn(() => true), audio = new QuestDemoAudio(new URLSearchParams(), fallback);
  try {
    demoAudioMaster.receive({ volume: .4, muted: false }); demoAudioMaster.unlock();
    audio.speak('Visible reaction'); expect(fallback).toHaveBeenCalledTimes(1);
    page.hidden = true; audio.speak('Late reaction'); expect(fallback).toHaveBeenCalledTimes(1);
  } finally { audio.dispose(); }
});

it('plays Mac-rendered OS speech on a headset without browser speech, sends the paired token, and drops a line replaced mid-fetch', async () => {
  const started: string[] = [];
  class FakeContext {
    state = 'running'; currentTime = 0; destination = {}; onstatechange: (() => void) | null = null;
    createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    decodeAudioData(bytes: ArrayBuffer) { return Promise.resolve({ line: new TextDecoder().decode(bytes) }); }
    createBufferSource() {
      const source = { buffer: null as { line: string } | null, onended: null, connect() {}, stop() {}, start: () => { started.push(source.buffer!.line); } };
      return source;
    }
  }
  vi.stubGlobal('speechSynthesis', undefined); vi.stubGlobal('AudioContext', FakeContext);
  const replies: (() => void)[] = [];
  const fetchMock = vi.fn((_url: string, init: { headers: Record<string, string>; body: string }) => new Promise((resolve) => {
    const line = (JSON.parse(init.body) as { text: string }).text;
    replies.push(() => resolve({ ok: true, arrayBuffer: async () => new TextEncoder().encode(line).buffer }));
  }));
  vi.stubGlobal('fetch', fetchMock);
  const fallback = vi.fn(() => true), audio = new QuestDemoAudio(new URLSearchParams(), fallback, () => 'device-token');
  try {
    demoAudioMaster.receive({ volume: .4, muted: false }); demoAudioMaster.unlock();
    audio.speak('First line'); audio.speak('Second line');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ Authorization: 'Bearer device-token' });
    for (const reply of replies) reply();
    await vi.waitFor(() => expect(started).toEqual(['Second line']));
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['Second line']);
    expect(fallback).not.toHaveBeenCalled();
    expect(audio.snapshot().stats).toMatchObject({ speechProvider: 'mac-os-on-headset', speechStarted: 1 });
  } finally { audio.dispose(); }
});
