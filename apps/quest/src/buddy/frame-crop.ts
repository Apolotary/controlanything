/**
 * What is in the show-me frame, and a JPEG crop of exactly that region of the passthrough camera.
 *
 * Presence (per frame, allocation-free): a tracked hand with at least two of its fingertips / palm joints inside
 * the frame's box (its square grown by 3 cm, from 14 cm behind to 15 cm in front of it). While the wrist menu is
 * open, a palm turned to the face is the menu hand, never a show; otherwise it is allowed, because showing an
 * object resting against the palm (a card, a phone) is exactly that pose. Controllers have no object in hand.
 *
 * Crop (once per capture, off the render path): grab the newest camera frame, project the frame's four world
 * corners with the head pose AT GRAB TIME through the left passthrough camera (scan/projection: head ∘ 6.3 cm
 * forward / 3.2 cm left / 11° pitched-down camera, Quest 3 intrinsics), grow the box 18 % for parallax (the object
 * is rarely exactly on the frame plane), union it with the presenting hand's projected joints when they poke out,
 * clamp to the image, and encode ≤ 384 px (a small crop answers faster). The frame is the contract: an object held
 * inside it is inside the crop, so "nothing" can only mean the frame really was empty.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import type { CameraSource } from '../scan/camera';
import type { JpegEncoder } from '../scan/encode';
import type { PoseRing } from '../scan/poses';
import { cameraPoseFromHead, type PoseLike, questIntrinsics, worldToPixel } from '../scan/projection';
import { FRAME_SIZE } from './viewfinder';

const PRESENCE_JOINTS: XRHandJoint[] = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip', 'middle-finger-metacarpal', 'wrist'];
const SIDES = ['left', 'right'] as const;
const MARGIN = 0.03;
const BEHIND = 0.14;
const FRONT = 0.15;

export interface FramePresence {
  hand?: 'left' | 'right';
  /** joints inside the frame box */
  inside: number;
  /** world centroid of the inside joints */
  point: Vector3;
}

const inv = new Matrix4();
const local = new Vector3();

/**
 * The hand held inside the frame (most joints inside), or null. `frameWorld` is the frame group's matrixWorld;
 * `menuOpen` says the wrist menu is showing (its palm-to-face hand is not a show).
 */
export function handInFrame(f: ShellFrame, frameWorld: Matrix4, out: FramePresence, menuOpen = false): FramePresence | null {
  inv.copy(frameWorld).invert();
  const half = FRAME_SIZE / 2 + MARGIN;
  let best = 0;
  for (const side of SIDES) {
    const h: ShellHand | undefined = f.hands[side];
    if (!h || h.controller || (menuOpen && h.palmUp)) continue;
    let n = 0;
    let sx = 0, sy = 0, sz = 0;
    for (const name of PRESENCE_JOINTS) {
      const p = h.joints[name]?.position;
      if (!p) continue;
      local.copy(p).applyMatrix4(inv);
      // +z points at the user's eyes
      if (Math.abs(local.x) > half || Math.abs(local.y) > half || local.z < -BEHIND || local.z > FRONT) continue;
      n++;
      sx += p.x; sy += p.y; sz += p.z;
    }
    if (n >= 2 && n > best) {
      best = n;
      out.hand = side;
      out.inside = n;
      out.point.set(sx / n, sy / n, sz / n);
    }
  }
  return best ? out : null;
}

export interface FrameCropDeps {
  camera: CameraSource;
  poses: PoseRing;
  encoder: JpegEncoder;
}

export interface FrameCrop {
  jpeg: string;
  width: number;
  height: number;
  /** crop box in the camera frame, px [x, y, w, h] */
  box: [number, number, number, number];
  /** the projected frame alone, px [x, y, w, h] (before padding / the hand union) */
  frameBox: [number, number, number, number];
  /** the camera image size */
  image: [number, number];
  /** the hand poked out of the frame and the box grew to keep it */
  grewForHand: boolean;
}

/**
 * Crop the camera to the frame. `corners` are the frame's world corners at the moment of the show; `joints` the
 * presenting hand's world joints (or empty). Returns null when the camera has no frame or the frame is behind it.
 */
export async function cropFrame(d: FrameCropDeps, corners: Vector3[], joints: Vector3[], maxWidth = 384): Promise<FrameCrop | null> {
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
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of corners) {
      const p = worldToPixel(c, k, cam);
      if (!p) return null;
      x0 = Math.min(x0, p.u); x1 = Math.max(x1, p.u); y0 = Math.min(y0, p.v); y1 = Math.max(y1, p.v);
    }
    const frameBox: [number, number, number, number] = [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
    // parallax pad: the object sits a few cm off the frame plane, and the camera is 6 cm ahead of the eyes
    const padX = (x1 - x0) * 0.09, padY = (y1 - y0) * 0.09;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    const fw = x1 - x0, fh = y1 - y0;
    let grewForHand = false;
    if (joints.length) {
      // keep a hand that pokes out (the object is in it), but never more than 1.5× the frame
      let hx0 = x0, hy0 = y0, hx1 = x1, hy1 = y1;
      for (const j of joints) {
        const p = worldToPixel(j, k, cam);
        if (!p) continue;
        hx0 = Math.min(hx0, p.u); hx1 = Math.max(hx1, p.u); hy0 = Math.min(hy0, p.v); hy1 = Math.max(hy1, p.v);
      }
      const lim = 0.25;
      hx0 = Math.max(hx0, x0 - fw * lim); hx1 = Math.min(hx1, x1 + fw * lim);
      hy0 = Math.max(hy0, y0 - fh * lim); hy1 = Math.min(hy1, y1 + fh * lim);
      grewForHand = hx0 < x0 - 1 || hx1 > x1 + 1 || hy0 < y0 - 1 || hy1 > y1 + 1;
      x0 = hx0; x1 = hx1; y0 = hy0; y1 = hy1;
    }
    const bx = Math.max(0, Math.floor(x0)), by = Math.max(0, Math.floor(y0));
    const bw = Math.min(g.width, Math.ceil(x1)) - bx, bh = Math.min(g.height, Math.ceil(y1)) - by;
    // the frame is (mostly) off-camera: no honest crop
    if (bw < 48 || bh < 48) return null;
    const bitmap = await createImageBitmap(g.bitmap, bx, by, bw, bh);
    const enc = await d.encoder.encode(bitmap, { maxWidth, quality: 0.8 });
    return { jpeg: enc.base64, width: enc.width, height: enc.height, box: [bx, by, bw, bh], frameBox, image: [g.width, g.height], grewForHand };
  } finally {
    g.bitmap.close();
  }
}
