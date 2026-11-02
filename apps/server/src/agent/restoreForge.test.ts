import { Driver } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createForge } from '../gen3d/forge';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED } from '../gen3d/sampleDevices';
import { contentEvents, LIGHT_DRAFT, mockFetch, sseResponse } from '../gen3d/testkit';
import { resolveMuseConfig } from '../muse/config';
import { restoreSavedForge } from './restoreForge';

const muse = resolveMuseConfig({ MODEL_API_KEY: 'test-key' });
const edit = { behaviors: [], controls: [], feedback: [], parts: [], remove: [], summary: 'renamed', title: 'Saved light controls' };
const reply = (data: unknown) => () => sseResponse(contentEvents(JSON.stringify(data)));

async function savedDevice() {
  const fetch = mockFetch([reply(LIGHT_DRAFT), reply(edit)]);
  const forge = createForge({ muse, fetchImpl: fetch.impl });
  const generated = await forge.generate({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED });
  const changed = await forge.edit({ specId: generated.uiSpec!.specId, instruction: 'rename the interface' });
  const driver = Driver.parse({
    ...FORGE_LIGHT_DRIVER, executor: { deviceId: 'dev_cardputer_a' }, provenance: [],
    actions: FORGE_LIGHT_DRIVER.actions.map((action) => ({ ...action, encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] } })),
  });
  return {
    cardId: FORGE_LIGHT_DEVICE.cardId, label: 'Ceiling light', driver,
    verification: FORGE_LIGHT_VERIFIED, uiSpec: changed.uiSpec!, forgeContext: forge.snapshot!(changed.uiSpec!.specId)!,
  };
}

describe('saved Forge restoration', () => {
  it('restores full history silently and accepts a new edit without generating setup again', async () => {
    const saved = await savedDevice();
    const fetch = mockFetch([reply(edit)]);
    const restored = createForge({ muse, fetchImpl: fetch.impl });
    const published = vi.fn();
    restored.subscribe(published);
    expect(restoreSavedForge(restored, saved)).toEqual(saved.uiSpec);
    expect(restored.snapshot!(saved.uiSpec.specId)?.revs).toHaveLength(2);
    expect(fetch.calls).toHaveLength(0);
    expect(published).not.toHaveBeenCalled();
    expect(restored.undo(saved.uiSpec.specId).ok).toBe(true);
    expect((await restored.edit({ specId: saved.uiSpec.specId, instruction: 'rename again' })).ok).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  it.each(['legacy', 'corrupt', 'different active interface'])('recovers %s context from the exact saved interface', async (kind) => {
    const saved = await savedDevice();
    const context = kind === 'legacy' ? undefined : kind === 'corrupt' ? { version: 999 } : { ...saved.forgeContext, cursor: 0 };
    const fetch = mockFetch([reply(edit)]);
    const restored = createForge({ muse, fetchImpl: fetch.impl });
    expect(restoreSavedForge(restored, { ...saved, forgeContext: context })).toEqual(saved.uiSpec);
    expect(restored.snapshot!(saved.uiSpec.specId)?.revs).toHaveLength(1);
    expect(fetch.calls).toHaveLength(0);
    expect((await restored.edit({ specId: saved.uiSpec.specId, instruction: 'rename again' })).ok).toBe(true);
  });

  it('isolates invalid records and forget removes only the selected editing context', async () => {
    const saved = await savedDevice();
    const fetch = mockFetch([]);
    const restored = createForge({ muse, fetchImpl: fetch.impl });
    expect(restoreSavedForge(restored, { ...saved, uiSpec: { specId: 'incomplete' } })).toBeUndefined();
    expect(restoreSavedForge(restored, saved)).toEqual(saved.uiSpec);
    expect(restored.forget!(saved.uiSpec.specId)).toBe(true);
    expect(restored.get(saved.uiSpec.specId)).toBeUndefined();
    expect(restored.target(saved.cardId)).toBeUndefined();
    expect(restored.snapshot!(saved.uiSpec.specId)).toBeUndefined();
    expect(fetch.calls).toHaveLength(0);
  });
});
