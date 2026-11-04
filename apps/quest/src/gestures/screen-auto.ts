/**
 * The screen without a setup step. When a hand program reads the screen and no plane is saved, the plane is guessed
 * from the detected device: SAM 3.1's box gives a good direction, but its depth comes from a size prior and can be
 * off by 10+ cm. The wearer's first touch fixes it: an index fingertip that comes to rest near the guessed plane has
 * been stopped by the glass, so the plane moves along the line of sight until it passes through that fingertip.
 *
 * Until that first touch the program sees no screen (s.screen is null), so a finger moving through the air in front of
 * a wrongly placed plane never splashes. A fingertip that later rests clearly BEHIND the plane (impossible with real
 * glass there) pushes the plane back to it. Pure: no scene, no DOM. World space is XR local-floor (y up).
 */
import { Vector3 } from 'three';
import type { ShellFrame } from '../app/hud-contract';
import { planeBasis } from '../scan/projection';
import type { ScreenPlane } from './screen-plane';

export interface ScreenGuess {
  /** World anchor of the detected screen (or of the selected device when no screen was detected). */
  position: Vector3;
  label: string;
  /** Unit vector from the device toward the capture camera: the frame `contour` is measured in. */
  facing?: Vector3;
  /** The outline in metres, in the plane through `position` facing the camera (x right, y up). */
  contour?: [number, number][];
  sizeM?: [number, number, number];
  /** false: no screen was detected; `position` is only roughly ahead, so the first touch places the plane itself. */
  measured: boolean;
}

const DEG = Math.PI / 180;
export const AUTO_SCREEN = {
  /** A 13-14 in laptop display, metres; its lid leans back like an open laptop; the lid edge sits this far above the display.
   *  With a detected box the display is `fill` of the box width (the lid's bezel), 16:10. */
  laptop: { width: 0.3, height: 0.195, lean: 12 * DEG, bezel: 0.012, fill: 0.93, aspect: 0.65 },
  monitor: { width: 0.6, aspect: 9 / 16, lean: 3 * DEG, bezel: 0.012 },
  /** The fingertip rests (moves at most stillRadius) this long... */
  restMs: 250, stillRadius: 0.015,
  /** ...this far in front of / behind the guessed plane, along its normal... */
  front: 0.2, behind: 0.25,
  /** ...inside the guessed screen grown by this factor about its centre, as seen from the eyes. */
  grow: 1.5,
  /** A hand already resting somewhere when the program starts must first move this far. */
  freshTravel: 0.06,
  /** Nearer to the eyes than this is not a screen. */
  minReach: 0.2,
  /** No detected screen: a fingertip resting this long within arm's reach in front of the wearer places the plane. */
  weak: { restMs: 400, minReach: 0.25, maxReach: 0.85, below: 0.75, above: 0.15, ahead: 0.15 },
  /** The rest must begin within withinMs of the fingertip moving toward the screen at least this fast (m/s). */
  approach: { speed: 0.1, withinMs: 400 },
  /** After the first touch the touched point lies at least this far inside the screen's edges (u, v). */
  margin: 0.05,
  /** A confirmed plane is pushed back when a resting fingertip is this far behind it (the glass is farther). */
  deeper: { min: 0.03, max: 0.2 },
} as const;

const UP = new Vector3(0, 1, 0);
const isMonitor = (label: string) => /\b(monitor|tv|television|display|imac)\b/i.test(label);
const t3 = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];
const v3 = (a: readonly [number, number, number]) => new Vector3(a[0], a[1], a[2]);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface Shape { width: number; height: number; lean: number; bezel: number; boxSized: boolean }
/** The box width is angular size times the guessed depth; with a size-prior depth it is about the prior itself. */
function shapeFor(guess: Pick<ScreenGuess, 'label' | 'sizeM'>): Shape {
  const w = guess.sizeM?.[0] ?? 0;
  if (!isMonitor(guess.label)) {
    const l = AUTO_SCREEN.laptop;
    if (!(w > 0.15 && w < 0.6)) return { width: l.width, height: l.height, lean: l.lean, bezel: l.bezel, boxSized: false };
    const width = clamp(w * l.fill, 0.22, 0.45);
    return { width, height: width * l.aspect, lean: l.lean, bezel: l.bezel, boxSized: true };
  }
  const m = AUTO_SCREEN.monitor, boxSized = w > 0.2 && w < 1.8;
  const width = boxSized ? w * 0.95 : m.width;
  return { width, height: width * m.aspect, lean: m.lean, bezel: m.bezel, boxSized };
}

/** Facing the wearer horizontally, leaning back by `lean`: right along the top edge, down the left edge, normal outward. */
function basis(from: Vector3, head: Vector3, lean: number): { right: Vector3; down: Vector3; normal: Vector3 } {
  const outward = new Vector3(head.x - from.x, 0, head.z - from.z);
  if (outward.lengthSq() < 1e-6) outward.set(0, 0, 1);
  outward.normalize();
  const right = new Vector3().crossVectors(outward.clone().negate(), UP).normalize();
  const down = UP.clone().multiplyScalar(-Math.cos(lean)).addScaledVector(outward, Math.sin(lean));
  const normal = new Vector3().crossVectors(right, down.clone().negate()).normalize();
  return { right, down, normal };
}

function planeFromCentre(centre: Vector3, b: ReturnType<typeof basis>, shape: Shape, extra: Pick<ScreenPlane, 'savedAt'> & Partial<ScreenPlane>): ScreenPlane {
  const origin = centre.clone().addScaledVector(b.right, -shape.width / 2).addScaledVector(b.down, -shape.height / 2);
  return { origin: t3(origin), right: t3(b.right), down: t3(b.down), normal: t3(b.normal), width: shape.width, height: shape.height, auto: true,
    ...(shape.boxSized ? { boxSized: true } : {}), ...extra };
}

export function planeCentre(plane: ScreenPlane, out = new Vector3()): Vector3 {
  return out.set(
    plane.origin[0] + (plane.right[0] * plane.width + plane.down[0] * plane.height) / 2,
    plane.origin[1] + (plane.right[1] * plane.width + plane.down[1] * plane.height) / 2,
    plane.origin[2] + (plane.right[2] * plane.width + plane.down[2] * plane.height) / 2,
  );
}

/**
 * The guessed (unconfirmed) plane of a detected screen. The top of the device's outline is the top of the lid (a box
 * around a laptop covers its lid and, below the hinge, the keyboard), so the display hangs just under it.
 */
export function autoScreenPlane(guess: ScreenGuess, head: Vector3, savedAt = Date.now()): ScreenPlane {
  const shape = shapeFor(guess), laptop = !isMonitor(guess.label);
  const b = basis(guess.position, head, shape.lean);
  let up = UP.clone(), side = new Vector3(), topY: number | undefined, midX = 0;
  const c = guess.contour;
  if (guess.facing && guess.facing.lengthSq() > 1e-6 && c && c.length >= 3) {
    let maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const [x, y] of c) { if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    const pb = planeBasis(guess.facing.clone().normalize());
    up = pb.up; side = pb.right; topY = maxY; midX = (minX + maxX) / 2;
  } else if (guess.sizeM && guess.sizeM[1] > 0) topY = guess.sizeM[1] / 2;
  topY = laptop ? clamp(topY ?? 0.15, 0.07, 0.3) : clamp(topY ?? shape.height / 2 + shape.bezel, shape.height * 0.3, shape.height * 1.3);
  if (!Number.isFinite(midX) || Math.abs(midX) > shape.width) midX = 0;
  const top = guess.position.clone().addScaledVector(up, topY).addScaledVector(side, midX);
  const centre = top.addScaledVector(b.down, shape.bezel + shape.height / 2);
  return planeFromCentre(centre, b, shape, { anchor: t3(guess.position), savedAt, confirmed: false });
}

/** No screen was detected: the first resting fingertip is the middle of the screen. */
export function planeAtTouch(tip: Vector3, head: Vector3, label: string, anchor: Vector3, savedAt = Date.now()): ScreenPlane {
  const shape = { ...shapeFor({ label }), boxSized: false };
  return planeFromCentre(tip.clone(), basis(tip, head, shape.lean), shape, { anchor: t3(anchor), savedAt, confirmed: true });
}

/**
 * The glass stopped the fingertip at `tip`: move the plane along the line of sight through its centre (the direction
 * SAM measured) until it passes through the fingertip, then slide it so the touch is inside the screen. A box-sized
 * plane keeps its angular size, so it grows or shrinks with the depth it moved to.
 */
export function confirmPlane(plane: ScreenPlane, tip: Vector3, head: Vector3, savedAt = Date.now()): ScreenPlane {
  const n = v3(plane.normal), right = v3(plane.right), down = v3(plane.down);
  const centre = planeCentre(plane);
  const sight = centre.clone().sub(head), before = sight.length();
  if (before < 1e-3) sight.copy(n).negate(); else sight.divideScalar(before);
  let along = sight.dot(n);
  // Seen almost edge-on, the line of sight would slide the plane sideways: move straight along the normal instead.
  if (along > -0.3) { sight.copy(n).negate(); along = -1; }
  centre.addScaledVector(sight, tip.clone().sub(centre).dot(n) / along);
  const k = plane.boxSized && before > 1e-3 ? clamp(centre.distanceTo(head) / before, 0.6, 1.6) : 1;
  const width = plane.width * k, height = plane.height * k;
  const origin = centre.addScaledVector(right, -width / 2).addScaledVector(down, -height / 2);
  const rel = tip.clone().sub(origin), m = AUTO_SCREEN.margin;
  const u = rel.dot(right) / width, v = rel.dot(down) / height;
  origin.addScaledVector(right, (u - clamp(u, m, 1 - m)) * width).addScaledVector(down, (v - clamp(v, m, 1 - m)) * height);
  return { ...plane, origin: t3(origin), width, height, savedAt, auto: true, confirmed: true };
}

interface Sample { t: number; x: number; y: number; z: number }
interface Rest {
  baseline: Vector3; seen: boolean; fresh: boolean;
  /** recent fingertip positions while in the zone (the stillness window) */
  samples: Sample[];
  /** approach toward the screen: smoothed m/s, its previous measure, and when it was last fast enough */
  speed: number; last: number; lastT: number; approachAt: number;
}
const rest = (): Rest => ({ baseline: new Vector3(), seen: false, fresh: false, samples: [], speed: 0, last: NaN, lastT: -Infinity, approachAt: -Infinity });

/**
 * Finds the resting fingertip that fixes an auto plane. `first`: the plane is a guess (or null: no screen detected);
 * a fingertip that moved toward the screen and then stopped dead for restMs (every sample of the window within
 * stillRadius) was stopped by the glass. A finger drifting or waving parallel to the screen never counts, even at the
 * turn of a wave. `deeper`: the plane is confirmed and only a fingertip resting behind it counts.
 */
export class ScreenTouchFinder {
  /** 0..1 of the current rest */
  progress = 0;
  /** a fingertip is in the touch zone right now (the wrist menu stays shut) */
  near = false;
  readonly tip = new Vector3();
  private readonly hands = { left: rest(), right: rest() };
  private lastTime = -Infinity;
  private readonly rel = new Vector3();
  private readonly dir = new Vector3();
  private readonly fwd = new Vector3();

  reset(): void {
    this.progress = 0; this.near = false; this.lastTime = -Infinity;
    this.hands.left = rest(); this.hands.right = rest();
  }

  update(frame: ShellFrame, timeMs: number, plane: ScreenPlane | null, mode: 'first' | 'deeper' = 'first'): Vector3 | null {
    if (timeMs < this.lastTime || timeMs - this.lastTime > 250) for (const r of [this.hands.left, this.hands.right]) { r.samples.length = 0; r.lastT = -Infinity; }
    this.lastTime = timeMs;
    this.near = false; this.progress = 0;
    const need = plane ? AUTO_SCREEN.restMs : AUTO_SCREEN.weak.restMs, head = frame.head.position;
    for (const side of ['right', 'left'] as const) {
      const hand = frame.hands[side], r = this.hands[side];
      const p = hand && !hand.controller ? hand.joints['index-finger-tip']?.position : undefined;
      if (!p || !Number.isFinite(p.x + p.y + p.z)) { r.seen = false; r.samples.length = 0; r.lastT = -Infinity; continue; }
      // A hand that was already still somewhere when the program started is not a touch: it has to move first.
      if (!r.fresh && mode === 'first') {
        if (!r.seen) { r.baseline.copy(p); r.seen = true; }
        else if (p.distanceTo(r.baseline) > AUTO_SCREEN.freshTravel) r.fresh = true;
      }
      // How fast the fingertip goes toward the screen (along the plane's normal; with no plane, away from the eyes).
      const m = plane ? (p.x - plane.origin[0]) * plane.normal[0] + (p.y - plane.origin[1]) * plane.normal[1] + (p.z - plane.origin[2]) * plane.normal[2] : -p.distanceTo(head);
      const dt = (timeMs - r.lastT) / 1000;
      if (dt > 0 && dt < 0.25 && Number.isFinite(r.last)) r.speed += ((r.last - m) / dt - r.speed) * (1 - Math.exp(-dt / 0.06));
      else r.speed = 0;
      r.last = m; r.lastT = timeMs;
      if (r.speed >= AUTO_SCREEN.approach.speed) r.approachAt = timeMs;
      if (!this.inZone(p, frame, plane, mode)) { r.samples.length = 0; continue; }
      this.near = true;
      if (mode === 'first' && !r.fresh) continue;
      r.samples.push({ t: timeMs, x: p.x, y: p.y, z: p.z });
      while (r.samples.length && r.samples[0]!.t < timeMs - need - 200) r.samples.shift();
      // The longest recent stretch with every sample within stillRadius of where the fingertip is now.
      let since = timeMs;
      for (let i = r.samples.length - 1; i >= 0; i--) {
        const q = r.samples[i]!;
        if (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) > AUTO_SCREEN.stillRadius) break;
        since = q.t;
      }
      const progress = Math.min(1, (timeMs - since) / need);
      if (progress >= this.progress) { this.progress = progress; this.tip.copy(p); }
      // It stopped right after moving toward the screen (the glass stopped it), not mid-air after drifting sideways.
      if (progress >= 1 && (mode === 'deeper' || since - r.approachAt <= AUTO_SCREEN.approach.withinMs)) {
        r.samples.length = 0;
        return p.clone();
      }
    }
    return null;
  }

  private inZone(p: Vector3, frame: ShellFrame, plane: ScreenPlane | null, mode: 'first' | 'deeper'): boolean {
    const head = frame.head.position, reach = p.distanceTo(head);
    if (!plane) {
      const w = AUTO_SCREEN.weak, dy = p.y - head.y;
      if (reach < w.minReach || reach > w.maxReach || dy < -w.below || dy > w.above) return false;
      this.fwd.set(0, 0, -1).applyQuaternion(frame.head.quaternion).setY(0);
      if (this.fwd.lengthSq() < 1e-6) return false;
      this.fwd.normalize();
      return (p.x - head.x) * this.fwd.x + (p.z - head.z) * this.fwd.z > w.ahead;
    }
    if (reach < AUTO_SCREEN.minReach) return false;
    const n = plane.normal, o = plane.origin;
    const s = (p.x - o[0]) * n[0] + (p.y - o[1]) * n[1] + (p.z - o[2]) * n[2];
    if (mode === 'deeper' ? s > -AUTO_SCREEN.deeper.min || s < -AUTO_SCREEN.deeper.max : s > AUTO_SCREEN.front || s < -AUTO_SCREEN.behind) return false;
    // Where the fingertip appears on the plane, seen from the eyes (a wrong depth shifts it along the line of sight).
    this.dir.subVectors(p, head);
    const denom = this.dir.x * n[0] + this.dir.y * n[1] + this.dir.z * n[2];
    if (denom > -0.15 * this.dir.length()) return false;
    const t = ((o[0] - head.x) * n[0] + (o[1] - head.y) * n[1] + (o[2] - head.z) * n[2]) / denom;
    if (!(t > 0)) return false;
    this.rel.copy(head).addScaledVector(this.dir, t).sub(v3(o));
    const u = (this.rel.x * plane.right[0] + this.rel.y * plane.right[1] + this.rel.z * plane.right[2]) / plane.width;
    const v = (this.rel.x * plane.down[0] + this.rel.y * plane.down[1] + this.rel.z * plane.down[2]) / plane.height;
    const g = ((mode === 'deeper' ? 1.2 : AUTO_SCREEN.grow) - 1) / 2;
    return u >= -g && u <= 1 + g && v >= -g && v <= 1 + g;
  }
}
