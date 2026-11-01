import { readFileSync } from 'node:fs';
import type { Daemon, Driver, HackSet, PayloadOf, UiSpecPayload } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CallLog } from '../muse/callLog';
import { decodeJpeg, encodeJpeg } from '../oracle/image';
import { roomImage } from '../oracle/oracle.test';
import { FixtureSam } from '../scan/sam';
import { ArmService } from './arm';
import { BLACKOUT_ID, BREATHE_DAEMON_ID, BREATHE_ID, buildRoomSpec, ComboRunner, SAY_LINE_ID } from './combos';
import { ControlRouter } from './control';
import { DaemonRunner, periodMs, waveValue } from './daemons';
import { Dispatcher } from './dispatch';
import { clipDurationMs, hearBack, similarity } from './heard';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import type { Target } from './types';

const FIXTURES = new URL('../../fixtures/', import.meta.url).pathname;
/** A real recording of a spoken line (macOS TTS, 24 kHz mono WAV) that Muse Voice Transcribe heard once for real; the transcript replays from fixtures/recorded/transcribe. */
const SAID_LINE = 'make it brighter, but keep the note tail.';
const SAID_WAV = readFileSync(`${FIXTURES}audio/make-it-brighter-but-keep-the-note-tail.wav`).toString('base64');

/** A hub whose "devices" answer exec.command and sense.request in-process. */
class RoomHub {
  sent: { to?: string; type: string; payload: any }[] = [];
  lamp = { on: true, level: 2 };
  macVolume = 55;
  printed: unknown[] = [];
  dispatcher!: Dispatcher;
  online = new Set(['card-1', 'devterm-1', 'quest-1']);
  broadcast(type: string, payload: unknown): number {
    this.sent.push({ type, payload });
    return 1;
  }
  sendToDevice(deviceId: string, type: string, payload: any): number {
    if (!this.online.has(deviceId)) return 0;
    this.sent.push({ to: deviceId, type, payload });
    if (type === 'exec.command') {
      const op = payload.op;
      if (op.kind === 'ir') {
        const key = op.ref?.split('/').pop() ?? '';
        if (key === 'off') this.lamp.on = false;
        if (key === 'fullOn') {
          this.lamp.on = true;
          this.lamp.level = 3;
        }
        if (key === 'brighter') this.lamp.level = Math.min(3, this.lamp.level + 1);
        if (key === 'dimmer') this.lamp.level = Math.max(0, this.lamp.level - 1);
      }
      if (op.kind === 'local' && op.op === 'print') this.printed.push(op.arg);
      setTimeout(() => this.dispatcher.onAck({ execId: payload.execId, ok: true, sentAt: Date.now() }), 0);
    }
    if (type === 'sense.request' && payload.kind === 'audio-clip') {
      // the microphone client "hears" the Mac: a real recording of the line, which the real model transcribed once
      setTimeout(() => this.dispatcher.onSense({ senseId: payload.senseId, kind: 'audio-clip', at: Date.now(), ok: true, clip: { wav: SAID_WAV, sampleRate: 24_000, durationMs: 2454, input: 'test microphone' } }), 0);
      return 1;
    }
    if (type === 'sense.request' && payload.kind === 'frame') {
      const img = roomImage({ bg: this.lamp.on ? 70 + this.lamp.level * 12 : 50, lamp: this.lamp.on ? 120 + this.lamp.level * 40 : 60 });
      const jpeg = Buffer.from(encodeJpeg(img, 90)).toString('base64');
      setTimeout(() => this.dispatcher.onSense({ senseId: payload.senseId, kind: 'frame', at: Date.now(), frame: { frameId: 'vf', jpeg, width: 320, height: 240, capturedAt: Date.now(), purpose: 'verify', camera: { source: 'synthetic' } } }), 0);
    }
    return 1;
  }
  devices() {
    return [
      { deviceId: 'card-1', name: 'Cardputer', kind: 'cardputer' as const, role: 'device' as const, capabilities: ['ir' as const], canApprove: false, online: this.online.has('card-1'), connections: 1, pairedAt: 1 },
      { deviceId: 'devterm-1', name: 'DevTerm', kind: 'devterm' as const, role: 'device' as const, capabilities: ['local' as const, 'printer' as const], canApprove: false, online: this.online.has('devterm-1'), connections: 1, pairedAt: 2 },
      { deviceId: 'quest-1', name: 'Quest', kind: 'quest' as const, role: 'hmd' as const, capabilities: ['camera' as const, 'mic' as const], canApprove: true, online: true, connections: 1, pairedAt: 3 },
    ];
  }
  of(type: string): any[] {
    return this.sent.filter((s) => s.type === type).map((s) => s.payload);
  }
}

const lightDriver: Driver = {
  driverId: 'drv-light',
  cardId: 'ceiling-light-1',
  transport: 'ir',
  executor: { deviceId: 'card-1' },
  provenance: [],
  actions: [
    { actionId: 'off', label: 'Lights off', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2f, 0x26], ref: 'lib:panasonic/ch1/off' }, expect: { sense: 'camera', effect: 'off' }, inverseActionId: 'full' },
    { actionId: 'full', label: 'Full on', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2c, 0x25], ref: 'lib:panasonic/ch1/fullOn' }, expect: { sense: 'camera', effect: 'on' }, inverseActionId: 'off' },
    { actionId: 'brighter', label: 'Brighter', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2a, 0x23], ref: 'lib:panasonic/ch1/brighter' }, expect: { sense: 'camera', effect: 'brighter' } },
    { actionId: 'dimmer', label: 'Dimmer', kind: 'trigger', encode: { kind: 'ir', protocol: 'AEHA', bytes: [0x2c, 0x52, 0x09, 0x2b, 0x22], ref: 'lib:panasonic/ch1/dimmer' }, expect: { sense: 'camera', effect: 'dimmer' } },
    { actionId: 'level', label: 'Brightness', kind: 'set', range: { min: 0, max: 100, step: 10 }, encode: { kind: 'step', upActionId: 'brighter', downActionId: 'dimmer', steps: 4, settleMs: 10 }, expect: { sense: 'camera', effect: 'any' } },
  ],
};
const lightSpec: UiSpecPayload = {
  specId: 'spec_ceiling-light-1',
  cardId: 'ceiling-light-1',
  rev: 1,
  hackset: {
    spec: 'ce.hackset/1',
    device: { id: 'ceiling-light-1', name: 'Ceiling light', channel: { type: 'ir' } },
    hacks: [
      { id: 'h_bright', name: 'Set brightness', kind: 'control', params: [{ id: 'p', name: 'Level', min: 0, max: 100, default: 60, step: 10 }], control: { archetype: 'ring', param: 'p' }, commands: [{ action: 'level', param: 'p' }], oracle: { type: 'camera', expect: 'luminance_tracks_param' }, inverse: { restore: 'p' }, max_rate_hz: 3 },
      { id: 'h_off', name: 'Turn off', kind: 'action', commands: [{ action: 'off' }], oracle: { type: 'camera', expect: 'off' }, inverse: { commands: [{ action: 'full' }] }, max_rate_hz: 1 },
    ],
  },
};
const macDriver: Driver = {
  driverId: 'drv-mac',
  cardId: 'dev-mac-local',
  transport: 'local',
  executor: { deviceId: 'mac-local' },
  provenance: [],
  actions: [
    { actionId: 'volume', label: 'Volume', kind: 'set', range: { min: 0, max: 100, step: 5 }, encode: { kind: 'local', op: 'volume', arg: '$value' }, expect: { sense: 'ack', effect: 'any' } },
    { actionId: 'say', label: 'Say hello', kind: 'trigger', encode: { kind: 'local', op: 'say', arg: SAID_LINE }, expect: { sense: 'audio', effect: 'louder' } },
  ],
};
const devtermDriver: Driver = {
  driverId: 'drv-dt',
  cardId: 'dev-devterm-1',
  transport: 'local',
  executor: { deviceId: 'devterm-1' },
  provenance: [],
  actions: [{ actionId: 'print', label: 'Print receipt', kind: 'trigger', encode: { kind: 'local', op: 'print', arg: { title: 'BLACKOUT' } }, expect: { sense: 'ack', effect: 'any' } }],
};

function setup(opts: { devterm?: boolean; mac?: boolean } = {}) {
  const hub = new RoomHub();
  const targets = new TargetStore(hub);
  const steps = new StepLog(hub);
  const macCalls: string[][] = [];
  const mac = { available: true, deviceId: 'mac-local', exec: async (op: any) => (op.kind === 'local' ? { ok: true, detail: `${op.op} ${op.arg}` } : { ok: false, error: 'unsupported' as const }), currentVolume: async () => hub.macVolume } as any;
  const dispatcher = new Dispatcher({ hub, macLocal: mac });
  hub.dispatcher = dispatcher;
  const lampPoly: [number, number][] = Array.from({ length: 8 }, (_, i) => [Math.round(160 + 36 * Math.cos((i / 8) * 6.283)), Math.round(60 + 36 * Math.sin((i / 8) * 6.283))]);
  const light = targets.create({
    cardId: 'ceiling-light-1',
    card: { cardId: 'ceiling-light-1', name: 'Ceiling light', maker: 'unknown', model: 'unknown', category: 'lighting', confidence: 0.5, protocols: ['ir'], evidence: [] },
    detection: { frameId: 'f', detId: 'f:0', sensorDeviceId: 'quest-1', label: 'ceiling light', prompt: 'ceiling light', score: 0.9, box: [124, 24, 72, 72], polygon: lampPoly, width: 320, height: 240, jpeg: '', capturedAt: 1 },
    driver: lightDriver,
    specId: lightSpec.specId,
    armed: true,
  });
  light.state = 'armed';
  light.verification = { off: 'pass', full: 'pass', brighter: 'pass', dimmer: 'pass', level: 'pass' };
  let macT: Target | undefined;
  if (opts.mac !== false) {
    macT = targets.create({ cardId: 'dev-mac-local', card: { cardId: 'dev-mac-local', name: 'This Mac', maker: 'Apple', model: 'mac', category: 'computer', confidence: 1, protocols: ['other'], evidence: [], notes: 'device:mac-local' }, driver: macDriver, armed: true });
    macT.state = 'armed';
    macT.verification = { volume: 'pass', say: 'pass' };
  }
  if (opts.devterm !== false) {
    const dt = targets.create({ cardId: 'dev-devterm-1', card: { cardId: 'dev-devterm-1', name: 'DevTerm', maker: 'ClockworkPi', model: 'devterm', category: 'computer', confidence: 1, protocols: ['other'], evidence: [], notes: 'device:devterm-1' }, driver: devtermDriver, armed: true });
    dt.state = 'armed';
    dt.verification = { print: 'pass' };
  }
  const roster = { devices: () => hub.devices(), macLocal: true };
  const arm = new ArmService({ hub, targets, steps, timeoutMs: 2000 });
  let room: UiSpecPayload | undefined;
  const specs = { get: (id: string) => (id === 'spec_room' ? room : id === lightSpec.specId ? lightSpec : undefined), list: () => [lightSpec, ...(room ? [room] : [])] };
  const sam = new FixtureSam({ callLog: new CallLog(() => {}) });
  const calls: { spec: string; hack: string; value: number }[] = [];
  const daemons = new DaemonRunner({ hub, steps, drive: { setParam: (spec, hack, _p, value) => (calls.push({ spec, hack, value }), true) } });
  // the say-line oracle in FIXTURE mode: the transcript Muse Voice Transcribe produced for this very recording replays from fixtures/recorded
  const transcriber = { mode: 'fixture' as const, model: 'fixture', transcribe: async () => ({ text: '[FIXTURE] what is this device?', source: 'fixture' as const, model: 'fixture', durationMs: 1 }) };
  const heard = (line: string, wav: Uint8Array) => hearBack({ transcriber, replayDir: `${FIXTURES}recorded` }, line, wav);
  const combos = new ComboRunner({ hub, targets, steps, dispatcher, sam, roster, arm, daemons, heard, readVolume: () => mac.currentVolume() });
  const control = new ControlRouter({ targets, dispatcher, specs, steps, hub });
  room = buildRoomSpec(targets.list(), specs.get);
  return { hub, targets, steps, dispatcher, arm, combos, daemons, control, room, calls, macCalls, light };
}

describe('room spec', () => {
  it('assembles Blackout and Breathe from the verified drivers and names what is missing', () => {
    const { room } = setup();
    expect(room).toBeDefined();
    const blackout = room!.hackset!.hacks.find((h) => h.id === BLACKOUT_ID)!;
    expect(blackout.commands.map((c) => [c.cardId, c.action, c.value])).toEqual([
      ['ceiling-light-1', 'off', undefined],
      ['dev-mac-local', 'volume', 0],
      ['dev-devterm-1', 'print', undefined],
    ]);
    expect(blackout.inverse?.commands?.map((c) => c.action)).toEqual(['full', 'volume']);
    const breathe = room!.hackset!.hacks.find((h) => h.id === BREATHE_ID)!;
    expect(breathe.kind).toBe('daemon');
    const sayLine = room!.hackset!.hacks.find((h) => h.id === SAY_LINE_ID)!;
    expect(sayLine.commands).toEqual([{ cardId: 'dev-mac-local', action: 'say' }]);
    expect(sayLine.oracle.type).toBe('mic');
    expect(sayLine.status).toBe('verified');
    expect(setup({ mac: false }).room!.hackset!.hacks.some((h) => h.id === SAY_LINE_ID)).toBe(false);
    const daemon = room!.hackset!.daemons!.find((d) => d.id === BREATHE_DAEMON_ID)!;
    expect(daemon.targets).toEqual([{ hack: 'h_bright', param: 'p' }]);
    expect(daemon.max_rate_hz).toBeLessThanOrEqual(1);
    expect(room!.gen3d!.parts.some((p) => p.archetype === 'daemon-link')).toBe(true);
    const { room: noDevterm } = setup({ devterm: false });
    expect(noDevterm!.hackset!.notes).toMatch(/DevTerm/);
    expect(noDevterm!.hackset!.hacks.find((h) => h.id === BLACKOUT_ID)!.commands).toHaveLength(2);
  });
});

describe('Blackout combo', () => {
  it('asks for a tap, runs every step with evidence, skips an offline device, and undoes what it can', async () => {
    const s = setup();
    s.hub.online.delete('devterm-1'); // the DevTerm went offline: its receipt is skipped and said so
    const blackout = s.room!.hackset!.hacks.find((h) => h.id === BLACKOUT_ID)!;
    const p = s.combos.run(blackout, s.room!);
    await new Promise((r) => setTimeout(r, 20));
    const req = s.hub.of('arm.request').at(-1) as PayloadOf<'arm.request'>;
    expect(req.title).toMatch(/Blackout/);
    expect(s.arm.onConfirm({ armId: req.armId, approve: true, hold: true }, { deviceId: 'quest-1', name: 'Quest', canApprove: true })).toBe(true);
    const run = await p;
    expect(run.confirmed).toBe(true);
    expect(run.steps.map((st) => [st.name, st.ok, st.skipped])).toEqual([
      ['Ceiling light', true, undefined],
      ['This Mac', true, undefined],
      ['DevTerm', false, 'offline'],
    ]);
    expect(s.hub.lamp.on).toBe(false);
    const evidence = s.hub.of('verify.result') as PayloadOf<'verify.result'>[];
    expect(evidence.find((e) => e.actionId === 'off')?.pass).toBe(true);
    expect(evidence.find((e) => e.actionId === 'volume')?.observed.metric).toBe('ack');
    const undo = await s.combos.undo();
    expect(undo.restored.join(' ')).toMatch(/Ceiling light/);
    expect(undo.restored.join(' ')).toMatch(/55/); // the Mac volume read before muting
    expect(s.hub.lamp.on).toBe(true);
    // a receipt cannot be unprinted
    const s2 = setup();
    const p2 = s2.combos.run(s2.room!.hackset!.hacks.find((h) => h.id === BLACKOUT_ID)!, s2.room!);
    await new Promise((r) => setTimeout(r, 20));
    const req2 = s2.hub.of('arm.request').at(-1) as PayloadOf<'arm.request'>;
    s2.arm.onConfirm({ armId: req2.armId, approve: true, hold: true }, { deviceId: 'quest-1', canApprove: true });
    const run2 = await p2;
    expect(run2.steps.every((st) => st.ok)).toBe(true);
    expect(s2.hub.printed).toHaveLength(1);
    const undo2 = await s2.combos.undo();
    expect(undo2.cannot).toEqual(['paper']);
    expect(undo2.restored).toHaveLength(2);
  });

  it('declined tap runs nothing', async () => {
    const s = setup();
    const blackout = s.room!.hackset!.hacks.find((h) => h.id === BLACKOUT_ID)!;
    const p = s.combos.run(blackout, s.room!);
    await new Promise((r) => setTimeout(r, 20));
    const req = s.hub.of('arm.request').at(-1) as PayloadOf<'arm.request'>;
    s.arm.onConfirm({ armId: req.armId, approve: false }, { deviceId: 'quest-1', canApprove: true });
    const run = await p;
    expect(run.confirmed).toBe(false);
    expect(run.steps).toHaveLength(0);
    expect(s.hub.lamp.on).toBe(true);
  });
});

describe('Say line hack', () => {
  it('speaks after a tap, the mic client records, Muse Voice Transcribe (recorded) hears the line back; nothing to undo', async () => {
    const s = setup();
    const sayLine = s.room!.hackset!.hacks.find((h) => h.id === SAY_LINE_ID)!;
    const p = s.combos.run(sayLine, s.room!);
    await new Promise((r) => setTimeout(r, 20));
    const req = s.hub.of('arm.request').at(-1) as PayloadOf<'arm.request'>;
    expect(req.title).toMatch(/Say line/);
    expect(s.arm.onConfirm({ armId: req.armId, approve: true }, { deviceId: 'quest-1', name: 'Quest', canApprove: true })).toBe(true);
    const run = await p;
    expect(run.confirmed).toBe(true);
    expect(run.steps.map((st) => [st.name, st.ok, st.skipped])).toEqual([['This Mac', true, undefined]]);
    // the Mac was asked to say exactly the line, nothing else reached it
    const said = s.hub.of('exec.command').filter((e) => e.op?.kind === 'local' && e.op.op === 'say');
    expect(said).toHaveLength(0); // mac-local runs in-process, not through the hub
    const evidence = (s.hub.of('verify.result') as PayloadOf<'verify.result'>[]).find((e) => e.actionId === 'say')!;
    expect(evidence.pass).toBe(true);
    expect(evidence.observed.metric).toBe('transcript');
    expect(evidence.observed.after).toBeGreaterThanOrEqual(0.5);
    expect(evidence.observed.note).toMatch(/muse-voice-transcribe-1\.0 \(FIXTURE replay\) heard "make it brighter/);
    expect(evidence.note).toMatch(/heard back by muse-voice-transcribe-1\.0/);
    const undo = await s.combos.undo();
    expect(undo).toEqual({ restored: [], cannot: [] });
  });
});

describe('Breathe daemon', () => {
  it('maps tempo to a wave no faster than 0.5 Hz and writes at most once a second', () => {
    expect(periodMs(120, 2)).toBe(4000); // 2 bars of 4 beats at 120 bpm
    expect(periodMs(300, 1)).toBe(2000); // never faster than 0.5 Hz
    expect(waveValue('sine', 0.25, 0, 100)).toBe(100);
    expect(waveValue('sine', 0.75, 0, 100)).toBeCloseTo(0, 6);
    expect(waveValue('step', 0.2, 20, 80)).toBe(80);
    expect(waveValue('linear', 0.25, 0, 100)).toBe(50);
  });

  it('follows MIDI clock, falls back to a menu/voice bpm, and stops on panic', () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const daemon = s.room!.hackset!.daemons!.find((d) => d.id === BREATHE_DAEMON_ID)!;
      const d2: Daemon = { ...daemon, trigger: { source: 'device.synth-1.clock_bpm' } };
      const status = s.daemons.start(d2, { specId: 'spec_room', targetSpecId: lightSpec.specId, cardId: 'ceiling-light-1' });
      expect(status).toMatchObject({ state: 'running', bpm: 120, source: 'default', rateHz: 1 });
      vi.advanceTimersByTime(4000);
      const writes = s.calls.filter((c) => c.hack === 'h_bright');
      expect(writes.length).toBeGreaterThanOrEqual(3);
      expect(writes.length).toBeLessThanOrEqual(5); // 1 Hz
      expect(Math.max(...writes.map((w) => w.value))).toBeGreaterThan(80);
      expect(Math.min(...writes.map((w) => w.value))).toBeLessThan(20);
      s.daemons.onSignal({ signal: 'clock_bpm', value: 90, at: Date.now(), cardId: 'synth-1' }, 'sim-1');
      expect(s.daemons.list()[0]).toMatchObject({ bpm: 90, source: 'midi-clock' });
      expect(s.daemons.setBpm(d2.id, 60, 'voice')).toBe(true);
      expect(s.hub.of('daemon.status').at(-1)).toMatchObject({ bpm: 60, source: 'voice' });
      expect(s.daemons.stopAll('panic')).toBe(1);
      expect(s.daemons.list()).toHaveLength(0);
      expect(s.hub.of('daemon.status').at(-1)).toMatchObject({ state: 'stopped' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('say-line oracle', () => {
  it('scores transcripts and sizes the clip', async () => {
    expect(similarity('Control everything is online.', 'control everything is online')).toBe(1);
    expect(similarity('Control everything is online.', 'Control everything is on line')).toBeGreaterThan(0.5);
    expect(similarity('Control everything is online.', 'the weather is nice today')).toBeLessThan(0.3);
    expect(similarity('hello', '')).toBe(0);
    expect(clipDurationMs('Control everything is online.')).toBeGreaterThan(2500);
    const heard = await hearBack({ transcriber: { mode: 'live', model: 'muse-voice-transcribe-1.0', transcribe: async () => ({ text: 'Control everything is online', source: 'live', model: 'muse-voice-transcribe-1.0', durationMs: 2000 }) } }, 'Control everything is online.', new Uint8Array(44));
    expect(heard).toMatchObject({ pass: true, similarity: 1, model: 'muse-voice-transcribe-1.0' });
    const miss = await hearBack({ transcriber: { mode: 'fixture', model: 'fixture', transcribe: async () => ({ text: '[FIXTURE] what is this device?', source: 'fixture', model: 'fixture', durationMs: 2000 }) } }, 'Control everything is online.', new Uint8Array(44));
    expect(miss.pass).toBe(false);
  });
});

describe('room hacks through the control router', () => {
  it('hands daemon and cross-device hacks to the room runner instead of firing them', () => {
    const s = setup();
    s.combos.roomTarget('spec_room'); // publishRoom() creates the room target before anyone can press its hacks
    const seen: string[] = [];
    const control = new ControlRouter({ targets: s.targets, dispatcher: s.dispatcher, specs: { get: (id) => (id === 'spec_room' ? s.room : undefined), list: () => [s.room!] }, steps: s.steps, hub: s.hub, onRoomHack: (h) => (seen.push(h.id), { ok: true, fired: 0, ms: 0 }) });
    expect(control.onControlEvent({ widgetId: BLACKOUT_ID, value: true, ts: 1, specId: 'spec_room', phase: 'end' }).ok).toBe(true);
    expect(control.onControlEvent({ widgetId: BREATHE_ID, value: 90, ts: 1, specId: 'spec_room', phase: 'end' }).ok).toBe(true);
    expect(seen).toEqual([BLACKOUT_ID, BREATHE_ID]);
    expect(s.hub.of('exec.command')).toHaveLength(0);
    // a device hack still fires directly (the light's own spec)
    const direct = new ControlRouter({ targets: s.targets, dispatcher: s.dispatcher, specs: { get: (id) => (id === lightSpec.specId ? lightSpec : undefined), list: () => [lightSpec] }, steps: s.steps, hub: s.hub });
    const r = direct.onControlEvent({ widgetId: 'h_off', value: true, ts: 1, specId: lightSpec.specId, phase: 'end' });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, fired: 1 });
  });
});

describe('room spec validates as gen3d', () => {
  it('is a valid ce.gen3d/1 spec', async () => {
    const { validateSpec } = await import('@ce/gen3d');
    const { room } = setup();
    const r = validateSpec(room!.gen3d);
    expect(r.ok, JSON.stringify((r as { issues?: unknown[] }).issues ?? r)).toBe(true);
    const parsed = (await import('@ce/protocol')).PayloadSchemas['ui.spec'].safeParse(room);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues.slice(0, 3))).toBe(true);
  });
});

export type { HackSet };
