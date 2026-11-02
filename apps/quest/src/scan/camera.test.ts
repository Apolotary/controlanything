import { afterEach, expect, it, vi } from 'vitest';
import { LiveCamera } from './camera';

afterEach(() => vi.unstubAllGlobals());

it('captures directly from the muted camera video as a resized ImageBitmap', async () => {
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 960, muted: false, playsInline: false, autoplay: false };
  const bitmap = { width: 416, height: 312, close: vi.fn() };
  const create = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('document', { createElement: () => video });
  vi.stubGlobal('createImageBitmap', create);
  const camera = new LiveCamera();
  (camera as unknown as { running: boolean }).running = true;
  const frame = await camera.grab({ maxWidth: 416 });
  expect(video.muted).toBe(true);
  expect(create).toHaveBeenCalledExactlyOnceWith(video, { resizeWidth: 416, resizeHeight: 312, resizeQuality: 'low' });
  expect(frame?.bitmap).toBe(bitmap);
  expect(frame?.intrinsics?.fx).toBeCloseTo(868.31 * 416 / 1280);
  expect(bitmap.close).not.toHaveBeenCalled(); // caller transfers ownership to the worker
});
