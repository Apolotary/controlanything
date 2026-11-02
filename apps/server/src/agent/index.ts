/**
 * The agent: wires the discovery loop and the control loop to the hub. One per server context (getAgent).
 *
 *   scan.frame -> ScanService (SAM 3.1 + QR pairing) -> scan.result
 *   target.select -> a Target -> runLoop (identify, link, research, drive, verify, forge, arm)
 *   exec.ack / sense.result -> Dispatcher · arm.confirm -> ArmService · control.event / panic -> ControlRouter
 *   voice.audio / voice.text -> VoiceRelay · gen3d.generate / gen3d.edit -> the forge
 */
import { type DeviceCardPayload, EXPERIMENTAL_TYPE, newId, type TargetCancelPayload, type TargetRetryPayload, type Hack, type Message, type TargetSelectPayload, type UiSpecPayload } from '@ce/protocol';
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
import { CANCELLED_GUIDANCE, type TimedPhase } from './guidance';
import { subscribeForge } from './forgeBridge';
import { detachRouteBridge } from '../gen3d/routes';
import { MacLocalExecutor } from './maclocal';
import { loadRecordedSpeech } from './recordedSpeech';
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
  cancel(p: TargetCancelPayload): boolean;
  retry(p: TargetRetryPayload, from: { deviceId: string; name?: string }): Target | undefined;
  close(): void;
}

export interface AgentOptions {
  /** disable the in-process Mac executor (tests) */
  macLocal?: boolean;
  settleMs?: (t: Target, transport: 'midi' | 'ir' | 'local') => number;
  companionWaitMs?: number;
  phaseTimeoutMs?: Partial<Record<TimedPhase, number>>;
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
  // CE_MAC_SILENT=1: this Mac must stay silent; nothing audible runs and a recorded clip stands in for its voice
  const macLocal = new MacLocalExecutor(undefined, macEnabled, process.env.CE_MAC_SILENT === '1');
  const silentSpeech = macLocal.silent ? loadRecordedSpeech(undefined, log) : undefined;
  if (macLocal.silent) log('[silent] CE_MAC_SILENT=1: say / Music are not run and the volume is kept in memory; acks and evidence say so');
  // a sensor whose last reply timed out (a dead headset tab) yields to a healthy one for ~30 s
  const roster: Roster = { devices: () => hub.devices(), macLocal: macLocal.available, unhealthy: (id) => dispatcher.unhealthy(id) };
  const steps = new StepLog(hub, log);
  const targets = new TargetStore(hub, log);
  const dispatcher = new Dispatcher({ hub, macLocal, log });
  const arm = new ArmService({ hub, targets, steps, log });
  // Own the broadcast bridge so cancelled discovery runs cannot publish stale controls.
  const sharedForge = opts.forge ? undefined : getForge(ctx, { broadcast: false });
  const forge = opts.forge ?? (() => sharedForge);
  if (sharedForge) detachRouteBridge(sharedForge);
  const unsubscribeForge = sharedForge ? subscribeForge(sharedForge, hub, targets) : () => {};
  let room: UiSpecPayload | undefined;
  let roomRev = 0;
  const deviceSpec = (specId: string) => {
    const spec = forge()?.get(specId);
    const target = spec?.cardId ? targets.get(spec.cardId) : undefined;
    return target && spec?.driverId !== target.driver?.driverId ? undefined : spec;
  };
  const specs = {
    get: (specId: string) => (specId === ROOM_SPEC_ID ? room : deviceSpec(specId)),
    list: () => [...(forge()?.list().filter((spec) => deviceSpec(spec.specId)) ?? []), ...(room ? [room] : [])],
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
        // a new tempo retunes it; a plain second pinch on the menu row stops it (the row is a toggle)
        if (bpm) daemons.setBpm(daemon.id, bpm, from === 'voice' ? 'voice' : 'menu');
        else daemons.stop(daemon.id, `stopped by ${from ?? 'the menu'}`);
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
  const roster0: Roster = { devices: () => hub.devices(), macLocal: macLocal.available, unhealthy: (id) => dispatcher.unhealthy(id) };
  const combos = new ComboRunner({ hub, targets, steps, dispatcher, sam, roster: roster0, arm, daemons, heard, readVolume: () => macLocal.currentVolume(), silentSpeech, log });
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
  const unsubscribeTargets = targets.onChange((t) => {
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
        const spec = t?.specId ? specs.get(t.specId) : undefined;
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

  const loopDeps = { hub, targets, steps, dispatcher, roster, sam, spark: muse, wonder, web, profiles, forge, arm, heard, readVolume: () => macLocal.currentVolume(), silentSpeech, log, companionWaitMs: opts.companionWaitMs, phaseTimeoutMs: opts.phaseTimeoutMs, settleMs: opts.settleMs, learnIr: opts.learnIr };

  const stop = (t: Target, reason = 'cancelled') => {
    t.abort?.abort(new Error(reason));
    arm.cancel(t, reason);
    control.cancel(t);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    targets.setState(t, 'failed', reason, CANCELLED_GUIDANCE);
  };
  const focus = (t: Target, from: { deviceId: string }) => {
    for (const previous of targets.list()) {
      if (previous !== t && previous.selectedBy === from.deviceId && (previous.abort || previous.armId)) stop(previous, 'another device selected');
    }
    t.selectedBy = from.deviceId;
  };
  const start = (t: Target, from: { deviceId: string }, options: { userText?: string; preferDeviceId?: string }, initial = false) => {
    focus(t, from);
    t.abort?.abort(new Error('retrying'));
    arm.cancel(t, 'retrying');
    control.cancel(t);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    if (!initial) t.runId = newId('run-');
    t.selection = options;
    t.specId = undefined;
    t.controlCount = undefined;
    t.driver = undefined;
    t.link = undefined;
    t.verification = {};
    t.evidence = [];
    t.lastError = undefined;
    void runLoop(loopDeps, t, options);
  };
  const cancel = (p: TargetCancelPayload): boolean => {
    const t = targets.get(p.cardId);
    if (!t || (p.runId && p.runId !== t.runId)) return false;
    stop(t);
    return true;
  };
  const retry = (p: TargetRetryPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    const t = targets.get(p.cardId);
    if (!t || (p.runId && p.runId !== t.runId)) return undefined;
    // A declined or expired confirmation only needs another tap, not another physical test.
    if (!t.abort && t.specId && t.driver && ['forged', 'verified', 'armed', 'controlling'].includes(t.state)) return select({ cardId: t.cardId }, from);
    start(t, from, t.selection ?? { preferDeviceId: from.deviceId });
    return t;
  };

  const select = (p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    if (p.cardId) {
      const existing = targets.get(p.cardId);
      if (!existing) return undefined;
      focus(existing, from);
      if (existing.abort && !existing.abort.signal.aborted) return existing; // already running
      if (existing.state === 'failed' || existing.state === 'needs-companion') {
        start(existing, from, { ...existing.selection, ...(p.text ? { userText: p.text } : {}), preferDeviceId: existing.selection?.preferDeviceId ?? from.deviceId });
        return existing;
      }
      // a headset that (re)joined mid-session pinches a device it already owns: give it the card, the controls and the armed state again
      if (existing.specId && existing.card) {
        const spec = specs.get(existing.specId);
        hub.sendToDevice(from.deviceId, 'device.card', existing.card);
        if (spec) hub.sendToDevice(from.deviceId, 'ui.spec', spec);
        if (existing.driver) hub.sendToDevice(from.deviceId, 'driver.status', { driverId: existing.driver.driverId, cardId: existing.cardId, phase: existing.armed ? 'armed' : 'disarmed', actions: existing.driver.actions.map((a) => ({ actionId: a.actionId, verified: existing.verification[a.actionId] ?? 'untested' })), modelId: existing.driver.modelId });
      }
      if (!existing.armed && !existing.armId && existing.driver && (existing.state === 'forged' || existing.state === 'verified') && existing.cardId !== ROOM_CARD_ID) {
        // the ARM window closed without a pinch (or was declined): pinching the device again asks again
        const driver = existing.driver;
        const abort = new AbortController();
        existing.abort = abort;
        existing.runId = newId('run-');
        void arm.request(existing, driver, undefined, abort.signal).then((r) => {
          if (!abort.signal.aborted && r.armed) hub.broadcast('driver.status', { driverId: driver.driverId, cardId: existing.cardId, phase: 'armed', actions: driver.actions.map((a) => ({ actionId: a.actionId, verified: existing.verification[a.actionId] ?? 'untested' })), modelId: driver.modelId });
        }).finally(() => { if (existing.abort === abort) existing.abort = undefined; });
      }
      return existing;
    }
    if (p.deviceId) {
      // a paired client as the device (the Mac itself, the iPhone, the DevTerm)
      const info = p.deviceId === macLocalInfo().deviceId ? macLocalInfo() : hub.devices().find((d) => d.deviceId === p.deviceId);
      if (!info) return undefined;
      const existing = targets.list().find((t) => t.card?.notes === `device:${info.deviceId}`);
      if (existing) return select({ cardId: existing.cardId, text: p.text }, from); // retry, re-arm or resume like any known card
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
      start(t, from, { userText: p.text, preferDeviceId: info.deviceId }, true);
      return t;
    }
    if (p.frameId && p.detId) {
      const det = scan.detection(p.frameId, p.detId);
      if (!det) return undefined;
      const known = targets.list().find((t) => t.detection && t.detection.sensorDeviceId === det.sensorDeviceId && t.detection.detId === det.detId);
      if (known) return select({ cardId: known.cardId, text: p.text }, from);
      const t = targets.create({ detection: det, selectedBy: from.deviceId });
      targets.setState(t, 'scanned', `${det.label} selected by ${from.name ?? from.deviceId}`);
      start(t, from, { userText: p.text, preferDeviceId: from.deviceId }, true);
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
      case 'target.cancel':
        cancel(m.payload);
        return;
      case 'target.retry':
        retry(m.payload, from);
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
        for (const t of targets.list()) if ((!m.payload.cardId || t.cardId === m.payload.cardId) && (t.abort || t.armId)) stop(t, 'stopped');
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
    cancel,
    retry,
    close: () => {
      unsubscribe();
      unsubscribeTargets();
      unsubscribeForge();
      if (roomTimer) clearTimeout(roomTimer);
      daemons.close();
      for (const t of targets.list()) t.abort?.abort();
      control.close();
      arm.close();
      dispatcher.close();
    },
  };
}
