import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptySpec } from '@ce/gen3d';
import type { DeviceCardPayload, DeviceInfo, UiSpecPayload } from '@ce/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import { MidiChartStore, type MidiChartInput } from '../devices/midi-charts';
import { validateDriver } from '../devices/validate';
import { templateMidiDraft } from './drive';
import { createAgent } from './index';
import { TagStore } from './tags';
import { TargetStore } from './targets';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

it('never restores or enables a saved MIDI CC removed by a later reviewed chart, including after restart', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'midi-chart-restore-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const card: DeviceCardPayload = { cardId: 'orion', name: 'Orion 6', maker: 'Example', model: 'Orion 6', category: 'synthesizer', confidence: 1, protocols: ['midi'], requires: ['midi'], evidence: [] };
  const chart: MidiChartInput = { maker: card.maker, model: card.model, channel: 3,
    source: { title: 'Orion manual', url: 'https://example.com/orion/manual', section: 'Page 42' }, parameters: [{ cc: 74, name: 'Cutoff', min: 20, max: 100 }] };
  const charts = new MidiChartStore(join(dataDir, 'reviewed-midi-charts.json'));
  charts.review(card, chart, 0, 'Owner');
  const profile = charts.profile(card)!;
  const research = { brief: 'Reviewed chart', provenance: [], profile, allowedCcs: new Set([74]) };
  const driver = validateDriver(templateMidiDraft(card, profile, research), { driverId: 'orion-driver', executor: { deviceId: 'mac', port: 'orion-out' } }, { allowedCcs: research.allowedCcs }).driver;
  const actionId = driver.actions[0].actionId;
  const spec: UiSpecPayload = { specId: 'orion-ui', cardId: card.cardId, driverId: driver.driverId,
    gen3d: { ...emptySpec('orion-ui'),
      parts: [{ id: 'cutoff-part', kind: 'archetype', archetype: 'lever', controlId: actionId }],
      controls: [{ id: actionId, kind: 'continuous', label: 'Cutoff', binding: { action: actionId }, range: { min: 20, max: 100 }, armed: true }] } };
  const target = new TargetStore({ broadcast: () => 0 }).create({ cardId: card.cardId, card, driver, research, specId: spec.specId, armed: true, state: 'armed', verification: { [actionId]: 'pass' } });
  const tags = new TagStore(join(dataDir, 'library.json'));
  tags.add(target, card.name); tags.sync(target, spec);
  const versionId = tags.library()[0].activeVersionId!;
  const companion: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'], canApprove: true, online: true, connections: 1, pairedAt: 1, ports: [{ id: 'orion-out', name: 'Orion', kind: 'midi-out', state: 'connected' }] };
  const config = loadConfig({ CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  const ctx = createContext(config, { registryFile: null, log: () => {} });
  vi.spyOn(ctx.hub, 'devices').mockReturnValue([companion]);
  const send = vi.spyOn(ctx.hub, 'sendToDevice').mockReturnValue(1);
  const first = createAgent(ctx, { macLocal: false, forge: () => undefined });
  expect(first.targets.get(card.cardId)?.driver).toEqual(driver);
  first.midiCharts.review(card, { ...chart, parameters: [{ cc: 71, name: 'Resonance', min: 30, max: 90 }] }, 1, 'Owner');
  first.invalidateMidiChart(card.cardId);
  expect(first.targets.get(card.cardId)).toMatchObject({ armed: false, verification: {} });
  expect(first.targets.get(card.cardId)?.driver).toBeUndefined();
  first.close();
  const restored = createAgent(ctx, { macLocal: false, forge: () => undefined });
  cleanups.push(() => { restored.close(); ctx.hub.close(); });
  restored.setMode('control');
  expect(restored.targets.get(card.cardId)?.driver).toBeUndefined();
  expect(restored.restoreVersion(card.cardId, versionId)).toBe(true); // History remains inspectable.
  expect(restored.targets.get(card.cardId)).toMatchObject({ armed: false, verification: {} });
  expect(restored.targets.get(card.cardId)?.driver).toBeUndefined();
  expect(restored.libraryState().devices[0].enabled).toBe(false);
  expect(restored.control.onControlEvent({ specId: spec.specId, widgetId: actionId, value: 100, phase: 'end', ts: 1 }, 'quest').ok).toBe(false);
  expect(send.mock.calls.some(([, type]) => type === 'exec.command')).toBe(false);
  expect(ctx.calls.list()).toEqual([]);
});
