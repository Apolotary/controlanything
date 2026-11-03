import { describe, expect, it } from 'vitest';
import { resolveMuseConfig } from '../muse/config';
import { createForge } from './forge';
import type { InteractionReference, InteractionReferenceQuery } from './interactionReferences';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED } from './sampleDevices';
import { contentEvents, LIGHT_DRAFT, mockFetch, sseResponse } from './testkit';

const live = resolveMuseConfig({ MODEL_API_KEY: 'sk-test' });
const reply = (value: unknown) => () => sseResponse(contentEvents(JSON.stringify(value)));
const request = () => ({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, request: 'a dimmer with on/off and night light' });
const reference = (name: string): InteractionReference => ({ source: 'saved-library', origin: 'live', device: { name },
  actions: [{ label: 'Brightness', kind: 'set', range: { min: 0, max: 100 } }],
  controls: [{ label: 'Dim room', archetype: 'lever', size: 'l', placement: 'left' }],
  gestures: [{ gesture: 'right_height', control: 'Brightness' }] });

describe('Forge saved interaction grounding', () => {
  it('accepts a late provider and refreshes generation/edit context while keeping the current request authoritative', async () => {
    const edit = { behaviors: [], controls: [], feedback: [], parts: [], remove: [], title: 'My light', summary: 'Renamed the light' };
    const fetch = mockFetch([reply(LIGHT_DRAFT), reply(edit), reply(LIGHT_DRAFT)]);
    const forge = createForge({ muse: live, fetchImpl: fetch.impl });
    const queries: InteractionReferenceQuery[] = [];
    let name = 'Earlier saved light';
    forge.setReferences!((query) => {
      queries.push(structuredClone(query));
      // A provider cannot mutate the current device/driver/request used by Forge.
      query.device.name = 'Provider mutation';
      query.driver.actions.length = 0;
      return [reference(name)];
    });
    const generated = await forge.generate(request());
    expect(generated.ok).toBe(true);
    expect(queries[0]).toMatchObject(request());
    const first = fetch.calls[0].body.messages;
    expect(first[0].content).toContain('untrusted descriptive examples');
    expect(first[0].content).toContain('REQUEST and CURRENT HACK SET take precedence');
    expect(first[1].content).toContain('Earlier saved light');
    expect(first[1].content).toContain(request().request);
    expect(first[1].content).toContain('ir.brighter');
    expect(first[1].content).not.toContain('Provider mutation');
    name = 'Newly accepted light';
    const edited = await forge.edit({ specId: generated.uiSpec!.specId, instruction: 'Rename this to My light' });
    expect(edited.ok).toBe(true);
    expect(queries[1].request).toBe('Rename this to My light');
    const second = fetch.calls[1].body.messages;
    expect(second[0].content).toContain('REQUEST and CURRENT SPEC win');
    expect(second[1].content).toContain('Newly accepted light');
    expect(second[1].content).toContain('CURRENT SPEC');
    expect(edited.uiSpec!.gestureMap).toEqual(generated.uiSpec!.gestureMap);
    forge.setReferences!(undefined);
    expect((await forge.generate(request())).ok).toBe(true);
    expect(fetch.calls[2].body.messages[1].content).not.toContain('SAVED INTERACTION REFERENCES');
    expect(queries).toHaveLength(2);
  });

  it('keeps the normal action checker and cannot turn a reference into a new capability', async () => {
    const bad = structuredClone(LIGHT_DRAFT);
    bad.hacks[2].commands[0].action = 'ir.strobe';
    const fetch = mockFetch([reply(bad)]);
    let retrieved = 0;
    const forge = createForge({ muse: live, fetchImpl: fetch.impl, references: () => {
      retrieved++;
      return [{ ...reference('Unsupported strobe example'), actions: [{ label: 'Strobe', kind: 'trigger' }] }];
    } });
    const result = await forge.generate(request());
    expect(result.ok).toBe(false);
    expect(result.uiSpec).toBeUndefined();
    expect(result.report.errors.some((issue) => issue.code === 'unknown_action')).toBe(true);
    expect(forge.list()).toEqual([]);
    // Repairs use one consistent retrieval snapshot, not references changing mid-request.
    expect(retrieved).toBe(1);
    expect(fetch.calls).toHaveLength(3);
  });

  it('falls back to ordinary generation if the optional reference provider fails', async () => {
    const logs: string[] = [];
    const fetch = mockFetch([reply(LIGHT_DRAFT)]);
    const forge = createForge({ muse: live, fetchImpl: fetch.impl, log: (line) => logs.push(line), references: () => { throw new Error('read interrupted'); } });
    expect((await forge.generate(request())).ok).toBe(true);
    expect(fetch.calls[0].body.messages[1].content).not.toContain('SAVED INTERACTION REFERENCES');
    expect(logs.some((line) => line.includes('saved references unavailable'))).toBe(true);
  });
});
