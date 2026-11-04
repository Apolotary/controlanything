/**
 * The photo the buddy just took, as a tiny polaroid: it pops out of the show-me frame, floats to the buddy while
 * Muse looks at it (so you see exactly what it saw), then either flies onto the collection shelf (an object) or
 * shrugs and fades (nothing seen). One plane, one 160 px canvas texture, drawn only when a photo is set.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';

const PX = 384;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

type Leg = { from: Vector3; to: Vector3; s0: number; s1: number; dur: number; arc: number; t: number; fade: boolean; done?: () => void };

export class Polaroid extends Mesh<PlaneGeometry, MeshBasicMaterial> {
  private readonly canvas?: HTMLCanvasElement;
  private readonly tex?: CanvasTexture;
  private leg: Leg | null = null;
  private wobble = 0;
  private time = 0;
  /** where it is heading (world), for e2e checks */
  readonly target = new Vector3();
  state: 'hidden' | 'held' | 'flying' | 'fading' = 'hidden';

  constructor() {
    super(new PlaneGeometry(1, 1.18), new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.name = 'buddy-polaroid';
    this.renderOrder = 33;
    this.visible = false;
    this.frustumCulled = false;
    if (typeof document === 'undefined') return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PX;
    this.canvas.height = Math.round(PX * 1.18);
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.material.map = this.tex;
  }

  /** Draw the photo (centre-cropped square) on a white polaroid card. */
  setPhoto(photo: CanvasImageSource & { width: number; height: number }): void {
    const c = this.canvas;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#FFFFFF';
    g.beginPath();
    g.roundRect(0, 0, c.width, c.height, 14);
    g.fill();
    const m = 10, side = c.width - m * 2;
    const scale = side / Math.max(photo.width, photo.height);
    const w = photo.width * scale, h = photo.height * scale;
    g.save();
    g.beginPath();
    g.roundRect(m, m, side, side, 8);
    g.clip();
    g.fillStyle = '#1e2730'; g.fillRect(m, m, side, side);
    g.drawImage(photo, m + (side - w) / 2, m + (side - h) / 2, w, h);
    g.restore();
    this.tex!.needsUpdate = true;
  }

  /** Move to `to` over `dur` seconds (an arc of `arc` metres up), scaling to `size` metres wide. */
  go(to: Vector3, size: number, dur: number, opts: { from?: Vector3; fromSize?: number; arc?: number; fade?: boolean; done?: () => void } = {}): void {
    const from = (opts.from ?? this.position).clone();
    this.leg = { from, to: to.clone(), s0: opts.fromSize ?? this.scale.x, s1: size, dur, arc: opts.arc ?? 0, t: 0, fade: Boolean(opts.fade), done: opts.done };
    this.target.copy(to);
    this.position.copy(from);
    this.scale.setScalar(this.leg.s0);
    this.material.opacity = 1;
    this.visible = true;
  }

  /** a little shake ("hm, nothing there") */
  shrug(): void {
    this.wobble = 1;
  }

  hide(): void {
    this.leg = null;
    this.visible = false;
    this.state = 'hidden';
  }

  /** Per frame; `face` is the point to turn toward (the user's head). */
  update(dt: number, face: Vector3): void {
    if (!this.visible) return;
    this.time += dt;
    const l = this.leg;
    if (l) {
      l.t = Math.min(1, l.t + dt / l.dur);
      const u = ease(l.t);
      this.position.lerpVectors(l.from, l.to, u);
      this.position.y += Math.sin(Math.PI * u) * l.arc;
      this.scale.setScalar(l.s0 + (l.s1 - l.s0) * u);
      if (l.fade) this.material.opacity = 1 - u;
      if (l.t >= 1) {
        this.leg = null;
        const done = l.done;
        if (l.fade) this.hide();
        done?.();
      }
    }
    this.lookAt(face);
    // shrug: a short wobble
    if (this.wobble > 0) {
      this.wobble = Math.max(0, this.wobble - dt * 1.6);
      this.rotateZ(Math.sin(this.time * 22) * 0.18 * this.wobble);
    }
  }
}
