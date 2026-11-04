import { describe, expect, it } from 'vitest';
import { ExecAckPayload, type Driver, type ExecOp, type DeviceInfo } from '@ce/protocol';
import { MUSICAL_SCALE, musicalDefaults } from '@ce/vsynth/musical-manifest';
import { musicalSynthDraft, musicalSynthProfile, MUSICAL_SYNTH_MANIFEST as M } from '../devices/musicalSynth';
import { midiOutputCandidates } from '../devices/midi';
import { validateDriver } from '../devices/validate';
import { musicalSynthCard, musicalSynthHosts } from './musical-synth';
import { tryLink } from './link';
import { verifyOnce } from './verify';
import type { VerifyDeps } from './verify';
import type { Target } from './types';
import { deviceHints, wireMessages } from './wire';
import { fixtureWireDraft } from './wire-fixture';
import { dryRun } from './wire-check';
import type { Dispatcher } from './dispatch';
import type { Roster } from './executors';

const host: DeviceInfo = { deviceId: 'mac', name: 'Mac', kind: 'mac', role: 'companion', online: true, canApprove: false, connections: 1, pairedAt: 1, capabilities: ['midi'], ports: [
  { id: 'ce-musical-synth', name: 'ControlAnything Synth', kind: 'midi-out', state: 'connected' },
  { id: 'physical-op1', name: 'OP-1 Field', kind: 'midi-out', state: 'connected' },
] };
const card = musicalSynthCard(host);
const driver: Driver = { ...musicalSynthDraft(card.cardId, []), driverId: 'music-driver', executor: { deviceId: 'mac', port: 'ce-musical-synth' }, maxRateHz: 200 };
const ccs = new Set<number>(M.controls.map(c => c.cc));
const target = { cardId: card.cardId, card, research: { profile: musicalSynthProfile() } } as Target;

function graph(source = 'musical-synth', tone = true, releaseTailRms = 0, forcedHz?: number) {
  let state = musicalDefaults(), frame = 0;
  const sent: ExecOp[] = [];
  const dispatcher = { exec: async (_id: string, op: ExecOp) => {
    sent.push(op);
    if (op.kind === 'midi' && op.msg === 'cc') { const c = M.controls.find(c => c.cc === op.number); if (c && typeof op.value === 'number') state[c.parameter] = op.value; }
    if (op.kind === 'midi' && op.msg === 'pc') state = { ...state, preset: op.number!, gate: 0 };
    return { execId: `e${++frame}`, ok: true, sentAt: Date.now(), applied: { source, params: { ...state }, visible: true, frame, at: Date.now(),
      audio: { unlocked: true, muted: true, rms: tone && state.gate >= 64 ? .1 : releaseTailRms, peak: tone && state.gate >= 64 ? .2 : 0, frequency: tone && state.gate >= 64 ? forcedHz ?? 440 * 2 ** ((MUSICAL_SCALE[state.noteIndex]! - 69) / 12) : 0 } } };
  } } as unknown as Dispatcher;
  return { dispatcher, sent };
}

describe('manifest-backed musical software instrument', () => {
  it('keeps locked software and physical MIDI routes distinct; exact locked owner never falls through to OP-1', async () => {
    const locked = { ...host, ports: host.ports!.map(p => p.id === 'ce-musical-synth' ? { ...p, state: 'disconnected' as const } : p) };
    expect(musicalSynthHosts([locked])).toHaveLength(1);
    expect(musicalSynthHosts([locked], true)).toHaveLength(0);
    expect(midiOutputCandidates(host.ports, undefined).map(p => p.id)).toEqual(['physical-op1']);
    const d = graph();
    const result = await tryLink({ dispatcher: d.dispatcher, roster: { devices: () => [locked] } as Roster }, card, 'midi', { linkId: 'l', profile: musicalSynthProfile() });
    expect(result.executor).toBeUndefined(); expect(result.result.reason).toContain('Sound on'); expect(d.sent).toEqual([]);
  });
  it('allows only the engine catalog, integer scale bounds and audio expectations', () => {
    expect(validateDriver(driver, { driverId: driver.driverId, executor: driver.executor }, { allowedCcs: ccs }).ok).toBe(true);
    const bad = { ...driver, actions: driver.actions.map(a => a.actionId === 'cc16' ? { ...a, range: { min: 0, max: 127, step: 1 } } : a) };
    expect(validateDriver(bad, { driverId: driver.driverId, executor: driver.executor }, { allowedCcs: ccs }).issues.some(i => i.code === 'musical_range')).toBe(true);
    const note = { ...driver, actions: [{ actionId: 'note', label: 'Note', kind: 'trigger' as const, encode: { kind: 'midi' as const, msg: 'note' as const, channel: 1, number: 60 }, expect: { sense: 'ack' as const, effect: 'any' as const } }] };
    expect(validateDriver(note, { driverId: driver.driverId, executor: driver.executor }, { allowedCcs: ccs }).ok).toBe(false);
  });
  it('requires a fresh actual analyser tone plus exact applied state, then releases the gate without panic', async () => {
    const d = graph('musical-synth', true, .03);
    const result = await verifyOnce({ dispatcher: d.dispatcher } as VerifyDeps, target, driver, driver.actions[0]!, 1, {});
    expect(result.evidence.pass).toBe(true); expect(result.evidence.note).toContain('Not physical microphone');
    expect(result.evidence.observed.before).toBe(.03); expect(result.evidence.observed.delta).toBeCloseTo(.07);
    expect(d.sent.some(o => o.kind === 'midi' && o.msg === 'panic')).toBe(false);
    expect(d.sent.filter(o => o.kind === 'midi' && o.msg === 'cc' && o.number === 17).at(-1)).toMatchObject({ value: 0 });
  });
  it('refuses a plain audio acknowledgement and a silent analyser even when parameter receipts match', async () => {
    for (const d of [graph('port'), graph('musical-synth', false)]) {
      const result = await verifyOnce({ dispatcher: d.dispatcher } as VerifyDeps, target, driver, driver.actions[0]!, 1, {}).catch(() => undefined);
      expect(result?.evidence.pass ?? false).toBe(false);
    }
  });
  it('retires an old verification cleanup before it can restore over a newer request', async () => {
    const d = graph(); let current = true;
    const exec = d.dispatcher.exec.bind(d.dispatcher);
    d.dispatcher.exec = (async (...args: Parameters<Dispatcher['exec']>) => {
      if (args[2]?.actionId?.endsWith(':restore-release')) expect(args[2].stillCurrent?.()).toBe(true);
      const ack = await exec(...args);
      if (args[2]?.actionId?.endsWith(':restore-release')) { current = false; expect(args[2].stillCurrent?.()).toBe(false); }
      return ack;
    }) as Dispatcher['exec'];
    const result = await verifyOnce({ dispatcher: d.dispatcher } as VerifyDeps, target, driver, driver.actions[0]!, 1, { cleanupAllowed: () => current });
    expect(result.evidence.pass).toBe(true);
    // The commanded pitch was sent; its old baseline is not restored after the request was retired.
    expect(d.sent.filter(o => o.kind === 'midi' && o.msg === 'cc' && o.number === 16)).toEqual([expect.objectContaining({ value: 0 })]);
  });
  it('rejects a sounding graph playing the wrong scale note', async () => {
    const d = graph('musical-synth', true, 0, 440);
    const result = await verifyOnce({ dispatcher: d.dispatcher } as VerifyDeps, target, driver, driver.actions[0]!, 1, {});
    expect(result.evidence.pass).toBe(false); expect(result.evidence.note).toContain('expected 130.8 Hz');
  });
  it('labels the software graph protocol and keeps fixture musical glue separate from live Muse', () => {
    const receipt = graph(); expect(receipt.sent).toEqual([]);
    expect(ExecAckPayload.safeParse({ execId: 'e', ok: true, sentAt: 0, applied: { source: 'musical-synth', params: musicalDefaults(), audio: { unlocked: true, muted: true, rms: .1, peak: .2, frequency: 261 } } }).success).toBe(true);
    const messages = wireMessages({ cardId: card.cardId, deviceName: card.name, request: 'Play a theremin with my right hand', driver });
    expect(deviceHints(driver).join('\n')).toContain('eight seconds');
    expect(deviceHints({ ...driver, executor: { deviceId: 'mac', port: 'OP-1 Field' } })).toEqual([]);
    const fixture = fixtureWireDraft(messages);
    expect(fixture.title).toContain('FIXTURE');
    expect(fixture.code).toContain("out.set('cc17', 0)");
    expect(dryRun(fixture.code, driver, fixture.needs).ok).toBe(true);
  });
});
