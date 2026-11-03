/**
 * The agent: wires the discovery loop and the control loop to the hub. One per server context (getAgent).
 *
 *   scan.frame -> ScanService (SAM 3.1 + QR pairing) -> scan.result
 *   tag.add / target.select -> identify only; control.setup -> link, research, drive, verify, forge, arm
 *   exec.ack / sense.result -> Dispatcher · arm.confirm -> ArmService · control.event / panic -> ControlRouter
 *   voice.audio / voice.text -> VoiceRelay · gen3d.generate / gen3d.edit -> the forge
 */
import { dirname, join } from 'node:path';
import { type DeviceCardPayload, EXPERIMENTAL_TYPE, newId, type TargetCancelPayload, type TargetRetryPayload, type Hack, type MessageType, type PayloadOf, type TargetSelectPayload, type UiSpecPayload, type Mode, type TagAddPayload, type TagsStatePayload, type LibraryStatePayload, type RoomPlacement } from '@ce/protocol';
import type { ServerContext } from '../context';
import { loadProfiles, type Profiles } from '../devices/profiles';
import { MidiChartStore } from '../devices/midi-charts';
import { getForge } from '../gen3d';
import type { Forge } from '../gen3d/forge';
import type { HubMessageEvent } from '../hub';
import { createMuseChat, type FixtureMuse, type MuseChat } from '../muse/adapter';
import { createWebSearcher } from '../research/websearch';
import { InteractionMemory } from '../knowledge/interactions';
import { CanvasStore } from '../canvas/store';
import { CanvasService, registerCanvasFixture } from '../canvas/service';
import { createSam, type Sam } from '../scan/sam';
import { VoiceRelay, type VoiceActions } from '../voice/relay';
import { DeviceAssistant, registerAssistantFixtures } from '../voice/assistant';
import { visualSynthCard, visualSynthCompanions, visualSynthHosts, virtualScreenExecutor, VIRTUAL_SCREEN_GUIDANCE } from './visual-synth';
import { currentControlSpec, verifiedControlCount } from './control-readiness';
import { IdentityCorrections } from './identity-correction';
import { ConnectedPeripherals, GENERAL_ASSISTANT_CARD } from './connected-peripheral';
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
import { restoreSavedForge } from './restoreForge';
import { visualSynthNeedsUpgrade } from '../devices/visualSynth';
import { detachRouteBridge } from '../gen3d/routes';
import { MacLocalExecutor } from './maclocal';
import { loadRecordedSpeech } from './recordedSpeech';
import { ScanService } from './scan';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { TagStore, evaluateConnection, tagCapability, tagSnapshot } from './tags';
import { interactionReferences } from './interaction-references';
import { helperPairUrls } from '../net';
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
  midiCharts: MidiChartStore;
  invalidateMidiChart(cardId: string): void;
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
  libraryState(): LibraryStatePayload;
  forget(cardId: string): boolean;
  restoreVersion(cardId: string, versionId: string): boolean;
  rename(cardId: string, displayName: string): boolean;
  place(cardId: string, placement: RoomPlacement): boolean;
  setup(cardId: string, from: { deviceId: string; name?: string }, rerun?: boolean): Target | undefined;
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
    registerAssistantFixtures(muse as FixtureMuse);
    registerCanvasFixture(muse as FixtureMuse);
  }
  const wonder: MuseChat | undefined = muse.mode === 'live' ? createMuseChat({ ...ctx.config.muse, model: WONDER_MODEL }, { callLog: ctx.calls, log }) : undefined;
  const sam = createSam(ctx.config.muse, { callLog: ctx.calls, log });
  const knowledgeDir = opts.tagsFile ? dirname(opts.tagsFile) : ctx.config.dataDir;
  const web = createWebSearcher(ctx.config.muse, { callLog: ctx.calls,
    cacheFile: opts.tagsFile === null ? undefined : join(knowledgeDir, 'research-cache.json') });
  const memory = new InteractionMemory(opts.tagsFile === null ? undefined : join(knowledgeDir, 'interaction-memory.json'));
  for (const warning of memory.warnings) log(`[memory] ${warning}`);
  const profiles = loadProfiles();
  const midiCharts = new MidiChartStore(opts.tagsFile === null ? undefined : join(knowledgeDir, 'reviewed-midi-charts.json'));
  for (const warning of midiCharts.warnings) log(`[midi-charts] ${warning}`);
  const macEnabled = opts.macLocal ?? (process.platform === 'darwin' && !process.env.VITEST && process.env.CE_MAC_LOCAL !== '0');
  // CE_MAC_SILENT=1: this Mac must stay silent; nothing audible runs and a recorded clip stands in for its voice
  const macLocal = new MacLocalExecutor(undefined, macEnabled, process.env.CE_MAC_SILENT === '1');
  const silentSpeech = macLocal.silent ? loadRecordedSpeech(undefined, log) : undefined;
  if (macLocal.silent) log('[silent] CE_MAC_SILENT=1: say / Music are not run and the volume is kept in memory; acks and evidence say so');
  // a sensor whose last reply timed out (a dead headset tab) yields to a healthy one for ~30 s
  const roster: Roster = { devices: () => hub.devices(), macLocal: macLocal.available, silentLocal: macLocal.silent,
    helperUrl: () => helperPairUrls(ctx.bound.http ?? ctx.config.http.port)[0], unhealthy: (id) => dispatcher.unhealthy(id) };
  const steps = new StepLog(hub, log);
  const targets = new TargetStore(hub, log);
  const tags = new TagStore(opts.tagsFile === null ? undefined : opts.tagsFile ?? join(ctx.config.dataDir, 'library.json'));
  for (const warning of tags.loadWarnings) log(`[library] ${warning}`);
  let mode: Mode = 'annotate';
  const canvasStore = new CanvasStore(opts.tagsFile === null ? undefined : join(knowledgeDir, 'canvas-history.json'));
  for (const warning of canvasStore.warnings) log(`[canvas] ${warning}`);
  const canvas = new CanvasService({ muse, store: canvasStore, log,
    object: (cardId) => {
      const target = targets.get(cardId);
      if (mode !== 'control' || !tags.has(cardId) || !target) return;
      return { name: target.card?.name ?? target.detection?.label ?? tags.get(cardId)?.label ?? 'Tagged object', category: target.card?.category,
        visibleText: target.card?.visibleText, evidence: target.card?.evidence, source: target.card?.source, modelId: target.card?.modelId };
    },
    broadcast: (state) => hub.broadcast('canvas.state', state),
    send: (sender, state) => hub.sendToDevice(sender, 'canvas.state', state),
  });
  const setups = new Set<string>();
  const identityCorrections = new IdentityCorrections();
  const connectedPeripherals = new ConnectedPeripherals();
  const needsReviewedMidiChart = (t: Target) => (t.identityCorrection?.firmware === 'unknown' || t.cardId.startsWith('connected-op1-field-')) && !!t.card && !midiCharts.profile(t.card);
  const reviewedChartHint = 'Firmware is not confirmed. On the Mac, open Details and review an incoming MIDI chart before setting up controls.';
  const midiPermissionsCurrent = (t: Pick<Target, 'cardId' | 'card' | 'research'>) => midiCharts.isCurrent(t.cardId, t.card, t.research?.profile);
  // Keep old versions as history, but never restore their execution authority after a chart change.
  const restoreTarget = (saved: Parameters<TargetStore['create']>[0] & { cardId: string }) => {
    const t = targets.create(saved);
    if (!midiPermissionsCurrent(t)) {
      tags.setEnabled(t.cardId, false);
      t.armed = false; t.verification = {}; t.evidence = []; t.driver = undefined; t.specId = undefined; t.controlCount = undefined;
      t.research = undefined; t.state = t.card ? 'identified' : 'scanned';
      t.sentence = 'MIDI chart changed'; t.hint = 'Set up control again to verify the current reviewed controls'; t.action = 'retry';
    }
    if (visualSynthNeedsUpgrade(t.driver)) {
      tags.setEnabled(t.cardId, false); t.armed = false;
      t.state = 'identified'; t.sentence = 'Visual controls update available';
      t.hint = 'Set up control to add forward/back Water ripples'; t.action = 'retry';
    }
    return t;
  };
  for (const tag of tags.list()) restoreTarget({ ...tag, state: tag.armed ? 'armed' : tag.card ? 'identified' : 'scanned' });
  const connected = (t: Target) => tags.has(t.cardId) && evaluateConnection(t, roster).connection !== 'offline';
  const canControl = (t: Target) => midiPermissionsCurrent(t) && mode === 'control' && tags.has(t.cardId) && Boolean(t.specId && verifiedControlCount(deviceSpec(t.specId), t)) && evaluateConnection(t, roster).connection === 'ready';
  const dispatcher = new Dispatcher({ hub, macLocal, log, canExec: (request) => {
    const t = request.cardId ? targets.get(request.cardId) : undefined;
    if (request.op.kind === 'midi' && request.op.msg === 'panic') return t?.driver?.executor.deviceId === request.executorDeviceId;
    if (!t || !midiPermissionsCurrent(t) || mode !== 'control' || !connected(t) || !t.driver) return false;
    if (t.driver.executor.deviceId !== request.executorDeviceId || (request.port && t.driver.executor.port !== request.port)) return false;
    if (request.driverId && request.driverId !== t.driver.driverId) return false;
    if (canControl(t)) return (request.op.kind === 'midi' && request.op.msg === 'panic') || Boolean(request.actionId && t.verification[request.actionId] === 'pass');
    return setups.has(t.cardId) && t.state === 'verifying' && Boolean(t.abort && !t.abort.signal.aborted);
  } });
  const arm = new ArmService({ hub, targets, steps, log, canArm: (t) => midiPermissionsCurrent(t) && mode === 'control' && connected(t) && setups.has(t.cardId) });
  // Own the broadcast bridge so cancelled discovery runs cannot publish stale controls.
  const sharedForge = opts.forge ? undefined : getForge(ctx, { broadcast: false });
  const forge = opts.forge ?? (() => sharedForge);
  if (sharedForge) detachRouteBridge(sharedForge);
  // Restore both controls and editing history before any presence or message listener can serve clients.
  for (const saved of tags.listAll()) restoreSavedForge(forge(), saved, log);
  const setupContext = (spec: UiSpecPayload) => {
    const current = forge();
    const skinId = /^\/api\/skins\/(skn_[a-f0-9]{64})\.webp$/.exec(spec.gen3d?.skin?.url ?? '')?.[1];
    const skin = skinId ? current?.skins?.get(skinId) : undefined;
    return {
      forgeContext: current?.snapshot?.(spec.specId),
      ...(skin ? { skinRefs: [tags.putAsset(skin.bytes, 'webp', skin.mime)] } : {}),
    };
  };
  let assistant: DeviceAssistant | undefined;
  const activeForge = forge();
  activeForge?.setReferences?.((query) => interactionReferences(tags.library(), query));
  const unsubscribeForge = activeForge?.subscribe ? subscribeForge(activeForge, hub, targets, (cardId) => {
    const t = targets.get(cardId);
    if (!t) return !tags.get(cardId); // Standalone HTTP samples have no saved device intent.
    return mode === 'control' && tags.has(cardId) && (setups.has(cardId) || canControl(t));
  }, (spec) => {
    const target = targets.get(spec.cardId!);
    const saved = tags.get(spec.cardId!);
    if (!saved) return;
    const context = setupContext(spec);
    if (target?.specId === spec.specId && target.driver?.driverId === spec.driverId && (target.armed || setups.has(target.cardId))) {
      tags.sync(target, spec, context);
    } else if (saved.specId === spec.specId && saved.driver?.driverId === spec.driverId) {
      // A skin may finish after leaving Control or hiding the device. Retain the accepted interface.
      tags.saveSetupContext(saved.cardId, context, spec);
    }
    publishTags();
  }) : () => {};
  let room: UiSpecPayload | undefined;
  let roomRev = 0;
  const deviceSpec = (specId: string) => {
    return [forge()?.get(specId), tags.list().find((t) => t.uiSpec?.specId === specId)?.uiSpec]
      .find((spec) => spec && spec.driverId === targets.get(spec.cardId ?? '')?.driver?.driverId);
  };
  const specs = {
    get: (specId: string) => (specId === ROOM_SPEC_ID ? room : deviceSpec(specId)),
    list: () => [...new Map([...(forge()?.list() ?? []), ...tags.list().flatMap((t) => t.uiSpec ? [t.uiSpec] : [])].filter((spec) => deviceSpec(spec.specId)).map((spec) => [spec.specId, spec])).values(), ...(room ? [room] : [])],
  };
  targets.setStatusProjection((target, status) => {
    if (!['armed', 'controlling', 'forged'].includes(target.state)) return status;
    const connection = evaluateConnection(target, roster);
    if (connection.connection === 'offline') return { ...status, sentence: 'Controls unavailable', hint: connection.hint, detail: 'offline' };
    const count = verifiedControlCount(target.specId ? deviceSpec(target.specId) : undefined, target);
    return count ? { ...status, sentence: `${count} verified control${count === 1 ? '' : 's'}${target.armed ? ' enabled' : ' · choose Enable'}` }
      : { ...status, sentence: 'No displayed controls have passed verification', hint: 'Set up control again, or choose Try visual synth from Menu.' };
  });
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
  const control = new ControlRouter({ targets, dispatcher, specs, steps, hub, log, onRoomHack, canControl,
    onResult: (result, from) => { hub.sendToDevice(from, 'control.result', result); },
  });
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
  const voiceActions: VoiceActions = {
    panic: (reason) => {
      panic(reason);
    },
    undo: (cardId) => {
      // the newest thing that happened: a room combo or a device hack
      const t = latestSpecTarget(cardId);
      const comboAt = combos.lastRun?.startedAt ?? 0;
      if (!cardId && comboAt && (!t || comboAt > t.since)) {
        void combos.undo();
        return true;
      }
      return t ? control.undo(t).ok : false;
    },
    hack: (text, cardId) => {
      const lower0 = text.toLowerCase();
      if (!cardId && room?.hackset) {
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
    edit: async (instruction, specId, cardId, signal) => {
      const t = targets.list().find((t) => t.specId === specId);
      if (!t || (cardId && t.cardId !== cardId) || !canControl(t)) return false;
      const f = forge();
      if (!f || !specId) return false;
      const r = await f.edit({ specId, instruction, signal });
      return r.ok;
    },
    scan: () => steps.note('scan', 'scan requested by voice', { kind: 'proof' }),
    specFor: (cardId) => latestSpecTarget(cardId)?.specId,
    canvasFor: (cardId) => !!cardId && !!canvas.document(cardId),
  };
  assistant = new DeviceAssistant({
    muse, forge, log, memory, web,
    broadcast: (payload) => hub.broadcast('voice.text', payload),
    device: (cardId) => {
      const t = targets.get(cardId);
      if (!t || !tags.has(cardId)) return undefined;
      let connection = evaluateConnection(t, roster);
      const spec = t.specId ? specs.get(t.specId) : undefined;
      if (connection.connection === 'ready' && !verifiedControlCount(spec, t)) connection = { connection: 'setup', hint: 'Set up control to verify the displayed actions.' };
      return { cardId, identityRevision: t.identityRevision ?? 0, name: t.card?.name ?? t.detection?.label ?? tags.get(cardId)?.label ?? cardId, mode,
        ...connection, armed: t.armed, setupRunning: setups.has(cardId), protocols: t.card?.protocols,
        ...(needsReviewedMidiChart(t) ? { setupBlocked: reviewedChartHint } : {}),
        identity: t.card ? { maker: t.card.maker, model: t.card.model, category: t.card.category,
          confidence: t.card.confidence, visibleText: t.card.visibleText, evidence: t.card.evidence, notes: t.card.notes } : undefined,
        driver: t.driver, verification: t.verification, spec,
        canvas: canvas.document(cardId) ? { title: canvas.document(cardId)!.spec.title, revision: canvas.document(cardId)!.revision } : undefined };
    },
    edit: (text, specId, cardId, signal) => voiceActions.edit(text, specId, cardId, signal),
    command: (text, cardId) => voiceActions.hack(text, cardId),
    canvas: (prompt, cardId, sender, requestId, signal) => canvas.isSelected(sender, cardId)
      ? canvas.request(sender, { cardId, requestId, prompt, baseRevision: canvas.document(cardId)?.revision }, signal) : Promise.resolve(false),
    connectedDevices: () => hub.devices().filter((d) => d.online && d.role === 'companion').slice(0, 12)
      .map((d) => ({ name: d.name, ports: (d.ports ?? []).filter((p) => p.state === 'connected').slice(0, 16).map((p) => `${p.name} (${p.kind})`) })),
    proposePeripheral: async (text, cardId, sender, signal) => {
      if (signal.aborted) return { ok: false, text: 'The instrument request was cancelled.' };
      const host = cardId === GENERAL_ASSISTANT_CARD ? undefined : targets.get(cardId);
      if (cardId !== GENERAL_ASSISTANT_CARD && (!host || !tags.has(cardId))) return { ok: false, text: 'The host is no longer tagged. Select it and ask again.' };
      const result = connectedPeripherals.propose(host, cardId, text, sender, hub.devices());
      if (!result.ok) return result;
      signal.addEventListener('abort', () => connectedPeripherals.cancel(sender, cardId), { once: true });
      return { ok: true, ...result.proposal };
    },
    confirmPeripheral: (proposalId, cardId, sender, accept) => {
      const host = cardId === GENERAL_ASSISTANT_CARD ? undefined : targets.get(cardId);
      if (cardId !== GENERAL_ASSISTANT_CARD && (!host || !tags.has(cardId))) return { ok: false, text: 'The host is no longer tagged. Review the instrument again.' };
      const result = connectedPeripherals.confirm(host, { proposalId, cardId, sender, accept }, hub.devices());
      if (!result.ok || result.dismissed) return result;
      let target = targets.get(result.card.cardId);
      if (target?.armed || target?.armId || target?.abort && !target.abort.signal.aborted) return { ok: false, text: 'Stop the instrument controls and finish setup before selecting it again.' };
      if (!tags.has(result.card.cardId) && tags.library().length >= 64) return { ok: false, text: 'Your saved device list is full. Forget an unused device, then choose the instrument again.' };
      const created = !target;
      if (!target) target = targets.create({ cardId: result.card.cardId, card: result.card, state: 'identified', selectedBy: sender,
        selection: { preferDeviceId: result.port.deviceId, userText: 'Owner-confirmed OP-1 Field connected to the paired Mac. Firmware and physical controls remain unverified.' },
        sentence: 'OP-1 Field selected', hint: 'Review the incoming MIDI chart in Mac Details, then set up and verify controls.' });
      try { tags.add(target, 'OP-1 Field'); }
      catch (error) {
        if (created) targets.remove(target.cardId);
        log(`[peripheral] save failed: ${(error as Error).message}`);
        return { ok: false, text: 'The connected instrument could not be saved. No controls were started.' };
      }
      target.selectedBy = sender;
      canvas.select(sender, target.cardId);
      hub.broadcast('device.card', target.card!); publishTags();
      hub.broadcast('target.status', targets.status(target));
      return { ok: true, selectedCardId: target.cardId,
        text: 'OP-1 Field selected as a separate connected instrument; the laptop is unchanged. Controls are off. Confirm firmware and review its incoming MIDI chart in Mac Details, then choose Set up control and verify the effect. Ask for your gesture mapping after enabling the verified controls.' };
    },
    proposeIdentity: async (text, cardId, sender, signal) => {
      const target = targets.get(cardId);
      if (signal.aborted || !target || !tags.has(cardId)) return { ok: false, text: 'Select a tagged object before correcting its identity.' };
      const result = identityCorrections.propose(target, text, sender, hub.devices());
      if (!result.ok) return { ok: false, text: result.reason };
      signal.addEventListener('abort', () => identityCorrections.cancel(sender, cardId), { once: true });
      return { ok: true, proposalId: result.proposal.proposalId, text: result.proposal.summary, summary: result.proposal.reviewLines };
    },
    confirmIdentity: (proposalId, cardId, sender, accept) => {
      // Only the owner/local voice.confirm message route reaches this callback. The review
      // itself binds sender, card, runtime state and the current physical MIDI output.
      const target = targets.get(cardId);
      if (!target || !tags.has(cardId)) return { ok: false, text: 'This object is no longer tagged. Review its identity again.' };
      const result = identityCorrections.confirm(target, { proposalId, cardId, sender, accept, canApprove: true }, hub.devices());
      if (result.status !== 'confirmed') return { ok: result.status === 'dismissed', text: result.reason };
      let saved;
      try {
        // Commit first: a disk failure must not leave live identity and durable controls disagreeing.
        saved = tags.correctIdentity({ ...target, ...result.patch }, result.audit);
        if (!saved) return { ok: false, text: 'The saved object is unavailable. No identity or controls were changed.' };
      } catch (error) {
        log(`[identity] save failed: ${(error as Error).message}`);
        return { ok: false, text: 'The correction could not be saved. No identity or controls were changed; please review it again.' };
      }
      Object.assign(target, result.patch, { identityRevision: saved.identityRevision, identityCorrection: saved.identityCorrection });
      // Live authority must cross the same boundary even if optional cache cleanup fails.
      const cleanup = (name: string, fn: () => unknown) => { try { fn(); } catch (error) { log(`[identity] ${name} cleanup failed: ${(error as Error).message}`); } };
      cleanup('identification', () => identifying.get(cardId)?.abort()); identifying.delete(cardId); tagIdentity.delete(cardId);
      cleanup('canvas', () => canvas.invalidate(cardId)); cleanup('voice', () => voice.invalidate(cardId));
      cleanup('assistant', () => assistant?.invalidate(cardId)); cleanup('combos', () => combos.cancel(cardId));
      cleanup('controls', () => control.cancel(target)); setups.delete(cardId);
      for (const version of tags.library().find((record) => record.cardId === cardId)?.versions ?? []) cleanup('old interface', () => forge()?.forget?.(version.specId));
      cleanup('interaction memory', () => memory.forget(cardId));
      hub.broadcast('device.card', target.card!);
      hub.broadcast('target.status', targets.status(target));
      publishTags();
      return { ok: true, text: 'Identity corrected to OP-1 Field. Old controls were cleared and controls remain off. Firmware and physical control are not verified. Review an incoming MIDI chart in Mac Details before a new setup.' };
    },
  });
  const voice = new VoiceRelay({ hub, transcriber: ctx.transcriber, log,
    actions: { ...voiceActions, workspaceIssue: (input) => assistant!.workspaceIssue(input), assist: (input, sender) => {
      if (input.cardId && tags.has(input.cardId)) canvas.select(sender, input.cardId);
      return assistant!.ask(input, sender);
    } },
  });

  const restoreVolume = async (value: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    const result = await macLocal.exec({ kind: 'local', op: 'volume', arg: value });
    if (!result.ok) throw new Error(result.detail ?? 'volume restoration failed');
  };
  const loopDeps = { hub, targets, steps, dispatcher, roster, sam, spark: muse, wonder, web, profiles, midiCharts, forge, arm, heard, readVolume: () => macLocal.currentVolume(), restoreVolume, silentSpeech, log, companionWaitMs: opts.companionWaitMs, phaseTimeoutMs: opts.phaseTimeoutMs, settleMs: opts.settleMs, learnIr: opts.learnIr };

  const tagsState = (): TagsStatePayload => ({ tags: tags.list().flatMap((tag) => {
    const target = targets.get(tag.cardId);
    if (!target) return [];
    const snapshot = tagSnapshot(tag, target, roster);
    if (snapshot.connection === 'ready' && (!target.specId || !verifiedControlCount(deviceSpec(target.specId), target))) {
      snapshot.connection = 'setup';
      snapshot.hint = 'Displayed controls have not passed verification. Set up control to check them.';
    }
    if (snapshot.connection !== 'offline' && needsReviewedMidiChart(target)) {
      snapshot.connection = 'setup'; snapshot.hint = reviewedChartHint;
    }
    return [snapshot];
  }) });
  const libraryState = (): LibraryStatePayload => {
    const visible = new Map(tagsState().tags.map((tag) => [tag.cardId, tag.connection]));
    return { devices: tags.library().map((record) => ({
      cardId: record.cardId, displayName: record.displayName, hidden: record.hidden,
      identity: record.identity, placement: record.placement, createdAt: record.createdAt, updatedAt: record.updatedAt,
      enabled: record.enabled, activeVersionId: record.activeVersionId, lastKnownState: record.lastKnownState,
      versions: record.versions.map((version) => ({ versionId: version.versionId, createdAt: version.createdAt, specId: version.uiSpec?.specId })),
      connection: visible.get(record.cardId) ?? 'offline',
    })) };
  };
  const publishTags = () => {
    hub.broadcast('library.state', libraryState());
    hub.broadcast('tags.state', tagsState());
    assistant?.refresh();
  };
  const unsubscribeTags = targets.onChange((t) => {
    if (!tags.has(t.cardId)) return;
    const spec = t.specId ? specs.get(t.specId) : undefined;
    tags.sync(t, spec, spec ? setupContext(spec) : undefined);
    publishTags();
  });
  const stop = (t: Target, reason = 'cancelled') => {
    canvas.invalidate(t.cardId);
    voice.invalidate(t.cardId);
    assistant?.invalidate(t.cardId);
    combos.cancel(t.cardId);
    setups.delete(t.cardId);
    t.abort?.abort(new Error(reason));
    arm.cancel(t, reason);
    control.cancel(t);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    targets.setState(t, 'failed', reason, CANCELLED_GUIDANCE);
  };
  const panic = (reason = 'panic', cardId?: string) => {
    canvas.invalidate(cardId);
    voice.invalidate(cardId);
    assistant?.invalidate(cardId);
    combos.cancel(cardId);
    daemons.stopAll(reason);
    for (const record of tags.library()) if (!cardId || record.cardId === cardId) tags.setEnabled(record.cardId, false);
    for (const t of targets.list()) if ((!cardId || t.cardId === cardId) && (t.abort || t.armId)) stop(t, reason);
    const result = control.panic(reason, cardId);
    publishTags();
    hub.broadcast('panic', { reason, ...(cardId ? { cardId } : {}) });
    return result;
  };
  const setMode = (next: Mode) => {
    if (mode === next) return;
    voice.invalidate();
    assistant?.invalidate();
    canvas.invalidate();
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
    if (mode === 'control') for (const t of targets.list()) if (tags.has(t.cardId) && t.specId) showControls(t);
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
        tags.sync(t);
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
    const savedId = p.cardId ?? p.targetId;
    let t = savedId ? targets.get(savedId) : undefined;
    const saved = savedId ? tags.get(savedId) : undefined;
    if (p.cardId && !saved) return undefined;
    if (!t && saved) t = restoreTarget({ ...saved, state: saved.armed ? 'armed' : saved.card ? 'identified' : 'scanned' });
    if (!t && match?.cardId) t = targets.get(match.cardId);
    const detection = frame ? scan.tagDetection(frame.frame.frameId, p.detId ?? match?.detId, p.label) : undefined;
    if (!t && detection) t = targets.list().find((known) => known.detection?.sensorDeviceId === detection.sensorDeviceId && known.detection.detId === detection.detId);
    if (!t && tags.library().length >= 64) return undefined;
    if (!t) t = targets.create({ ...(p.targetId ? { cardId: p.targetId } : {}), detection, selectedBy: from.deviceId });
    if (!tags.get(t.cardId) && tags.library().length >= 64) return undefined;
    t.selectedBy = from.deviceId;
    if (detection) t.detection = detection;
    tags.add(t, p.label, p.position);
    publishTags();
    if (!saved?.card) identifyTag(t);
    return t;
  };
  const removeTag = (cardId: string): boolean => {
    canvas.invalidate(cardId);
    voice.invalidate(cardId);
    assistant?.invalidate(cardId);
    if (!tags.has(cardId)) return false;
    identifying.get(cardId)?.abort();
    identifying.delete(cardId);
    tagIdentity.delete(cardId);
    const t = targets.get(cardId);
    if (t) {
      if (t.abort || t.armId || setups.has(cardId)) stop(t, 'device untagged');
      else control.cancel(t);
    }
    tags.remove(cardId);
    targets.remove(cardId);
    publishTags();
    return true;
  };
  const forget = (cardId: string): boolean => {
    if (!tags.get(cardId)) return false;
    removeTag(cardId);
    const specIds = new Set(tags.library().find((record) => record.cardId === cardId)?.versions.map((version) => version.specId));
    for (const specId of specIds) forge()?.forget?.(specId);
    tags.forget(cardId);
    memory.forget(cardId);
    canvas.forget(cardId);
    targets.remove(cardId);
    publishTags();
    return true;
  };
  const restoreVersion = (cardId: string, versionId: string): boolean => {
    if (!tags.canRestoreVersion(cardId, versionId)) return false;
    voice.invalidate(cardId);
    assistant?.invalidate(cardId);
    const previous = targets.get(cardId);
    if (previous) {
      setups.delete(cardId);
      previous.abort?.abort();
      arm.cancel(previous, 'restoring saved setup');
      control.cancel(previous);
    }
    const saved = tags.restoreVersion(cardId, versionId);
    if (!saved) return false;
    restoreSavedForge(forge(), saved, log);
    if (tags.has(cardId)) {
      const target = restoreTarget({ ...saved, state: saved.armed ? 'armed' : saved.card ? 'identified' : 'scanned' });
      if (mode === 'control') showControls(target);
    }
    publishTags();
    return true;
  };
  const rename = (cardId: string, displayName: string): boolean => {
    if (!tags.get(cardId)) return false;
    tags.rename(cardId, displayName);
    publishTags();
    return true;
  };
  const place = (cardId: string, placement: RoomPlacement): boolean => {
    if (!tags.get(cardId)) return false;
    tags.setPlacement(cardId, placement);
    publishTags();
    return true;
  };
  const showControls = (t: Target, deviceId?: string) => {
    const send = <T extends MessageType>(type: T, payload: PayloadOf<T>) => deviceId
      ? hub.sendToDevice(deviceId, type, payload) : hub.broadcast(type, payload);
    if (t.card) send('device.card', t.card);
    if (t.link) send('link.result', t.link);
    if (!midiPermissionsCurrent(t)) return;
    if (t.driver) send('driver.spec', t.driver);
    for (const evidence of t.evidence) send('verify.result', evidence);
    if (t.specId) {
      const spec = specs.get(t.specId);
      if (spec) send('ui.spec', currentControlSpec(spec, t));
    }
    if (t.driver) send('driver.status', { driverId: t.driver.driverId, cardId: t.cardId, phase: t.armed ? 'armed' : 'disarmed', actions: t.driver.actions.map((a) => ({ actionId: a.actionId, verified: t.verification[a.actionId] ?? 'untested' })), modelId: t.driver.modelId });
  };
  const setup = (cardId: string, from: { deviceId: string; name?: string }, rerun = false): Target | undefined => {
    const t = targets.get(cardId);
    const connection = t && tags.has(cardId) ? evaluateConnection(t, roster) : undefined;
    if (!t || !tags.has(cardId) || mode !== 'control' || connection?.connection === 'offline') {
      const hint = !t || !tags.has(cardId) ? 'Tag this device in Annotate mode first' : mode !== 'control' ? 'Switch to Control mode to set up this device' : connection?.hint ?? 'Connect a companion for this device';
      const state = tagsState();
      const action = mode === 'control' ? connection?.action : undefined;
      state.tags = state.tags.map((tag) => tag.cardId === cardId ? { ...tag, connection: 'offline', hint, action } : tag);
      hub.sendToDevice(from.deviceId, 'tags.state', state);
      steps.note('link', hint, { cardId, kind: 'proof', status: 'fail', sentence: hint, hint, action });
      return undefined;
    }
    if (needsReviewedMidiChart(t)) {
      t.hint = reviewedChartHint;
      // A rejected setup must terminate the requesting client's busy state. No run or device command started.
      hub.sendToDevice(from.deviceId, 'target.status', { ...targets.status(t), state: 'failed', sentence: 'Review the MIDI chart first', detail: reviewedChartHint, hint: reviewedChartHint, action: 'retry' });
      steps.note('research', reviewedChartHint, { cardId, kind: 'proof', status: 'fail', sentence: 'Review the MIDI chart first', hint: reviewedChartHint });
      return undefined;
    }
    if (t.abort && !t.abort.signal.aborted) return t;
    if (!rerun && canControl(t)) {
      showControls(t, from.deviceId);
      return t;
    }
    for (const previous of targets.list()) {
      if (previous !== t && previous.selectedBy === from.deviceId && setups.has(previous.cardId)) stop(previous, 'another device selected');
    }
    t.selectedBy = from.deviceId;
    tags.beginCandidate(cardId);
    arm.cancel(t, 'retrying');
    control.cancel(t);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    t.runId = newId('run-');
    setups.add(t.cardId);
    // A completed setup that was declined only needs a fresh ARM confirmation.
    if (!rerun && !visualSynthNeedsUpgrade(t.driver) && midiPermissionsCurrent(t) && t.specId && t.driver && verifiedControlCount(specs.get(t.specId), t) > 0) {
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
    void runLoop(loopDeps, t, { ...t.selection, identified: tagIdentity.get(t.cardId), refreshResearch: rerun }).finally(() => {
      if (targets.get(t.cardId) === t && t.runId === runId) {
        setups.delete(t.cardId);
        const spec = t.specId ? specs.get(t.specId) : undefined;
        tags.sync(t, spec, spec ? setupContext(spec) : undefined);
        // A failed candidate leaves the last completed setup available as one coherent unit.
        const saved = tags.get(t.cardId);
        if (!t.armed && saved?.uiSpec) {
          restoreSavedForge(forge(), saved, log);
          restoreTarget({ ...saved, state: saved.armed ? 'armed' : 'forged' });
        }
        publishTags();
      }
    });
    return t;
  };
  const cancel = (p: TargetCancelPayload): boolean => {
    const t = targets.get(p.cardId);
    if (!t || !tags.has(t.cardId) || (p.runId && p.runId !== t.runId)) return false;
    tags.setEnabled(t.cardId, false);
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
    if (p.cardId && tags.has(p.cardId)) canvas.select(from.deviceId, p.cardId);
    if (p.virtual === 'visual-synth') {
      const reply = (ok: boolean, cardId?: string, reason?: string) => {
        if (p.requestId) hub.sendToDevice(from.deviceId, 'target.select.result', { requestId: p.requestId, ok, cardId, reason });
      };
      if (mode !== 'control') { reply(false, undefined, 'Choose Use devices, then Try visual synth.'); return; }
      const candidates = visualSynthCompanions(hub.devices());
      const executor = p.deviceId ? candidates.find((device) => device.deviceId === p.deviceId) : candidates.length === 1 ? candidates[0] : undefined;
      if (!executor) {
        const hosts = visualSynthHosts(hub.devices());
        const previousOwners = new Set(targets.list()
          .filter((target) => tags.has(target.cardId) && target.selectedBy === from.deviceId)
          .map((target) => virtualScreenExecutor(target.card)).filter((id) => hosts.some((host) => host.deviceId === id)));
        // selectedBy is session-local. On restart, recover only a unique saved
        // visual target whose explicit owner and preferred connection agree.
        const savedVisualTags = tags.list().filter((tag) => virtualScreenExecutor(tag.card));
        const savedOwners = new Set(savedVisualTags.map((tag) => virtualScreenExecutor(tag.card)));
        if (savedVisualTags.some((tag) => tag.selection?.preferDeviceId !== virtualScreenExecutor(tag.card))) savedOwners.clear();
        const rememberedOwners = previousOwners.size ? previousOwners : savedOwners;
        const remembered = rememberedOwners.size === 1 ? hosts.find((host) => rememberedOwners.has(host.deviceId)) : undefined;
        const host = p.deviceId ? hosts.find((device) => device.deviceId === p.deviceId) : hosts.length === 1 ? hosts[0] : remembered;
        if (host && p.requestId) {
          hub.sendToDevice(host.deviceId, 'visual.open', { requestId: p.requestId });
          // The existing Quest presence recovery retries selection after a real
          // visible renderer advertises its port. Opening itself is not Ready.
          reply(false, undefined, 'Waiting for the Mac visuals to open in your paired companion. Bring that browser tab to the front; selection will continue automatically.');
          return;
        }
        reply(false, undefined, candidates.length > 1 && !p.deviceId
          ? 'More than one Mac has visuals open. Keep only the screen you want open, then try again.'
          : hosts.length > 1 && !p.deviceId ? 'More than one paired companion can open visuals. Keep only the Mac companion you want connected, then try again.'
          : 'Open your paired Mac companion in Chrome, keep that tab visible, then choose Try visual synth again.');
        return;
      }
      const card = visualSynthCard(executor);
      const saved = tags.get(card.cardId);
      if (!saved && tags.library().length >= 64) { reply(false, undefined, 'Your device library is full. Forget an unused device, then try again.'); return; }
      let target = targets.get(card.cardId);
      if (!target) target = targets.create({ ...(saved ?? {}), cardId: card.cardId, card, selectedBy: from.deviceId,
        state: saved?.armed ? 'armed' : 'identified' });
      target.card = card;
      canvas.select(from.deviceId, target.cardId);
      target.selectedBy = from.deviceId;
      target.selection = { preferDeviceId: executor.deviceId, userText: 'Use the built-in silent visual synth on this Mac screen.' };
      // A known software instrument has no fabricated physical detection or image crop.
      target.detection = undefined;
      tags.add(target, 'Visual synth', p.position);
      hub.broadcast('device.card', card);
      publishTags();
      if (target.specId) showControls(target, from.deviceId);
      reply(true, card.cardId, VIRTUAL_SCREEN_GUIDANCE);
      return target;
    }
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
    if (presence.deviceId && !hub.devices().some((device) => device.deviceId === presence.deviceId && device.online)) {
      assistant?.disconnect(presence.deviceId);
      voice.disconnect(presence.deviceId);
      canvas.disconnect(presence.deviceId);
    }
    if (presence.deviceId && (presence.reason === 'join' || presence.reason === 'update')) hub.sendToDevice(presence.deviceId, 'mode.state', { mode });
    for (const t of targets.list()) {
      if (!tags.has(t.cardId) || connected(t)) continue;
      if (setups.has(t.cardId)) stop(t, 'companion disconnected');
      control.cancel(t, { preserveArmed: true });
    }
    publishTags();
    if (presence.reason === 'join' && presence.deviceId) {
      for (const state of canvas.snapshots()) if (tags.has(state.cardId)) hub.sendToDevice(presence.deviceId, 'canvas.state', state);
      for (const t of targets.list()) {
        if (!tags.has(t.cardId)) continue;
        if (mode === 'control') {
          showControls(t, presence.deviceId);
          if (setups.has(t.cardId) || t.specId) hub.sendToDevice(presence.deviceId, 'target.status', targets.status(t));
        } else if (t.card) hub.sendToDevice(presence.deviceId, 'device.card', t.card);
      }
      if (mode === 'control') for (const request of arm.pendingRequests()) hub.sendToDevice(presence.deviceId, 'arm.request', request);
    }
  });

  const onMessage = (e: HubMessageEvent): void => {
    if (EXPERIMENTAL_TYPE.test(e.message.type)) return;
    const m = e.message as AgentMessage;
    const from = { deviceId: e.device.deviceId, name: e.device.name, canApprove: e.device.canApprove, local: e.connection.local };
    if (m.type.startsWith('canvas.') && !from.canApprove && !from.local) {
      if ('cardId' in m.payload) hub.sendToDevice(from.deviceId, 'canvas.state', { cardId: String(m.payload.cardId),
        ...('requestId' in m.payload ? { requestId: String(m.payload.requestId) } : {}), status: 'error', message: 'Only an owner may create or play shared canvas games.' });
      return;
    }
    if (['mode.set', 'tag.add', 'tag.remove', 'library.place', 'library.forget', 'library.restore', 'library.rename', 'control.setup', 'target.select', 'target.retry', 'voice.confirm'].includes(m.type) && !from.canApprove && !from.local) {
      hub.sendToDevice(from.deviceId, 'log', { level: 'error', code: 'forbidden', message: 'Only an owner may tag or set up devices.' });
      return;
    }
    switch (m.type) {
      case 'canvas.get':
        canvas.get(from.deviceId, m.payload.cardId);
        return;
      case 'canvas.request':
        void canvas.request(from.deviceId, m.payload);
        return;
      case 'canvas.cancel':
        canvas.cancel(from.deviceId, m.payload.cardId, m.payload.requestId);
        return;
      case 'canvas.restore':
        canvas.restore(from.deviceId, m.payload);
        return;
      case 'canvas.action':
        canvas.action(from.deviceId, m.payload);
        return;
      case 'mode.set':
        setMode(m.payload.mode);
        return;
      case 'tag.add':
        addTag(m.payload, from);
        return;
      case 'tag.remove':
        removeTag(m.payload.cardId);
        return;
      case 'library.place':
        if (m.payload.placement.headsetId === from.deviceId) place(m.payload.cardId, m.payload.placement);
        return;
      case 'library.forget':
        forget(m.payload.cardId);
        return;
      case 'library.restore':
        restoreVersion(m.payload.cardId, m.payload.versionId);
        return;
      case 'library.rename':
        rename(m.payload.cardId, m.payload.displayName);
        return;
      case 'control.setup':
        setup(m.payload.cardId, from, m.payload.rerun);
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
      case 'voice.cancel':
        voice.cancel(from.deviceId, m.payload.cardId, m.payload.utteranceId);
        assistant?.cancel(from.deviceId, m.payload.cardId, m.payload.utteranceId);
        return;
      case 'voice.confirm':
        assistant?.confirm(m.payload, from.deviceId);
        return;
      case 'voice.audio':
        if (!from.canApprove && !from.local) return;
        void voice.onAudio(m.payload, from.deviceId);
        return;
      case 'voice.text':
        if (!from.canApprove && !from.local) return;
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
    midiCharts,
    invalidateMidiChart(cardId) {
      const t = targets.get(cardId);
      tags.setEnabled(cardId, false);
      if (!t) return;
      // The import route refuses active/armed targets; this only clears local saved authority.
      canvas.invalidate(cardId); voice.invalidate(cardId); assistant?.invalidate(cardId);
      t.armed = false; t.driver = undefined; t.specId = undefined; t.controlCount = undefined;
      t.research = undefined; t.verification = {}; t.evidence = [];
      targets.setState(t, 'identified', 'reviewed MIDI chart changed', {
        sentence: 'Reviewed MIDI chart saved', hint: 'Set up control again to verify the current reviewed controls', action: 'retry',
      });
      publishTags();
    },
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
    libraryState,
    forget,
    restoreVersion,
    rename,
    place,
    setup,
    panic,
    close: () => {
      canvas.invalidate();
      voice.invalidate();
      assistant?.invalidate();
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
