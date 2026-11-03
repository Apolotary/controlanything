import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMessage, type DeviceInfo, type MessageType, type PayloadOf } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import type { HubMessageEvent } from '../hub';
import { createAgent } from './index';

const owner = { deviceId: 'quest', name: 'Quest' };
const mac: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', capabilities: ['midi'],
  canApprove: true, online: true, connections: 1, pairedAt: 1,
  ports: [{ id: 'op1-out', name: 'OP-1', manufacturer: 'Teenage Engineering', kind: 'midi-out', state: 'connected' }] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); vi.restoreAllMocks(); });

function server(dir?: string) {
  const ctx = createContext(loadConfig({ CE_DATA_DIR: dir, MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' }), { registryFile: null, log: () => {} });
  vi.spyOn(ctx.hub, 'devices').mockReturnValue([mac]);
  const events = vi.spyOn(ctx.hub, 'onMessage'), broadcasts = vi.spyOn(ctx.hub, 'broadcast');
  const directed = vi.spyOn(ctx.hub, 'sendToDevice');
  const agent = createAgent(ctx, { macLocal: false, forge: () => undefined, ...(dir ? {} : { tagsFile: null }) });
  const execute = vi.spyOn(agent.dispatcher, 'exec');
  let closed = false;
  const close = () => { if (!closed) { closed = true; agent.close(); ctx.hub.close(); } };
  cleanups.push(close);
  const emit = <T extends MessageType>(type: T, payload: PayloadOf<T>, sender = 'quest', canApprove = true) => {
    const event: HubMessageEvent = { message: makeMessage(type, payload, { from: sender, to: 'server' }),
      device: { ...owner, deviceId: sender, canApprove, kind: 'quest', capabilities: ['camera'], tokenHash: 'fixture', pairedAt: 1 },
      connection: { local: false } as HubMessageEvent['connection'] };
    for (const [listener] of events.mock.calls) listener(event);
  };
  const replies = () => broadcasts.mock.calls.filter(([type]) => type === 'voice.text').map(([, p]) => p as PayloadOf<'voice.text'>);
  const add = () => {
    const target = agent.targets.create({ cardId: 'keyboard', state: 'identified', card: { cardId: 'keyboard', name: 'External wired keyboard', maker: 'Unknown', model: 'Keyboard', category: 'computer', protocols: ['hid'], confidence: .7, evidence: ['Keys'] } });
    agent.addTag({ targetId: target.cardId, label: 'Keyboard', position: { x: 1, y: 1, z: -1 } }, owner);
    return target;
  };
  const proposal = async () => {
    emit('voice.text', { cardId: 'keyboard', utteranceId: 'correct', final: true, text: 'This is actually an OP-1 Field, not a typing keyboard. Build controls so I can play it with my hands.' });
    await vi.waitFor(() => expect(replies().at(-1)?.assistant?.state).toBe('proposal'));
    const reply = replies().at(-1)!;
    expect(reply.assistant?.proposalKind).toBe('identity');
    return { cardId: 'keyboard', proposalId: reply.assistant!.proposalId!, accept: true };
  };
  return { agent, emit, replies, add, proposal, execute, close, directed };
}

describe('owner-reviewed identity correction through real agent message wiring', () => {
  it.each(['I have an OP-1 Field connected to this laptop. Create gesture control for it.', 'This is my MacBook with an OP-1 Field connected to it. Create gesture control.'])('selects a separate instrument and preserves host identity/chart gating: %s', async (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-peripheral-flow-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = server(dir), laptop = s.add();
    laptop.card = { ...laptop.card!, name: 'Apple MacBook laptop', category: 'computer', model: 'MacBook', protocols: ['other'] };
    const before = structuredClone(laptop.card);
    s.emit('voice.text', { cardId: laptop.cardId, utteranceId: 'peripheral-request', final: true, text });
    await vi.waitFor(() => expect(s.replies().at(-1)?.assistant?.state).toBe('proposal'));
    const proposal = s.replies().at(-1)!.assistant!;
    expect(proposal.proposalKind).toBe('peripheral'); expect(laptop.card).toEqual(before);
    s.emit('voice.confirm', { cardId: laptop.cardId, proposalId: proposal.proposalId!, accept: true });
    const selectedId = s.replies().at(-1)?.assistant?.selectedCardId;
    expect(selectedId).toBeTruthy(); expect(selectedId).not.toBe(laptop.cardId);
    const instrument = s.agent.targets.get(selectedId!)!;
    expect(instrument.card?.model).toBe('OP-1 Field'); expect(instrument.armed).toBe(false); expect(instrument.detection).toBeUndefined();
    expect(laptop.card).toEqual(before); expect(s.execute).not.toHaveBeenCalled();
    s.agent.setMode('control'); expect(s.agent.setup(instrument.cardId, owner)).toBeUndefined();
    expect(instrument.hint).toContain('incoming MIDI chart'); expect(s.execute).not.toHaveBeenCalled();
    expect(s.directed).toHaveBeenCalledWith('quest', 'target.status', expect.objectContaining({ cardId: instrument.cardId, state: 'failed', sentence: 'Review the MIDI chart first', hint: expect.stringContaining('Firmware is not confirmed') }));
    s.close();
    const restored = server(dir); restored.agent.setMode('control');
    expect(restored.agent.targets.get(selectedId!)?.card?.model).toBe('OP-1 Field');
    expect(restored.agent.setup(selectedId!, owner)).toBeUndefined(); expect(restored.execute).not.toHaveBeenCalled();
  });

  it('requires the same authorized sender and persists correction without starting controls, including after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-identity-flow-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = server(dir), target = s.add();
    const confirm = await s.proposal();
    s.emit('voice.confirm', confirm, 'other-owner');
    s.emit('voice.confirm', confirm, 'quest', false);
    expect(target.card?.model).toBe('Keyboard');
    s.emit('voice.confirm', confirm);
    expect(target.card?.model).toBe('OP-1 Field');
    expect(target.identityRevision).toBe(1);
    expect(target.identityCorrection).toMatchObject({ firmware: 'unknown', confirmedBy: 'quest', physicalControlVerified: false });
    expect(target).toMatchObject({ armed: false, verification: {}, evidence: [], state: 'identified' });
    expect(target.driver).toBeUndefined();
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.replies().at(-1)?.assistant?.text).toContain('controls remain off');
    s.agent.setMode('control');
    expect(s.agent.setup(target.cardId, owner)).toBeUndefined();
    expect(target.hint).toContain('incoming MIDI chart');
    expect(s.execute).not.toHaveBeenCalled();
    s.emit('voice.confirm', confirm);
    expect(target.identityRevision).toBe(1);
    s.close();
    const restored = server(dir), saved = restored.agent.targets.get('keyboard')!;
    expect(saved.card?.model).toBe('OP-1 Field');
    expect(saved.identityRevision).toBe(1);
    expect(saved.driver).toBeUndefined();
    restored.agent.setMode('control');
    expect(restored.agent.setup(saved.cardId, owner)).toBeUndefined();
    expect(restored.execute).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'mode', 'remove', 'dismiss'] as const)('keeps the original identity after %s invalidates review', async (change) => {
    const s = server(), target = s.add(), confirm = await s.proposal();
    if (change === 'cancel') s.emit('voice.cancel', { cardId: target.cardId });
    if (change === 'mode') s.agent.setMode('control');
    if (change === 'remove') s.agent.removeTag(target.cardId);
    if (change === 'dismiss') s.emit('voice.confirm', { ...confirm, accept: false });
    s.emit('voice.confirm', confirm);
    expect(target.card?.model).toBe('Keyboard');
    expect(target.identityRevision).toBeUndefined();
    expect(s.execute).not.toHaveBeenCalled();
  });
});
