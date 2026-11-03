import { describe, expect, it } from 'vitest';
import { DeviceCardPayload, type DeviceInfo } from '@ce/protocol';
import { MidiChartStore } from '../devices/midi-charts';
import { IdentityCorrections, IDENTITY_REVIEW_TTL_MS, isIdentityCorrectionRequest } from './identity-correction';
import { TargetStore } from './targets';

const mac: DeviceInfo = { deviceId: 'mac', name: 'Paired Mac', kind: 'mac', role: 'companion', capabilities: ['midi'], canApprove: true,
  online: true, connections: 1, pairedAt: 1, ports: [
    { id: 'op1-in', kind: 'midi-in', name: 'OP-1', manufacturer: 'teenage engineering', state: 'connected' },
    { id: 'op1-out', kind: 'midi-out', name: 'OP-1', manufacturer: 'teenage engineering', state: 'connected' },
  ] };
const request = 'This is not a typing keyboard. It is an OP-1 Field connected to my Mac.';
function harness() {
  let now = 1000;
  const service = new IdentityCorrections(() => now);
  const targets = new TargetStore({ broadcast: () => 0 });
  const target = targets.create({ cardId: 'same-physical-tag', selectedBy: 'quest', state: 'identified',
    card: { cardId: 'same-physical-tag', name: 'External wired keyboard', maker: 'Example', model: 'Wired Keyboard', category: 'other',
      confidence: .8, protocols: ['hid'], requires: [], evidence: ['A row of keys'], source: 'live', modelId: 'muse-spark-1.3',
      frameId: 'camera-frame', detId: 'det', bbox: { x: .2, y: .3, w: .4, h: .2 } },
  });
  const confirm = (proposalId: string, extra = {}) => service.confirm(target,
    { proposalId, cardId: target.cardId, sender: 'quest', accept: true, canApprove: true, ...extra }, [mac]);
  const propose = (text = request, devices = [mac]) => {
    const result = service.propose(target, text, 'quest', devices);
    if (!result.ok) throw new Error(result.reason);
    return result.proposal;
  };
  return { service, target, targets, confirm, propose, advance: (ms: number) => { now += ms; } };
}

describe('reviewed object identity correction', () => {
  it.each(['OP-1 Field', 'OP1 Field', 'op one field', 'OP‑1 Field', 'Teenage Engineering OP-1 Field'])('recognizes an explicit %s correction without treating ordinary questions as corrections', (model) => {
    const h = harness();
    expect(h.propose(`It’s actually an ${model}, not a computer keyboard`).firmware).toBe('unknown');
    expect(isIdentityCorrectionRequest('Tell me about this device')).toBe(false);
    expect(isIdentityCorrectionRequest('What is an OP-1 Field?')).toBe(false);
    expect(isIdentityCorrectionRequest('Reidentify this object')).toBe(true);
  });

  it.each(['This is an OP-1', 'This is not an OP-1 Field', 'It isn’t an OP-1 Field', 'What is an OP-1 Field?', 'This is a book'])('does not authorize Field identity from ambiguous, negated or unsupported text: %s', (text) => {
    const h = harness();
    expect(h.service.propose(h.target, text, 'quest', [mac]).ok).toBe(false);
    expect(h.target.card?.protocols).toEqual(['hid']);
  });

  it.each([
    [],
    [{ ...mac, online: false }],
    [{ ...mac, ports: [mac.ports![0]] }],
    [{ ...mac, kind: 'sim' as const }],
    [{ ...mac, ports: [{ ...mac.ports![1], state: 'disconnected' as const }] }],
    [{ ...mac, ports: [{ ...mac.ports![1], manufacturer: 'Another maker' }] }],
    [mac, { ...mac, deviceId: 'second-mac' }],
  ].map((devices) => ({ devices })))('requires one unambiguous connected physical MIDI output (%j)', ({ devices }) => {
    const h = harness();
    expect(h.service.propose(h.target, request, 'quest', devices).ok).toBe(false);
  });

  it('only proposes first, then returns a disarmed patch preserving the same tracked object after explicit confirmation', () => {
    const h = harness();
    h.target.driver = { driverId: 'old-driver', cardId: h.target.cardId, transport: 'local', executor: { deviceId: 'wrong-mac' }, provenance: [],
      actions: [{ actionId: 'play', label: 'Play', kind: 'trigger', encode: { kind: 'local', op: 'music', arg: 'play' } }] };
    h.target.specId = 'old-spec'; h.target.verification = { play: 'pass' }; h.target.stepIndex = { old: 3 }; h.target.paramValues = { old: 70 };
    h.target.research = { brief: 'Wrong old capabilities', provenance: [] };
    h.target.selection = { userText: 'old wrong instructions', preferDeviceId: 'wrong-mac' };
    const before = structuredClone(h.target);
    const other = h.targets.create({ cardId: 'other-tag' });
    const proposal = h.propose();
    expect(h.target).toEqual(before);
    expect(proposal.summary).toContain('family only');
    const result = h.confirm(proposal.proposalId);
    expect(result.status).toBe('confirmed');
    if (result.status !== 'confirmed') throw new Error(result.reason);
    expect(h.target).toEqual(before); // Integration owns atomic application and durable tag/placement storage.
    expect(result.audit).toMatchObject({ source: 'user-confirmed', confirmedBy: 'quest', firmware: 'unknown', physicalControlVerified: false });
    Object.assign(h.target, result.patch);
    expect(h.target.cardId).toBe(before.cardId);
    expect(h.target.selectedBy).toBe('quest');
    expect(h.target.card).toMatchObject({ cardId: before.cardId, model: 'OP-1 Field', category: 'synthesizer', protocols: ['midi'], requires: ['midi'], bbox: before.card!.bbox });
    expect(DeviceCardPayload.safeParse(h.target.card).success).toBe(true);
    expect(h.target.card?.source).toBeUndefined(); expect(h.target.card?.modelId).toBeUndefined();
    expect(h.target.card?.notes).toContain('Firmware is unknown');
    expect(h.target).toMatchObject({ armed: false, verification: {}, evidence: [], stepIndex: {}, paramValues: {}, selection: { preferDeviceId: 'mac' } });
    for (const key of ['driver', 'specId', 'research', 'link', 'armId', 'abort', 'driverIssues'] as const) expect(h.target[key]).toBeUndefined();
    expect(h.targets.get('other-tag')).toBe(other);
    expect(h.confirm(proposal.proposalId).status).toBe('rejected');
  });

  it('keeps review scoped to its sender, object and approver; dismissal never changes the card', () => {
    const h = harness(), p = h.propose();
    expect(h.confirm(p.proposalId, { sender: 'another-headset' }).status).toBe('rejected');
    expect(h.confirm(p.proposalId, { cardId: 'other-tag' }).status).toBe('rejected');
    expect(h.confirm(p.proposalId, { canApprove: false }).status).toBe('rejected');
    expect(h.confirm(p.proposalId, { accept: false }).status).toBe('dismissed');
    expect(h.target.card?.model).toBe('Wired Keyboard');
    expect(h.confirm(p.proposalId).status).toBe('rejected');
  });

  it.each(['identity', 'setup', 'armed', 'driver', 'selection', 'expired', 'cancelled', 'invalidated'] as const)('rejects stale confirmation after %s changes', (change) => {
    const h = harness(), p = h.propose();
    if (change === 'identity') h.target.card!.model = 'Changed';
    if (change === 'setup') h.target.abort = new AbortController();
    if (change === 'armed') h.target.armed = true;
    if (change === 'driver') h.target.specId = 'new-spec';
    if (change === 'selection') h.target.selectedBy = 'other-wearer';
    if (change === 'expired') h.advance(IDENTITY_REVIEW_TTL_MS);
    if (change === 'cancelled') h.service.cancel('quest', h.target.cardId);
    if (change === 'invalidated') h.service.invalidate(h.target.cardId);
    expect(h.confirm(p.proposalId).status).toBe('rejected');
    expect(h.target.card?.protocols).toEqual(['hid']);
  });

  it('rechecks the same output at confirmation instead of carrying forward disconnected or substituted evidence', () => {
    const h = harness(), p = h.propose();
    const result = h.service.confirm(h.target, { proposalId: p.proposalId, cardId: h.target.cardId, sender: 'quest', accept: true, canApprove: true },
      [{ ...mac, ports: [{ ...mac.ports![1], id: 'replacement-output' }] }]);
    expect(result.status).toBe('rejected');
    expect(h.target.card?.protocols).toEqual(['hid']);
  });

  it('refuses proposals while controls are enabled or a setup is active', () => {
    const h = harness(); h.target.armed = true;
    expect(h.service.propose(h.target, request, 'quest', [mac]).ok).toBe(false);
    h.target.armed = false; h.target.abort = new AbortController();
    expect(h.service.propose(h.target, request, 'quest', [mac]).ok).toBe(false);
  });

  it('does not transfer reviewed MIDI permissions from the old identity to the corrected Field model', () => {
    const h = harness(), charts = new MidiChartStore();
    const previousCard = { ...h.target.card!, protocols: ['midi'] as const, requires: ['midi'] as const };
    charts.review({ ...previousCard, protocols: [...previousCard.protocols], requires: [...previousCard.requires] }, {
      maker: previousCard.maker, model: previousCard.model, channel: 4,
      source: { title: 'Old device chart', url: 'https://example.com/old-manual', section: 'CC page' },
      parameters: [{ cc: 74, name: 'Previous parameter', min: 20, max: 100 }],
    }, 0, 'Owner');
    const p = h.propose(), result = h.confirm(p.proposalId);
    if (result.status !== 'confirmed') throw new Error(result.reason);
    expect(charts.profile(result.patch.card)).toBeUndefined();
    expect(result.patch.research).toBeUndefined();
    expect(result.audit.firmware).toBe('unknown');
  });
});
