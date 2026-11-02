/**
 * Debug readout for the live detector (`?debug=1`): one small plate, low-left in the field of view, showing
 * model · execution provider · fps · inference ms · latency · interval · render frame ms. Redrawn at most 4×/s
 * (text only changes, nothing flashes). Its own canvas texture, independent of the HUD renderer.
 */
import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, type PerspectiveCamera, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';

const W_PX = 1024;
const H_PX = 96;
const W_M = 0.3;

export class LiveReadout extends Mesh<PlaneGeometry, MeshBasicMaterial> {
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: CanvasTexture;
  private text = '';
  private lastDraw = 0;
  private readonly off = new Vector3();

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = W_PX;
    canvas.height = H_PX;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    super(new PlaneGeometry(W_M, (W_M * H_PX) / W_PX), new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.canvas = canvas;
    this.tex = tex;
    this.renderOrder = 1000;
    this.frustumCulled = false;
    this.name = 'live-readout';
    this.raycast = () => {}; // never takes a cursor ray
  }

  /** Follow the head (0.6 m ahead, low-left) and redraw when the text changed (≤ 4 Hz). */
  update(camera: PerspectiveCamera, now: number, lines: string[]): void {
    camera.getWorldPosition(this.position);
    camera.getWorldQuaternion(this.quaternion);
    this.off.set(-0.12, -0.17, -0.6).applyQuaternion(this.quaternion);
    this.position.add(this.off);
    const text = lines.join('\n');
    if (text === this.text || now - this.lastDraw < 250) return;
    this.text = text;
    this.lastDraw = now;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W_PX, H_PX);
    ctx.fillStyle = 'rgba(10,14,18,0.92)';
    ctx.fillRect(0, 0, W_PX, H_PX);
    ctx.strokeStyle = '#38F0FF';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W_PX - 3, H_PX - 3);
    ctx.fillStyle = '#F3F7FA';
    ctx.font = "28px 'Share Tech Mono', Menlo, monospace";
    lines.slice(0, 2).forEach((l, i) => ctx.fillText(l.slice(0, 70), 16, 38 + i * 36));
    this.tex.needsUpdate = true;
  }

  override dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}
