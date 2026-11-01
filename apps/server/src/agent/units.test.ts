import type { AgentStepPayload, ControlEventPayload, Driver, HackSet, PayloadOf, UiSpecPayload } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { classify, wavFromPcm16 } from '../voice/relay';
import { inspectWav } from '../muse/transcribe';
import { ArmService } from './arm';
import { ControlRouter } from './control';
import { Dispatcher, RateLimiter } from './dispatch';
import { pickExecutor, pickSensor, type Roster } from './executors';
import { MacLocalExecutor, planLocal } from './maclocal';
import { scanPrompts } from './scan';
import { StepLog } from './steps';
import { TargetStore } from './targets';

class FakeHub {
  sent: { to?: string; type: string; payload: unknown }[] = [];
  online = new Set<string>();
  broadcast(type: string, payload: unknown): number {
    this.sent.push({ type, payload });
    return 1;
  }
  sendToDevice(deviceId: string, type: string, payload: unknown): number {
    if (!this.online.has(deviceId)) return 0;
    this.sent.push({ to: deviceId, type, payload });
    return 1;
  }
  devices() {
    return [];
  }
  of(type: string): any[] {
    return this.sent.filter((s) => s.type === type).map((s) => s.payload);
  }
}

describe('rate limiter and dispatcher', () => {
  it('token bucket allows a burst then paces at the rate', () => {
    let t = 0;
    const l = new RateLimiter(4, 1, () => t);
    expect(l.take()).toBe(true);
    expect(l.take()).toBe(false);
    expect(l.waitMs()).toBe(250);
    t += 250;
    expect(l.take()).toBe(true);
  });

  it('exec waits for the ack, times out, and refuses offline executors', async () => {
    const hub = new FakeHub();
    hub.online.add('card-1');
    const d = new Dispatcher({ hub, ackTimeoutMs: 50 });
    const p = d.exec('card-1', { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4], rawUs: [9000, 4500, 560, 560] });
    const cmd = hub.of('exec.command')[0] as PayloadOf<'exec.command'>;
    expect(cmd.executorDeviceId).toBe('card-1');
    d.onAck({ execId: cmd.execId, ok: true, sentAt: 1, latencyMs: 2 });
    await expect(p).resolves.toMatchObject({ ok: true });
    await expect(d.exec('card-1', { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4], rawUs: [9000, 4500] })).rejects.toThrow(/rate limit/);
    await expect(d.exec('nobody', { kind: 'local', op: 'say', arg: 'x' })).rejects.toThrow(/offline/);
    const slow = d.exec('card-1', { kind: 'midi', msg: 'cc', channel: 1, number: 1, value: 1 });
    await expect(slow).rejects.toThrow(/no exec.ack/);
    expect(d.sent.length).toBe(3);
  });

  it('sense collects ir-capture results until the window closes and resolves frames on the first result', async () => {
    const hub = new FakeHub();
    hub.online.add('sim');
    const d = new Dispatcher({ hub });
    const p = d.sense('sim', 'ir-capture', { durationMs: 20, timeoutMs: 40 });
    const req = hub.of('sense.request')[0] as PayloadOf<'sense.request'>;
    d.onSense({ senseId: req.senseId, kind: 'ir-capture', ir: { rawUs: [9000, 4500] }, at: 1 });
    d.onSense({ senseId: req.senseId, kind: 'ir-capture', ir: { rawUs: [9100, 4400] }, at: 2 });
    expect((await p).length).toBe(2);
    const f = d.sense('sim', 'frame', { timeoutMs: 100 });
    const req2 = hub.of('sense.request')[1] as PayloadOf<'sense.request'>;
    d.onSense({ senseId: req2.senseId, kind: 'frame', frame: { frameId: 'f', jpeg: 'AA', width: 1, height: 1, capturedAt: 1, purpose: 'verify' }, at: 1 });
    expect((await f)[0].frame?.frameId).toBe('f');
  });

  it('runs local ops through the Mac executor plan without a shell', async () => {
    expect(planLocal({ kind: 'local', op: 'volume', arg: 42 })).toEqual({ file: 'osascript', args: ['-e', 'set volume output volume 42'] });
    expect(planLocal({ kind: 'local', op: 'music', arg: 'next' })).toEqual({ file: 'osascript', args: ['-e', 'tell application "Music" to next track'] });
    expect(planLocal({ kind: 'local', op: 'say', arg: 'hello; rm -rf /' })).toEqual({ file: 'say', args: ['hello; rm -rf /'] });
    expect(planLocal({ kind: 'local', op: 'torch', arg: true })).toMatchObject({ ok: false, error: 'unsupported' });
    const calls: string[][] = [];
    const mac = new MacLocalExecutor(async (f, a) => {
      calls.push([f, ...a]);
      return 'done';
    }, true);
    await expect(mac.exec({ kind: 'local', op: 'volume', arg: 30 })).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toEqual(['osascript', '-e', 'set volume output volume 30']);
    await expect(mac.exec({ kind: 'local', op: 'volume', arg: 30 }, true)).resolves.toMatchObject({ ok: true, detail: expect.stringMatching(/dry run/) });
    await expect(mac.exec({ kind: 'midi', msg: 'cc', channel: 1 })).resolves.toMatchObject({ ok: false, error: 'unsupported' });
  });
});

describe('executor and sensor picking by capability', () => {
  const roster: Roster = {
    macLocal: true,
    devices: () => [
      { deviceId: 'mac-1', name: 'MacBook', kind: 'mac', role: 'companion', capabilities: ['midi', 'mic'], canApprove: true, online: true, connections: 1, pairedAt: 1, ports: [{ id: 'o1', kind: 'midi-out', name: 'OP-1' }, { id: 'o2', kind: 'midi-out', name: 'EP-133' }] },
      { deviceId: 'card-1', name: 'Cardputer', kind: 'cardputer', role: 'device', capabilities: ['ir', 'display'], canApprove: false, online: true, connections: 1, pairedAt: 2 },
      { deviceId: 'quest-1', name: 'Quest', kind: 'quest', role: 'hmd', capabilities: ['camera', 'mic', 'hands'], canApprove: true, online: true, connections: 1, pairedAt: 3 },
      { deviceId: 'sim-1', name: 'Sim room', kind: 'sim', role: 'device', capabilities: ['ir', 'midi', 'camera', 'mic'], canApprove: false, online: false, connections: 0, pairedAt: 4 },
    ],
  };
  it('picks MIDI by port hint, IR by cardputer, local by the Mac, camera by the Quest; offline devices never', () => {
    expect(pickExecutor(roster, 'midi', { portHint: 'ep-133' })).toMatchObject({ deviceId: 'mac-1', port: { name: 'EP-133' } });
    expect(pickExecutor(roster, 'midi', { portHint: 'op-1' })).toMatchObject({ port: { name: 'OP-1' } });
    expect(pickExecutor(roster, 'ir')).toMatchObject({ deviceId: 'card-1' });
    expect(pickExecutor(roster, 'local')).toMatchObject({ deviceId: 'mac-local', internal: true });
    expect(pickSensor(roster, 'camera')?.deviceId).toBe('quest-1');
    expect(pickSensor(roster, 'mic')?.deviceId).toBe('mac-1');
    expect(pickSensor(roster, 'ir')?.deviceId).toBe('card-1');
    expect(pickExecutor({ ...roster, macLocal: false, devices: () => roster.devices().filter((d) => d.kind !== 'mac') }, 'midi')).toBeUndefined();
  });
});

describe('steps, targets, arm', () => {
  it('step log broadcasts agent.step with model fields and keeps history', () => {
    const hub = new FakeHub();
    const log = new StepLog(hub);
    const h = log.begin('identify', 'identifying', { cardId: 'c1', model: 'muse-spark-1.3', effort: 'low' });
    h.ok('done', { latencyMs: 1234, evidence: 'OP-1 Field' });
    const steps = hub.of('agent.step') as AgentStepPayload[];
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ status: 'ok', model: 'muse-spark-1.3', effort: 'low', latencyMs: 1234, evidence: 'OP-1 Field', cardId: 'c1' });
    expect(log.list('c1')).toHaveLength(1);
  });

  it('arm requires an approver, honours hold for irreversible drivers, and expires', async () => {
    const hub = new FakeHub();
    const targets = new TargetStore(hub);
    const steps = new StepLog(hub);
    const arm = new ArmService({ hub, targets, steps, timeoutMs: 60 });
    const t = targets.create({ cardId: 'c1' });
    const driver: Driver = { driverId: 'd', cardId: 'c1', transport: 'ir', executor: { deviceId: 'x' }, provenance: [], actions: [{ actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'NEC', bytes: [1, 2, 3, 4] }, confirm: 'hold' }] };
    t.verification = { off: 'pass' };
    const p = arm.request(t, driver);
    const req = hub.of('arm.request')[0] as PayloadOf<'arm.request'>;
    expect(req.irreversible).toBe(true);
    expect(arm.onConfirm({ armId: req.armId, approve: true }, { deviceId: 'nobody', canApprove: false })).toBe(false);
    expect(arm.onConfirm({ armId: req.armId, approve: true }, { deviceId: 'quest', canApprove: true })).toBe(true); // tap, not hold
    expect(t.armed).toBe(false);
    expect(arm.onConfirm({ armId: req.armId, approve: true, hold: true }, { deviceId: 'quest', name: 'Quest', canApprove: true })).toBe(true);
    await expect(p).resolves.toMatchObject({ armed: true, by: 'Quest' });
    expect(t.armed).toBe(true);
    expect(t.state).toBe('armed');
    const t2 = targets.create({ cardId: 'c2' });
    await expect(arm.request(t2, { ...driver, cardId: 'c2', actions: [{ ...driver.actions[0], confirm: undefined }] })).resolves.toMatchObject({ armed: false, reason: /no confirmation/ });
  });
});

describe('control router', () => {
  const driver: Driver = {
    driverId: 'drv',
    cardId: 'light',
    transport: 'ir',
    executor: { deviceId: 'card-1' },
    provenance: [],
    actions: [
      { actionId: 'off', label: 'Off', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], unitUs: 432 }, inverseActionId: 'full' },
      { actionId: 'full', label: 'Full', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2c, 0x25], unitUs: 432 }, inverseActionId: 'off' },
      { actionId: 'up', label: 'Brighter', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2a, 0x23], unitUs: 432 } },
      { actionId: 'down', label: 'Dimmer', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2b, 0x22], unitUs: 432 } },
      { actionId: 'level', label: 'Level', kind: 'set', range: { min: 0, max: 100 }, encode: { kind: 'step', upActionId: 'up', downActionId: 'down', steps: 10, settleMs: 10 } },
    ],
  };
  const hackset: HackSet = {
    spec: 'ce.hackset/1',
    device: { id: 'light', name: 'Ceiling light', channel: { type: 'ir', via: 'card-1' } },
    hacks: [
      { id: 'h_off', name: 'Lights off', kind: 'action', commands: [{ action: 'off' }], oracle: { type: 'camera', expect: 'off' }, inverse: { commands: [{ action: 'full' }] }, max_rate_hz: 1 },
      { id: 'h_dim', name: 'Dim room', kind: 'control', params: [{ id: 'p', name: 'Level', min: 0, max: 100, default: 50, step: 10 }], control: { archetype: 'ring', param: 'p' }, commands: [{ action: 'level', param: 'p' }], oracle: { type: 'camera', expect: 'luminance_tracks_param' }, inverse: { restore: 'p' }, max_rate_hz: 3 },
    ],
  };
  const spec: UiSpecPayload = { specId: 'spec_light', cardId: 'light', rev: 1, hackset };

  function setup(armed = true) {
    const hub = new FakeHub();
    hub.online.add('card-1');
    const targets = new TargetStore(hub);
    const steps = new StepLog(hub);
    const dispatcher = new Dispatcher({ hub });
    const t = targets.create({ cardId: 'light', driver, specId: 'spec_light', armed });
    t.verification = { off: 'pass', full: 'pass', up: 'pass', down: 'pass', level: 'pass' };
    const router = new ControlRouter({ targets, dispatcher, specs: { get: (id) => (id === spec.specId ? spec : undefined), list: () => [spec] }, steps, hub });
    return { hub, targets, router, t, dispatcher };
  }

  it('routes a hack press to a resolved exec.command in well under 50 ms, and refuses when not armed', () => {
    const { hub, router } = setup();
    const ev: ControlEventPayload = { widgetId: 'h_off', value: true, ts: Date.now(), specId: 'spec_light', phase: 'end' };
    const r = router.onControlEvent(ev);
    expect(r).toMatchObject({ ok: true, hackId: 'h_off', fired: 1 });
    expect(r.ms).toBeLessThan(50);
    const cmd = hub.of('exec.command')[0] as PayloadOf<'exec.command'>;
    expect(cmd.op).toMatchObject({ kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], khz: 38 });
    expect((cmd.op as { rawUs?: number[] }).rawUs?.length).toBe(2 + 40 * 2 + 1);
    // second press within the hack's 1 Hz budget is dropped
    expect(router.onControlEvent(ev)).toMatchObject({ ok: false, reason: 'rate limited' });
    const { router: disarmed } = setup(false);
    expect(disarmed.onControlEvent(ev)).toMatchObject({ ok: false, reason: 'not armed' });
  });

  it('drives a step composite from the tracked level and undoes with the inverse', async () => {
    vi.useFakeTimers();
    try {
      const { hub, router, t } = setup();
      t.stepIndex.level = 5;
      t.paramValues.p = 50;
      const r = router.onControlEvent({ widgetId: 'h_dim', value: 80, ts: 1, specId: 'spec_light', phase: 'end' });
      expect(r.ok).toBe(true);
      expect(r.fired).toBe(1); // first step now, the rest paced at >= 3 Hz
      await vi.advanceTimersByTimeAsync(2000);
      const cmds = hub.of('exec.command') as PayloadOf<'exec.command'>[];
      expect(cmds.length).toBe(2); // 5 -> 7: two "up" presses
      expect(cmds.every((c) => c.actionId === 'up')).toBe(true);
      expect(t.paramValues.p).toBe(80);
      const u = router.undo(t); // restores p to 50: 7 -> 5, two "down" presses (first now)
      expect(u.ok).toBe(true);
      expect(t.paramValues.p).toBe(50);
      await vi.advanceTimersByTimeAsync(2000);
      expect(hub.of('exec.command').filter((c: PayloadOf<'exec.command'>) => c.actionId === 'down').length).toBe(2);
      const off = router.onControlEvent({ widgetId: 'h_off', value: true, ts: 2, specId: 'spec_light', phase: 'end' });
      expect(off.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(400); // the 3 Hz light cap between IR sends
      const u2 = router.undo(t);
      expect(u2.ok).toBe(true);
      const last = hub.of('exec.command').at(-1) as PayloadOf<'exec.command'>;
      expect(last.actionId).toBe('full');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores controls bound to unverified actions and disarms everything on panic', () => {
    const { router, t, hub } = setup();
    t.verification.off = 'fail';
    expect(router.onControlEvent({ widgetId: 'h_off', value: true, ts: 1, specId: 'spec_light', phase: 'end' })).toMatchObject({ ok: false, reason: /unverified/ });
    const p = router.panic('test');
    expect(p.disarmed).toEqual(['light']);
    expect(t.armed).toBe(false);
    expect(hub.of('target.status').at(-1)).toMatchObject({ state: 'forged' });
  });
});

describe('voice relay helpers and scan prompts', () => {
  it('classifies intents and builds valid WAVs', () => {
    expect(classify('stop everything')).toBe('panic');
    expect(classify('undo that')).toBe('undo');
    expect(classify('scan the room')).toBe('scan');
    expect(classify('make resonance a big red lever')).toBe('edit');
    expect(classify('lights off')).toBe('hack');
    expect(classify('what is this?')).toBe('question');
    const pcm = new Uint8Array(16000 * 2);
    const wav = wavFromPcm16(pcm, 16000);
    expect(inspectWav(wav)).toMatchObject({ channels: 1, sampleRate: 16000, bitsPerSample: 16, durationMs: 1000 });
  });

  it('never asks SAM for people', () => {
    expect(scanPrompts({ CE_SCAN_PROMPTS: 'ceiling light, person, synthesizer' })).toEqual(['ceiling light', 'synthesizer']);
    expect(scanPrompts({})).toContain('electronic device');
  });
});
