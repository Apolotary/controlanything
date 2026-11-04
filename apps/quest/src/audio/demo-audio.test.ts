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
