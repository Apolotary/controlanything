import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, PayloadOf, UiSpecPayload } from '@ce/protocol';
import { emptySpec } from '@ce/gen3d';
import { loadConfig } from '../config';
import { createContext } from '../context';
import type { Forge } from '../gen3d/forge';
import { createAgent } from './index';
import { tryLink } from './link';
import { runLoop } from './loop';
import { visualSynthCard, visualSynthCompanions } from './visual-synth';
import { loadProfiles } from '../devices/profiles';
import type { Dispatcher } from './dispatch';
import { visualSynthDraft } from '../devices/visualSynth';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagStore } from './tags';
import { TargetStore } from './targets';

vi.mock('./loop', async (original) => ({ ...await original<typeof import('./loop')>(), runLoop: vi.fn(async () => {}) }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.mocked(runLoop).mockClear(); });
const companion = (deviceId = 'mac'): DeviceInfo => ({ deviceId, name: 'My Mac', kind: 'mac', role: 'companion', online: true,
  canApprove: true, connections: 1, pairedAt: 1, capabilities: ['midi'], ports: [
    { id: 'ce-visual-synth', name: 'ControlAnything Visual Synth', kind: 'midi-out', state: 'connected' },
    { id: 'physical-op1', name: 'OP-1', kind: 'midi-out', state: 'connected' },
  ] });
function setup(devices: DeviceInfo[] = [companion()], tagsFile: string | null = null) {
  const config = loadConfig({ MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  const ctx = createContext(config, { log: () => {}, registryFile: null });
  vi.spyOn(ctx.hub, 'devices').mockReturnValue(devices);
  const sent = vi.spyOn(ctx.hub, 'sendToDevice'); const broadcast = vi.spyOn(ctx.hub, 'broadcast');
  const specs = new Map<string, UiSpecPayload>();
  const forge = { get: (id: string) => specs.get(id), list: () => [...specs.values()] } as unknown as Forge;
  const agent = createAgent(ctx, { macLocal: false, tagsFile, forge: () => forge });
  const exec = vi.spyOn(agent.dispatcher, 'exec');
  cleanups.push(() => { agent.close(); ctx.hub.close(); });
  const select = (extra: Partial<PayloadOf<'target.select'>> = {}) => agent.select({ virtual: 'visual-synth', requestId: 'request', ...extra }, { deviceId: 'quest', name: 'Quest' });
  return { agent, ctx, sent, broadcast, exec, select, specs };
}

function savedVisuals(entries: { owner: string; preferred?: string; hidden?: boolean }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-visual-owner-')), file = join(dir, 'library.json');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const library = new TagStore(file);
  for (const entry of entries) {
    const card = visualSynthCard(companion(entry.owner));
    const target = new TargetStore({ broadcast: () => 0 }).create({ cardId: card.cardId, card,
      selection: { preferDeviceId: entry.preferred ?? entry.owner } });
    library.add(target, 'Visual synth');
    if (entry.hidden) library.remove(card.cardId);
  }
  return file;
}

describe('explicit virtual instrument selection', () => {
  it('opens a closed renderer only on the exact companion and waits for real presence before selecting', () => {
    const mac = companion(); mac.ports![0]!.state = 'disconnected';
    const h = setup([mac]); h.agent.setMode('control');
    expect(h.select()).toBeUndefined();
    expect(h.sent).toHaveBeenCalledWith('mac', 'visual.open', { requestId: 'request' });
    expect(h.sent).toHaveBeenLastCalledWith('quest', 'target.select.result', expect.objectContaining({ ok: false, reason: expect.stringContaining('continue automatically') }));
    expect(h.agent.tagsState().tags).toEqual([]); expect(h.exec).not.toHaveBeenCalled();
    mac.ports![0]!.state = 'connected';
    expect(h.select()?.card?.notes).toBe('virtual:visual-synth:mac');
    expect(runLoop).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });

  it('does not auto-open ambiguous, offline or differently named physical ports', () => {
    const one = companion('one'), two = companion('two');
    one.ports![0]!.state = two.ports![0]!.state = 'disconnected';
    const h = setup([one, two]); h.agent.setMode('control'); h.select();
    expect(h.sent.mock.calls.some((call) => call[1] === 'visual.open')).toBe(false);
    h.select({ deviceId: 'two' });
    expect(h.sent).toHaveBeenCalledWith('two', 'visual.open', { requestId: 'request' });
    h.sent.mockClear(); two.online = false; h.select({ deviceId: 'two' });
    expect(h.sent.mock.calls.some((call) => call[1] === 'visual.open')).toBe(false);
  });

  it('reopens the requester’s previously selected screen rather than another idle companion', () => {
    const one = companion('one'), two = companion('two');
    const h = setup([one, two]); h.agent.setMode('control');
    h.select({ deviceId: 'two' });
    one.ports![0]!.state = two.ports![0]!.state = 'disconnected'; h.sent.mockClear();
    h.select();
    expect(h.sent).toHaveBeenCalledWith('two', 'visual.open', { requestId: 'request' });
    expect(h.sent).not.toHaveBeenCalledWith('one', 'visual.open', expect.anything());
  });

  it('recovers the exact unique saved visual owner after restart when two companions are idle', () => {
    const one = companion('one'), two = companion('two');
    one.ports![0]!.state = two.ports![0]!.state = 'disconnected';
    const h = setup([one, two], savedVisuals([{ owner: 'two' }])); h.agent.setMode('control');
    expect(h.agent.targets.list()[0].selectedBy).toBeUndefined(); // Not persisted; recovery must use the saved binding.
    h.select();
    expect(h.sent).toHaveBeenCalledWith('two', 'visual.open', { requestId: 'request' });
    expect(h.sent).not.toHaveBeenCalledWith('one', 'visual.open', expect.anything());
    expect(runLoop).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['hidden', [{ owner: 'two', hidden: true }]],
    ['mismatched preference', [{ owner: 'two', preferred: 'one' }]],
    ['multiple saved owners', [{ owner: 'one' }, { owner: 'two' }]],
    ['unavailable saved owner', [{ owner: 'absent' }]],
  ] as const)('does not choose arbitrarily for %s when multiple companions are idle', (_label, entries) => {
    const one = companion('one'), two = companion('two');
    one.ports![0]!.state = two.ports![0]!.state = 'disconnected';
    const h = setup([one, two], savedVisuals([...entries])); h.agent.setMode('control'); h.select();
    expect(h.sent.mock.calls.some(([, type]) => type === 'visual.open')).toBe(false);
    expect(h.sent).toHaveBeenLastCalledWith('quest', 'target.select.result', expect.objectContaining({ ok: false, reason: expect.stringContaining('More than one') }));
    expect(runLoop).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });
  it('creates a distinct known virtual tag, replies to the requester, and waits for explicit setup', async () => {
    const h = setup(); h.agent.setMode('control');
    const point = { x: 0, y: 1.3, z: -1.4 };
    const target = h.select({ position: point })!;
    expect(target.card).toMatchObject({ name: 'ControlAnything Visual Synth', category: 'synthesizer', requires: ['midi'], notes: 'virtual:visual-synth:mac' });
    expect(target.card!.evidence.join(' ')).toContain('not an object detection');
    expect(target.detection).toBeUndefined(); expect(target.armed).toBe(false);
    expect(target.selection?.preferDeviceId).toBe('mac'); expect(target.selectedBy).toBe('quest');
    expect(h.agent.tagsState().tags).toEqual([expect.objectContaining({ cardId: target.cardId, label: 'Visual synth', position: point, connection: 'setup' })]);
    expect(h.sent).toHaveBeenLastCalledWith('quest', 'target.select.result', expect.objectContaining({ requestId: 'request', ok: true, cardId: target.cardId }));
    expect(runLoop).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
    h.agent.setup(target.cardId, { deviceId: 'quest' });
    expect(runLoop).toHaveBeenCalledExactlyOnceWith(expect.anything(), target, expect.objectContaining({ preferDeviceId: 'mac' }));
    await Promise.resolve();
  });

  it('reselects the same virtual instrument without adding labels or touching the laptop target', () => {
    const h = setup(); h.agent.setMode('control');
    const laptop = h.agent.targets.create({ cardId: 'laptop', card: { cardId: 'laptop', name: 'Apple MacBook', maker: 'Apple', model: 'MacBook', category: 'computer', protocols: ['other'], confidence: 1, evidence: [] } });
    const first = h.select()!, second = h.select()!;
    expect(second).toBe(first); expect(first.cardId).not.toBe(laptop.cardId);
    expect(laptop.card?.category).toBe('computer'); expect(h.agent.tagsState().tags).toHaveLength(1);
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('publishes readiness only for actions actually displayed and currently verified', async () => {
    const h = setup(); h.agent.setMode('control'); const target = h.select()!;
    target.driver = { ...visualSynthDraft(target.cardId, []), driverId: 'driver', executor: { deviceId: 'mac', port: 'ce-visual-synth' } };
    target.armed = true; target.state = 'armed'; target.specId = 'spec'; target.verification = { pattern0: 'pass', cc71: 'untested' };
    h.specs.set('spec', { specId: 'spec', cardId: target.cardId, driverId: 'driver', gen3d: { ...emptySpec('spec'), controls: [
      { id: 'warp', kind: 'continuous', label: 'Warp', armed: true, binding: { action: 'cc71' }, range: { min: 0, max: 127 } },
    ] } });
    expect(h.agent.tagsState().tags[0]).toMatchObject({ connection: 'setup', hint: expect.stringContaining('not passed verification') });
    expect(h.agent.targets.status(target).sentence).toBe('No displayed controls have passed verification');
    h.select();
    expect(h.sent.mock.calls.findLast((call) => call[1] === 'ui.spec')?.[2]).toMatchObject({ gen3d: { controls: [{ id: 'warp', armed: false }] } });
    target.verification.cc71 = 'pass';
    expect(h.agent.tagsState().tags[0].connection).toBe('ready');
    expect(h.agent.targets.status(target).sentence).toBe('1 verified control enabled');
    target.verification.cc71 = 'untested';
    h.agent.setup(target.cardId, { deviceId: 'quest' });
    expect(runLoop).toHaveBeenCalledOnce(); // No re-Enable shortcut for an unusable saved interface.
    await Promise.resolve();
  });

  it.each(['annotate', 'missing', 'ambiguous', 'wrong-companion'] as const)('reports %s without selecting another device or running setup', (failure) => {
    const h = setup(failure === 'missing' ? [] : failure === 'ambiguous' ? [companion('one'), companion('two')] : [companion()]);
    if (failure !== 'annotate') h.agent.setMode('control');
    expect(h.select(failure === 'wrong-companion' ? { deviceId: 'someone-else' } : {})).toBeUndefined();
    expect(h.sent).toHaveBeenLastCalledWith('quest', 'target.select.result', expect.objectContaining({ ok: false, requestId: 'request', reason: expect.any(String) }));
    expect(h.agent.tagsState().tags).toEqual([]); expect(runLoop).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });

  it('requires the exact virtual output on the explicitly chosen companion, not a similarly named physical port', async () => {
    const mac = companion(); const fake = { ...companion('other'), ports: [{ id: 'physical', name: 'ControlAnything Visual Synth', kind: 'midi-out' as const, state: 'connected' as const }] };
    expect(visualSynthCompanions([fake])).toEqual([]);
    const card = visualSynthCard(mac), profile = loadProfiles().midi.get('controlanything-visual-synth');
    const exec = vi.fn(); const dispatcher = { exec } as unknown as Dispatcher;
    const result = await tryLink({ roster: { devices: () => [mac, fake], macLocal: false }, dispatcher }, card, 'midi', { linkId: 'link', profile, preferDeviceId: 'other', probeIdentity: false });
    expect(result.executor).toMatchObject({ deviceId: 'mac', port: { id: 'ce-visual-synth' } });
    const disconnected = await tryLink({ roster: { devices: () => [fake, companion('replacement')], macLocal: false }, dispatcher }, card, 'midi', { linkId: 'link', profile, probeIdentity: false });
    expect(disconnected.executor).toBeUndefined(); expect(disconnected.result.verdict).toBe('none'); expect(exec).not.toHaveBeenCalled();
  });
});
