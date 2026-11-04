/**
 * The calibrated plane of a screen, from two touched corners (top-left, then bottom-right), and the maths that turns a
 * fingertip into screen coordinates. Pure: no three.js scene, no DOM. World space is the XR local-floor space (y up).
 *
 * A screen's horizontal edges are horizontal, so the plane is fixed by the two corners plus one number: how far the
 * screen leans back (a laptop lid ~100-120 deg) which decides the plane's azimuth. We pick the azimuth that faces the
 * wearer's head at calibration, limited to the physically possible lean (a monitor ~0 deg, a lid up to ~35 deg back).
 * Both corners lie on the plane by construction.
 */
import { Vector3 } from 'three';

export interface ScreenPlane {
  /** top-left corner, world metres */
  origin: [number, number, number];
  /** unit, along the top edge toward the right */
  right: [number, number, number];
  /** unit, down the left edge */
  down: [number, number, number];
  /** unit, out of the screen toward the wearer */
  normal: [number, number, number];
  width: number;
  height: number;
  /** the selected device's anchor when calibrated: a saved plane is dropped when the anchor moved. */
  anchor?: [number, number, number];
  savedAt: number;
  /** Built from the detected device (gestures/screen-auto.ts), not from touched corners. */
  auto?: boolean;
  /** An auto plane whose depth a fingertip resting on the glass has fixed. Only confirmed planes are saved. */
  confirmed?: boolean;
  /** An auto plane sized from the detected box at its guessed depth: its size follows the depth the touch finds. */
  boxSized?: boolean;
}
export type PlaneResult = { plane: ScreenPlane } | { error: string };

export const SCREEN_LIMITS = {
  minWidth: 0.1, maxWidth: 2.2, minHeight: 0.06, maxHeight: 1.3,
  /** lean back (top edge farther than the bottom) and lean forward, as tan(angle) of height */
  leanBack: Math.tan(35 * Math.PI / 180), leanForward: Math.tan(5 * Math.PI / 180),
  /** a saved plane is trusted only while its anchor is within this of the current one (metres) */
  anchorDrift: 0.6,
} as const;

const UP = new Vector3(0, 1, 0);
const tuple = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];
const vec = (a: readonly [number, number, number]): Vector3 => new Vector3(a[0], a[1], a[2]);

export function planeFromCorners(topLeft: Vector3, bottomRight: Vector3, head: Vector3, anchor: Vector3, savedAt = Date.now()): PlaneResult {
  const d = new Vector3().subVectors(bottomRight, topLeft);
  const drop = -d.y;
  if (!(drop >= SCREEN_LIMITS.minHeight * 0.8)) return { error: 'The bottom-right corner should be lower than the top-left one' };
  const flat = new Vector3(d.x, 0, d.z), flatLen = flat.length();
  if (flatLen < 0.05) return { error: 'The two corners are too close together' };
  // Horizontal direction from the device toward the wearer (the screen's outward side).
  const toward = new Vector3(head.x - anchor.x, 0, head.z - anchor.z);
  if (toward.lengthSq() < 1e-4) toward.set(head.x - topLeft.x, 0, head.z - topLeft.z);
  if (toward.lengthSq() < 1e-4) toward.set(0, 0, 1);
  toward.normalize();
  const sMin = -SCREEN_LIMITS.leanForward * drop, sMax = SCREEN_LIMITS.leanBack * drop;
  const s0 = flat.dot(toward), target = Math.min(sMax, Math.max(sMin, s0));
  let outward = toward;
  if (target !== s0) {
    // Rotate the facing direction (about the vertical axis) just enough to reach the allowed lean.
    const beta = Math.atan2(flat.z, flat.x), gamma0 = Math.atan2(toward.z, toward.x);
    const delta = Math.acos(Math.min(1, Math.max(-1, target / flatLen)));
    const diff = (g: number) => Math.abs(Math.atan2(Math.sin(g - gamma0), Math.cos(g - gamma0)));
    const a = beta + delta, b = beta - delta, gamma = diff(a) <= diff(b) ? a : b;
    outward = new Vector3(Math.cos(gamma), 0, Math.sin(gamma));
  }
  const looking = outward.clone().negate();
  const right = new Vector3().crossVectors(looking, UP).normalize();
  const width = d.dot(right), lean = d.dot(outward);
  const height = Math.hypot(drop, lean);
  if (width < SCREEN_LIMITS.minWidth) return { error: 'The bottom-right corner should be to the right of the top-left one, as you face the screen' };
  if (width > SCREEN_LIMITS.maxWidth || height > SCREEN_LIMITS.maxHeight || height < SCREEN_LIMITS.minHeight) return { error: 'That screen is not a size I can use. Touch its two opposite corners' };
  // up along the screen: (drop·up − lean·outward)/height; down is its negation.
  const down = new Vector3().addScaledVector(UP, -drop).addScaledVector(outward, lean).divideScalar(height);
  const normal = new Vector3().crossVectors(right, down.clone().negate()).normalize();
  return { plane: { origin: tuple(topLeft), right: tuple(right), down: tuple(down), normal: tuple(normal), width, height, anchor: tuple(anchor), savedAt } };
}

export interface PlanePoint { u: number; v: number; distance: number; inside: boolean }
const rel = new Vector3();
/** Project a world point: u, v are 0..1 (clamped) with top-left = 0,0; `distance` is signed metres toward the wearer. */
export function projectOnPlane(plane: ScreenPlane, point: Vector3, out: PlanePoint = { u: 0, v: 0, distance: 0, inside: false }): PlanePoint {
  rel.set(point.x - plane.origin[0], point.y - plane.origin[1], point.z - plane.origin[2]);
  const ru = (rel.x * plane.right[0] + rel.y * plane.right[1] + rel.z * plane.right[2]) / plane.width;
  const rv = (rel.x * plane.down[0] + rel.y * plane.down[1] + rel.z * plane.down[2]) / plane.height;
  out.distance = rel.x * plane.normal[0] + rel.y * plane.normal[1] + rel.z * plane.normal[2];
  out.inside = ru >= 0 && ru <= 1 && rv >= 0 && rv <= 1;
  out.u = Math.min(1, Math.max(0, ru)); out.v = Math.min(1, Math.max(0, rv));
  return out;
}

/** World position of a point on the plane (u, v in 0..1), for markers. */
export function planePoint(plane: ScreenPlane, u: number, v: number, out = new Vector3()): Vector3 {
  return out.set(
    plane.origin[0] + plane.right[0] * plane.width * u + plane.down[0] * plane.height * v,
    plane.origin[1] + plane.right[1] * plane.width * u + plane.down[1] * plane.height * v,
    plane.origin[2] + plane.right[2] * plane.width * u + plane.down[2] * plane.height * v,
  );
}

// --- storage: one plane per device card, in localStorage (may be unavailable or full; everything is optional) ----

const KEY = (cardId: string) => `ce.screen-plane.v1.${cardId}`;
function validTuple(a: unknown): a is [number, number, number] { return Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n)); }
export function isScreenPlane(o: unknown): o is ScreenPlane {
  const p = o as Partial<ScreenPlane> | null;
  return !!p && validTuple(p.origin) && validTuple(p.right) && validTuple(p.down) && validTuple(p.normal)
    && typeof p.width === 'number' && p.width > 0 && typeof p.height === 'number' && p.height > 0 && typeof p.savedAt === 'number';
}
/** `notBefore`: ignore a plane saved earlier (an older page load had another XR reference space). */
export function loadPlane(cardId: string, anchor?: Vector3 | null, storage: Pick<Storage, 'getItem'> | undefined = safeStorage(), notBefore = 0): ScreenPlane | null {
  try {
    const raw = storage?.getItem(KEY(cardId));
    if (!raw) return null;
    const plane = JSON.parse(raw) as unknown;
    if (!isScreenPlane(plane) || plane.auto && !plane.confirmed || plane.savedAt < notBefore) return null;
    if (anchor && plane.anchor && vec(plane.anchor).distanceTo(anchor) > SCREEN_LIMITS.anchorDrift) return null;
    return plane;
  } catch { return null; }
}
export function savePlane(cardId: string, plane: ScreenPlane, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): boolean {
  try { storage?.setItem(KEY(cardId), JSON.stringify(plane)); return !!storage; } catch { return false; }
}
export function clearPlane(cardId: string, storage: Pick<Storage, 'removeItem'> | undefined = safeStorage()): void {
  try { storage?.removeItem(KEY(cardId)); } catch { /* storage unavailable */ }
}
function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
