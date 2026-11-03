import { createVisualSynth, createVisualSynthRelay } from '@ce/vsynth';
import { announceVisualRenderer } from '../visualPresence';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#visuals')!;
const change = document.querySelector<HTMLOutputElement>('#last-change')!;

try {
  const synth = createVisualSynth(canvas, { onChange: (label) => {
    change.textContent = label === 'Connected · Ready' ? 'Visuals connected · Use Try visual synth in your headset'
      : label === 'Reset · Ready' ? 'Reset · Enable and Perform from your headset' : label;
  } });
  const relay = createVisualSynthRelay(synth);
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
    presence.update();
  });
  addEventListener('pagehide', () => { presence.dispose(); relay.dispose(); synth.dispose(); }, { once: true });
  synth.start();
} catch (error) {
  change.textContent = error instanceof Error ? error.message : 'The visual instrument could not start.';
  document.body.classList.add('unavailable');
}
