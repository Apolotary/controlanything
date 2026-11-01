import { Quaternion, Vector3, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  cameraPoseFromHead,
  depthFromSize,
  fovYDeg,
  pixelToRay,
  projectionFromIntrinsics,
  QUEST3_1280x960,
  questIntrinsics,
  rayPlane,
  scaleIntrinsics,
  worldToPixel,
} from './projection';

const head = { position: new Vector3(0.1, 1.6, -0.2), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4) };

describe('Quest 3 intrinsics', () => {
  it('uses the measured 1280×960 calibration', () => {
    expect(questIntrinsics(1280, 960)).toEqual(QUEST3_1280x960);
  });

  it('derives a centred crop for 1280×720 (cy ≈ 360.7)', () => {
    const k = questIntrinsics(1280, 720);
    expect(k.fx).toBeCloseTo(868, 3);
    expect(k.cy).toBeCloseTo(640.7 - 280, 3);
  });

  it('scales with the encoded size', () => {
    const k = scaleIntrinsics(QUEST3_1280x960, 640, 480);
    expect(k.fx).toBeCloseTo(434.155, 3);
    expect(k.cx).toBeCloseTo(320.09, 2);
    expect(fovYDeg(k)).toBeCloseTo(fovYDeg(QUEST3_1280x960), 6);
    expect(fovYDeg(QUEST3_1280x960)).toBeCloseTo(57.87, 2);
  });
});

describe('camera pose from the head', () => {
  it('puts the left camera 3.2 cm left, 1.7 cm down, 6.3 cm forward, pitched 11.1° down', () => {
    const id = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
    const cam = cameraPoseFromHead(id, 'left');
    expect(cam.position.x).toBeCloseTo(-0.032, 6);
    expect(cam.position.y).toBeCloseTo(1.583, 6);
    expect(cam.position.z).toBeCloseTo(-0.063, 6);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    expect((Math.asin(fwd.y) * 180) / Math.PI).toBeCloseTo(-11.1, 3);
  });
});

describe('pixel ↔ ray', () => {
  const k = QUEST3_1280x960;
  const cam = cameraPoseFromHead(head, 'left');

  it('the principal point looks straight down the optical axis', () => {
    const r = pixelToRay(k.cx, k.cy, k, cam);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    expect(r.dir.angleTo(fwd)).toBeLessThan(1e-6);
    expect(r.origin.distanceTo(cam.position)).toBeLessThan(1e-9);
  });

  it('round-trips a pixel through 3D at any depth', () => {
    for (const [u, v, d] of [
      [100, 80, 0.5],
      [1200, 900, 2],
      [640, 100, 3.7],
    ]) {
      const r = pixelToRay(u, v, k, cam);
      const p = r.origin.clone().addScaledVector(r.dir, d);
      const px = worldToPixel(p, k, cam)!;
      expect(px.u).toBeCloseTo(u, 6);
      expect(px.v).toBeCloseTo(v, 6);
    }
  });

  it('image y grows downward (a point above the axis has a smaller v)', () => {
    const up = cam.position.clone().add(new Vector3(0, 0.3, 0)).add(new Vector3(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(2));
    expect(worldToPixel(up, k, cam)!.v).toBeLessThan(k.cy);
  });

  it('returns null behind the camera', () => {
    const behind = cam.position.clone().add(new Vector3(0, 0, 1).applyQuaternion(cam.quaternion));
    expect(worldToPixel(behind, k, cam)).toBeNull();
  });
});

describe('projection matrix from intrinsics', () => {
  it('maps a camera-space point to the same pixel as the pinhole model', () => {
    const k = QUEST3_1280x960;
    const m = projectionFromIntrinsics(k, 0.05, 50);
    const pCam = new Vector4(0.31, -0.12, -1.7, 1);
    const clip = pCam.clone().applyMatrix4(m);
    const ndcX = clip.x / clip.w;
    const ndcY = clip.y / clip.w;
    const u = ((ndcX + 1) / 2) * k.width;
    const v = ((1 - ndcY) / 2) * k.height;
    expect(u).toBeCloseTo(k.cx + (k.fx * 0.31) / 1.7, 6);
    expect(v).toBeCloseTo(k.cy - (k.fy * -0.12) / 1.7, 6);
  });
});

describe('depth from size', () => {
  it('a 0.5 m ceiling light spanning 200 px at fx 868 is ~2.2 m away', () => {
    expect(depthFromSize('ceiling light', [0, 0, 200, 120], QUEST3_1280x960)).toBeCloseTo((868.31 * 0.5) / 200, 6);
  });
  it('clamps to the room range', () => {
    expect(depthFromSize('phone', [0, 0, 2, 2], QUEST3_1280x960)).toBe(4.5);
    expect(depthFromSize('laptop', [0, 0, 1200, 900], QUEST3_1280x960)).toBe(0.3);
  });
});

describe('ray–plane', () => {
  it('hits a plane in front, misses one behind', () => {
    const ray = { origin: new Vector3(0, 1, 0), dir: new Vector3(0, 0, -1) };
    expect(rayPlane(ray, new Vector3(0, 0, -2), new Vector3(0, 0, 1))!.z).toBeCloseTo(-2, 9);
    expect(rayPlane(ray, new Vector3(0, 0, 2), new Vector3(0, 0, 1))).toBeNull();
  });
});
