import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSpec } from '@ce/gen3d';
import { afterEach, describe, expect, it } from 'vitest';
import { CallLog } from '../muse/callLog';
import { resolveMuseConfig } from '../muse/config';
import type { EditSet } from './editPatch';
import { createForge, type ForgeProgress, type ForgeSnapshot } from './forge';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DEVICE } from './sampleDevices';
import { LiveSkinPainter, ReplaySkinPainter, skinPrompt, SkinStore, webpSize } from './skin';
import { contentEvents, fakeWebp, imageResponse, LIGHT_DRAFT, routeFetch, sseResponse } from './testkit';

const live = resolveMuseConfig({ MODEL_API_KEY: 'sk-test' });
const fixture = resolveMuseConfig({});
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ce-skin-'));
  tmps.push(d);
  return d;
};
const CROP = { jpegBase64: '/9j/AAAA', width: 390, height: 155 };

describe('skin prompt and request', () => {
  it("asks for a dark, text-free texture in the device's own materials and colours", () => {
    const p = skinPrompt(FORGE_OP1_DEVICE, true);
    expect(p).toContain('brushed grey aluminium');
    expect(p).toContain('#2F6BFF');
    expect(p).toMatch(/Draw no text, letters, numbers, logos, knobs/);
    expect(skinPrompt(FORGE_LIGHT_DEVICE, false)).toContain('frosted acrylic');
  });

  it('edits from the crop with low reasoning, every tool off, webp out; generates from a prompt without one', async () => {
    const f = routeFetch({ '/images/': [imageResponse(fakeWebp())] });
    const store = new SkinStore();
    const p = new LiveSkinPainter({ apiKey: 'sk-test', fetchImpl: f.impl, store });
    const r = await p.paint({ device: FORGE_OP1_DEVICE, crop: CROP });
    expect(f.calls[0].url).toBe('https://api.meta.ai/v1/images/edits');
    expect(f.calls[0].body).toMatchObject({
      model: 'muse-image-1.0',
      images: [{ image_url: 'data:image/jpeg;base64,/9j/AAAA' }],
      n: 1,
      output_format: 'webp',
      response_format: 'b64_json',
      reasoning_strength: 'low',
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
    });
    expect(r).toMatchObject({ ok: true, mode: 'edit', model: 'muse-image-1.0', source: 'live', width: 1920, height: 720 });
    expect(r.url).toMatch(/^\/api\/skins\/skn_[A-Za-z0-9]+\.webp$/);
    expect(store.get(r.skinId!)?.bytes).toEqual(fakeWebp());
    await p.paint({ device: FORGE_LIGHT_DEVICE });
    expect(f.calls[1].url).toBe('https://api.meta.ai/v1/images/generations');
    expect(f.calls[1].body.images).toBeUndefined();
  });

  it('reports a failure without throwing', async () => {
    const f = routeFetch({ '/images/': [() => new Response('{"error":{"code":"content_policy_violation"}}', { status: 400 })] });
    const r = await new LiveSkinPainter({ apiKey: 'k', fetchImpl: f.impl, store: new SkinStore() }).paint({ device: FORGE_OP1_DEVICE, crop: CROP });
    expect(r).toMatchObject({ ok: false, source: 'live' });
    expect(r.error).toMatch(/HTTP 400.*content_policy_violation/);
  });

  it('records live skins and replays them by card, then by device category', async () => {
    const dir = tmp();
    const f = routeFetch({ '/images/': [imageResponse(fakeWebp(1536, 576))] });
    await new LiveSkinPainter({ apiKey: 'k', fetchImpl: f.impl, store: new SkinStore(), recordDir: dir }).paint({ device: FORGE_OP1_DEVICE, transport: 'midi', crop: CROP });
    expect(readdirSync(dir).sort().map((n) => n.split('.').pop())).toEqual(['json', 'webp']);
    const store = new SkinStore();
    const replay = new ReplaySkinPainter({ dir, store, speed: 0 });
    const same = await replay.paint({ device: FORGE_OP1_DEVICE });
    expect(same).toMatchObject({ ok: true, source: 'fixture', model: 'fixture', recordedFrom: 'muse-image-1.0', width: 1536, height: 576 });
    expect(store.get(same.skinId!)?.bytes).toEqual(fakeWebp(1536, 576));
    expect((await replay.paint({ device: { ...FORGE_OP1_DEVICE, cardId: 'synthesizer-1' } })).ok).toBe(true);
    const none = await replay.paint({ device: FORGE_LIGHT_DEVICE });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/^FIXTURE: no recorded skin/);
  });

  it('reads WebP sizes (VP8X)', () => {
    expect(webpSize(fakeWebp(800, 300))).toEqual({ width: 800, height: 300 });
    expect(webpSize(new Uint8Array(40))).toBeUndefined();
  });

  it('serves identical content-addressed bytes after restart and rejects missing or corrupt assets', () => {
    const dir = tmp();
    const first = new SkinStore(1, dir);
    const bytes = fakeWebp(800, 300);
    const id = first.put(bytes);
    expect(first.put(bytes)).toBe(id);
    first.put(fakeWebp(801, 300));
    expect(first.size).toBe(1);
    const restarted = new SkinStore(1, dir);
    expect(restarted.get(id)?.bytes).toEqual(Buffer.from(bytes));
    expect(restarted.get('skn_missing')).toBeUndefined();
    expect(restarted.get('../outside')).toBeUndefined();
    writeFileSync(join(dir, `${id.slice(4)}.webp`), 'interrupted');
    expect(restarted.get(id)).toBeUndefined();
    expect(readdirSync(dir).some((file) => file.endsWith('.tmp'))).toBe(false);
  });
});

describe('forge + skin: controls arm first, the skin arrives as a later revision', () => {
  const lever: EditSet = { behaviors: [], controls: [], feedback: [], parts: [{ id: 'p_h_dim', kind: 'archetype', archetype: 'lever', controlId: 'h_dim', params: { length: 0.22, accent: '#FF2020' } }], remove: [], summary: 'lever', title: '' };

  it('restores an edited interface, late skin and history without a model call, then accepts another edit', async () => {
    const dir = tmp();
    const f = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT))), () => sseResponse(contentEvents(JSON.stringify(lever)))], '/images/': [imageResponse(fakeWebp(), 80)] });
    const forge = createForge({ muse: live, fetchImpl: f.impl, skin: true, skinStore: new SkinStore(64, dir) });
    const snapshots: ForgeSnapshot[] = [];
    forge.subscribe((event) => {
      if (event.type === 'spec') snapshots.push(forge.snapshot!(event.uiSpec.specId)!);
    });
    const generated = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, crop: CROP });
    const id = generated.uiSpec!.specId;
    await forge.edit({ specId: id, instruction: 'make the dimmer a lever' });
    const withSkin = await forge.whenSkin!(id);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].revs[0].gen3d.skin).toBeUndefined();
    expect(snapshots.at(-1)!.revs.at(-1)!.gen3d.skin).toEqual(withSkin!.gen3d.skin);
    const saved = JSON.parse(JSON.stringify(snapshots.at(-1)));
    const editFetch = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(lever)))] });
    const restarted = createForge({ muse: live, fetchImpl: editFetch.impl, skin: true, skinStore: new SkinStore(64, dir) });
    const events: unknown[] = [];
    restarted.subscribe((event) => events.push(event));
    expect(restarted.restore!(saved)).toEqual(withSkin);
    expect(events).toHaveLength(0);
    expect(editFetch.calls).toHaveLength(0);
    expect(restarted.snapshot!(id)).toEqual(saved);
    expect(restarted.target(FORGE_LIGHT_DEVICE.cardId)?.verification).toEqual(FORGE_LIGHT_VERIFIED);
    const skinId = withSkin!.gen3d.skin!.url.match(/(skn_[A-Za-z0-9]+)/)![1];
    expect(restarted.skins!.get(skinId)?.bytes).toEqual(Buffer.from(fakeWebp()));
    expect(restarted.undo(id).ok).toBe(true);
    expect(restarted.redo(id).ok).toBe(true);
    expect(editFetch.calls).toHaveLength(0);
    const edited = await restarted.edit({ specId: id, instruction: 'use a lever again' });
    expect(edited.ok).toBe(true);
    expect(edited.uiSpec!.gen3d.skin).toEqual(withSkin!.gen3d.skin);
    expect(editFetch.calls).toHaveLength(1);
  });

  it('paints in parallel, never gates arming, attaches the skin on rev+1 and keeps it through edits and undo', async () => {
    const f = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT))), () => sseResponse(contentEvents(JSON.stringify(lever)))], '/images/': [imageResponse(fakeWebp(), 80)] });
    const calls = new CallLog(() => {});
    const forge = createForge({ muse: live, fetchImpl: f.impl, callLog: calls, skin: true });
    const steps: ForgeProgress[] = [];
    forge.subscribe((e) => {
      if (e.type === 'progress') steps.push(e.progress);
    });
    const r = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, crop: CROP });
    // armed right away, no skin yet
    expect(r.ok).toBe(true);
    expect(r.uiSpec!.rev).toBe(1);
    expect(r.uiSpec!.gen3d.skin).toBeUndefined();
    expect(r.uiSpec!.gen3d.controls.find((c) => c.id === 'h_dim')?.armed).toBe(true);
    // both calls start together: the image request goes out first, before the hack-set stream
    expect(f.calls.map((c) => c.url.replace('https://api.meta.ai/v1', ''))).toEqual(['/images/edits', '/chat/completions']);

    const withSkin = await forge.whenSkin!(r.uiSpec!.specId);
    expect(withSkin!.rev).toBe(2);
    expect(withSkin!.gen3d.skin).toMatchObject({ kind: 'panel', source: 'muse-image-1.0', fit: 'cover', partIds: [], fadeS: 2.5 });
    expect(withSkin!.gen3d.skin!.url).toMatch(/^\/api\/skins\/skn_/);
    expect(validateSpec(withSkin!.gen3d).ok).toBe(true);
    expect(steps.find((s) => s.title.startsWith('Painting a panel skin'))).toMatchObject({ status: 'running', model: 'muse-image-1.0' });
    expect(steps.find((s) => s.title.startsWith('Panel skin painted'))).toMatchObject({ status: 'ok', model: 'muse-image-1.0', source: 'live' });
    expect(steps.find((s) => s.title.startsWith('Panel skin painted'))!.latencyMs).toBeGreaterThanOrEqual(60);
    expect(calls.list().map((c) => [c.label, c.model])).toEqual([
      ['gen3d.forge', 'muse-spark-1.3'],
      ['gen3d.skin', 'muse-image-1.0'],
    ]);

    // an edit keeps the skin; undo goes back to content that still has it
    const e = await forge.edit({ specId: r.uiSpec!.specId, instruction: 'make the dimmer a big red lever' });
    expect(e.uiSpec!.gen3d.skin?.url).toBe(withSkin!.gen3d.skin!.url);
    const u = forge.undo(r.uiSpec!.specId);
    expect(u.uiSpec!.gen3d.skin?.url).toBe(withSkin!.gen3d.skin!.url);
  });

  it('a failed skin only logs: the controls stay armed and no revision is added', async () => {
    const f = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT)))], '/images/': [() => new Response('{"error":{}}', { status: 503 })] });
    const forge = createForge({ muse: live, fetchImpl: f.impl, skin: true });
    const r = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED });
    expect(await forge.whenSkin!(r.uiSpec!.specId)).toBeUndefined();
    expect(forge.get(r.uiSpec!.specId)?.rev).toBe(1);
    expect(f.calls[0].url).toContain('/images/generations');
  });

  it('ignores an older generation skin after a replacement interface is committed', async () => {
    const f = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT)))], '/images/': [imageResponse(fakeWebp(800, 300), 80), imageResponse(fakeWebp(1600, 600))] });
    const forge = createForge({ muse: live, fetchImpl: f.impl, skin: true });
    const req = { device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED };
    const first = await forge.generate(req);
    const oldSkin = forge.whenSkin!(first.uiSpec!.specId);
    const second = await forge.generate({ ...req, repaintSkin: true });
    const current = await forge.whenSkin!(second.uiSpec!.specId);
    const saved = forge.snapshot!(second.uiSpec!.specId);
    expect(await oldSkin).toBeUndefined();
    expect(forge.get(second.uiSpec!.specId)).toEqual(current);
    expect(forge.snapshot!(second.uiSpec!.specId)).toEqual(saved);
  });

  it('regenerating the same device reuses its skin without painting again', async () => {
    const f = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT)))], '/images/': [imageResponse(fakeWebp())] });
    const forge = createForge({ muse: live, fetchImpl: f.impl, skin: true });
    const r = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, crop: CROP });
    await forge.whenSkin!(r.uiSpec!.specId);
    const again = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED });
    expect(again.uiSpec!.gen3d.skin?.source).toBe('muse-image-1.0');
    expect(f.calls.filter((c) => c.url.includes('/images/'))).toHaveLength(1);
  });

  it('replays a recorded skin in FIXTURE mode', async () => {
    const dir = tmp();
    const f = routeFetch({ '/chat/completions': [() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT)))], '/images/': [imageResponse(fakeWebp())] });
    const rec = createForge({ muse: live, fetchImpl: f.impl, skin: true, recordDir: dir });
    const r = await rec.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, crop: CROP });
    await rec.whenSkin!(r.uiSpec!.specId);
    const replay = createForge({ muse: fixture, skin: true, replayDir: dir, replaySpeed: 0 });
    const p = await replay.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED });
    const s = await replay.whenSkin!(p.uiSpec!.specId);
    expect(s!.gen3d.skin?.source).toBe('muse-image-1.0');
    expect(replay.skins!.get(s!.gen3d.skin!.url.match(/(skn_[A-Za-z0-9]+)/)![1])?.bytes).toEqual(fakeWebp());
  });
});
