/**
 * While a screen program runs (touch the water), Muse's AR controls stay hidden: the wearer just touches the real
 * screen. This small read-only glass panel beside the device shows what the program is doing: a tiny screen with the
 * fingertip dot, a thin pressure bar and the values it sends. It never takes pinches, pokes or rays.
 */
import { BufferGeometry, CircleGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3, type Object3D } from 'three';
import type { WireAction } from '@ce/protocol';
import type { WireLiveScreen, WireOutputStream } from '../contract';
import { GlassSurfaces } from './surface';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';

export const LIVE_PANEL = { width: 0.135, height: 0.112, screenW: 0.105, screenH: 0.05 } as const;
const ACCENT = '#8ad8ff';
const IDLE_TEXT = 'rgba(255,255,255,0.64)';

const noRay = (o: Object3D): void => { o.raycast = () => {}; };
const words = (id: string): string => id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
const fmt = (v: number, a: WireAction | undefined): string => {
  const span = a?.min !== undefined && a?.max !== undefined ? a.max - a.min : 1;
  return span > 10 || Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(2);
};
/** 0..1 within the action's range; values sent past it (e.g. MIDI 0..127 for a 0..1 action) use 0..127. */
const fraction = (v: number, a: WireAction | undefined): number => {
  const lo = a?.min ?? 0, max = a?.max ?? 1, hi = v > max ? 127 : max;
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
};

export class LivePanel extends Group {
  private readonly surfaces = new GlassSurfaces();
  private readonly plate = this.surfaces.create(LIVE_PANEL.width, LIVE_PANEL.height, 'plate');
  /** The tiny screen: a dark rectangle with a thin rim (a rounded glass button would read as a pill at this size). */
  private readonly screen = new Mesh(new PlaneGeometry(LIVE_PANEL.screenW, LIVE_PANEL.screenH), new MeshBasicMaterial({ color: '#0b0d12', transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly rim = new LineLoop(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([
    -LIVE_PANEL.screenW / 2, -LIVE_PANEL.screenH / 2, 0, LIVE_PANEL.screenW / 2, -LIVE_PANEL.screenH / 2, 0,
    LIVE_PANEL.screenW / 2, LIVE_PANEL.screenH / 2, 0, -LIVE_PANEL.screenW / 2, LIVE_PANEL.screenH / 2, 0], 3)),
  new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly track = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly bar = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly dot = new Mesh(new CircleGeometry(1, 24), new MeshBasicMaterial({ color: ACCENT, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly halo = new Mesh(new CircleGeometry(1, 32), new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly status = new Mesh(new CircleGeometry(0.0028, 16), new MeshBasicMaterial({ color: '#7ee2a8', transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  private readonly title: SdfText;
  private readonly values: SdfText;
  private readonly latest = new Map<string, number>();
  private readonly desired = new Vector3();
  private readonly look = new Vector3();
  private actions: WireAction[] = [];
  private live?: WireLiveScreen;
  private stream?: WireOutputStream;
  private hint = '';
  private seq = 0;
  private key = '';
  private placed = false;
  private opacity = 0;
  private shown = false;
  private textClock = 0;
  private pressure = 0;
  private pulse = 0;

  constructor() {
    super();
    this.name = 'screen-live-panel';
    this.visible = false;
    (this as unknown as { pointerEvents: string }).pointerEvents = 'none';
    const top = LIVE_PANEL.height / 2;
    this.screen.position.set(0, top - 0.026 - LIVE_PANEL.screenH / 2, 0.0005);
    this.rim.position.copy(this.screen.position).setZ(0.0006);
    this.track.scale.set(LIVE_PANEL.screenW, 0.003, 1);
    this.track.position.set(0, this.screen.position.y - LIVE_PANEL.screenH / 2 - 0.0065, 0.0006);
    this.bar.scale.set(0.0001, 0.003, 1);
    this.bar.position.copy(this.track.position).setZ(0.0007);
    this.dot.position.z = 0.0009; this.halo.position.z = 0.0008;
    this.status.position.set(-LIVE_PANEL.width / 2 + 0.014, top - 0.0135, 0.0006);
    this.title = makeText({ text: 'Live', size: 0.0095, weight: 600, anchorX: 'left', anchorY: 'middle', singleLine: true, maxWidth: LIVE_PANEL.width - 0.034 });
    this.title.position.set(-LIVE_PANEL.width / 2 + 0.022, top - 0.0135, 0.001);
    this.values = makeText({ text: ' ', size: 0.0076, tabular: true, anchorX: 'center', anchorY: 'top', align: 'center', color: '#cfd6e4', maxWidth: LIVE_PANEL.width - 0.016, maxHeight: 0.02 });
    this.values.position.set(0, this.track.position.y - 0.0055, 0.001);
    for (const m of [this.screen, this.rim, this.track, this.bar, this.halo, this.dot, this.status]) m.renderOrder = THEME.render.buttons + 1;
    this.dot.renderOrder = this.halo.renderOrder + 1;
    for (const o of [this.plate, this.screen, this.rim, this.track, this.bar, this.dot, this.halo, this.status, this.title, this.values]) { noRay(o); this.add(o); }
  }

  /** Show for this running screen program (null hides). */
  set(view: { live: WireLiveScreen; actions: WireAction[]; title?: string } | null, stream: WireOutputStream | undefined, hint: string | undefined): void {
    this.shown = !!view;
    if (!view) return;
    this.live = view.live; this.stream = stream; this.hint = hint ?? '';
    const key = `${view.title ?? ''}|${view.actions.map((a) => a.actionId).join(',')}`;
    if (key !== this.key) {
      this.key = key; this.actions = view.actions; this.latest.clear(); this.seq = stream?.seq ?? 0; this.placed = false; this.pressure = 0;
      setText(this.title, `Live · ${(view.title || 'Screen').slice(0, 26)}`);
    }
  }

  /** Beside the device at `anchor`, facing the eyes; eased so it never jumps. */
  place(anchor: Vector3, head: Vector3, dt: number): void {
    this.desired.copy(anchor);
    if (!this.placed) { this.position.copy(this.desired); this.placed = true; }
    else this.position.lerp(this.desired, 1 - Math.exp(-6 * Math.min(0.1, dt)));
    this.look.copy(head);
    this.lookAt(this.look);
  }

  private read(): void {
    const stream = this.stream;
    if (!stream) return;
    if (stream.seq < this.seq) this.seq = 0;
    for (let seq = Math.max(this.seq + 1, stream.seq - stream.slots.length + 1); seq <= stream.seq; seq++) {
      const e = stream.slots[(seq - 1) % stream.slots.length];
      if (e?.seq === seq) this.latest.set(e.actionId, Number(e.value));
    }
    this.seq = stream.seq;
  }

  /** "touch 0.42, 0.61 · pressure 0.80 · ripples 63" from the values the program last sent. */
  private line(): string {
    const name = (a: WireAction) => words(a.label && a.label.length <= 16 ? a.label : a.actionId);
    const stem = (n: string) => n.replace(/\s+/g, '');
    const parts: string[] = [], used = new Set<string>();
    for (const a of this.actions) {
      if (used.has(a.actionId) || !this.latest.has(a.actionId)) continue;
      const n = name(a), x = /^(.*?)\s?x$/.exec(n);
      const pair = x ? this.actions.find((b) => b !== a && stem(name(b)) === `${stem(x[1]!)}y` && this.latest.has(b.actionId)) : undefined;
      used.add(a.actionId);
      if (pair) {
        used.add(pair.actionId);
        parts.push(`${x![1]!.trim() || 'xy'} ${fmt(this.latest.get(a.actionId)!, a)}, ${fmt(this.latest.get(pair.actionId)!, pair)}`);
      } else parts.push(`${n} ${fmt(this.latest.get(a.actionId)!, a)}`);
    }
    return parts.slice(0, 5).join(' · ');
  }

  update(dt: number): void {
    this.opacity += ((this.shown ? 1 : 0) - this.opacity) * Math.min(1, dt * 8);
    this.visible = this.opacity > 0.01;
    if (!this.visible) return;
    this.title.visible = this.values.visible = this.opacity > 0.3;
    this.read();
    const live = this.live;
    // The pressure bar: the program's pressure-like output, else contact itself.
    const press = this.actions.find((a) => /press|force|depth|strength|velocity/i.test(`${a.actionId} ${a.label}`) && this.latest.has(a.actionId));
    const target = press ? fraction(this.latest.get(press.actionId)!, press) : live?.touching ? 1 : 0;
    this.pressure += (target - this.pressure) * Math.min(1, dt * 14);
    const w = Math.max(0.0001, LIVE_PANEL.screenW * this.pressure);
    this.bar.scale.x = w; this.bar.position.x = -LIVE_PANEL.screenW / 2 + w / 2;
    // The fingertip on the tiny screen: bright on contact, faint while hovering, hidden when away.
    const near = !!live?.found && !!live.near;
    this.dot.visible = this.halo.visible = near;
    if (live && near) {
      const x = (live.u - 0.5) * (LIVE_PANEL.screenW - 0.008), y = (0.5 - live.v) * (LIVE_PANEL.screenH - 0.008);
      this.dot.position.x = this.halo.position.x = x; this.dot.position.y = this.halo.position.y = this.screen.position.y + y;
      this.dot.scale.setScalar(live.touching ? 0.0035 : 0.0022);
      this.pulse = live.touching ? (this.pulse + dt * 1.6) % 1 : 0;
      this.halo.scale.setScalar(live.touching ? 0.004 + this.pulse * 0.007 : 0.0036);
      (this.halo.material as MeshBasicMaterial).opacity = (live.touching ? 0.45 * (1 - this.pulse) : 0.12) * this.opacity;
      (this.dot.material as MeshBasicMaterial).color.set(live.touching ? ACCENT : '#ffffff');
      (this.dot.material as MeshBasicMaterial).opacity = (live.touching ? 1 : 0.55) * this.opacity;
    }
    (this.status.material as MeshBasicMaterial).color.set(live?.touching ? '#7ee2a8' : '#a1a1a6');
    this.textClock += dt;
    if (this.textClock >= 0.1) {
      this.textClock = 0;
      const line = !live?.found ? this.hint || 'Touch your screen' : this.line() || 'Touch the screen to play';
      setText(this.values, line, !live?.found || !this.latest.size ? IDLE_TEXT : '#cfd6e4');
    }
  }

  /** Debug/test view. */
  snapshot(): Record<string, unknown> | undefined {
    if (!this.shown) return undefined;
    return { found: !!this.live?.found, touching: !!this.live?.touching, u: this.live?.u, v: this.live?.v, pressure: Math.round(this.pressure * 100) / 100,
      values: Object.fromEntries(this.latest), text: this.values.text, position: this.position.toArray().map((n) => Math.round(n * 1000) / 1000) };
  }

  /** Text is disposed with the HUD root. */
  override dispose(): void {
    this.surfaces.dispose();
    for (const m of [this.screen, this.rim, this.track, this.bar, this.dot, this.halo, this.status]) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
  }
}
