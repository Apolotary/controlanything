import { createVisualSynth, createVisualSynthRelay, type VisualSynthRenderer, type VisualSynthRelay } from '@ce/vsynth';
import { announceVisualRenderer } from './visualPresence';
import './visualLauncher.css';

/** In-page launch is intentionally independent of browser popup permission. */
export class VisualSynthLauncher {
  private panel?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private output?: HTMLOutputElement;
  private retry?: HTMLButtonElement;
  private renderer?: VisualSynthRenderer;
  private relay?: VisualSynthRelay;
  private presence?: ReturnType<typeof announceVisualRenderer>;
  private ownerId?: string;
  private ready = false;
  private lastLabel = 'Visuals ready · Continue Set up control in Quest, then Enable and Perform';
  private readonly visibility = () => this.update();
  private readonly resize = () => {
    if (!this.canvas) return;
    const scale = Math.min(devicePixelRatio || 1, 1.5, 1920 / Math.max(innerWidth, 1));
    this.canvas.width = Math.max(1, Math.round(innerWidth * scale));
    this.canvas.height = Math.max(1, Math.round(innerHeight * scale));
    if (this.ready) this.renderer?.render(performance.now());
  };

  constructor(private readonly options: {
    owner(): string | undefined;
    connected(): boolean;
    onClosed?(): void;
  }) {}

  get opened(): boolean { return !!this.panel; }
  get available(): boolean { return this.ready && !!this.panel && !document.hidden && this.options.connected() && this.ownerId === this.options.owner(); }

  open(): boolean {
    const owner = this.options.owner();
    if (!owner) return false;
    if (this.panel && this.ownerId === owner && this.ready) { this.update(); return true; }
    this.close(); this.ownerId = owner;
    const panel = document.createElement('section'); panel.className = 'visual-launcher'; panel.id = 'visual-launcher';
    panel.setAttribute('aria-label', 'Visual synth');
    const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', 'Silent visual synth controlled from Quest');
    const toolbar = document.createElement('div'); toolbar.className = 'visual-launcher-toolbar';
    const title = document.createElement('strong'); title.textContent = 'ControlAnything · Visual Synth';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Back to companion';
    close.addEventListener('click', () => this.close());
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.hidden = true;
    retry.addEventListener('click', () => this.open());
    toolbar.append(title, retry, close);
    const output = document.createElement('output'); output.className = 'visual-launcher-status'; output.setAttribute('aria-live', 'polite');
    output.textContent = 'Opening visuals…';
    panel.append(canvas, toolbar, output); document.body.append(panel);
    this.panel = panel; this.canvas = canvas; this.output = output; this.retry = retry;
    this.resize();
    try {
      const renderer = this.renderer = createVisualSynth(canvas, { onChange: (label) => {
        this.lastLabel = label === 'Connected · Ready'
          ? 'Visuals connected · Continue setup in Quest'
          : label === 'Reset · Ready' ? 'Visuals reset · Enable and Perform from Quest' : label;
        if (this.output && this.available) this.output.textContent = this.lastLabel;
      } });
      // Creation compiles the shaders and draws once. Draw at the actual canvas
      // dimensions before publishing any visible-renderer readiness.
      renderer.renderAt(0);
      this.relay = createVisualSynthRelay(renderer);
      this.ready = true;
      this.presence = announceVisualRenderer(owner, () => this.available);
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault(); this.ready = false; renderer.stop(); this.presence?.update();
        if (this.output) this.output.textContent = 'Graphics paused. Choose Try again to reopen this screen.';
        if (this.retry) this.retry.hidden = false;
      });
      document.addEventListener('visibilitychange', this.visibility);
      globalThis.addEventListener('resize', this.resize);
      this.update();
      return true;
    } catch (error) {
      this.ready = false; this.renderer?.dispose(); this.renderer = undefined;
      output.textContent = error instanceof Error ? error.message : 'The visual screen could not start. Choose Try again.';
      retry.hidden = false;
      return false;
    }
  }

  /** Socket/visibility changes never advertise a hidden or disconnected renderer. */
  update(): void {
    if (!this.panel) return;
    if (this.ownerId !== this.options.owner()) { this.close(); return; }
    if (this.available) {
      this.renderer?.start();
      if (this.output) this.output.textContent = this.lastLabel;
    } else {
      this.renderer?.stop();
      if (this.output && this.ready) this.output.textContent = document.hidden ? 'Paused while this companion tab is hidden' : 'Paused · Reconnect the companion to continue';
    }
    this.presence?.update();
  }

  close(): void {
    const hadPanel = !!this.panel;
    this.ready = false; this.presence?.dispose(); this.presence = undefined;
    this.relay?.dispose(); this.relay = undefined;
    this.renderer?.dispose(); this.renderer = undefined;
    document.removeEventListener('visibilitychange', this.visibility);
    globalThis.removeEventListener('resize', this.resize);
    this.panel?.remove(); this.panel = undefined; this.canvas = undefined; this.output = undefined; this.retry = undefined; this.ownerId = undefined;
    this.lastLabel = 'Visuals ready · Continue Set up control in Quest, then Enable and Perform';
    if (hadPanel) this.options.onClosed?.();
  }
}
