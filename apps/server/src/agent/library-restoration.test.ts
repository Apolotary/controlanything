import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Driver, type DeviceCardPayload, type DeviceInfo, type Evidence, type MessageType, type PayloadOf } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import { createForge, FORGE_KIT } from '../gen3d/forge';
import { useForge } from '../gen3d/routes';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED } from '../gen3d/sampleDevices';
import { SkinStore, type SkinResult } from '../gen3d/skin';
import { LIGHT_DRAFT } from '../gen3d/testkit';
import { ReplayTransport, type RecordedRun } from '../gen3d/transport';
import { createAgent } from './index';

const owner = { deviceId: 'quest', name: 'Quest' };
const card: DeviceCardPayload = { ...FORGE_LIGHT_DEVICE, maker: 'KOIZUMI', model: 'KRH-TG-9A', category: 'lighting', protocols: ['ir'], requires: ['ir'], confidence: 1, evidence: ['White shade and remote label'] };
const driver = Driver.parse({ ...FORGE_LIGHT_DRIVER, provenance: [{ source: 'learned', ref: 'remote-capture' }], actions: FORGE_LIGHT_DRIVER.actions.map((action, index) => ({ ...action, encode: { kind: 'ir', protocol: 'NEC', bytes: [index, 1, 2, 3] } })) });
const bridge: DeviceInfo = { deviceId: driver.executor.deviceId, name: 'IR bridge', kind: 'cardputer', role: 'device', capabilities: ['ir'], canApprove: false, online: true, connections: 1, pairedAt: 1 };
const evidence: Evidence = {
  evidenceId: 'evidence-off', cardId: card.cardId, driverId: driver.driverId, actionId: 'ir.off', execId: 'verified-off', attempt: 1,
  sent: { op: { kind: 'ir', protocol: 'NEC', bytes: [1, 1, 2, 3] }, at: 10 },
  expected: { sense: 'camera', effect: 'off' },
  observed: { sense: 'camera', metric: 'luma-mask-vs-ring', before: 0.9, after: 0.1, delta: -0.8, threshold: 0.2, sensorDeviceId: owner.deviceId, note: 'The selected lamp went dark' }, pass: true,
};
const edit = {
  behaviors: [], controls: [], feedback: [], remove: [], summary: 'A larger dimmer', title: '',
  parts: [{ id: 'p_h_dim', kind: 'archetype', archetype: 'lever', controlId: 'h_dim', params: { length: 0.22 }, transform: { position: [-0.1, 0, 0] } }],
};
const recordings: RecordedRun[] = (['generate', 'edit'] as const).map((task) => ({
  kind: 'gen3d-run', kit: FORGE_KIT, task, cardId: card.cardId, request: task === 'generate' ? 'Simple light controls' : 'Make the dimmer larger',
  mode: 'json', category: 'lighting', transport: 'ir', recordedAt: '2026-11-01T00:00:00Z', ok: true,
  calls: [{ label: `gen3d.${task}`, model: 'muse-spark-1.3', text: JSON.stringify(task === 'generate' ? LIGHT_DRAFT : edit), latencyMs: 0 }],
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});
function digest(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Real agent/Forge wiring with fixture model replies and an in-memory executor transport. */
function server(dataDir: string, initialDevices: DeviceInfo[] = []) {
  const config = loadConfig({ CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  const ctx = createContext(config, { registryFile: null, log: () => {} });
  let devices = initialDevices;
  vi.spyOn(ctx.hub, 'devices').mockImplementation(() => devices);
  const broadcasts = vi.spyOn(ctx.hub, 'broadcast');
  const commands: PayloadOf<'exec.command'>[] = [];
  const send = vi.spyOn(ctx.hub, 'sendToDevice').mockImplementation((_device, type, payload) => {
    if (type === 'exec.command') commands.push(payload as PayloadOf<'exec.command'>);
    return 1;
  });
  const presence = vi.spyOn(ctx.hub, 'onPresence');
  const model = vi.spyOn(ctx.muse, 'chatJson');
  const transport = new ReplayTransport(recordings, { speed: 0 });
  const sessions = vi.spyOn(transport, 'session');
  const skins = new SkinStore(64, join(dataDir, 'library/assets'));
  let finishSkin: ((result: SkinResult) => void) | undefined;
  const paint = vi.fn(() => new Promise<SkinResult>((resolve) => { finishSkin = resolve; }));
  const forge = createForge({ muse: config.muse, transport, callLog: ctx.calls, skinStore: skins, skinPainter: { source: 'fixture', paint } });
  useForge(ctx, forge);
  const agent = createAgent(ctx, { macLocal: false });
  let closed = false;
  const close = () => { if (!closed) { closed = true; agent.close(); ctx.hub.close(); } };
  cleanups.push(close);
  const online = (next: DeviceInfo[]) => {
    devices = next;
    for (const [listener] of presence.mock.calls) listener({ spaceId: ctx.registry.spaceId, devices, reason: 'update', deviceId: bridge.deviceId });
  };
  const of = <T extends MessageType>(type: T) => broadcasts.mock.calls.filter(([sentType]) => sentType === type).map(([, payload]) => payload as PayloadOf<T>);
  const completeSkin = async (specId: string, bytes: Uint8Array) => {
    const skinId = skins.put(bytes);
    expect(finishSkin).toBeDefined();
    finishSkin!({ ok: true, skinId, url: `/api/skins/${skinId}.webp`, width: 1600, height: 600, bytes: bytes.length, mode: 'edit', model: 'fixture', source: 'fixture', recordedFrom: 'muse-image-1.0', latencyMs: 5 });
    await forge.whenSkin?.(specId);
    return skinId;
  };
  return { ctx, agent, forge, commands, send, model, sessions, paint, online, of, completeSkin, close };
}

describe('complete saved device restoration', () => {
  it('retains a late skin for a hidden device without publishing its controls', async () => {
    const dataDir = mkdtempSync(join(process.cwd(), '.restoration-test-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = server(dataDir, [bridge]);
    const target = first.agent.targets.create({ cardId: card.cardId, card, driver, verification: FORGE_LIGHT_VERIFIED, state: 'verified' });
    first.agent.addTag({ targetId: target.cardId, label: card.name }, owner);
    const generated = await first.forge.generate({ device: card, driver, verification: target.verification });
    target.specId = generated.uiSpec!.specId;
    target.armed = true;
    first.agent.targets.setState(target, 'armed');
    first.agent.setMode('control');
    expect(first.agent.removeTag(target.cardId)).toBe(true);
    const published = first.of('ui.spec').length;
    const skinId = await first.completeSkin(target.specId, Buffer.from('hidden device skin'));
    expect(first.of('ui.spec')).toHaveLength(published);
    expect(first.agent.libraryState().devices[0]).toMatchObject({ hidden: true, enabled: false });
    const expected = structuredClone(first.forge.get(target.specId));
    first.close();
    const restored = server(dataDir, [bridge]);
    expect(restored.agent.tagsState().tags).toEqual([]);
    expect(restored.forge.get(target.specId)).toEqual(expected);
    expect(restored.forge.skins!.get(skinId)?.bytes).toEqual(Buffer.from('hidden device skin'));
    expect(restored.of('ui.spec')).toEqual([]);
    expect(restored.commands).toEqual([]);
    expect(restored.ctx.calls.list()).toEqual([]);
  });

  it('isolates a damaged crop reference while restoring every saved device', async () => {
    const dataDir = mkdtempSync(join(process.cwd(), '.restoration-test-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = server(dataDir, [bridge]);
    for (const id of [card.cardId, 'second-light']) {
      const deviceCard = { ...card, cardId: id };
      const deviceDriver = { ...driver, cardId: id, driverId: `driver-${id}` };
      const target = first.agent.targets.create({ cardId: id, card: deviceCard, driver: deviceDriver, verification: FORGE_LIGHT_VERIFIED, state: 'verified' });
      first.agent.addTag({ targetId: id, label: card.name }, owner);
      const generated = await first.forge.generate({ device: deviceCard, driver: deviceDriver, verification: target.verification, crop: { jpegBase64: Buffer.from(`${id} crop`).toString('base64') } });
      expect(generated.ok).toBe(true);
      target.specId = generated.uiSpec!.specId;
      target.armed = true;
      first.agent.targets.setState(target, 'armed');
    }
    first.close();
    const path = join(dataDir, 'library.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const affected = saved.records[0];
    affected.versions.find((version: { versionId: string }) => version.versionId === affected.activeVersionId).forgeContext.crop.jpegBase64.$libraryAsset = { hash: 'invalid' };
    writeFileSync(path, JSON.stringify(saved));
    const restored = server(dataDir, [bridge]);
    expect(restored.agent.tagsState().tags).toHaveLength(2);
    expect(restored.agent.tagsState().tags.every((tag) => tag.connection === 'ready')).toBe(true);
    expect(restored.forge.snapshot!(restored.forge.specIdFor(card.cardId))?.crop).toBeUndefined();
    expect(restored.forge.snapshot!(restored.forge.specIdFor('second-light'))?.crop?.jpegBase64).toBe(Buffer.from('second-light crop').toString('base64'));
    expect(restored.commands).toEqual([]);
    expect(restored.ctx.calls.list()).toEqual([]);
  });

  it('restores edited controls, a late skin, evidence, learned IR and acknowledged values without setup or model calls', async () => {
    const dataDir = mkdtempSync(join(process.cwd(), '.restoration-test-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = server(dataDir, [bridge]);
    const target = first.agent.targets.create({ cardId: card.cardId, card, driver, verification: FORGE_LIGHT_VERIFIED, evidence: [evidence], state: 'verified' });
    target.research = { brief: 'Original remote captures retained for future changes', provenance: [{ source: 'learned', ref: 'remote-capture' }], learned: [{ learnId: 'remote-capture', button: 'Off', hypothesis: 'off', rawUs: [9000, 4500, 560, 560], capturedAt: 10 }] };
    first.agent.addTag({ targetId: target.cardId, label: card.name }, owner);
    first.agent.place(target.cardId, { headsetId: owner.deviceId, origin: 'https://room.example', handle: 'room-anchor', panelOffset: { x: 0, y: 0.12, z: 0 }, fallback: { label: card.name }, updatedAt: 10 });
    const crop = { jpegBase64: Buffer.from('retained device crop').toString('base64'), width: 8, height: 8 };
    const generated = await first.forge.generate({ device: card, driver, verification: target.verification, request: 'Simple light controls', crop });
    expect(generated.ok).toBe(true);
    target.specId = generated.uiSpec!.specId;
    target.armed = true;
    target.paramValues.p_lvl = 70;
    first.agent.targets.setState(target, 'armed');
    const originalVersion = first.agent.libraryState().devices[0].activeVersionId!;
    const edited = await first.forge.edit({ specId: target.specId, instruction: 'Make the dimmer larger' });
    expect(edited.ok).toBe(true);
    const skinBytes = Buffer.from('retained webp skin bytes');
    const skinId = await first.completeSkin(target.specId, skinBytes);
    const expectedSpec = structuredClone(first.forge.get(target.specId)!);
    const expectedHash = digest(expectedSpec);
    expect(expectedSpec.gen3d.skin?.url).toContain(skinId);
    expect(expectedSpec.gen3d.parts.find((part) => part.id === 'p_h_dim')?.archetype).toBe('lever');

    first.agent.setMode('control');
    const command = first.agent.control.onControlEvent({ specId: target.specId, widgetId: 'h_dim', value: 80, phase: 'end', ts: 1 }, owner.deviceId);
    expect(command.fired).toBe(1);
    expect(target.paramValues.p_lvl).toBe(70);
    expect(first.agent.libraryState().devices[0].lastKnownState?.paramValues.p_lvl).toBe(70);
    first.agent.dispatcher.onAck({ execId: first.commands[0].execId, ok: true, sentAt: 20 });
    expect(target.paramValues.p_lvl).toBe(80);
    expect(first.agent.libraryState().devices[0].lastKnownState?.paramValues.p_lvl).toBe(80);
    expect(first.agent.libraryState().devices[0].versions.length).toBeGreaterThan(2);
    expect(readFileSync(join(dataDir, 'library.json'), 'utf8')).not.toContain(crop.jpegBase64);
    first.close();

    const restored = server(dataDir);
    const saved = restored.agent.targets.get(card.cardId)!;
    expect(restored.agent.mode()).toBe('annotate');
    expect(restored.agent.tagsState().tags[0].connection).toBe('offline');
    expect(saved).toMatchObject({ armed: true, driver, evidence: [evidence], research: target.research, paramValues: { p_lvl: 80 } });
    expect(digest(restored.forge.get(target.specId))).toBe(expectedHash);
    expect(restored.forge.snapshot!(target.specId)?.crop).toEqual(crop);
    expect(restored.forge.skins!.get(skinId)?.bytes).toEqual(skinBytes);
    expect(restored.agent.libraryState().devices[0].placement?.handle).toBe('room-anchor');
    expect(restored.ctx.calls.list()).toEqual([]);
    expect(restored.sessions).not.toHaveBeenCalled();
    expect(restored.model).not.toHaveBeenCalled();
    expect(restored.paint).not.toHaveBeenCalled();
    expect(restored.commands).toEqual([]);

    restored.online([bridge]);
    expect(restored.agent.tagsState().tags[0].connection).toBe('ready');
    restored.agent.setMode('control');
    expect(restored.of('ui.spec').find((spec) => spec.specId === target.specId)).toEqual(expectedSpec);
    expect(restored.of('verify.result')).toEqual(expect.arrayContaining([evidence]));
    expect(restored.commands).toEqual([]);
    expect(restored.ctx.calls.list()).toEqual([]);
    const undo = restored.forge.undo(target.specId);
    expect(undo.ok).toBe(true);
    expect(restored.sessions).not.toHaveBeenCalled();
    expect(restored.forge.redo(target.specId).ok).toBe(true);
    const nextEdit = await restored.forge.edit({ specId: target.specId, instruction: 'Make the dimmer larger' });
    expect(nextEdit.ok).toBe(true);
    expect(nextEdit.uiSpec!.rev).toBeGreaterThan(expectedSpec.rev);
    expect(restored.sessions).toHaveBeenCalledTimes(1);
    expect(restored.commands).toEqual([]);

    restored.agent.panic('Disable saved controls', target.cardId);
    expect(restored.agent.restoreVersion(target.cardId, originalVersion)).toBe(true);
    expect(restored.agent.targets.get(target.cardId)).toMatchObject({ armed: false, evidence: [evidence], paramValues: { p_lvl: 80 } });
    expect(restored.forge.get(target.specId)?.gen3d.parts.find((part) => part.id === 'p_h_dim')?.archetype).toBe(generated.uiSpec!.gen3d.parts.find((part) => part.id === 'p_h_dim')?.archetype);
    expect(restored.commands).toEqual([]);
    restored.close();
    const disabled = server(dataDir, [bridge]);
    expect(disabled.agent.tagsState().tags[0].connection).toBe('setup');
    expect(disabled.agent.targets.get(target.cardId)?.armed).toBe(false);
    expect(disabled.commands).toEqual([]);
    expect(disabled.ctx.calls.list()).toEqual([]);
  });
});
