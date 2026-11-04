import { createVisualSynth, createVisualSynthRelay, type VisualSynthParameters, type VisualSynthRenderer, type VisualSynthRelay } from '@ce/vsynth';
import { announceVisualRenderer } from './visualPresence';
import './visualLauncher.css';

const SVG = 'http://www.w3.org/2000/svg';
/** Arc gauges that mirror the two AR dials (Warp on hand height, Ripples on push/pull). */
const GAUGES = [{ key: 'warp', label: 'Warp' }, { key: 'ripple', label: 'Ripples' }] as const;
const ARC = 'M 8 44 A 36 36 0 1 1 72 44';
const ARC_LENGTH = 169.6; // 270° of r=36

/**
 * The Mac's full-screen visual synth: the device the headset controls. In-page (no popup permission),
 * it keeps animating while the window is visible but unfocused, and answers each applied command with a
 * receipt (frame, visibility, parameters) that the companion forwards in exec.ack.
 */
export class VisualSynthLauncher {
  private panel?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private output?: HTMLOutputElement;
  private retry?: HTMLButtonElement;
  private readoutName?: HTMLElement;
  private readoutValue?: HTMLElement;
  private live?: HTMLElement;
  private gauges = new Map<string, { arc: SVGPathElement; value: HTMLElement }>();
  private renderer?: VisualSynthRenderer;
  private relay?: VisualSynthRelay;
  private presence?: ReturnType<typeof announceVisualRenderer>;
  private ownerId?: string;
  private ready = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private chromeTimer?: ReturnType<typeof setTimeout>;
  /** Keeps the Mac's display awake while the visuals show (the user is looking through the headset). */
  private wakeLock?: WakeLockSentinel;
  private wakeLockPending = false;
  private readonly visibility = () => this.update();
  private readonly resize = () => {
    if (!this.canvas) return;
    const scale = Math.min(devicePixelRatio || 1, 1.5, 1920 / Math.max(innerWidth, 1));
    this.canvas.width = Math.max(1, Math.round(innerWidth * scale));
    this.canvas.height = Math.max(1, Math.round(innerHeight * scale));
    if (this.ready) this.renderer?.render(performance.now());
  };
  private readonly keys = (event: KeyboardEvent) => {
    if (event.key === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey) this.toggleFullscreen();
  };

  constructor(private readonly options: {
    owner(): string | undefined;
    connected(): boolean;
    onClosed?(): void;
  }) {}

  get opened(): boolean { return !!this.panel; }
  /** The panel is up and its renderer started (not waiting on a retry after a graphics failure). */
  get drawing(): boolean { return !!this.panel && this.ready; }
  /** Advertised to the room: a visible, ready screen of the paired owner on a live connection. */
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
    const brand = document.createElement('div'); brand.className = 'visual-launcher-brand';
    const live = document.createElement('span'); live.className = 'visual-launcher-live';
    const title = document.createElement('strong'); title.textContent = 'ControlAnything';
    brand.append(live, title);
    const full = document.createElement('button'); full.type = 'button'; full.textContent = 'Full screen'; full.className = 'visual-launcher-chrome';
    full.addEventListener('click', () => this.toggleFullscreen());
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Back to companion'; close.className = 'visual-launcher-chrome';
    close.addEventListener('click', () => this.close());
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.hidden = true;
    retry.addEventListener('click', () => this.open());
    toolbar.append(brand, retry, full, close);
    const output = document.createElement('output'); output.className = 'visual-launcher-status'; output.setAttribute('aria-live', 'polite');
    output.textContent = 'Opening visuals…';
    const readout = document.createElement('div'); readout.className = 'visual-launcher-readout';
    const readoutName = document.createElement('span'); readoutName.className = 'visual-launcher-readout-name';
    const readoutValue = document.createElement('span'); readoutValue.className = 'visual-launcher-readout-value';
    readout.append(readoutName, readoutValue);
    const meters = document.createElement('div'); meters.className = 'visual-launcher-meters';
    this.gauges.clear();
    for (const gauge of GAUGES) {
      const host = document.createElement('div'); host.className = 'visual-launcher-gauge';
      const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 80 72'); svg.setAttribute('aria-hidden', 'true');
      const track = document.createElementNS(SVG, 'path'); track.setAttribute('d', ARC); track.setAttribute('class', 'track');
      const arc = document.createElementNS(SVG, 'path'); arc.setAttribute('d', ARC); arc.setAttribute('class', 'value');
      arc.setAttribute('stroke-dasharray', `0 ${ARC_LENGTH}`);
      svg.append(track, arc);
      const value = document.createElement('span'); value.className = 'visual-launcher-gauge-value';
      const label = document.createElement('span'); label.className = 'visual-launcher-gauge-label'; label.textContent = gauge.label;
      host.append(svg, value, label); meters.append(host);
      this.gauges.set(gauge.key, { arc, value });
    }
    panel.append(canvas, toolbar, output, readout, meters); document.body.append(panel);
    this.panel = panel; this.canvas = canvas; this.output = output; this.retry = retry;
    this.readoutName = readoutName; this.readoutValue = readoutValue; this.live = live;
    panel.addEventListener('pointermove', () => this.showChrome());
    panel.addEventListener('dblclick', () => this.toggleFullscreen());
    this.resize();
    try {
      const renderer = this.renderer = createVisualSynth(canvas, { onChange: (label, parameters) => this.changed(label, parameters) });
      // Creation compiles the shaders and draws once. Draw at the actual canvas
      // dimensions before publishing any visible-renderer readiness.
      renderer.renderAt(0);
      this.meters(renderer.getState());
      this.relay = createVisualSynthRelay(renderer, {
        renderer: () => ({ visible: document.visibilityState === 'visible', frame: renderer.stats().frames }),
      });
      this.ready = true;
      this.presence = announceVisualRenderer(owner, () => this.available);
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault(); this.ready = false; renderer.stop(); this.presence?.update();
        if (this.output) this.output.textContent = 'Graphics paused. Choose Try again to reopen this screen.';
        if (this.retry) this.retry.hidden = false;
      });
      document.addEventListener('visibilitychange', this.visibility);
      globalThis.addEventListener('resize', this.resize);
      globalThis.addEventListener('keydown', this.keys);
      this.update();
      this.showChrome();
      return true;
    } catch (error) {
      this.ready = false; this.renderer?.dispose(); this.renderer = undefined;
      output.textContent = error instanceof Error ? error.message : 'The visual screen could not start. Choose Try again.';
      retry.hidden = false;
      return false;
    }
  }

  /** The animation runs whenever the page is visible (focused or not); readiness also needs the room connection. */
  update(): void {
    if (!this.panel) return;
    if (this.ownerId !== this.options.owner()) { this.close(); return; }
    if (this.ready && !document.hidden) { this.renderer?.start(); this.keepAwake(); }
    else this.renderer?.stop();
    const available = this.available;
    this.live?.classList.toggle('on', available);
    if (this.output && this.ready) {
      const text = available ? '' : document.hidden ? 'Paused while this companion tab is hidden' : 'Paused · Reconnecting to your room';
      if (this.output.textContent !== text) this.output.textContent = text;
      if (this.output.hidden !== available) this.output.hidden = available;
    }
    this.presence?.update();
  }

  /** Screen Wake Lock (Chrome, secure context): the browser drops it when the page hides; update() asks again. */
  private keepAwake(): void {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!wakeLock || this.wakeLock || this.wakeLockPending) return;
    this.wakeLockPending = true;
    wakeLock.request('screen').then((sentinel) => {
      this.wakeLockPending = false;
      if (!this.panel) { void sentinel.release().catch(() => {}); return; }
      this.wakeLock = sentinel;
      sentinel.addEventListener('release', () => { if (this.wakeLock === sentinel) this.wakeLock = undefined; });
    }, () => { this.wakeLockPending = false; });
  }

  close(): void {
    const hadPanel = !!this.panel;
    void this.wakeLock?.release().catch(() => {}); this.wakeLock = undefined;
    this.ready = false; this.presence?.dispose(); this.presence = undefined;
    this.relay?.dispose(); this.relay = undefined;
    this.renderer?.dispose(); this.renderer = undefined;
    clearTimeout(this.idleTimer); clearTimeout(this.chromeTimer);
    document.removeEventListener('visibilitychange', this.visibility);
    globalThis.removeEventListener('resize', this.resize);
    globalThis.removeEventListener('keydown', this.keys);
    if (document.fullscreenElement && document.fullscreenElement === this.panel) void document.exitFullscreen?.().catch(() => {});
    this.panel?.remove(); this.panel = undefined; this.canvas = undefined; this.output = undefined; this.retry = undefined; this.ownerId = undefined;
    this.readoutName = undefined; this.readoutValue = undefined; this.live = undefined; this.gauges.clear();
    if (hadPanel) this.options.onClosed?.();
  }

  /** Open visuals on a panel that is already up: show its buttons (Full screen, Back to companion) again. */
  reveal(): void {
    if (!this.panel) return;
    this.showChrome();
  }

  private toggleFullscreen(): void {
    if (!this.panel) return;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void this.panel.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  }

  /** Buttons appear on pointer movement and fade out after 2.5 s, so recordings show only the visuals. */
  private showChrome(): void {
    this.panel?.classList.add('chrome');
    clearTimeout(this.chromeTimer);
    this.chromeTimer = setTimeout(() => this.panel?.classList.remove('chrome'), 2500);
  }

  private changed(label: string, parameters: VisualSynthParameters): void {
    this.meters(parameters);
    // The fingertip (Touch X / Y / pressure, tens of updates a second) is drawn in the water itself; no big number for it.
    if (label === 'Connected · Ready' || label.startsWith('Touch ')) return;
    const [name, value] = label.split(' · ');
    if (!this.readoutName || !this.readoutValue || !this.panel) return;
    this.readoutName.textContent = label === 'Reset · Ready' ? 'Reset' : name ?? '';
    this.readoutValue.textContent = label === 'Reset · Ready' ? 'Ready' : value ?? '';
    this.panel.classList.add('changing');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.panel?.classList.remove('changing'), 2200);
  }

  private meters(parameters: VisualSynthParameters): void {
    for (const { key } of GAUGES) {
      const gauge = this.gauges.get(key);
      if (!gauge) continue;
      const unit = Math.max(0, Math.min(1, parameters[key]));
      gauge.arc.setAttribute('stroke-dasharray', `${(unit * ARC_LENGTH).toFixed(1)} ${ARC_LENGTH}`);
      gauge.value.textContent = `${Math.round(unit * 100)}`;
    }
  }
}
