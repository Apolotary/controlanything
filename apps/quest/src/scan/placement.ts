/**
 * 2D detection → 3D placement (research/04 §3): a ray from the CAPTURE camera pose through the box centre,
 * then depth from (in order) a WebXR hit test, the emulator's virtual room, or a size prior along the ray
 * (marked unconfirmed; selecting a candidate does not measure its depth).
 */
import { Vector3 } from 'three';
import type { Det } from '../io/v1';
import type { FrameRecord } from './capture';
import { depthFromSize, pixelToRay, planeBasis, rayPlane, type WorldRay, worldToPixel } from './projection';
import { overlapsHand } from './yolo/quality';

export interface DepthHit {
  point: Vector3;
  normal?: Vector3;
}

export interface DepthProvider {
  readonly name: string;
  hit(ray: WorldRay): Promise<DepthHit | null>;
}

export interface Placement {
  position: Vector3;
  normal?: Vector3;
  /** unit vector from the device toward the capture camera */
  facing: Vector3;
  confirmed: boolean;
  method: string;
  /** metres from the camera */
  depth: number;
  sizeM: [number, number, number];
  contour?: [number, number][];
}

const MAX_CONTOUR = 64;

export async function placeDetection(det: Det, rec: FrameRecord, providers: DepthProvider[]): Promise<Placement> {
  const [x, y, w, h] = det.box;
  const ray = pixelToRay(x + w / 2, y + h / 2, rec.intrinsics, rec.cam);
  let hit: DepthHit | null = null;
  let method = 'size-prior';
  for (const p of providers) {
    try {
      hit = await p.hit(ray);
    } catch {
      hit = null;
    }
    if (hit) {
      method = p.name;
      break;
    }
  }
  let position: Vector3;
  let depth: number;
  if (hit) {
    position = hit.point.clone();
    depth = position.distanceTo(ray.origin);
  } else {
    depth = depthFromSize(det.label, det.box, rec.intrinsics);
    position = ray.origin.clone().addScaledVector(ray.dir, depth);
  }
  const facing = ray.origin.clone().sub(position).normalize();
  // metric size at the depth along the optical axis
  const camFwd = new Vector3(0, 0, -1).applyQuaternion(rec.cam.quaternion);
  const zCam = Math.max(0.05, depth * Math.max(0.2, ray.dir.dot(camFwd)));
  const wm = (w * zCam) / rec.intrinsics.fx;
  const hm = (h * zCam) / rec.intrinsics.fy;
  const placement: Placement = {
    position,
    facing,
    confirmed: Boolean(hit),
    method,
    depth,
    sizeM: [round(wm), round(hm), round(Math.min(wm, hm) * 0.5)],
  };
  if (hit?.normal) placement.normal = hit.normal.clone();
  const contour = det.polygon ?? boxPolygon(det.box);
  placement.contour = liftContour(contour, rec, position, facing);
  return placement;
}

function boxPolygon([x, y, w, h]: [number, number, number, number]): [number, number][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** Mask outline (px) → metres in the plane through `position` facing the camera (x right, y up). */
export function liftContour(poly: [number, number][], rec: FrameRecord, position: Vector3, facing: Vector3): [number, number][] {
  const step = Math.max(1, Math.ceil(poly.length / MAX_CONTOUR));
  const camUp = new Vector3(0, 1, 0).applyQuaternion(rec.cam.quaternion);
  const { right, up } = planeBasis(facing, camUp);
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i += step) {
    const [u, v] = poly[i];
    const p = rayPlane(pixelToRay(u, v, rec.intrinsics, rec.cam), position, facing);
    if (!p) continue;
    const d = p.sub(position);
    out.push([round(d.dot(right)), round(d.dot(up))]);
  }
  return out;
}

const PERSON = /\b(person|people|human|man|woman|men|women|child|kid|face|head|body|hand|arm|finger)s?\b/i;

/**
 * Client-side guards before anything is drawn (BRIEF §4.1 rule 7, research/15 §4.2): never tag people or
 * hands; drop walls/floors (a box over 60 % of the frame); drop boxes that are really the user's hand
 * substantially covered by projected hand joints. Devices remain selectable under partial occlusion.
 */
export function rejectReason(det: Det, rec: FrameRecord): string | null {
  if (PERSON.test(det.label) || (det.prompt && PERSON.test(det.prompt))) return 'person or body part';
  const cropArea = rec.region ? (rec.region[2] - rec.region[0]) * (rec.region[3] - rec.region[1]) : 1;
  const area = (det.box[2] * det.box[3]) / (rec.width * rec.height) * cropArea;
  if (area > 0.6) return 'covers over 60 % of the frame';
  const joints = rec.handJoints.flatMap((joint) => {
    const px = worldToPixel(joint, rec.intrinsics, rec.cam);
    return px ? [{ ...px, radius: Math.max(2, rec.intrinsics.fx * 0.018 / px.depth) }] : [];
  });
  if (overlapsHand(det.box, joints)) return 'overlaps a tracked hand';
  return null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
