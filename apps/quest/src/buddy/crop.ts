/**
 * "Show the buddy something": where the held object is, and a JPEG crop of it from the passthrough camera.
 *
 * Presenter (per frame, allocation-free): a tracked hand raised in front of the face (joints within 18–65 cm of the
 * head, inside a 35° cone), else the point 45 cm along the gaze. The crop (once per show, off the render path):
 * grab the latest camera frame, project the presenter's joints with the head pose AT CAPTURE TIME, square and pad
 * the box so the object around the fingers fits (≥ 22 cm at that depth), snap to a live YOLO box near the hand
 * when SCAN is running, then encode ≤ 448 px JPEG through the app's encoder worker.
 */
import { Quaternion, Vector3 } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import type { CameraSource } from '../scan/camera';
import type { JpegEncoder } from '../scan/encode';
import type { PoseRing } from '../scan/poses';
import { cameraPoseFromHead, type PoseLike, questIntrinsics, worldToPixel } from '../scan/projection';

export interface Presenter {
  kind: 'hand' | 'gaze';
  hand?: 'left' | 'right';
  /** world point of the held object (best guess) */
  point: Vector3;
  /** metres from the head */
  distance: number;
  /** 0..1, how clearly the hand is held up to be seen (centred + in range) */
  score: number;
}

const OBJECT_JOINTS: XRHandJoint[] = ['wrist', 'thumb-tip', 'index-finger-metacarpal', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-metacarpal', 'pinky-finger-tip'];

const SIDES = ['left', 'right'] as const;
const fwd = new Vector3();
const toHand = new Vector3();
const acc = new Vector3();

/** The hand most clearly held up in front of the face, or null. Writes into `out`. */
export function findPresenter(f: ShellFrame, out: Presenter): Presenter | null {
  fwd.set(0, 0, -1).applyQuaternion(f.head.quaternion);
  let best: Presenter | null = null;
  let bestScore = 0;
  for (const side of SIDES) {
    const h: ShellHand | undefined = f.hands[side];
    // controllers have no object in hand; a palm turned to the face is opening the wrist palette, not showing
    if (!h || h.controller || h.palmUp) continue;
    acc.set(0, 0, 0);
    let n = 0;
    for (const j of OBJECT_JOINTS) {
      const p = h.joints[j]?.position;
      if (p) { acc.add(p); n++; }
    }
    if (n < 3) continue;
    acc.multiplyScalar(1 / n);
    toHand.copy(acc).sub(f.head.position);
    const dist = toHand.length();
    if (dist < 0.18 || dist > 0.65) continue;
    const cos = toHand.dot(fwd) / dist;
    const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
    if (angle > 0.61) continue; // 35°
    const score = (1 - angle / 0.61) * (dist > 0.25 && dist < 0.55 ? 1 : 0.6);
    if (score > bestScore) {
      bestScore = score;
      out.kind = 'hand';
      out.hand = side;
      out.point.copy(acc);
      out.distance = dist;
      out.score = score;
      best = out;
    }
  }
  return best;
}

/** The gaze point (nothing held up): 45 cm straight ahead. */
export function gazePresenter(f: ShellFrame, out: Presenter): Presenter {
  out.kind = 'gaze';
  out.hand = undefined;
  out.point.copy(f.head.position).addScaledVector(fwd.set(0, 0, -1).applyQuaternion(f.head.quaternion), 0.45);
  out.distance = 0.45;
  out.score = 0;
  return out;
}

export interface CropDeps {
  camera: CameraSource;
  poses: PoseRing;
  encoder: JpegEncoder;
  /** live YOLO boxes on screen (world), when SCAN is running */
  liveBoxes?: () => { position: Vector3; size: number }[];
}

export interface Crop {
  jpeg: string;
  width: number;
  height: number;
  /** crop box in the camera frame, px */
  box: [number, number, number, number];
  /** what the crop was centred on */
  via: 'hand' | 'gaze' | 'yolo';
  /** world size of the crop square at the object's depth, metres */
  sizeM: number;
}

/**
 * One crop of the presented object. `joints` are the presenting hand's joint positions (world) at the moment of
 * the show, or empty for a gaze crop. Returns null when the camera has no frame.
 */
export async function cropPresented(d: CropDeps, presenter: Presenter, joints: Vector3[], maxWidth = 448): Promise<Crop | null> {
  const g = await d.camera.grab();
  if (!g) return null;
  try {
    let head: PoseLike | null = null;
    if (g.headPose) {
      head = {
        position: new Vector3(g.headPose.position.x, g.headPose.position.y, g.headPose.position.z),
        quaternion: new Quaternion(g.headPose.orientation.x, g.headPose.orientation.y, g.headPose.orientation.z, g.headPose.orientation.w),
      };
    } else {
      const p = d.poses.lookup(g.tCapture) ?? d.poses.latest();
      if (p) head = { position: p.position.clone(), quaternion: p.quaternion.clone() };
    }
    if (!head) return null;
    const cam = cameraPoseFromHead(head, d.camera.eye);
    const k = g.intrinsics ?? questIntrinsics(g.width, g.height);

    let center = presenter.point.clone();
    let minSize = 0.22;
    let via: Crop['via'] = presenter.kind;
    // snap to a live YOLO box near the hand (the object itself, not the hand)
    const boxes = d.liveBoxes?.() ?? [];
    let bestD = presenter.kind === 'hand' ? 0.2 : 0.12;
    for (const b of boxes) {
      const dist = b.position.distanceTo(presenter.point);
      if (dist < bestD) {
        bestD = dist;
        center = b.position.clone();
        minSize = Math.min(0.45, Math.max(0.12, b.size * 1.25));
        via = 'yolo';
      }
    }

    const c = worldToPixel(center, k, cam);
    if (!c) return null;
    let x0 = c.u, x1 = c.u, y0 = c.v, y1 = c.v;
    if (via === 'hand') {
      for (const j of joints) {
        const p = worldToPixel(j, k, cam);
        if (!p) continue;
        x0 = Math.min(x0, p.u); x1 = Math.max(x1, p.u); y0 = Math.min(y0, p.v); y1 = Math.max(y1, p.v);
      }
    }
    const minPx = (k.fx * minSize) / Math.max(0.12, c.depth);
    let side = Math.max(x1 - x0, y1 - y0) * 1.45;
    side = Math.max(side, minPx, 160);
    side = Math.min(side, Math.min(g.width, g.height));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 - (via === 'hand' ? side * 0.08 : 0);
    const bx = Math.round(Math.min(Math.max(0, cx - side / 2), g.width - side));
    const by = Math.round(Math.min(Math.max(0, cy - side / 2), g.height - side));
    const s = Math.round(side);
    const bitmap = await createImageBitmap(g.bitmap, bx, by, s, s);
    const enc = await d.encoder.encode(bitmap, { maxWidth, quality: 0.82 });
    return { jpeg: enc.base64, width: enc.width, height: enc.height, box: [bx, by, s, s], via, sizeM: (s * Math.max(0.12, c.depth)) / k.fx };
  } finally {
    g.bitmap.close();
  }
}
