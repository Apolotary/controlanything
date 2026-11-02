import { BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import type { Handedness, ShellFrame } from './hud-contract';
import type { HandDiagnostics } from './input';
import { WorldPanel } from '../hud/v2/world-panel';

const HANDS = ['left', 'right'] as const;
const FORWARD = new Vector3(0, 0, 1);

interface HoverTarget {
  position: Vector3;
  facing: Vector3;
  sizeM: [number, number, number];
}

/** Shared fingertip and target feedback, plus one optional diagnostic plate. */
export class HandFeedback {
  readonly root = new Group();
  private readonly geometry = new SphereGeometry(0.006, 8, 6);
  private readonly idle = new MeshBasicMaterial({ color: 0x91b4a7, depthTest: true, depthWrite: false, toneMapped: false });
  private readonly pressed = new MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: false, toneMapped: false });
  private readonly dots: Record<Handedness, Mesh<SphereGeometry, MeshBasicMaterial>>;
  private readonly hoverGeometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  private readonly hoverMaterial = new LineBasicMaterial({ color: 0xe1eee8, depthTest: true, depthWrite: false, toneMapped: false });
  private readonly hovers: Record<Handedness, LineLoop<BufferGeometry, LineBasicMaterial>>;
  private readonly facing = new Vector3();
  private showHover = true;
  private plate?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly plateAnchor = new WorldPanel({ height: -0.4 });
  private canvas?: HTMLCanvasElement;
  private context?: CanvasRenderingContext2D;
  private texture?: CanvasTexture;
  private lastDrawn = -Infinity;
  private previousTime: number | null = null;
  private elapsed = 0;
  private frames = 0;
  private fps: number | null = null;

  constructor(debug: boolean) {
    this.root.name = 'hand-feedback';
    const makeDot = (hand: Handedness) => {
      const dot = new Mesh(this.geometry, this.idle);
      dot.name = `fingertip-${hand}`;
      dot.visible = false;
      dot.renderOrder = 100;
      dot.raycast = () => {};
      this.root.add(dot);
      return dot;
    };
    this.dots = { left: makeDot('left'), right: makeDot('right') };
    const makeHover = (hand: Handedness) => {
      const hover = new LineLoop(this.hoverGeometry, this.hoverMaterial);
      hover.name = `hand-hover-${hand}`;
      hover.visible = false;
      hover.renderOrder = 99;
      hover.raycast = () => {};
      this.root.add(hover);
      return hover;
    };
    this.hovers = { left: makeHover('left'), right: makeHover('right') };
    if (!debug) return;
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return;
    this.canvas = canvas;
    this.context = context;
    this.texture = new CanvasTexture(canvas);
    this.plate = new Mesh(new PlaneGeometry(0.54, 0.18), new MeshBasicMaterial({
      map: this.texture, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.plate.name = 'hand-debug';
    this.plate.renderOrder = 101;
    this.plate.raycast = () => {};
    this.root.add(this.plate);
  }

  setAppearance(appearance: { accent: string; showHover: boolean }): void {
    this.idle.color.set(appearance.accent);
    this.pressed.color.set(appearance.accent);
    this.showHover = appearance.showHover;
    if (!this.showHover) for (const hover of Object.values(this.hovers)) hover.visible = false;
  }

  setHover(hand: Handedness, target?: HoverTarget): void {
    const hover = this.hovers[hand];
    hover.visible = this.showHover && Boolean(target);
    if (!target) return;
    this.facing.copy(target.facing).normalize();
    if (this.facing.lengthSq() === 0) this.facing.copy(FORWARD);
    hover.position.copy(target.position).addScaledVector(this.facing, 0.006);
    hover.quaternion.setFromUnitVectors(FORWARD, this.facing);
    hover.scale.set(Math.max(0.03, target.sizeM[0] + 0.035), Math.max(0.03, target.sizeM[1] + 0.035), 1);
  }

  update(f: ShellFrame, diagnostics: Record<Handedness, HandDiagnostics>, calls: number): void {
    for (const side of HANDS) {
      const hand = f.hands[side];
      const tip = hand?.joints['index-finger-tip'];
      const dot = this.dots[side];
      dot.visible = Boolean(tip);
      if (!tip) continue;
      dot.position.copy(tip.position);
      dot.material = hand?.pinching ? this.pressed : this.idle;
      dot.scale.setScalar(hand?.pinching ? 1.25 : 1);
    }
    if (!this.plate) return;
    this.plateAnchor.update(this.plate, f.head, f.time);
    // f.dt is capped by the input sampler; timestamps measure the actual frame rate.
    if (this.previousTime !== null && f.time > this.previousTime) {
      this.elapsed += f.time - this.previousTime;
      this.frames++;
      if (this.elapsed >= 250) {
        this.fps = this.frames * 1000 / this.elapsed;
        this.elapsed = 0;
        this.frames = 0;
      }
    } else if (this.previousTime !== null && f.time < this.previousTime) {
      this.elapsed = 0;
      this.frames = 0;
      this.fps = null;
      this.lastDrawn = -Infinity;
    }
    this.previousTime = f.time;
    if (f.time - this.lastDrawn < 250) return;
    this.lastDrawn = f.time;
    this.draw(f, diagnostics, calls);
  }

  private draw(f: ShellFrame, diagnostics: Record<Handedness, HandDiagnostics>, calls: number): void {
    const ctx = this.context!;
    ctx.fillStyle = '#17221e';
    ctx.fillRect(0, 0, this.canvas!.width, this.canvas!.height);
    ctx.font = '28px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`Hands   FPS ${this.fps?.toFixed(1) ?? '--'}   calls ${calls}`, 20, 16);
    HANDS.forEach((side, index) => {
      const d = diagnostics[side];
      const y = 66 + index * 90;
      ctx.fillStyle = d.tracked ? '#e1eee8' : '#a8b8b0';
      ctx.fillText(`${side === 'left' ? 'L' : 'R'} ${d.tracked ? 'tracked' : 'untracked'}   joints ${d.jointCount}   distance ${d.pinchDistanceCm?.toFixed(1) ?? '--'} cm`, 20, y);
      ctx.fillText(`   select events ${d.selectEvents}   down ${d.selectDown ? 'yes' : 'no'}   pinch ${f.hands[side]?.pinching ? 'yes' : 'no'}`, 20, y + 36);
    });
    this.texture!.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.idle.dispose();
    this.pressed.dispose();
    this.hoverGeometry.dispose();
    this.hoverMaterial.dispose();
    this.plate?.geometry.dispose();
    this.plate?.material.dispose();
    this.texture?.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}
