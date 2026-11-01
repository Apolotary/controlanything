/**
 * The agent: wires the discovery loop and the control loop to the hub. One per server context (getAgent).
 *
 *   scan.frame -> ScanService (SAM 3.1 + QR pairing) -> scan.result
 *   target.select -> a Target -> runLoop (identify, link, research, drive, verify, forge, arm)
 *   exec.ack / sense.result -> Dispatcher · arm.confirm -> ArmService · control.event / panic -> ControlRouter
 *   voice.audio / voice.text -> VoiceRelay · gen3d.generate / gen3d.edit -> the forge
 */
import { type DeviceCardPayload, EXPERIMENTAL_TYPE, type Hack, type Message, type TargetSelectPayload, type UiSpecPayload } from '@ce/protocol';
import type { ServerContext } from '../context';
import { loadProfiles, type Profiles } from '../devices/profiles';
import { getForge } from '../gen3d';
import type { Forge } from '../gen3d/forge';
import type { HubMessageEvent } from '../hub';
import { createMuseChat, type FixtureMuse, type MuseChat } from '../muse/adapter';
import { createWebSearcher } from '../research/websearch';
import { createSam, type Sam } from '../scan/sam';
import { VoiceRelay } from '../voice/relay';
import { ArmService } from './arm';
import { BLACKOUT_ID, BREATHE_DAEMON_ID, BREATHE_ID, buildRoomSpec, ComboRunner, ROOM_CARD_ID, ROOM_SPEC_ID } from './combos';
import { ControlRouter } from './control';
import { DaemonRunner } from './daemons';
import { Dispatcher } from './dispatch';
import { hearBack } from './heard';
import { fixtureDriverDraft, WONDER_MODEL } from './drive';
import { macLocalInfo, type Roster } from './executors';
import { fixtureDeviceCard } from './identify';
import { runLoop } from './loop';
import { MacLocalExecutor } from './maclocal';
import { ScanService } from './scan';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import type { Target } from './types';

export interface Agent {
  targets: TargetStore;
  steps: StepLog;
  dispatcher: Dispatcher;
  scan: ScanService;
  control: ControlRouter;
  arm: ArmService;
  voice: VoiceRelay;
  daemons: DaemonRunner;
  combos: ComboRunner;
  /** the room's combos + daemons spec, once two or more verified devices exist */
  roomSpec(): UiSpecPayload | undefined;
  /** rebuild and broadcast the room spec now */
  publishRoom(): UiSpecPayload | undefined;
  profiles: Profiles;
  sam: Sam;
  roster: Roster;
  forge(): Forge | undefined;
  /** start the loop for a selection (returns the target, or undefined when nothing matched) */
  select(p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined;
  close(): void;
}

export interface AgentOptions {
  /** disable the in-process Mac executor (tests) */
  macLocal?: boolean;
  settleMs?: (t: Target, transport: 'midi' | 'ir' | 'local') => number;
  companionWaitMs?: number;
  learnIr?: boolean;
  prompts?: string[];
  /** replace the forge lookup (tests) */
  forge?: () => Forge | undefined;
}

const agents = new WeakMap<ServerContext, Agent>();

export function getAgent(ctx: ServerContext, opts: AgentOptions = {}): Agent {
  let a = agents.get(ctx);
  if (a) return a;
  a = createAgent(ctx, opts);
  agents.set(ctx, a);
  return a;
}

export function createAgent(ctx: ServerContext, opts: AgentOptions = {}): Agent {
  const log = ctx.log;
  const hub = ctx.hub;
  const muse = ctx.muse;
  // fixture mode: canned answers keyed by the json_schema name so the whole loop runs without a key
  if (muse.mode === 'fixture' && 'register' in muse) {
    (muse as FixtureMuse).register('device_card', fixtureDeviceCard as never);
    (muse as FixtureMuse).register('driver_draft', fixtureDriverDraft as never);
  }
  const wonder: MuseChat | undefined = muse.mode === 'live' ? createMuseChat({ ...ctx.config.muse, model: WONDER_MODEL }, { callLog: ctx.calls, log }) : undefined;
  const sam = createSam(ctx.config.muse, { callLog: ctx.calls, log });
  const web = createWebSearcher(ctx.config.muse, { callLog: ctx.calls });
  const profiles = loadProfiles();
  const macEnabled = opts.macLocal ?? (process.platform === 'darwin' && !process.env.VITEST && process.env.CE_MAC_LOCAL !== '0');
  const macLocal = new MacLocalExecutor(undefined, macEnabled);
  const roster: Roster = { devices: () => hub.devices(), macLocal: macLocal.available };
  const steps = new StepLog(hub, log);
  const targets = new TargetStore(hub, log);
  const dispatcher = new Dispatcher({ hub, macLocal, log });
  const arm = new ArmService({ hub, targets, steps, log });
  const forge = opts.forge ?? (() => getForge(ctx));
  let room: UiSpecPayload | undefined;
  let roomRev = 0;
  const specs = {
    get: (specId: string) => (specId === ROOM_SPEC_ID ? room : forge()?.get(specId)),
    list: () => [...(forge()?.list() ?? []), ...(room ? [room] : [])],
  };
  const heard = (line: string, wav: Uint8Array, signal?: AbortSignal) => hearBack({ transcriber: ctx.transcriber, recordDir: ctx.config.muse.recordDir, replayDir: ctx.config.muse.replayDir, log }, line, wav, signal);
  // room hacks: daemons start after a tap, combos run with a tap of their own
  const onRoomHack = (hack: Hack, spec: UiSpecPayload, value: number | boolean, from?: string) => {
    if (hack.kind === 'daemon') {
      const daemon = spec.hackset?.daemons?.find((dm) => dm.targets.some((t) => hack.commands.some((c) => c.action && t.hack)) && (dm.id === BREATHE_DAEMON_ID || dm.name === hack.name)) ?? spec.hackset?.daemons?.[0];
      const light = hack.commands[0]?.cardId ? targets.get(hack.commands[0].cardId) : undefined;
      if (!daemon || !light?.specId) return { ok: false, reason: 'daemon has no target spec', fired: 0, ms: 0 };
      if (value === false || value === 0) {
        daemons.stop(daemon.id, `stopped by ${from ?? 'the menu'}`);
        return { ok: true, hackId: hack.id, fired: 0, ms: 0 };
      }
      const bpm = typeof value === 'number' && value > 1 ? value : undefined;
      if (daemons.isRunning(daemon.id)) {
        if (bpm) daemons.setBpm(daemon.id, bpm, from === 'voice' ? 'voice' : 'menu');
        return { ok: true, hackId: hack.id, fired: 0, ms: 0 };
      }
      const roomT = combos.roomTarget(spec.specId);
      void arm
        .ask(roomT, { title: `Start ${daemon.name}?`, summary: `${daemon.blurb ?? daemon.name}; the light's brightness follows ${daemon.trigger.source.startsWith('device.') ? 'the synth tempo' : `${bpm ?? 120} bpm`} at <= 0.5 Hz`, actions: hack.commands.map((c) => ({ actionId: c.action, label: `${targets.get(c.cardId ?? '')?.card?.name ?? c.cardId}: ${c.action}`.slice(0, 40), verified: (targets.get(c.cardId ?? '')?.verification[c.action] ?? 'untested') as 'pass' | 'fail' | 'untested' | 'pending' })) })
        .then((r) => {
          if (r.armed) daemons.start(daemon, { specId: spec.specId, targetSpecId: light.specId!, cardId: light.cardId, bpm, source: from === 'voice' ? 'voice' : 'menu' });
        });
      return { ok: true, hackId: hack.id, fired: 0, ms: 0 };
    }
    void combos.run(hack, spec).catch((e) => log(`[combo] ${hack.id}: ${(e as Error).message}`));
    return { ok: true, hackId: hack.id, fired: 0, ms: 0 };
  };
  const control = new ControlRouter({ targets, dispatcher, specs, steps, hub, log, onRoomHack });
  const daemons = new DaemonRunner({ hub, steps, log, drive: control });
  const roster0: Roster = { devices: () => hub.devices(), macLocal: macLocal.available };
  const combos = new ComboRunner({ hub, targets, steps, dispatcher, sam, roster: roster0, arm, daemons, heard, readVolume: () => macLocal.currentVolume(), log });
  const publishRoom = (): UiSpecPayload | undefined => {
    const built = buildRoomSpec(targets.list(), (id) => specs.get(id), roomRev + 1);
    if (!built) return room;
    roomRev++;
    room = built;
    combos.roomTarget(ROOM_SPEC_ID);
    hub.broadcast('ui.spec', built);
    steps.note('forge', `room: ${built.hackset!.hacks.map((h) => h.name).join(' · ')}`, { cardId: ROOM_CARD_ID, kind: 'proof', evidence: 'assembled from verified drivers' });
    return built;
  };
  let roomTimer: ReturnType<typeof setTimeout> | undefined;
  targets.onChange((t) => {
    if (t.cardId === ROOM_CARD_ID || !['armed', 'forged', 'verified'].includes(t.state)) return;
    if (roomTimer) clearTimeout(roomTimer);
    roomTimer = setTimeout(() => publishRoom(), 300);
  });
  const scan = new ScanService({ sam, hub, pairing: ctx.pairing, targets, steps, dispatcher, log, prompts: opts.prompts });

  const latestSpecTarget = (cardId?: string): Target | undefined => {
    if (cardId) return targets.get(cardId);
    return targets
      .list()
      .filter((t) => t.specId)
      .sort((x, y) => y.since - x.since)[0];
  };
  const voice = new VoiceRelay({
    hub,
    transcriber: ctx.transcriber,
    log,
    actions: {
      panic: (reason) => {
        daemons.stopAll(reason);
        control.panic(reason);
      },
      undo: (cardId) => {
        // the newest thing that happened: a room combo or a device hack
        const t = latestSpecTarget(cardId);
        const comboAt = combos.lastRun?.startedAt ?? 0;
        if (comboAt && (!t || comboAt > t.since)) {
          void combos.undo();
          return true;
        }
        return t ? control.undo(t).ok : false;
      },
      hack: (text, cardId) => {
        const lower0 = text.toLowerCase();
        if (room?.hackset) {
          const blackout = room.hackset.hacks.find((h) => h.id === BLACKOUT_ID);
          const breathe = room.hackset.hacks.find((h) => h.id === BREATHE_ID);
          if (blackout && /black ?out|lights out everything|everything off/.test(lower0)) return onRoomHack(blackout, room, true, 'voice').ok;
          if (breathe && /breath/.test(lower0)) {
            if (/stop|pause|kill|end/.test(lower0)) return onRoomHack(breathe, room, false, 'voice').ok;
            const bpm = /(\d{2,3})\s*(bpm|beats)?/.exec(lower0);
            return onRoomHack(breathe, room, bpm ? Number(bpm[1]) : true, 'voice').ok;
          }
        }
        const t = latestSpecTarget(cardId);
        const spec = t?.specId ? forge()?.get(t.specId) : undefined;
        if (!t || !spec?.hackset) return false;
        const lower = text.toLowerCase();
        const hack = spec.hackset.hacks.find((h) => lower.includes(h.name.toLowerCase()) || lower.includes(h.id.toLowerCase()));
        if (!hack) return false;
        const m = /(\d{1,3})\s*(%|percent)?/.exec(lower);
        return control.runHack(t, hack.id, m ? Number(m[1]) : undefined).ok;
      },
      edit: async (instruction, specId) => {
        const f = forge();
        if (!f || !specId) return false;
        const r = await f.edit({ specId, instruction });
        return r.ok;
      },
      scan: () => steps.note('scan', 'scan requested by voice', { kind: 'proof' }),
      specFor: (cardId) => latestSpecTarget(cardId)?.specId,
    },
  });

  const loopDeps = { hub, targets, steps, dispatcher, roster, sam, spark: muse, wonder, web, profiles, forge, arm, log, companionWaitMs: opts.companionWaitMs, settleMs: opts.settleMs, learnIr: opts.learnIr };

  const select = (p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    if (p.cardId) {
      const existing = targets.get(p.cardId);
      if (!existing) return undefined;
      if (existing.abort) return existing; // already running
      if (existing.state === 'failed' || existing.state === 'needs-companion') {
        existing.runId = `run-${Date.now().toString(36)}`;
        void runLoop(loopDeps, existing, { userText: p.text, preferDeviceId: from.deviceId });
      }
      return existing;
    }
    if (p.deviceId) {
      // a paired client as the device (the Mac itself, the iPhone, the DevTerm)
      const info = p.deviceId === macLocalInfo().deviceId ? macLocalInfo() : hub.devices().find((d) => d.deviceId === p.deviceId);
      if (!info) return undefined;
      const existing = targets.list().find((t) => t.card?.notes === `device:${info.deviceId}`);
      if (existing) return existing;
      const card: DeviceCardPayload = {
        cardId: `dev-${info.deviceId}`,
        name: info.name,
        maker: info.kind === 'mac' ? 'Apple' : info.kind === 'iphone' ? 'Apple' : info.kind === 'devterm' ? 'ClockworkPi' : info.kind === 'cardputer' ? 'M5Stack' : 'unknown',
        model: info.kind,
        category: info.kind === 'iphone' ? 'phone' : info.kind === 'cardputer' ? 'microcontroller' : 'computer',
        confidence: 1,
        protocols: ['other'],
        evidence: [`paired client ${info.deviceId} (${info.kind})`],
        requires: ['local'],
        notes: `device:${info.deviceId}`,
        source: 'live',
      };
      const t = targets.create({ cardId: card.cardId, card, selectedBy: from.deviceId });
      hub.broadcast('device.card', card);
      targets.setState(t, 'identified', `${info.name}, a paired ${info.kind}`);
      void runLoop(loopDeps, t, { userText: p.text, preferDeviceId: info.deviceId });
      return t;
    }
    if (p.frameId && p.detId) {
      const det = scan.detection(p.frameId, p.detId);
      if (!det) return undefined;
      const known = targets.list().find((t) => t.detection && t.detection.sensorDeviceId === det.sensorDeviceId && t.detection.detId === det.detId);
      if (known) return select({ cardId: known.cardId, text: p.text }, from);
      const t = targets.create({ detection: det, selectedBy: from.deviceId });
      targets.setState(t, 'scanned', `${det.label} selected by ${from.name ?? from.deviceId}`);
      void runLoop(loopDeps, t, { userText: p.text, preferDeviceId: from.deviceId });
      return t;
    }
    return undefined;
  };

  const onMessage = (e: HubMessageEvent): void => {
    if (EXPERIMENTAL_TYPE.test(e.message.type)) return;
    const m = e.message as Message;
    const from = { deviceId: e.device.deviceId, name: e.device.name, canApprove: e.device.canApprove, local: e.connection.local };
    switch (m.type) {
      case 'scan.frame':
        void scan.onFrame(m.payload, from);
        return;
      case 'target.select':
        select(m.payload, from);
        return;
      case 'exec.ack':
        dispatcher.onAck(m.payload);
        return;
      case 'sense.result':
        dispatcher.onSense(m.payload);
        return;
      case 'arm.confirm':
        arm.onConfirm(m.payload, from);
        return;
      case 'control.event': {
        const r = control.onControlEvent(m.payload, from.deviceId);
        if (!r.ok && r.reason && r.reason !== 'not armed' && r.reason !== 'rate limited') log(`[control] ${m.payload.widgetId}: ${r.reason}`);
        return;
      }
      case 'panic':
        daemons.stopAll(m.payload.reason ?? 'panic');
        control.panic(m.payload.reason ?? `panic from ${from.name}`, m.payload.cardId);
        return;
      case 'device.signal':
        daemons.onSignal(m.payload, from.deviceId);
        return;
      case 'voice.audio':
        void voice.onAudio(m.payload);
        return;
      case 'voice.text':
        void voice.onText(m.payload);
        return;
      case 'gen3d.generate': {
        const f = forge();
        if (!f) return;
        void f.generateFor(m.payload.cardId, { request: m.payload.request, runId: m.payload.requestId }).catch((err) => log(`[gen3d] generate: ${(err as Error).message}`));
        return;
      }
      case 'gen3d.edit': {
        const f = forge();
        if (!f) return;
        void f.edit({ specId: m.payload.specId, instruction: m.payload.instruction, runId: m.payload.requestId }).catch((err) => log(`[gen3d] edit: ${(err as Error).message}`));
        return;
      }
      default:
        return;
    }
  };
  const unsubscribe = hub.onMessage(onMessage);

  return {
    targets,
    steps,
    dispatcher,
    scan,
    control,
    arm,
    voice,
    daemons,
    combos,
    roomSpec: () => room,
    publishRoom,
    profiles,
    sam,
    roster,
    forge,
    select,
    close: () => {
      unsubscribe();
      if (roomTimer) clearTimeout(roomTimer);
      daemons.close();
      for (const t of targets.list()) t.abort?.abort();
      control.close();
      arm.close();
      dispatcher.close();
    },
  };
}
