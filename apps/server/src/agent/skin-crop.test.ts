/**
 * The keyless judge path still shows a panel skin: the real forge in FIXTURE mode, given the scan crop the loop
 * now passes (cropForSkin), arms the controls first (rev 1) and then replays the recorded muse-image-1.0 skin
 * for that device (rev 2), served as a webp. No model call, no key.
 */
import { describe, expect, it } from 'vitest';
import { createForge } from '../gen3d';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED } from '../gen3d/sampleDevices';
import { resolveMuseConfig } from '../muse/config';
import { encodeJpeg } from '../oracle/image';
import { cropForSkin } from './identify';

const RECORDED = new URL('../../fixtures/recorded/gen3d', import.meta.url).pathname;

describe('scan crop -> forge -> recorded skin (keyless)', () => {
  it('arms the controls first and lands the recorded panel skin as the next revision', { timeout: 20_000 }, async () => {
    // a small synthetic frame with a bright disc, cropped the way the loop does it before FORGE
    const width = 640;
    const height = 480;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const lit = (x - 320) ** 2 + (y - 160) ** 2 < 90 ** 2;
        data[i] = lit ? 250 : 60;
        data[i + 1] = lit ? 235 : 60;
        data[i + 2] = lit ? 200 : 70;
        data[i + 3] = 255;
      }
    }
    const frame = { width, height, data };
    expect(encodeJpeg(frame).length).toBeGreaterThan(0);
    const crop = cropForSkin(frame, [230, 70, 180, 180]);
    expect(crop.jpegBase64.startsWith('data:')).toBe(false);
    expect(Math.max(crop.width, crop.height)).toBeLessThanOrEqual(1024);

    const forge = createForge({ muse: resolveMuseConfig({ MODEL_MODE: 'fixture' }), replayDir: RECORDED, replaySpeed: 0, skin: true });
    const r = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, crop });
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toBe('fixture');
    expect(r.uiSpec!.rev).toBe(1);
    expect(r.uiSpec!.gen3d.controls.some((c) => c.armed)).toBe(true); // controls arm without waiting for the skin

    // at replay speed 0 the skin may already be in; either way the skinned revision is the one the headset shows
    const skinned = await forge.whenSkin!(r.uiSpec!.specId);
    expect(skinned, 'the recorded skin replays for the light').toBeDefined();
    expect(skinned!.rev).toBeGreaterThanOrEqual(1);
    expect(skinned!.gen3d.skin?.url).toMatch(/^\/api\/skins\/skn_[A-Za-z0-9]+\.webp$/);
    expect(skinned!.gen3d.skin?.source).toBe('muse-image-1.0');
    const id = skinned!.gen3d.skin!.url.match(/(skn_[A-Za-z0-9]+)/)![1];
    const stored = forge.skins!.get(id);
    expect(stored?.bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(stored!.bytes.subarray(0, 4)).toString('ascii')).toBe('RIFF'); // webp container
  });
});
