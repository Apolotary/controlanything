/**
 * Muse, the desk buddy: a procedural coral gumdrop robot with a glossy visor face (face.ts), floating hands, a
 * springy antenna and a hover glow. ~1.6k triangles, 8 draw calls (+1 confetti, +1 emote glyph), no textures
 * except a 64 px glow sprite, and no per-frame allocations.
 *
 * It idles (bob, blinks, saccades), looks at things (eyes first, then the body), plays one emotion at a time
 * (eased face params + antenna colour) and one body action at a time (hop, spin, dance, clap…).
 */
import {
  AdditiveBlending, CanvasTexture, Color, CylinderGeometry, DoubleSide, Group, InstancedMesh, LatheGeometry, MathUtils, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, Quaternion, SphereGeometry, Vector2, Vector3,
} from 'three';
import { makeText, setText, type SdfText } from '../hud/v2/text';
import { FaceMaterial, NEUTRAL_FACE, type FaceParams } from './face';

export type BuddyEmotion = 'delighted' | 'love' | 'curious' | 'impressed' | 'amused' | 'surprised' | 'sleepy' | 'confused' | 'unimpressed' | 'hungry';
export type Mood = BuddyEmotion | 'neutral' | 'thinking' | 'noticing';
export type BuddyAction = 'hop' | 'spin' | 'wiggle' | 'nod' | 'tilt' | 'dance' | 'clap' | 'sniff' | 'shiver' | 'float' | 'giggle' | 'wave';

export const BODY = { radius: 0.056, half: 0.052, n: 2.6 } as const;
const FACE = { width: 0.084, height: 0.06, y: 0.006 } as const;

const PRESETS: Record<Mood, Partial<FaceParams>> = {
  neutral: {},
  thinking: { open: 0.82, smile: -0.05, scaleL: 0.95, scaleR: 1.05, blush: 0.05 },
  noticing: { open: 1.2, scaleL: 1.08, scaleR: 1.08, smile: 0.15, mouth: 0.25 },
  delighted: { happy: 1, smile: 1, mouth: 0.35, blush: 0.75 },
  love: { heart: 1, smile: 0.8, blush: 1, scaleL: 1.1, scaleR: 1.1 },
  curious: { open: 1.12, scaleL: 1.15, scaleR: 0.88, smile: 0.12, mouth: 0.18, tilt: 0.12 },
  impressed: { open: 1.3, scaleL: 1.12, scaleR: 1.12, mouth: 0.6, smile: 0.2, blush: 0.35 },
  amused: { happy: 0.85, smile: 1, mouth: 0.7, blush: 0.5 },
  surprised: { open: 1.38, scaleL: 1.22, scaleR: 1.22, mouth: 1, smile: 0 },
  sleepy: { open: 0.14, smile: 0.05, blush: 0.2 },
  confused: { open: 1, scaleL: 0.82, scaleR: 1.15, smile: -0.35, tilt: -0.3 },
  unimpressed: { open: 0.95, lid: 0.55, smile: -0.12, blush: 0 },
  hungry: { open: 1.15, smile: 0.6, mouth: 0.85, blush: 0.4 },
};

/** antenna bulb colour per mood (small status light; the rest of the look stays neutral) */
const BULB: Record<Mood, string> = {
  neutral: '#FFD27A', thinking: '#FFE08A', noticing: '#FFFFFF', delighted: '#FFD54F', love: '#FF8FB1', curious: '#BDE3FF', impressed: '#FFFFFF',
  amused: '#FFD54F', surprised: '#FFFFFF', sleepy: '#8C7FA8', confused: '#C9B6FF', unimpressed: '#A39E99', hungry: '#FFB067',
};
const EYE: Partial<Record<Mood, string>> = { love: '#FFC2D4', sleepy: '#CFC6BC', unimpressed: '#E6DED3' };
const EYE_DEFAULT = '#FFF1DE';

const ACTION_S: Record<BuddyAction, number> = {
  hop: 0.75, spin: 1.1, wiggle: 1.0, nod: 0.9, tilt: 1.2, dance: 2.2, clap: 1.3, sniff: 1.2, shiver: 0.9, float: 2.0, giggle: 0.9, wave: 1.4,
};

const CONFETTI = 48;
const CONFETTI_COLORS = ['#FF8A65', '#FFE8D6', '#FFD54F', '#FF8FB1', '#8EE3C8', '#FFFFFF'];

/** radius of the gumdrop at height y (superellipse, a little wider at the bottom) */
export function bodyRadius(y: number): number {
  const t = Math.min(1, Math.abs(y) / BODY.half);
  return BODY.radius * Math.pow(1 - Math.pow(t, BODY.n), 1 / BODY.n) * (1 + 0.07 * (0.5 - 0.5 * (y / BODY.half)));
}

function bodyGeometry(): LatheGeometry {
  const pts: Vector2[] = [];
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const th = -Math.PI / 2 + (Math.PI * i) / steps;
    const s = Math.sin(th);
    const y = BODY.half * Math.sign(s) * Math.pow(Math.abs(s), 2 / BODY.n);
    pts.push(new Vector2(Math.max(i === 0 || i === steps ? 0 : 1e-4, bodyRadius(y)), y));
  }
  return new LatheGeometry(pts, 48);
}

function faceGeometry(): PlaneGeometry {
  const g = new PlaneGeometry(FACE.width, FACE.height, 24, 16);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) + FACE.y;
    const r = bodyRadius(y);
    pos.setXYZ(i, x, y, Math.sqrt(Math.max(r * r - x * x, 0)) + 0.0014);
  }
  g.computeBoundingSphere();
  return g;
}

function glowTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

/** coral vinyl-toy material with a soft cream rim (fresnel) so it reads against any passthrough room */
function toyMaterial(color: string, rim: string, rimStrength = 0.45): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, roughness: 0.42, metalness: 0, emissive: new Color(color).multiplyScalar(0.12) });
  const rimColor = new Color(rim);
  m.customProgramCacheKey = () => `buddy-toy-${rimStrength}`;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: rimColor };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace('#include <opaque_fragment>', `
        float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.6);
        outgoingLight += uRim * fres * ${rimStrength.toFixed(2)};
        #include <opaque_fragment>`);
  };
  return m;
}

const damp = (cur: number, target: number, k: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const ease = (t: number) => t * t * (3 - 2 * t);

export class Mascot extends Group {
  /** the floating part: bob + action offsets; everything visible hangs off it */
  readonly rig = new Group();
  readonly body: Mesh;
  readonly face: Mesh;
  private readonly faceMat: FaceMaterial;
  private readonly hands: Mesh[];
  private readonly antenna = new Group();
  private readonly bulb: Mesh;
  private readonly bulbMat: MeshStandardMaterial;
  private readonly glow: Mesh;
  private readonly confetti: InstancedMesh;
  private readonly emote: SdfText;

  private readonly cur: FaceParams = { ...NEUTRAL_FACE };
  private readonly target: FaceParams = { ...NEUTRAL_FACE };
  private mood: Mood = 'neutral';
  private moodUntil = Infinity;
  private readonly eyeCol = new Color(EYE_DEFAULT);
  private readonly eyeTarget = new Color(EYE_DEFAULT);
  private readonly bulbCol = new Color(BULB.neutral);
  private readonly bulbTarget = new Color(BULB.neutral);

  private time = 0;
  private nextBlink = 2;
  private blinkT = -1;
  private nextSaccade = 1.5;
  private readonly saccade = new Vector2();
  private readonly look = new Vector2();
  private yaw = 0;
  private pitch = 0;
  private action: BuddyAction | null = null;
  private actionT = 0;
  private antennaAngle = 0;
  private antennaVel = 0;
  private readonly lastWorld = new Vector3();
  private lastVelX = 0;
  private emoteT = -1;
  private think = 0;

  // confetti state (preallocated)
  private readonly cPos = new Float32Array(CONFETTI * 3);
  private readonly cVel = new Float32Array(CONFETTI * 3);
  private readonly cRot = new Float32Array(CONFETTI * 2);
  private readonly cLife = new Float32Array(CONFETTI);
  private confettiOn = false;

  // temps
  private readonly tmpV = new Vector3();
  private readonly tmpV2 = new Vector3();
  private readonly tmpO = new Object3D();
  private readonly invQ = new Quaternion();

  constructor() {
    super();
    this.name = 'buddy-mascot';
    this.add(this.rig);
    const coral = toyMaterial('#FF8A65', '#FFE8D6', 0.5);
    const cream = toyMaterial('#FFE8D6', '#FFFFFF', 0.25);

    this.body = new Mesh(bodyGeometry(), coral);
    this.body.name = 'buddy-body';
    this.rig.add(this.body);

    this.faceMat = new FaceMaterial(FACE.width, FACE.height);
    this.face = new Mesh(faceGeometry(), this.faceMat);
    this.face.name = 'buddy-face';
    this.face.renderOrder = 1;
    this.body.add(this.face);

    const handGeo = new SphereGeometry(0.0135, 20, 14);
    this.hands = [new Mesh(handGeo, cream), new Mesh(handGeo, cream)];
    for (const h of this.hands) this.rig.add(h);

    const stalk = new Mesh(new CylinderGeometry(0.0018, 0.0026, 0.026, 10), cream);
    stalk.position.y = 0.013;
    this.bulbMat = new MeshStandardMaterial({ color: '#FFE9B0', emissive: new Color(BULB.neutral), emissiveIntensity: 0.9, roughness: 0.3 });
    this.bulb = new Mesh(new SphereGeometry(0.0078, 16, 12), this.bulbMat);
    this.bulb.position.y = 0.029;
    this.antenna.add(stalk, this.bulb);
    this.antenna.position.set(0, BODY.half - 0.004, -0.004);
    this.body.add(this.antenna);

    const glowTex = glowTexture();
    this.glow = new Mesh(
      new PlaneGeometry(0.11, 0.11),
      new MeshBasicMaterial({ color: '#FFD9B8', map: glowTex, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = -BODY.half - 0.022;
    this.add(this.glow);

    this.confetti = new InstancedMesh(new PlaneGeometry(0.007, 0.011), new MeshBasicMaterial({ side: DoubleSide, toneMapped: false }), CONFETTI);
    this.confetti.frustumCulled = false;
    this.confetti.visible = false;
    const c = new Color();
    for (let i = 0; i < CONFETTI; i++) this.confetti.setColorAt(i, c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]));
    this.add(this.confetti);

    this.emote = makeText({ text: '', size: 0.03, color: '#FFFFFF', weight: 600, anchorX: 'center', anchorY: 'middle', outline: true });
    this.emote.position.set(0.078, BODY.half + 0.012, 0.01);
    this.emote.renderOrder = 36;
    this.emote.visible = false;
    this.rig.add(this.emote);

    this.body.traverse((o) => ((o as unknown as { pointerEvents?: string }).pointerEvents = 'none'));
    (this.body as unknown as { pointerEvents: string }).pointerEvents = 'auto';
  }

  get currentMood(): Mood { return this.mood; }
  get busyAction(): boolean { return this.action !== null; }

  /** Show an emotion for `holdS` seconds (Infinity = until changed), then drift back to neutral. */
  setMood(mood: Mood, holdS = 4): void {
    this.mood = mood;
    this.moodUntil = this.time + holdS;
    const p = PRESETS[mood];
    Object.assign(this.target, NEUTRAL_FACE, p);
    this.eyeTarget.set(EYE[mood] ?? EYE_DEFAULT);
    this.bulbTarget.set(BULB[mood]);
    if (mood === 'sleepy') this.showEmote('z z');
    else if (mood === 'confused') this.showEmote('?');
    else if (mood === 'surprised' || mood === 'impressed') this.showEmote('!');
    else if (mood === 'noticing') this.showEmote('!');
  }

  play(action: BuddyAction): void {
    this.action = action;
    this.actionT = 0;
  }

  celebrate(big = true): void {
    const n = big ? CONFETTI : 18;
    for (let i = 0; i < CONFETTI; i++) {
      const o = i * 3;
      if (i >= n) { this.cLife[i] = 0; continue; }
      const a = Math.random() * Math.PI * 2;
      const up = 0.55 + Math.random() * 0.5;
      const out = 0.12 + Math.random() * 0.22;
      this.cPos[o] = 0; this.cPos[o + 1] = BODY.half * 0.6; this.cPos[o + 2] = 0;
      this.cVel[o] = Math.cos(a) * out; this.cVel[o + 1] = up; this.cVel[o + 2] = Math.sin(a) * out;
      this.cRot[i * 2] = Math.random() * 6; this.cRot[i * 2 + 1] = (Math.random() - 0.5) * 9;
      this.cLife[i] = 1.6 + Math.random() * 0.8;
    }
    this.confettiOn = true;
    this.confetti.visible = true;
  }

  showEmote(text: string): void {
    setText(this.emote, text);
    this.emote.visible = true;
    this.emoteT = 0;
  }

  /**
   * Per frame. `lookWorld` is what to look at (the user's hand / object / head), in world space.
   * Only writes to preallocated objects.
   */
  update(dt: number, lookWorld: Vector3 | null): void {
    dt = Math.min(0.05, Math.max(0, dt));
    this.time += dt;
    const t = this.time;
    if (this.time > this.moodUntil && this.mood !== 'neutral') this.setMood('neutral', Infinity);

    // --- face params (eased) ---
    const k = 10;
    const c = this.cur, g = this.target;
    c.open = damp(c.open, g.open, k, dt);
    c.happy = damp(c.happy, g.happy, k, dt);
    c.heart = damp(c.heart, g.heart, k, dt);
    c.scaleL = damp(c.scaleL, g.scaleL, k, dt);
    c.scaleR = damp(c.scaleR, g.scaleR, k, dt);
    c.lid = damp(c.lid, g.lid, k, dt);
    c.smile = damp(c.smile, g.smile, k, dt);
    c.mouth = damp(c.mouth, g.mouth, k, dt);
    c.blush = damp(c.blush, g.blush, 6, dt);
    c.tilt = damp(c.tilt, g.tilt, k, dt);
    this.eyeCol.lerp(this.eyeTarget, 1 - Math.exp(-8 * dt));
    this.bulbCol.lerp(this.bulbTarget, 1 - Math.exp(-6 * dt));

    // --- blinks (not while happy/heart/sleepy: those eyes are already shapes) ---
    if (this.blinkT < 0 && t > this.nextBlink) this.blinkT = 0;
    let blink = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT / 0.14;
      blink = b < 0.5 ? 1 - b * 2 * 0.92 : 0.08 + (b - 0.5) * 2 * 0.92;
      if (b >= 1) {
        this.blinkT = -1;
        blink = 1;
        // sometimes a double blink
        this.nextBlink = t + (Math.random() < 0.18 ? 0.22 : 2.2 + Math.random() * 3.4);
      }
    }

    // --- gaze: eyes lead, body follows ---
    let targetYaw = 0, targetPitch = 0, gx = 0, gy = 0;
    if (lookWorld) {
      this.updateWorldMatrix(true, false);
      this.getWorldQuaternion(this.invQ).invert();
      this.getWorldPosition(this.tmpV2);
      const local = this.tmpV.copy(lookWorld).sub(this.tmpV2).applyQuaternion(this.invQ);
      const yaw = Math.atan2(local.x, local.z);
      const pitch = Math.atan2(local.y, Math.hypot(local.x, local.z));
      targetYaw = MathUtils.clamp(yaw * 0.7, -0.9, 0.9);
      targetPitch = MathUtils.clamp(-pitch * 0.5, -0.35, 0.35);
      gx = MathUtils.clamp((yaw - targetYaw) * 2.2 + yaw * 0.6, -1, 1);
      gy = MathUtils.clamp(pitch * 1.6, -1, 1);
    }
    if (t > this.nextSaccade) {
      this.saccade.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.3);
      this.nextSaccade = t + 0.8 + Math.random() * 2.2;
    }
    if (this.mood === 'thinking') {
      gx = 0.65 + Math.sin(t * 1.3) * 0.25; gy = 0.55;
    }
    this.look.x = damp(this.look.x, gx + this.saccade.x * 0.35, 18, dt);
    this.look.y = damp(this.look.y, gy + this.saccade.y * 0.35, 18, dt);
    this.yaw = damp(this.yaw, targetYaw, 4, dt);
    this.pitch = damp(this.pitch, targetPitch, 4, dt);

    // --- idle float + action ---
    const sleepy = this.mood === 'sleepy';
    const bobHz = sleepy ? 0.35 : 0.55;
    let px = 0, py = Math.sin(t * Math.PI * 2 * bobHz) * (sleepy ? 0.003 : 0.0055), pz = 0;
    let ry = 0, rx = 0, rz = Math.sin(t * Math.PI * 2 * bobHz * 0.5) * 0.04;
    let sq = Math.sin(t * Math.PI * 2 * bobHz + 1.2) * 0.012;
    let lhx = 0, lhy = 0, lhz = 0, rhx = 0, rhy = 0, rhz = 0;
    if (this.action) {
      this.actionT += dt;
      const dur = ACTION_S[this.action];
      const u = Math.min(1, this.actionT / dur);
      const fade = 1 - ease(Math.max(0, (u - 0.8) / 0.2));
      switch (this.action) {
        case 'hop': {
          const h = Math.sin(Math.PI * u);
          py += h * 0.05;
          sq += (u < 0.12 ? -0.12 * Math.sin((u / 0.12) * Math.PI) : 0) + (u > 0.85 ? -0.1 * Math.sin(((u - 0.85) / 0.15) * Math.PI) : 0) + h * 0.05;
          lhy = rhy = h * 0.02;
          break;
        }
        case 'spin':
          ry += ease(u) * Math.PI * 2;
          py += Math.sin(Math.PI * u) * 0.02;
          lhx = -Math.sin(Math.PI * u) * 0.01; rhx = -lhx;
          break;
        case 'wiggle':
          rz += Math.sin(u * Math.PI * 2 * 3) * 0.22 * fade;
          break;
        case 'nod':
          rx += Math.sin(u * Math.PI * 2 * 2) * 0.22 * fade;
          break;
        case 'tilt':
          rz += Math.sin(Math.PI * u) * 0.32;
          break;
        case 'dance': {
          const beat = u * 4;
          py += Math.abs(Math.sin(beat * Math.PI)) * 0.03;
          ry += Math.sin(beat * Math.PI) * 0.45 * fade;
          rz += Math.sin(beat * Math.PI) * 0.12 * fade;
          lhy = Math.max(0, Math.sin(beat * Math.PI)) * 0.04 * fade;
          rhy = Math.max(0, -Math.sin(beat * Math.PI)) * 0.04 * fade;
          break;
        }
        case 'clap': {
          const s = Math.abs(Math.sin(u * Math.PI * 3)) * fade;
          lhx = 0.045 * s; rhx = -0.045 * s; lhz = rhz = 0.045 * s; lhy = rhy = 0.012 * s;
          py += 0.008 * s;
          break;
        }
        case 'sniff':
          rx += 0.25 * Math.sin(Math.PI * u);
          pz += 0.025 * Math.sin(Math.PI * u);
          sq += Math.max(0, Math.sin(u * Math.PI * 2 * 5)) * 0.03 * fade;
          break;
        case 'shiver':
          px += Math.sin(u * Math.PI * 2 * 9) * 0.0035 * fade;
          sq -= 0.04 * fade;
          break;
        case 'float':
          py += Math.sin(Math.PI * u) * 0.045;
          lhx = -0.02 * Math.sin(Math.PI * u); rhx = -lhx; lhy = rhy = 0.03 * Math.sin(Math.PI * u);
          break;
        case 'giggle':
          rz += Math.sin(u * Math.PI * 2 * 3) * 0.12 * fade;
          sq += Math.abs(Math.sin(u * Math.PI * 2 * 3)) * 0.05 * fade;
          break;
        case 'wave': {
          const s = Math.sin(Math.PI * Math.min(1, u * 1.2));
          rhy = 0.05 * s; rhx = 0.01 * s; rhz = 0.01;
          rhx += Math.sin(u * Math.PI * 2 * 3) * 0.012 * s;
          rz += -0.08 * s;
          break;
        }
      }
      if (u >= 1) this.action = null;
    }

    // thinking: a slow head-tilt sway and a little bob, so a 7 s wait still looks alive (0.35 Hz, never a flash)
    this.think = damp(this.think, this.mood === 'thinking' ? 1 : 0, 4, dt);
    if (this.think > 0.01) {
      rz += Math.sin(t * Math.PI * 2 * 0.35) * 0.16 * this.think;
      py += Math.abs(Math.sin(t * Math.PI * 2 * 0.35)) * 0.008 * this.think;
      lhy += Math.sin(t * Math.PI * 2 * 0.35) * 0.006 * this.think;
      rhy += 0.018 * this.think; rhx -= 0.012 * this.think; rhz += 0.02 * this.think; // a hand to the chin
    }

    this.rig.position.set(px, py, pz);
    this.rig.rotation.set(rx + this.pitch, ry + this.yaw, rz, 'YXZ');
    const s = MathUtils.clamp(sq, -0.2, 0.2);
    this.body.scale.set(1 + s * 0.6, 1 - s, 1 + s * 0.6);

    // hands float beside the body, slightly out of phase
    const hb = Math.sin(t * Math.PI * 2 * bobHz - 0.9) * 0.004;
    this.hands[0].position.set(-0.071 + lhx, -0.012 + hb + lhy, 0.012 + lhz);
    this.hands[1].position.set(0.071 + rhx, -0.012 - hb + rhy, 0.012 + rhz);

    // antenna: a damped spring driven by sideways motion (secondary motion)
    this.rig.getWorldPosition(this.tmpV);
    const vx = dt > 0 ? (this.tmpV.x - this.lastWorld.x + this.tmpV.z - this.lastWorld.z) / dt : 0;
    const ax = dt > 0 ? (vx - this.lastVelX) / dt : 0;
    this.lastWorld.copy(this.tmpV);
    this.lastVelX = vx;
    const acc = -120 * this.antennaAngle - 7 * this.antennaVel - MathUtils.clamp(ax, -40, 40) * 0.25;
    this.antennaVel += acc * dt;
    this.antennaAngle = MathUtils.clamp(this.antennaAngle + this.antennaVel * dt, -0.6, 0.6);
    this.antenna.rotation.z = this.antennaAngle + Math.sin(t * 2.1) * 0.05;

    // bulb: thinking pulses slowly (≤ 1 Hz, photosensitivity rule)
    const pulse = this.mood === 'thinking' ? 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 0.9) : 1;
    this.bulbMat.emissive.copy(this.bulbCol);
    this.bulbMat.emissiveIntensity = 0.5 + 0.6 * pulse;

    // hover glow breathes with the bob
    const gm = this.glow.material as MeshBasicMaterial;
    gm.opacity = 0.38 + 0.12 * Math.sin(t * Math.PI * 2 * bobHz + Math.PI);

    // face
    const f = this.cur;
    const savedOpen = f.open;
    f.open = savedOpen * blink;
    this.faceMat.apply(f, this.look.x, this.look.y, this.eyeCol);
    f.open = savedOpen;

    // emote glyph floats up and fades
    if (this.emoteT >= 0) {
      this.emoteT += dt;
      const e = this.emoteT / 1.8;
      this.emote.position.y = BODY.half + 0.012 + e * 0.025;
      (this.emote as unknown as { fillOpacity: number; outlineOpacity: number }).fillOpacity = 1 - ease(Math.max(0, (e - 0.6) / 0.4));
      (this.emote as unknown as { outlineOpacity: number }).outlineOpacity = (this.emote as unknown as { fillOpacity: number }).fillOpacity * 0.6;
      if (e >= 1) { this.emote.visible = false; this.emoteT = -1; }
    }

    if (this.confettiOn) this.updateConfetti(dt);
  }

  private updateConfetti(dt: number): void {
    let alive = 0;
    const o3 = this.tmpO;
    for (let i = 0; i < CONFETTI; i++) {
      const o = i * 3;
      if (this.cLife[i] <= 0) {
        o3.position.set(0, 0, 0);
        o3.scale.setScalar(0);
        o3.updateMatrix();
        this.confetti.setMatrixAt(i, o3.matrix);
        continue;
      }
      alive++;
      this.cLife[i] -= dt;
      this.cVel[o + 1] -= 1.1 * dt;
      const drag = Math.exp(-1.8 * dt);
      this.cVel[o] *= drag; this.cVel[o + 1] *= drag; this.cVel[o + 2] *= drag;
      this.cPos[o] += this.cVel[o] * dt; this.cPos[o + 1] += this.cVel[o + 1] * dt; this.cPos[o + 2] += this.cVel[o + 2] * dt;
      this.cRot[i * 2] += this.cRot[i * 2 + 1] * dt;
      o3.position.set(this.cPos[o], this.cPos[o + 1], this.cPos[o + 2]);
      o3.rotation.set(this.cRot[i * 2], this.cRot[i * 2] * 0.7, this.cRot[i * 2] * 0.3);
      o3.scale.setScalar(Math.min(1, this.cLife[i] * 2));
      o3.updateMatrix();
      this.confetti.setMatrixAt(i, o3.matrix);
    }
    this.confetti.instanceMatrix.needsUpdate = true;
    if (!alive) {
      this.confettiOn = false;
      this.confetti.visible = false;
    }
  }

  override dispose(): void {
    this.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as { dispose?: () => void } | undefined;
      mat?.dispose?.();
    });
    this.emote.dispose();
  }
}
