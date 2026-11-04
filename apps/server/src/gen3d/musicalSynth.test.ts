import { PayloadSchemas } from '@ce/protocol';
import { expect, it } from 'vitest';
import { musicalSynthDraft } from '../devices/musicalSynth';
import { resolveMuseConfig } from '../muse/config';
import { createForge } from './forge';
import { RECORDED_GEN3D_DIR } from './routes';
import { MUSICAL_SYNTH_FIXTURE } from './musicalSynth';

it('fixture musical catalog uses the actual driver rather than replaying unrelated visual controls', async () => {
  const driver = { ...musicalSynthDraft('musical-synth-mac', []), driverId: 'music-driver', executor: { deviceId: 'mac', port: 'ce-musical-synth' } };
  const forge = createForge({ muse: resolveMuseConfig({ MODEL_MODE: 'fixture' }), replayDir: RECORDED_GEN3D_DIR, replaySpeed: 0 });
  const result = await forge.generate({ device: { cardId: driver.cardId, name: 'ControlAnything Synth', category: 'synthesizer' }, driver,
    verification: Object.fromEntries(driver.actions.map(a => [a.actionId, a.actionId === 'cc71' ? 'fail' : 'pass'])) });
  expect(result.ok, JSON.stringify(result.report.errors)).toBe(true);
  expect(result).toMatchObject({ source: 'fixture', model: MUSICAL_SYNTH_FIXTURE, costUsd: 0 });
  expect(result.recordedFrom).toBeUndefined(); expect(result.report.attempts).toBe(1);
  expect(PayloadSchemas['ui.spec'].safeParse(result.uiSpec).success).toBe(true);
  expect(result.uiSpec!.gen3d.controls.map(c => c.binding.action)).toEqual(['cc16', 'cc17', 'cc74', 'cc71', 'preset0', 'preset1', 'preset2']);
  expect(result.uiSpec!.gen3d.controls.find(c => c.binding.action === 'cc16')?.range).toEqual({ min: 0, max: 14, step: 1 });
  expect(result.uiSpec!.gen3d.controls.find(c => c.binding.action === 'cc71')?.armed).toBe(false);
  expect(result.uiSpec!.hackset.hacks.every(h => h.oracle.type === 'wire')).toBe(true);
});
