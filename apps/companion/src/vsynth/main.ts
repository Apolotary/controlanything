import { createVisualSynth, createVisualSynthRelay, WaterAudio } from '@ce/vsynth';
import { demoAudioMaster } from '@ce/protocol';
import { announceVisualRenderer } from '../visualPresence';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#visuals')!;
const change = document.querySelector<HTMLOutputElement>('#last-change')!;

try {
  demoAudioMaster.forceMute(new URLSearchParams(location.search).get('mute') === '1');
  const audio = new WaterAudio();
  const synth = createVisualSynth(canvas, { onChange: (label, parameters) => {
    change.textContent = label === 'Connected · Ready' ? 'Visuals connected · Select this Mac and ask Muse to wire your hands'
      : label === 'Reset · Ready' ? 'Reset · Ask Muse in Quest for new hand wiring' : label;
    if (label === 'Connected · Ready' || label === 'Reset · Ready') audio.adopt(parameters);
    else if (label.startsWith('Touch ')) audio.receive(parameters);
  } });
  const audioSubscriptions = [demoAudioMaster.registerOutput(volume => audio.setVolume(volume)),
    demoAudioMaster.onUnlock(() => { void audio.unlock().catch(() => {}); })];
  const unlock = () => demoAudioMaster.unlock();
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
  audio.adopt(synth.getState()); audio.setActive(!document.hidden);
  const relay = createVisualSynthRelay(synth, { renderer: () => ({ visible: document.visibilityState === 'visible', frame: synth.stats().frames }) });
  const presence = announceVisualRenderer(new URLSearchParams(location.search).get('owner'), () => !document.hidden);
  const resize = (): void => {
    // Limit pixel work on large laptop displays while keeping the canvas crisp.
    const scale = Math.min(devicePixelRatio || 1, 1.5, 1920 / Math.max(innerWidth, 1));
    canvas.width = Math.max(1, Math.round(innerWidth * scale));
    canvas.height = Math.max(1, Math.round(innerHeight * scale));
  };
  resize();
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) synth.stop();
    else synth.start();
    audio.setActive(!document.hidden);
    presence.update();
  });
  addEventListener('pagehide', () => { presence.dispose(); relay.dispose(); synth.dispose(); audio.dispose();
    for (const unsubscribe of audioSubscriptions) unsubscribe();
    removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock);
  }, { once: true });
  synth.start();
} catch (error) {
  change.textContent = error instanceof Error ? error.message : 'The visual instrument could not start.';
  document.body.classList.add('unavailable');
}
