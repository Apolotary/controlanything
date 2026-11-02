import { PayloadSchemas } from '@ce/protocol';
import { describe, expect, it } from 'vitest';
import { resolveMuseConfig } from '../muse/config';
import { createForge } from './forge';
import { forgeMessages } from './forgePrompt';
import { draftIssues } from './forgeVerify';
import type { ForgeDriver } from './forgeTypes';
import { isVisualSynth, VISUAL_SYNTH_FIXTURE, visualSynthDraft } from './visualSynth';

const device = { cardId: 'visual', name: 'ControlAnything Visual Synth', category: 'synthesizer' };
const driver: ForgeDriver = {
  driverId: 'drv_visual', cardId: device.cardId, name: device.name, transport: 'midi',
  actions: [
    { actionId: 'cc71', label: 'Warp', kind: 'set', range: { min: 0, max: 127, step: 1 }, expect: { sense: 'camera', effect: 'any' }, encode: { kind: 'midi', msg: 'cc', number: 71 } },
    ...[0, 1, 2].map((number) => ({ actionId: `pattern${number}`, label: `Pattern ${number}`, kind: 'trigger' as const,
      expect: { sense: 'camera' as const, effect: 'any' }, encode: { kind: 'midi', msg: 'pc', number } })),
  ],
};
const verification = Object.fromEntries(driver.actions.map((action) => [action.actionId, 'pass' as const]));

describe('silent visual synth forge', () => {
  it('compiles one Warp control and three camera-verified pattern buttons without claiming a recording', async () => {
    const forge = createForge({ muse: resolveMuseConfig({ MODEL_MODE: 'fixture' }) });
    const result = await forge.generate({ device, driver, verification });
    expect(result.ok, JSON.stringify(result.report.errors)).toBe(true);
    expect(result).toMatchObject({ source: 'fixture', model: VISUAL_SYNTH_FIXTURE, costUsd: 0 });
    expect(result.recordedFrom).toBeUndefined();
    expect(result.uiSpec?.recordedFrom).toBeUndefined();
    expect(PayloadSchemas['ui.spec'].safeParse(result.uiSpec).success).toBe(true);
    expect(result.uiSpec!.gen3d.controls.map((control) => [control.kind, control.binding.action, control.armed])).toEqual([
      ['continuous', 'cc71', true], ['trigger', 'pattern0', true], ['trigger', 'pattern1', true], ['trigger', 'pattern2', true],
    ]);
    expect(result.uiSpec!.gen3d.controls[0].range).toEqual({ min: 0, max: 127, step: 1 });
    expect(result.uiSpec!.hackset.hacks.every((hack) => hack.oracle.type === 'camera')).toBe(true);
  });

  it('keeps failed pattern actions disabled', async () => {
    const forge = createForge({ muse: resolveMuseConfig({ MODEL_MODE: 'fixture' }) });
    const result = await forge.generate({ device, driver, verification: { ...verification, pattern2: 'fail' } });
    expect(result.ok).toBe(true);
    expect(result.uiSpec!.gen3d.controls.find((control) => control.binding.action === 'pattern2')?.armed).toBe(false);
  });

  it('bounds live generation and rejects an audio oracle even when the driver effect is any', () => {
    const draft = visualSynthDraft(driver);
    expect(draftIssues(draft, driver)).toEqual([]);
    draft.hacks[0].oracle.type = 'mic';
    expect(draftIssues(draft, driver).some((issue) => issue.code === 'visual_synth_camera')).toBe(true);
    const secondControl = structuredClone(draft.hacks[0]);
    secondControl.id = 'h_warp2';
    draft.hacks.push(secondControl);
    expect(draftIssues(draft, driver).some((issue) => issue.code === 'visual_synth_card')).toBe(true);
    const messages = forgeMessages({ device, driver, verification, request: 'Build controls' });
    expect(messages[1].content).toContain('exactly one main control called Warp');
    expect(isVisualSynth({ ...driver, name: 'Another synth' })).toBe(false);
  });
});
