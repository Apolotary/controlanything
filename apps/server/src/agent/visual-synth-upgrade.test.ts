import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySpec } from '@ce/gen3d';
import { Driver, type DeviceInfo, type UiSpecPayload } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import { visualSynthDraft } from '../devices/visualSynth';
import type { Forge } from '../gen3d/forge';
import { createAgent } from './index';
import { runLoop } from './loop';
import { TagStore } from './tags';
import { TargetStore } from './targets';
import { visualSynthCard } from './visual-synth';

// The rebuild boundary is mocked; persistence, restoration, permission checks and
// the completed-setup shortcut use the real agent. No model or device is invoked.
vi.mock('./loop', async (original) => ({ ...await original<typeof import('./loop')>(), runLoop: vi.fn(async () => {}) }));

const owner = { deviceId: 'quest', name: 'Quest' };
const mac: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'],
  online: true, canApprove: true, connections: 1, pairedAt: 1,
  ports: [{ id: 'ce-visual-synth', name: 'ControlAnything Visual Synth', kind: 'midi-out', state: 'connected' }] };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks(); vi.mocked(runLoop).mockClear();
});

function savedVisual(legacy: boolean, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-visual-upgrade-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'library.json'), library = new TagStore(file);
  const card = visualSynthCard(mac), draft = visualSynthDraft(card.cardId, []);
  const driver = Driver.parse({ ...draft, driverId: legacy ? 'old-four-actions' : 'current-five-actions',
    executor: { deviceId: mac.deviceId, port: 'ce-visual-synth' },
    actions: legacy ? draft.actions.filter((action) => action.actionId !== 'cc21') : draft.actions });
  const spec: UiSpecPayload = { specId: 'saved-visual-interface', cardId: card.cardId, driverId: driver.driverId,
    gen3d: { ...emptySpec('saved-visual-interface'), parts: [{ id: 'warp-lever', kind: 'archetype', archetype: 'lever', controlId: 'cc71' }], controls: driver.actions.map((action) => ({
      id: action.actionId, kind: action.kind === 'set' ? 'continuous' as const : 'trigger' as const,
      label: action.label, armed: true, binding: { action: action.actionId },
      ...(action.range ? { range: action.range } : {}),
    })) } };
  const target = new TargetStore({ broadcast: () => 0 }).create({ cardId: card.cardId, card, driver, specId: spec.specId,
    selection: { preferDeviceId: mac.deviceId }, state: 'armed', armed: true,
    verification: Object.fromEntries(driver.actions.map((action) => [action.actionId, 'pass' as const])) });
  library.add(target, 'Visual synth', { x: 0, y: 1.4, z: -1.2 });
  library.sync(target, spec);
  library.setEnabled(card.cardId, enabled);
  const version = library.library()[0].activeVersionId;
  return { dir, file, card, driver, spec, version };
}

function restored(saved: ReturnType<typeof savedVisual>) {
  const config = loadConfig({ CE_DATA_DIR: saved.dir, MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  const ctx = createContext(config, { registryFile: null, log: () => {} });
  vi.spyOn(ctx.hub, 'devices').mockReturnValue([mac]);
  const sent = vi.spyOn(ctx.hub, 'sendToDevice'), broadcast = vi.spyOn(ctx.hub, 'broadcast');
  const model = vi.spyOn(ctx.muse, 'chatJson');
  // Saved UiSpec is restored by the agent's real durable-library fallback.
  const forge = { get: () => undefined, list: () => [] } as unknown as Forge;
  const agent = createAgent(ctx, { macLocal: false, tagsFile: saved.file, forge: () => forge });
  let closed = false;
  const close = () => { if (!closed) { closed = true; agent.close(); ctx.hub.close(); } };
  cleanups.push(close);
  return { agent, sent, broadcast, model, close, target: agent.targets.get(saved.card.cardId)! };
}

describe('saved visual synth capability upgrade', () => {
  it('disarms the legacy saved driver on restart while retaining its exact interface and version history', () => {
    const saved = savedVisual(true), h = restored(saved);
    expect(h.target).toMatchObject({ state: 'identified', armed: false, driver: saved.driver, specId: saved.spec.specId,
      sentence: 'Visual controls update available', action: 'retry' });
    expect(h.agent.tagsState().tags[0]).toMatchObject({ connection: 'setup', hint: expect.stringContaining('Water ripples') });
    expect(h.agent.libraryState().devices[0]).toMatchObject({ enabled: false, activeVersionId: saved.version });
    h.agent.setMode('control');
    const attempted = h.agent.control.onControlEvent({ specId: saved.spec.specId, widgetId: 'cc71', value: 80, phase: 'end', ts: 1 }, owner.deviceId);
    expect(attempted.fired).toBe(0);
    expect(h.sent.mock.calls.some(([, type]) => type === 'exec.command')).toBe(false);
    expect(h.broadcast.mock.calls.some(([type]) => type === 'arm.request')).toBe(false);
    expect(runLoop).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled();
    const durable = new TagStore(saved.file);
    expect(durable.get(saved.card.cardId)).toMatchObject({ armed: false, driver: saved.driver, uiSpec: saved.spec });
    expect(durable.library()[0].versions).toHaveLength(1);
    h.close();
    expect(restored(saved).target.armed).toBe(false); // The disarm survives another restart.
  });

  it('explicit setup rebuilds an old completed driver instead of merely asking to re-enable four old actions', async () => {
    const saved = savedVisual(true), h = restored(saved); h.agent.setMode('control');
    h.agent.setup(saved.card.cardId, owner);
    expect(runLoop).toHaveBeenCalledExactlyOnceWith(expect.anything(), h.target, expect.objectContaining({ preferDeviceId: mac.deviceId }));
    expect(h.target).toMatchObject({ armed: false, verification: {}, evidence: [] });
    expect(h.target.driver).toBeUndefined(); expect(h.target.specId).toBeUndefined();
    expect(h.broadcast.mock.calls.some(([type]) => type === 'arm.request')).toBe(false);
    expect(h.sent.mock.calls.some(([, type]) => type === 'exec.command')).toBe(false);
    await Promise.resolve();
    // A failed/empty rebuild still leaves the historical setup disabled.
    expect(new TagStore(saved.file).get(saved.card.cardId)?.armed).toBe(false);
    expect(new TagStore(saved.file).library()[0].versions).toHaveLength(1);
  });

  it('reuses a current five-action enabled setup without rebuilding or asking to enable again', () => {
    const saved = savedVisual(false), h = restored(saved); h.agent.setMode('control');
    expect(h.target).toMatchObject({ armed: true, driver: saved.driver, specId: saved.spec.specId });
    expect(h.agent.tagsState().tags[0].connection).toBe('ready');
    h.agent.setup(saved.card.cardId, owner);
    expect(runLoop).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled();
    expect(h.broadcast.mock.calls.some(([type]) => type === 'arm.request')).toBe(false);
    expect(h.sent.mock.calls.some(([, type]) => type === 'ui.spec')).toBe(true);
    expect(h.sent.mock.calls.some(([, type]) => type === 'exec.command')).toBe(false);
  });

  it('reuses a current disabled setup but preserves the explicit Enable confirmation', () => {
    const saved = savedVisual(false, false), h = restored(saved); h.agent.setMode('control');
    h.agent.setup(saved.card.cardId, owner);
    expect(runLoop).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled();
    expect(h.target.armed).toBe(false); expect(h.target.driver).toEqual(saved.driver);
    const requests = h.broadcast.mock.calls.filter(([type]) => type === 'arm.request');
    expect(requests).toHaveLength(1);
    expect(requests[0][1]).toMatchObject({ specId: saved.spec.specId, driverId: saved.driver.driverId,
      actions: expect.arrayContaining([expect.objectContaining({ actionId: 'cc21', verified: 'pass' })]) });
    expect(h.sent.mock.calls.some(([, type]) => type === 'exec.command')).toBe(false);
  });
});
