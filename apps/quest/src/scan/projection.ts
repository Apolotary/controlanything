/**
 * Quest 3 passthrough camera model and 2D <-> 3D projection (research/04-quest-stack.md §2–3).
 *
 * Conventions: WebXR / three.js right-handed, metres, a camera looks down its local -Z with +Y up;
 * image pixels have their origin top-left with v growing downward. All poses are in "local-floor".
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Intrinsics } from '../io/v1';

/** Sensor frame 1280×1280, two independent on-device calibration dumps (Oct 2026), rounded. */
export const QUEST3_SENSOR = { fx: 868, fy: 868, cx: 644.7, cy: 640.7, width: 1280, height: 1280 } as const;
/** Measured directly on a 1280×960 Camera2 stream (third dump): the centred 160-row crop of the sensor. */
export const QUEST3_1280x960: Intrinsics = { fx: 868.31, fy: 868.31, cx: 640.18, cy: 482.07, width: 1280, height: 960 };

/** Intrinsics for the stream size the browser actually delivers (centred crop of the sensor, then uniform scale). */
export function questIntrinsics(width: number, height: number): Intrinsics {
  if (width === 1280 && height === 960) return { ...QUEST3_1280x960 };
  const s = width / QUEST3_SENSOR.width;
  const cropY = (QUEST3_SENSOR.height - height / s) / 2;
  return {
    fx: QUEST3_SENSOR.fx * s,
    fy: QUEST3_SENSOR.fy * s,
    cx: QUEST3_SENSOR.cx * s,
    cy: (QUEST3_SENSOR.cy - cropY) * s,
    width,
    height,
  };
}

/** The same camera at another image size (e.g. the JPEG was downscaled before sending). */
export function scaleIntrinsics(k: Intrinsics, width: number, height: number): Intrinsics {
  const sx = width / k.width;
  const sy = height / k.height;
  return { fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy, width, height };
}

export function fovYDeg(k: Intrinsics): number {
  return (2 * Math.atan(k.height / 2 / k.fy) * 180) / Math.PI;
}

export function fovXDeg(k: Intrinsics): number {
  return (2 * Math.atan(k.width / 2 / k.fx) * 180) / Math.PI;
}

/**
 * Left/right RGB camera relative to the viewer (head) pose: 3.2 cm to the side, 1.7 cm down, 6.3 cm forward,
 * pitched 11.1° down. Sign of the pitch to be confirmed in spike S3 (a desk edge must land on the desk).
 */
export const CAMERA_PITCH_DEG = -11.1;
export function headFromCamera(eye: 'left' | 'right' | 'mono'): { position: Vector3; quaternion: Quaternion } {
  const x = eye === 'right' ? 0.032 : eye === 'left' ? -0.032 : 0;
  return {
    position: new Vector3(x, -0.017, -0.063),
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (CAMERA_PITCH_DEG * Math.PI) / 180),
  };
}

export interface PoseLike {
  position: Vector3;
  quaternion: Quaternion;
}

/** World pose of the camera = head pose ∘ head→camera offset. */
export function cameraPoseFromHead(head: PoseLike, eye: 'left' | 'right' | 'mono', out?: PoseLike): PoseLike {
  const off = headFromCamera(eye);
  const o = out ?? { position: new Vector3(), quaternion: new Quaternion() };
  o.position.copy(off.position).applyQuaternion(head.quaternion).add(head.position);
  o.quaternion.copy(head.quaternion).multiply(off.quaternion);
  return o;
}

export interface WorldRay {
  origin: Vector3;
  dir: Vector3;
}

/** Ray from the camera centre through pixel (u, v). */
export function pixelToRay(u: number, v: number, k: Intrinsics, cam: PoseLike): WorldRay {
  const d = new Vector3((u - k.cx) / k.fx, -(v - k.cy) / k.fy, -1).normalize().applyQuaternion(cam.quaternion);
  return { origin: cam.position.clone(), dir: d };
}

/** Project a world point into the image; null when it is behind (or within 5 cm of) the camera. */
export function worldToPixel(p: Vector3, k: Intrinsics, cam: PoseLike): { u: number; v: number; depth: number } | null {
  const inv = new Quaternion().copy(cam.quaternion).invert();
  const c = p.clone().sub(cam.position).applyQuaternion(inv);
  if (c.z >= -0.05) return null;
  return { u: k.cx + (k.fx * c.x) / -c.z, v: k.cy - (k.fy * c.y) / -c.z, depth: -c.z };
}

/** OpenGL projection matrix that reproduces the pinhole intrinsics exactly (for the synthetic camera). */
export function projectionFromIntrinsics(k: Intrinsics, near = 0.05, far = 50): Matrix4 {
  const { fx, fy, cx, cy, width: w, height: h } = k;
  const m = new Matrix4();
  // row-major arguments
  m.set(
    (2 * fx) / w, 0, 1 - (2 * cx) / w, 0,
    0, (2 * fy) / h, (2 * cy) / h - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  );
  return m;
}

// --- depth without a hit ------------------------------------------------------------------------

/** Typical largest dimension (metres) of the things we scan, for a depth guess from the box size. */
const SIZE_PRIORS: [RegExp, number][] = [
  [/ceiling light|ceiling lamp|pendant/i, 0.5],
  [/lamp|light/i, 0.35],
  [/air condition/i, 0.8],
  [/television|\btv\b|monitor|display/i, 0.7],
  [/fan/i, 0.4],
  [/synth|keyboard instrument|groovebox/i, 0.3],
  [/drum machine|sampler|ep-133|k\.o/i, 0.24],
  [/laptop|macbook|notebook/i, 0.31],
  [/screen and keyboard|cardputer|handheld/i, 0.085],
  [/remote/i, 0.17],
  [/phone|iphone/i, 0.15],
  [/speaker/i, 0.2],
  [/computer|devterm/i, 0.25],
];
export const DEFAULT_SIZE_M = 0.25;

export function sizePriorM(label: string): number {
  for (const [re, m] of SIZE_PRIORS) if (re.test(label)) return m;
  return DEFAULT_SIZE_M;
}

/** Depth along the ray from the apparent size: z = f · size / pixels, clamped to a plausible room range. */
export function depthFromSize(label: string, boxPx: [number, number, number, number], k: Intrinsics): number {
  const px = Math.max(boxPx[2], boxPx[3], 1);
  const z = (k.fx * sizePriorM(label)) / px;
  return Math.min(4.5, Math.max(0.3, z));
}

// --- plane helpers -------------------------------------------------------------------------------

/** Right/up axes of a plane whose normal `facing` points at the viewer (x right, y up as the viewer sees it). */
export function planeBasis(facing: Vector3, camUp?: Vector3): { right: Vector3; up: Vector3 } {
  const worldUp = new Vector3(0, 1, 0);
  const ref = Math.abs(facing.dot(worldUp)) > 0.95 ? (camUp?.clone() ?? new Vector3(0, 0, -1)) : worldUp;
  const right = new Vector3().crossVectors(ref, facing).normalize();
  const up = new Vector3().crossVectors(facing, right).normalize();
  return { right, up };
}

/** Intersect a ray with the plane through `point` with normal `n`; null when parallel or behind. */
export function rayPlane(ray: WorldRay, point: Vector3, n: Vector3): Vector3 | null {
  const denom = ray.dir.dot(n);
  if (Math.abs(denom) < 1e-6) return null;
  const t = point.clone().sub(ray.origin).dot(n) / denom;
  if (t <= 0) return null;
  return ray.origin.clone().addScaledVector(ray.dir, t);
}
