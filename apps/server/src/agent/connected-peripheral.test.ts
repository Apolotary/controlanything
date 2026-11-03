import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '@ce/protocol';
import { ConnectedPeripherals, GENERAL_ASSISTANT_CARD, isConnectedPeripheralRequest, isHostPeripheralReference } from './connected-peripheral';
import type { Target } from './types';

const mac: DeviceInfo = { deviceId: 'mac', name: 'Paired Mac', kind: 'mac', role: 'companion', capabilities: ['midi'], online: true, canApprove: true, connections: 1, pairedAt: 1,
  ports: [{ id: 'op1-out', name: 'OP-1', manufacturer: 'Teenage Engineering', kind: 'midi-out', state: 'connected' }] };
const host = (): Target => ({ cardId: 'laptop', card: { cardId: 'laptop', name: 'Apple MacBook laptop', maker: 'Apple', model: 'MacBook', category: 'computer', confidence: 1, protocols: ['other'], evidence: [] },
  runId: 'host-run', state: 'identified', since: 0, verification: {}, evidence: [], armed: false, stepIndex: {}, paramValues: {} });
const prompt = 'I have an OP-1 Field connected to this laptop. Can you create gesture control for it?';

describe('connected-instrument owner review', () => {
  it('recognizes the instrument requested through a host without confusing it with a model denial', () => {
    expect(isConnectedPeripheralRequest(prompt, { name: 'Apple MacBook laptop' })).toBe(true);
    expect(isConnectedPeripheralRequest('Control my OP-1 Field', { name: 'Apple MacBook laptop' })).toBe(true);
    expect(isConnectedPeripheralRequest('This is not an OP-1 Field', { name: 'Apple MacBook laptop' })).toBe(false);
    expect(isConnectedPeripheralRequest('What is an OP-1 Field?')).toBe(false);
  });
  it('distinguishes a host identity with a peripheral from an instrument identity correction', () => {
    const laptop = { name: 'Apple MacBook laptop', identity: { category: 'computer' } };
    expect(isHostPeripheralReference('This is my MacBook with an OP-1 Field connected to it. Create gesture control.', laptop)).toBe(true);
    expect(isHostPeripheralReference('It’s a laptop with an OP-1 Field connected. Can I control it?', laptop)).toBe(true);
    expect(isHostPeripheralReference('This is an OP-1 Field connected to my Mac, not a laptop. Create gesture control.', laptop)).toBe(false);
    expect(isHostPeripheralReference('This is actually an OP-1 Field, not a typing keyboard.', { name: 'External wired keyboard' })).toBe(false);
  });
  it('proposes then constructs a separate logical target without mutating the host or starting control', () => {
    const service = new ConnectedPeripherals(), laptop = host(), before = structuredClone(laptop);
    const proposal = service.propose(laptop, laptop.cardId, prompt, 'quest', [mac]);
    expect(proposal.ok).toBe(true); if (!proposal.ok) throw Error(proposal.text);
    expect(laptop).toEqual(before);
    const result = service.confirm(laptop, { sender: 'quest', cardId: 'laptop', proposalId: proposal.proposal.proposalId, accept: true }, [mac]);
    expect(result).toMatchObject({ ok: true, dismissed: false, card: { model: 'OP-1 Field', protocols: ['midi'] } });
    if (result.ok && !result.dismissed) { expect(result.card.cardId).not.toBe('laptop'); expect(result.card.notes).toContain('Not a visual detection'); }
    expect(laptop).toEqual(before);
  });
  it.each(['disconnect', 'host-change', 'expired', 'wrong-sender', 'dismiss'] as const)('does not create a target after %s', (change) => {
    let now = 100;
    const service = new ConnectedPeripherals(() => now), laptop = host();
    const p = service.propose(laptop, 'laptop', prompt, 'quest', [mac]); if (!p.ok) throw Error(p.text);
    if (change === 'host-change') laptop.runId = 'new-run';
    if (change === 'expired') now += 120_001;
    const result = service.confirm(laptop, { sender: change === 'wrong-sender' ? 'other' : 'quest', cardId: 'laptop', proposalId: p.proposal.proposalId, accept: change !== 'dismiss' }, change === 'disconnect' ? [] : [mac]);
    expect(result).not.toHaveProperty('card');
    expect(laptop.card?.name).toBe('Apple MacBook laptop');
  });
  it('supports general context and asks for exact model, unique port and stopped host', () => {
    const service = new ConnectedPeripherals();
    expect(service.propose(undefined, GENERAL_ASSISTANT_CARD, prompt, 'quest', [mac]).ok).toBe(true);
    expect(service.propose(host(), 'laptop', 'Control OP-1 connected to my Mac', 'quest', [mac])).toMatchObject({ ok: false, text: expect.stringContaining('original OP-1 or OP-1 Field') });
    expect(service.propose(host(), 'laptop', prompt, 'quest', [])).toMatchObject({ ok: false, text: expect.stringContaining('No physical OP-1 MIDI output') });
    expect(service.propose(host(), 'laptop', prompt, 'quest', [mac, { ...mac, deviceId: 'other' }])).toMatchObject({ ok: false });
    expect(service.propose({ ...host(), armed: true }, 'laptop', prompt, 'quest', [mac])).toMatchObject({ ok: false, text: expect.stringContaining('Stop') });
  });
});
