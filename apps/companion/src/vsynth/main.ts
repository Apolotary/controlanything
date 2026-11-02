import { createVisualSynth, createVisualSynthRelay } from '@ce/vsynth';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#visuals')!;
const change = document.querySelector<HTMLOutputElement>('#last-change')!;

try {
  const synth = createVisualSynth(canvas, { onChange: (label) => { change.textContent = label; } });
  const relay = createVisualSynthRelay(synth);
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
  });
  addEventListener('pagehide', () => { relay.dispose(); synth.dispose(); }, { once: true });
  synth.start();
} catch (error) {
  change.textContent = error instanceof Error ? error.message : 'The visual instrument could not start.';
  document.body.classList.add('unavailable');
}
