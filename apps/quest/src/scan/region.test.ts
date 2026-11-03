import { afterEach, describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { regionCrop, scanRegion } from './region';
import { cameraPoseFromHead, pixelToRay, questIntrinsics } from './projection';
import { FrameCapture } from './capture';
import { PoseRing } from './poses';
import { ManualRegionSelector } from './manual-region';
import type { ShellFrame } from '../app/hud-contract';
import type { CameraSource } from './camera';
import type { JpegEncoder } from './encode';

afterEach(() => vi.unstubAllGlobals());
describe('deliberate area identification', () => {
  it('normalizes reversed corners and rejects accidental tiny/nonfinite selections', () => {
    expect(scanRegion([0.8, 0.9], [0.2, 0.3])).toEqual([0.2, 0.3, 0.8, 0.9]);
    expect(scanRegion([0.5, 0.5], [0.51, 0.9])).toBeNull();
    expect(scanRegion([NaN, 0], [1, 1])).toBeNull();
  });
  it('keeps a cropped detection on the same real-world ray', () => {
    const k = questIntrinsics(1280, 960), crop = regionCrop(k, [0.2, 0.3, 0.7, 0.8]);
    const cam = { position: new Vector3(1, 1.5, 2), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7) };
    const before = pixelToRay(460, 510, k, cam), after = pixelToRay(460 - crop.x, 510 - crop.y, crop.intrinsics, cam);
    expect(before.dir.distanceTo(after.dir)).toBeLessThan(1e-10);
  });
  it('only encodes selected pixels and closes the original camera bitmap', async () => {
    const original = { close: vi.fn() }, cropped = { close: vi.fn() };
    const crop = vi.fn().mockResolvedValue(cropped); vi.stubGlobal('createImageBitmap', crop);
    const encode = vi.fn().mockResolvedValue({ base64: 'cropped-jpeg', width: 640, height: 480, bytes: 10 });
    const camera = { eye: 'left', kind: 'passthrough', grab: async () => ({ bitmap: original, width: 1280, height: 960, tCapture: 10,
      headPose: { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }) } as unknown as CameraSource;
    const capture = new FrameCapture({ camera, poses: new PoseRing(), encoder: { encode } as unknown as JpegEncoder, handJoints: () => [] });
    const result = await capture.capture('scan', undefined, [0.25, 0.25, 0.75, 0.75]);
    expect(crop).toHaveBeenCalledWith(original, 320, 240, 640, 480);
    expect(original.close).toHaveBeenCalledOnce(); expect(encode.mock.calls[0][0]).toBe(cropped);
    expect(result?.payload.jpeg).toBe('cropped-jpeg');
    expect(result?.record.intrinsics.cx).toBeCloseTo(320.18);
  });
  it('needs two separate pinches, ignores the menu-opening pinch and cancels cleanly', () => {
    const selector = new ManualRegionSelector(); selector.begin();
    const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
    const cam = cameraPoseFromHead(head, 'left'), k = questIntrinsics(1280, 960);
    const step = (u: number, v: number, pinching: boolean) => {
      const ray = pixelToRay(u * 1280, v * 960, k, cam);
      return selector.update({ head: { ...head, ray }, hands: { right: { pinching, ray } } } as ShellFrame, 'left');
    };
    expect(step(0.2, 0.2, true)).toBeUndefined(); step(0.2, 0.2, false);
    expect(step(0.2, 0.2, true)).toBeUndefined();
    expect(step(0.7, 0.8, true)).toBeUndefined(); step(0.7, 0.8, false);
    const selected = step(0.7, 0.8, true)!;
    expect(selected[0]).toBeCloseTo(0.2); expect(selected[3]).toBeCloseTo(0.8);
    expect(selector.active).toBe(false); expect(selector.root.visible).toBe(false);
    selector.begin(); selector.cancel(); expect(step(0.2, 0.2, true)).toBeUndefined();
  });
});
