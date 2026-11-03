import { emptySpec } from '@ce/gen3d';
import type { Driver, UiSpecPayload } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { currentControlSpec, verifiedControlCount } from './control-readiness';
import { ControlRouter } from './control';
import { Dispatcher } from './dispatch';
import { StepLog } from './steps';
import { TargetStore } from './targets';

function setup() {
  const hub = { broadcast: vi.fn(() => 1), sendToDevice: vi.fn(() => 1) };
  const targets = new TargetStore(hub);
  const driver: Driver = { driverId: 'mac-driver', cardId: 'mac', transport: 'local', executor: { deviceId: 'local-mac' }, provenance: [], actions: [
    { actionId: 'say', label: 'Say', kind: 'trigger', encode: { kind: 'local', op: 'say', arg: 'hello' } },
    { actionId: 'play', label: 'Play', kind: 'trigger', encode: { kind: 'local', op: 'music', arg: 'play' } },
  ] };
  const target = targets.create({ cardId: 'mac', driver, specId: 'mac-spec', armed: true, verification: { say: 'pass', play: 'untested' } });
  const spec: UiSpecPayload = { specId: 'mac-spec', cardId: 'mac', driverId: driver.driverId, gen3d: { ...emptySpec('mac-spec'),
    controls: [{ id: 'play', kind: 'trigger', label: 'Start playback', armed: true, binding: { action: 'play', args: { hack: 'play' } } }],
    parts: [{ id: 'hacks', kind: 'archetype', archetype: 'hack-list', params: { items: [{ id: 'play-item', kind: 'action', label: 'Start playback', controlId: 'play', status: 'verified' }] } }],
  }, hackset: { spec: 'ce.hackset/1', device: { id: 'mac', name: 'Mac playback', channel: { type: 'local', via: 'Mac' } }, hacks: [
    { id: 'play', name: 'Start playback', kind: 'action', status: 'verified', commands: [{ action: 'play' }], oracle: { type: 'wire', expect: 'serial_ack' }, max_rate_hz: 1 },
  ] } };
  return { hub, targets, target, spec };
}

describe('current displayed control availability', () => {
  it('does not turn untested playback into verified controls because speech passed', () => {
    const h = setup(); const projected = currentControlSpec(h.spec, h.target);
    expect(verifiedControlCount(h.spec, h.target)).toBe(0);
    expect(projected.gen3d?.controls[0].armed).toBe(false);
    expect(projected.gen3d?.parts[0].params?.items?.[0].status).toBe('locked');
    expect(projected.hackset?.hacks[0].status).toBe('locked'); expect(projected.gen3d?.state?.armed).toBe(false);
    expect(h.spec.gen3d?.controls[0].armed).toBe(true); // Original history/layout is unchanged.
  });

  it('requires all commands in a displayed hack and rejects absent actions even with forged pass state', () => {
    const h = setup(); h.target.verification.play = 'pass';
    expect(verifiedControlCount(h.spec, h.target)).toBe(1);
    expect(currentControlSpec(h.spec, h.target).gen3d?.controls[0].armed).toBe(true);
    h.spec.hackset!.hacks[0].commands.push({ action: 'absent' }); h.target.verification.absent = 'pass';
    expect(verifiedControlCount(h.spec, h.target)).toBe(0);
  });

  it('server rejects the unverified playback command without sending executor output', () => {
    const h = setup(); const dispatcher = new Dispatcher({ hub: h.hub });
    const router = new ControlRouter({ ...h, dispatcher, steps: new StepLog(h.hub), specs: { get: () => h.spec, list: () => [h.spec] } });
    const result = router.onControlEvent({ specId: h.spec.specId, widgetId: 'play', value: true, phase: 'end', ts: 1 }, 'quest');
    expect(result).toMatchObject({ ok: false, fired: 0, reason: 'unverified actions: play' });
    expect(h.hub.sendToDevice).not.toHaveBeenCalled();
  });
});
