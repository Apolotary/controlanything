/**
 * The agent: wires the discovery loop and the control loop to the hub. One per server context (getAgent).
 *
 *   scan.frame -> ScanService (SAM 3.1 + QR pairing) -> scan.result
 *   tag.add / target.select -> identify only; control.setup -> link, research, drive, verify, forge, arm
 *   exec.ack / sense.result -> Dispatcher · arm.confirm -> ArmService · control.event / panic -> ControlRouter
 *   voice.audio / voice.text -> VoiceRelay · gen3d.generate / gen3d.edit -> the forge
 */
import { join } from 'node:path';
import { type DeviceCardPayload, EXPERIMENTAL_TYPE, newId, type TargetCancelPayload, type TargetRetryPayload, type Hack, type MessageType, type PayloadOf, type TargetSelectPayload, type UiSpecPayload, type Mode, type TagAddPayload, type TagsStatePayload } from '@ce/protocol';
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
import { cropJpeg, fixtureDeviceCard, identify, type IdentifyResult } from './identify';
import { decodeJpeg } from '../oracle/image';
import { runLoop } from './loop';
import { CANCELLED_GUIDANCE, type TimedPhase } from './guidance';
import { subscribeForge } from './forgeBridge';
import { detachRouteBridge } from '../gen3d/routes';
import { MacLocalExecutor } from './maclocal';
import { loadRecordedSpeech } from './recordedSpeech';
import { ScanService } from './scan';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { TagStore, evaluateConnection, tagCapability, tagSnapshot } from './tags';
import type { Target } from './types';

// Derive from the payload map so newly added protocol schemas participate in narrowing.
type AgentMessage = { [K in MessageType]: { type: K; payload: PayloadOf<K> } }[MessageType];

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
  /** Tag in annotation mode; reopen existing controls in control mode. */
  select(p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined;
  cancel(p: TargetCancelPayload): boolean;
  retry(p: TargetRetryPayload, from: { deviceId: string; name?: string }): Target | undefined;
  mode(): Mode;
  setMode(mode: Mode): void;
  tagsState(): TagsStatePayload;
  addTag(p: TagAddPayload, from: { deviceId: string; name?: string }): Target | undefined;
  removeTag(cardId: string): boolean;
  setup(cardId: string, from: { deviceId: string; name?: string }): Target | undefined;
  panic(reason?: string, cardId?: string): { disarmed: string[]; sent: number };
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
  /** null keeps tags in memory (tests). */
  tagsFile?: string | null;
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
  const tags = new TagStore(opts.tagsFile === null ? undefined : opts.tagsFile ?? join(ctx.config.dataDir, 'tags.json'));
  let mode: Mode = 'annotate';
  const setups = new Set<string>();
  for (const tag of tags.list()) targets.create({ ...tag, state: tag.armed ? 'armed' : tag.card ? 'identified' : 'scanned' });
  const connected = (t: Target) => tags.has(t.cardId) && evaluateConnection(t, roster).connection !== 'offline';
  const canControl = (t: Target) => mode === 'control' && tags.has(t.cardId) && evaluateConnection(t, roster).connection === 'ready';
  const dispatcher = new Dispatcher({ hub, macLocal, log, canExec: (request) => {
    const t = request.cardId ? targets.get(request.cardId) : undefined;
    if (request.op.kind === 'midi' && request.op.msg === 'panic') return t?.driver?.executor.deviceId === request.executorDeviceId;
    if (!t || mode !== 'control' || !connected(t) || !t.driver) return false;
    if (t.driver.executor.deviceId !== request.executorDeviceId || (request.port && t.driver.executor.port !== request.port)) return false;
    if (request.driverId && request.driverId !== t.driver.driverId) return false;
    if (canControl(t)) return (request.op.kind === 'midi' && request.op.msg === 'panic') || Boolean(request.actionId && t.verification[request.actionId] === 'pass');
    return setups.has(t.cardId) && t.state === 'verifying' && Boolean(t.abort && !t.abort.signal.aborted);
  } });
  const arm = new ArmService({ hub, targets, steps, log, canArm: (t) => mode === 'control' && connected(t) && setups.has(t.cardId) });
  // Own the broadcast bridge so cancelled discovery runs cannot publish stale controls.
  const sharedForge = opts.forge ? undefined : getForge(ctx, { broadcast: false });
  const forge = opts.forge ?? (() => sharedForge);
  if (sharedForge) detachRouteBridge(sharedForge);
  const unsubscribeForge = sharedForge ? subscribeForge(sharedForge, hub, targets, (cardId) => {
    const t = targets.get(cardId);
    if (!t) return true; // HTTP / sample generations that no discovery run owns
    return mode === 'control' && tags.has(cardId) && (setups.has(cardId) || canControl(t));
  }) : () => {};
  let room: UiSpecPayload | undefined;
  let roomRev = 0;
  const deviceSpec = (specId: string) => {
    const spec = forge()?.get(specId) ?? tags.list().find((t) => t.uiSpec?.specId === specId)?.uiSpec;
    const target = spec?.cardId ? targets.get(spec.cardId) : undefined;
    return target && spec?.driverId !== target.driver?.driverId ? undefined : spec;
  };
  const specs = {
    get: (specId: string) => (specId === ROOM_SPEC_ID ? room : deviceSpec(specId)),
    list: () => [...new Map([...(forge()?.list() ?? []), ...tags.list().flatMap((t) => t.uiSpec ? [t.uiSpec] : [])].filter((spec) => deviceSpec(spec.specId)).map((spec) => [spec.specId, spec])).values(), ...(room ? [room] : [])],
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
  const control = new ControlRouter({ targets, dispatcher, specs, steps, hub, log, onRoomHack, canControl });
  const daemons = new DaemonRunner({ hub, steps, log, drive: control });
  const roster0: Roster = { devices: () => hub.devices(), macLocal: macLocal.available, unhealthy: (id) => dispatcher.unhealthy(id) };
  const combos = new ComboRunner({ hub, targets, steps, dispatcher, sam, roster: roster0, arm, daemons, heard, readVolume: () => macLocal.currentVolume(), silentSpeech, log, canControl });
  const publishRoom = (): UiSpecPayload | undefined => {
    if (mode !== 'control') return undefined;
    const built = buildRoomSpec(targets.list(), (id) => specs.get(id), roomRev + 1);
    if (!built) return room;
    roomRev++;
    room = built;
    combos.roomTarget(ROOM_SPEC_ID);
    hub.broadcast('ui.spec', built);
    steps.note('forge', `room: ${built.hackset!.hacks.map((h) => h.name).join(' · ')}`, { cardId: ROOM_CARD_ID, kind: 'proof', evidence: 'assembled from verified drivers' });
    return built;
  };
  const scan = new ScanService({ sam, hub, pairing: ctx.pairing, targets, steps, dispatcher, log, prompts: opts.prompts, enabled: () => mode === 'annotate' });

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
        panic(reason);
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
        const t = targets.list().find((t) => t.specId === specId);
        if (!t || !canControl(t)) return false;
        const f = forge();
        if (!f || !specId) return false;
        const r = await f.edit({ specId, instruction });
        return r.ok;
      },
      scan: () => steps.note('scan', 'scan requested by voice', { kind: 'proof' }),
      specFor: (cardId) => latestSpecTarget(cardId)?.specId,
    },
  });

  const restoreVolume = async (value: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    const result = await macLocal.exec({ kind: 'local', op: 'volume', arg: value });
    if (!result.ok) throw new Error(result.detail ?? 'volume restoration failed');
  };
  const loopDeps = { hub, targets, steps, dispatcher, roster, sam, spark: muse, wonder, web, profiles, forge, arm, heard, readVolume: () => macLocal.currentVolume(), restoreVolume, silentSpeech, log, companionWaitMs: opts.companionWaitMs, phaseTimeoutMs: opts.phaseTimeoutMs, settleMs: opts.settleMs, learnIr: opts.learnIr };

  const tagsState = (): TagsStatePayload => ({ tags: tags.list().map((tag) => tagSnapshot(tag, targets.get(tag.cardId)!, roster)) });
  const publishTags = () => hub.broadcast('tags.state', tagsState());
  const unsubscribeTags = targets.onChange((t) => {
    if (!tags.has(t.cardId)) return;
    tags.sync(t, t.specId ? specs.get(t.specId) : undefined);
    publishTags();
  });
  const stop = (t: Target, reason = 'cancelled') => {
    combos.cancel(t.cardId);
    setups.delete(t.cardId);
    t.abort?.abort(new Error(reason));
    arm.cancel(t, reason);
    control.cancel(t);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    targets.setState(t, 'failed', reason, CANCELLED_GUIDANCE);
  };
  const panic = (reason = 'panic', cardId?: string) => {
    combos.cancel(cardId);
    daemons.stopAll(reason);
    for (const t of targets.list()) if ((!cardId || t.cardId === cardId) && (t.abort || t.armId)) stop(t, reason);
    const result = control.panic(reason, cardId);
    hub.broadcast('panic', { reason, ...(cardId ? { cardId } : {}) });
    return result;
  };
  const setMode = (next: Mode) => {
    if (mode === next) return;
    mode = next;
    if (mode === 'annotate') {
      combos.cancel();
      daemons.stopAll('annotation mode');
      for (const t of targets.list()) {
        if ((setups.has(t.cardId) && !t.armed) || t.armId) stop(t, 'annotation mode');
        control.cancel(t, { preserveArmed: true });
      }
    }
    hub.broadcast('mode.state', { mode });
    publishTags();
  };
  // Tagging only names the device (one quiet Muse Spark call, no agent.step / target.status / pipeline messages):
  // the pipeline's own messages flow only after control.setup (research/20-two-modes.md).
  const identifying = new Map<string, AbortController>();
  const tagIdentity = new Map<string, Omit<IdentifyResult, 'card'>>();
  const identifyTag = (t: Target) => {
    if (t.card || !t.detection || t.abort || identifying.has(t.cardId)) return;
    const detection = t.detection;
    const abort = new AbortController();
    identifying.set(t.cardId, abort);
    void (async () => {
      try {
        const crop = cropJpeg(decodeJpeg(detection.jpeg), detection.box);
        const r = await identify(muse, detection, crop, detection.jpeg, { cardId: t.cardId, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]) });
        if (abort.signal.aborted || !tags.has(t.cardId) || t.card) return;
        t.card = r.card;
        const { card: _card, ...identity } = r;
        tagIdentity.set(t.cardId, identity);
        hub.broadcast('device.card', r.card);
        log(`[tag] ${t.cardId} is ${r.card.name} (${r.card.maker} ${r.card.model}) · ${r.model} ${r.latencyMs} ms`);
        publishTags();
      } catch (e) {
        if (!abort.signal.aborted) log(`[tag] could not name ${t.cardId}: ${(e as Error).message}`);
      } finally {
        if (identifying.get(t.cardId) === abort) identifying.delete(t.cardId);
      }
    })();
  };
  const addTag = (p: TagAddPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    if (mode !== 'annotate' || /\b(person|people|human|man|woman|child|face|hand|body)\b/i.test(p.label)) return undefined;
    const frame = p.frameId ? scan.frame(p.frameId) : scan.latest(from.deviceId);
    const match = frame?.detections.find((d) => (p.detId && d.detId === p.detId) || (p.targetId && (d.trackId === p.targetId || d.detId === p.targetId)));
    let t = p.targetId ? targets.get(p.targetId) : undefined;
    if (!t && match?.cardId) t = targets.get(match.cardId);
    const detection = frame ? scan.tagDetection(frame.frame.frameId, p.detId ?? match?.detId, p.label) : undefined;
    if (!t && detection) t = targets.list().find((known) => known.detection?.sensorDeviceId === detection.sensorDeviceId && known.detection.detId === detection.detId);
    if (!t && tags.list().length >= 64) return undefined;
    if (!t) t = targets.create({ ...(p.targetId ? { cardId: p.targetId } : {}), detection, selectedBy: from.deviceId });
    if (!tags.has(t.cardId) && tags.list().length >= 64) return undefined;
    t.selectedBy = from.deviceId;
    if (detection) t.detection = detection;
    tags.add(t, p.label, p.position);
    publishTags();
    identifyTag(t);
    return t;
  };
  const removeTag = (cardId: string): boolean => {
    if (!tags.has(cardId)) return false;
    identifying.get(cardId)?.abort();
    identifying.delete(cardId);
    const t = targets.get(cardId);
    if (t) {
      stop(t, 'device untagged');
      t.armed = false;
    }
    tags.remove(cardId);
    targets.remove(cardId);
    publishTags();
    return true;
  };
  const showControls = (t: Target, deviceId: string) => {
    if (t.card) hub.sendToDevice(deviceId, 'device.card', t.card);
    if (t.specId) {
      const spec = specs.get(t.specId);
      if (spec) hub.sendToDevice(deviceId, 'ui.spec', spec);
    }
    if (t.driver) hub.sendToDevice(deviceId, 'driver.status', { driverId: t.driver.driverId, cardId: t.cardId, phase: t.armed ? 'armed' : 'disarmed', actions: t.driver.actions.map((a) => ({ actionId: a.actionId, verified: t.verification[a.actionId] ?? 'untested' })), modelId: t.driver.modelId });
  };
  const setup = (cardId: string, from: { deviceId: string; name?: string }): Target | undefined => {
    const t = targets.get(cardId);
    const connection = t && tags.has(cardId) ? evaluateConnection(t, roster) : undefined;
    if (!t || !tags.has(cardId) || mode !== 'control' || connection?.connection === 'offline') {
      const hint = !t || !tags.has(cardId) ? 'Tag this device in Annotate mode first' : mode !== 'control' ? 'Switch to Control mode to set up this device' : connection?.hint ?? 'Connect a companion for this device';
      const state = tagsState();
      state.tags = state.tags.map((tag) => tag.cardId === cardId ? { ...tag, connection: 'offline', hint } : tag);
      hub.sendToDevice(from.deviceId, 'tags.state', state);
      steps.note('link', hint, { cardId, kind: 'proof', status: 'fail', sentence: hint, hint, action: mode === 'control' ? 'open-companion' : undefined });
      return undefined;
    }
    if (t.abort && !t.abort.signal.aborted) return t;
    if (canControl(t)) {
      showControls(t, from.deviceId);
      return t;
    }
    for (const previous of targets.list()) {
      if (previous !== t && previous.selectedBy === from.deviceId && setups.has(previous.cardId)) stop(previous, 'another device selected');
    }
    t.selectedBy = from.deviceId;
    arm.cancel(t, 'retrying');
    control.cancel(t);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    t.runId = newId('run-');
    setups.add(t.cardId);
    // A completed setup that was declined only needs a fresh ARM confirmation.
    if (t.specId && t.driver && Object.values(t.verification).includes('pass') && specs.get(t.specId)) {
      const abort = new AbortController();
      t.abort = abort;
      showControls(t, from.deviceId);
      void arm.request(t, t.driver, undefined, abort.signal).finally(() => {
        if (targets.get(t.cardId) === t && t.abort === abort) { t.abort = undefined; setups.delete(t.cardId); }
      });
      return t;
    }
    t.selection ??= { preferDeviceId: from.deviceId };
    const capability = tagCapability(t);
    if (t.card && capability) t.card.requires = [capability];
    if (capability === 'local') {
      const localDevices = hub.devices().filter((d) => d.online && d.capabilities.includes('local') && (d.kind === 'mac' || d.kind === 'sim'));
      const explicit = t.card?.notes?.match(/^device:(.+)$/)?.[1];
      const preferred = localDevices.find((d) => d.deviceId === t.selection?.preferDeviceId)?.deviceId;
      t.selection.preferDeviceId = explicit ?? preferred ?? (roster.macLocal ? macLocalInfo().deviceId : localDevices[0]?.deviceId);
    }
    t.specId = undefined;
    t.controlCount = undefined;
    t.driver = undefined;
    t.link = undefined;
    t.verification = {};
    t.evidence = [];
    t.armed = false;
    t.lastError = undefined;
    const runId = t.runId;
    void runLoop(loopDeps, t, { ...t.selection, identified: tagIdentity.get(t.cardId) }).finally(() => {
      if (targets.get(t.cardId) === t && t.runId === runId) { setups.delete(t.cardId); tags.sync(t, t.specId ? specs.get(t.specId) : undefined); publishTags(); }
    });
    return t;
  };
  const cancel = (p: TargetCancelPayload): boolean => {
    const t = targets.get(p.cardId);
    if (!t || !tags.has(t.cardId) || (p.runId && p.runId !== t.runId)) return false;
    stop(t);
    return true;
  };
  const retry = (p: TargetRetryPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    const t = targets.get(p.cardId);
    if (!t || !tags.has(t.cardId) || (p.runId && p.runId !== t.runId)) return undefined;
    if (mode === 'annotate') { identifyTag(t); return t; }
    return setup(t.cardId, from);
  };
  const select = (p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    if (mode === 'control') {
      const existing = p.cardId ? targets.get(p.cardId) : undefined;
      if (!existing || !tags.has(existing.cardId)) return undefined;
      if (canControl(existing)) showControls(existing, from.deviceId);
      publishTags();
      return existing;
    }
    if (p.deviceId) {
      const info = p.deviceId === macLocalInfo().deviceId && roster.macLocal ? macLocalInfo() : hub.devices().find((d) => d.deviceId === p.deviceId);
      if (!info) return undefined;
      let t = targets.list().find((known) => known.card?.notes === `device:${info.deviceId}`);
      if (!t) {
        const card: DeviceCardPayload = { cardId: `dev-${info.deviceId}`, name: info.name, maker: info.kind === 'mac' || info.kind === 'iphone' ? 'Apple' : 'unknown', model: info.kind,
          category: info.kind === 'iphone' ? 'phone' : 'computer', confidence: 1, protocols: ['other'], evidence: [`paired client ${info.deviceId} (${info.kind})`], requires: ['local'], notes: `device:${info.deviceId}`, source: 'live' };
        t = targets.create({ cardId: card.cardId, card, selection: { userText: p.text, preferDeviceId: info.deviceId } });
      }
      return addTag({ targetId: t.cardId, label: info.name.slice(0, 80) }, from);
    }
    const existing = p.cardId ? targets.get(p.cardId) : undefined;
    const det = p.frameId && p.detId ? scan.detection(p.frameId, p.detId) : undefined;
    if (!existing && !det) return undefined;
    return addTag({ targetId: existing?.cardId, frameId: p.frameId, detId: p.detId, label: existing?.card?.name.slice(0, 80) ?? existing?.detection?.label ?? det!.label }, from);
  };
  const unsubscribePresence = hub.onPresence((presence) => {
    if (presence.deviceId && (presence.reason === 'join' || presence.reason === 'update')) hub.sendToDevice(presence.deviceId, 'mode.state', { mode });
    for (const t of targets.list()) {
      if (!tags.has(t.cardId) || connected(t)) continue;
      if (setups.has(t.cardId)) stop(t, 'companion disconnected');
      control.cancel(t, { preserveArmed: true });
    }
    publishTags();
  });

  const onMessage = (e: HubMessageEvent): void => {
    if (EXPERIMENTAL_TYPE.test(e.message.type)) return;
    const m = e.message as AgentMessage;
    const from = { deviceId: e.device.deviceId, name: e.device.name, canApprove: e.device.canApprove, local: e.connection.local };
    if (['mode.set', 'tag.add', 'tag.remove', 'control.setup', 'target.select', 'target.retry'].includes(m.type) && !from.canApprove && !from.local) {
      hub.sendToDevice(from.deviceId, 'log', { level: 'error', code: 'forbidden', message: 'Only an owner may tag or set up devices.' });
      return;
    }
    switch (m.type) {
      case 'mode.set':
        setMode(m.payload.mode);
        return;
      case 'tag.add':
        addTag(m.payload, from);
        return;
      case 'tag.remove':
        removeTag(m.payload.cardId);
        return;
      case 'control.setup':
        setup(m.payload.cardId, from);
        return;
      case 'control.cancel':
        cancel(m.payload);
        return;
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
        panic(m.payload.reason ?? `panic from ${from.name}`, m.payload.cardId);
        return;
      case 'device.signal':
        daemons.onSignal(m.payload, from.deviceId);
        return;
      case 'voice.audio':
        void voice.onAudio(m.payload, from.deviceId);
        return;
      case 'voice.text':
        void voice.onText(m.payload, from.deviceId);
        return;
      case 'gen3d.generate': {
        const t = targets.get(m.payload.cardId);
        if (!t || !canControl(t)) return;
        const f = forge();
        if (!f) return;
        void f.generateFor(m.payload.cardId, { request: m.payload.request, runId: m.payload.requestId }).catch((err) => log(`[gen3d] generate: ${(err as Error).message}`));
        return;
      }
      case 'gen3d.edit': {
        const t = targets.list().find((t) => t.specId === m.payload.specId);
        if (!t || !canControl(t)) return;
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
    mode: () => mode,
    setMode,
    tagsState,
    addTag,
    removeTag,
    setup,
    panic,
    close: () => {
      unsubscribe();
      unsubscribePresence();
      unsubscribeTags();
      unsubscribeForge();
      combos.cancel();
      daemons.close();
      for (const t of targets.list()) t.abort?.abort();
      control.close();
      arm.close();
      dispatcher.close();
    },
  };
}
