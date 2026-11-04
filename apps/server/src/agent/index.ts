/**
 * The agent: wires the discovery loop and the control loop to the hub. One per server context (getAgent).
 *
 *   scan.frame -> ScanService (SAM 3.1 + QR pairing) -> scan.result
 *   tag.add / target.select -> identify only; control.setup -> link, research, drive, verify, forge, arm
 *   exec.ack / sense.result -> Dispatcher · arm.confirm -> ArmService · control.event / panic -> ControlRouter
 *   voice.audio / voice.text -> VoiceRelay · gen3d.generate / gen3d.edit -> the forge
 */
import { dirname, join } from 'node:path';
import { type DeviceCardPayload, type DeviceInfo, type Driver, type Vec3, EXPERIMENTAL_TYPE, newId, type TargetCancelPayload, type TargetRetryPayload, type Hack, type MessageType, type PayloadOf, type TargetSelectPayload, type UiSpecPayload, type Mode, type TagAddPayload, type TagsStatePayload, type LibraryStatePayload, type RoomPlacement } from '@ce/protocol';
import type { ServerContext } from '../context';
import { REPO_ROOT } from '../config';
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
import { VISUAL_PAUSED_HINT, VISUAL_PRESENCE_GRACE_MS, VISUAL_REMIND_MS, VISUAL_WAIT_MS, VISUAL_SYNTH_CARD_ID, visualSynthCard, visualSynthCompanions, visualSynthHosts, virtualScreenExecutor, VIRTUAL_SCREEN_GUIDANCE } from './visual-synth';
import { currentControlSpec, verifiedControlCount } from './control-readiness';
import { IdentityCorrections } from './identity-correction';
import { ConnectedPeripherals, GENERAL_ASSISTANT_CARD } from './connected-peripheral';
import { ArmService } from './arm';
import { BLACKOUT_ID, BREATHE_DAEMON_ID, BREATHE_ID, buildRoomSpec, ComboRunner, ROOM_CARD_ID, ROOM_SPEC_ID } from './combos';
import { ControlRouter } from './control';
import { DaemonRunner } from './daemons';
import { Dispatcher, isNeutralSoftwareRelease } from './dispatch';
import { hearBack } from './heard';
import { fixtureDriverDraft, WONDER_MODEL } from './drive';
import { macLocalInfo, type Roster } from './executors';
import { cropJpeg, fixtureDeviceCard, identify, type IdentifyResult } from './identify';
import { decodeJpeg } from '../oracle/image';
import { demoMode, prefetchEnabled, prefetchVisualDriver, runLoop } from './loop';
import { StreamClient } from '../gen3d/stream';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';
import { validateDriver } from '../devices/validate';
import { verifyDriver } from './verify';
import { releaseWireOutputs } from './wire-stop';
import { agentCompanion, agentPortAllowed, virtualAgentRoute } from './agent-routing';
import { libraryDriverNote, WireService } from './wire';
import { ConnectorHost, isNeutralConnectorRelease } from './connector-host';
import { MuseAgent, type AgentContext } from './muse-agent';
import { MUSICAL_SYNTH_PORT_ID } from '../devices/musicalSynth';
import { MuseBridgeHarness } from './muse-harness';
import { CodingAgentService } from './coding-agent';
import { FreshConnectorGenerator } from './fresh-connector';
import { GeneratedConnectorRegistry } from './connector-runtime';
import { freshConnectorWriter } from './connector-wire';
import { cancellableDelay, RequestCancelledError } from '../muse/cancellation';
import { fixtureWireDraft } from './wire-fixture';
import { CANCELLED_GUIDANCE, type TimedPhase } from './guidance';
import { subscribeForge } from './forgeBridge';
import { restoreSavedForge } from './restoreForge';
import { musicalSynthExecutor, musicalSynthHosts, musicalSynthCard, MUSICAL_SYNTH_GUIDANCE } from './musical-synth';
import { extendWithMusicalCapabilities, isMusicalSynthPort, MUSICAL_SYNTH_MANIFEST } from '../devices/musicalSynth';
import { extendWithTouch, isVisualSynthPort, visualSynthNeedsUpgrade } from '../devices/visualSynth';
import { detachRouteBridge } from '../gen3d/routes';
import { MacLocalExecutor } from './maclocal';
import { loadRecordedSpeech } from './recordedSpeech';
import { ScanService } from './scan';
import { StepLog } from './steps';
import { TargetStore } from './targets';
import { TagStore, evaluateConnection, tagCapability, tagSnapshot } from './tags';
import { interactionReferences } from './interaction-references';
import { helperPairUrls } from '../net';
import type { Target, TargetDetection } from './types';
import type { WireReadyPayload } from '@ce/protocol';

// Derive from the payload map so newly added protocol schemas participate in narrowing.
type AgentMessage = { [K in MessageType]: { type: K; payload: PayloadOf<K> } }[MessageType];

export interface Agent {
  coding: CodingAgentService;
  freshConnectors: FreshConnectorGenerator;
  connectors: GeneratedConnectorRegistry;
  harness: MuseBridgeHarness;
  /** The Muse coding agent and the connectors it deployed (one Node process per device). */
  museAgent: MuseAgent;
  connectorHost: ConnectorHost;
  agentWorkspace: string;
  wireReady(cardId: string): WireReadyPayload | undefined;
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
  settleMs?: (t: Target, transport: Driver['transport']) => number;
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
/** Value-only library.state / tags.state updates go out at most this often. */
const PUBLISH_VALUES_MS = 500;

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
    // recorded wirings for "Touch the water" and "Hands as knobs", labelled FIXTURE (wire-fixture.ts)
    (muse as FixtureMuse).register('wire_program', fixtureWireDraft as never);
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
  // Explicit test opt-in only; the live demo uses the shared master sound state.
  const macLocal = new MacLocalExecutor(undefined, macEnabled, process.env.CE_MAC_SILENT === '1', () => hub.audioMasterState);
  const unsubscribeAudio = hub.onAudioMaster(() => macLocal.masterChanged());
  const silentSpeech = macLocal.silent ? loadRecordedSpeech(undefined, log) : undefined;
  if (macLocal.silent) log('[silent] CE_MAC_SILENT=1: say / Music are not run and the volume is kept in memory; acks and evidence say so');
  // a sensor whose last reply timed out (a dead headset tab) yields to a healthy one for ~30 s
  // Presence grace: when a visual synth host's renderer (or the whole companion) drops, remember when.
  let visualUp = new Set<string>();
  const visualLost = new Map<string, number>();
  const trackVisualPresence = (): boolean => {
    const now = Date.now();
    const up = new Set(visualSynthCompanions(hub.devices()).map((device) => device.deviceId));
    let lost = false;
    const changed: string[] = [];
    for (const id of visualUp) if (!up.has(id)) { visualLost.set(id, now); lost = true; changed.push(id); }
    for (const id of up) { visualLost.delete(id); if (!visualUp.has(id)) changed.push(id); }
    visualUp = up;
    // An armed (or forged) visual synth hears about its screen at once: paused when it closes, live again when it is back.
    const t = targets.get(VISUAL_SYNTH_CARD_ID);
    const host = t ? virtualScreenExecutor(t.card) : undefined;
    if (t && host && changed.includes(host) && tags.has(t.cardId) && ['armed', 'controlling', 'forged'].includes(t.state)) {
      log(`[visual] ${host}'s screen ${up.has(host) ? 'is back: controls resume' : 'closed: controls paused'}`);
      hub.broadcast('target.status', targets.status(t));
    }
    return lost;
  };
  /** A selection waiting for the Mac's screen (see awaitVisuals). Declared before the roster reads it. */
  let visualIntent: { from: { deviceId: string; name?: string }; at: number; hostId: string; timers: ReturnType<typeof setTimeout>[] } | undefined;
  /** The visual synth's screen is not open (or not visible) on its Mac: its controls pause instead of failing. */
  const visualPaused = (t: Target): boolean => {
    const host = virtualScreenExecutor(t.card);
    return !!host && !visualSynthCompanions(hub.devices()).some((device) => device.deviceId === host);
  };
  const roster: Roster = { devices: () => hub.devices(), macLocal: macLocal.available, silentLocal: macLocal.silent,
    visualOpening: (id) => visualIntent?.hostId === id,
    helperUrl: () => helperPairUrls(ctx.bound.http ?? ctx.config.http.port)[0], unhealthy: (id) => dispatcher.unhealthy(id),
    visualGrace: (id) => { const at = visualLost.get(id); return at !== undefined && Date.now() - at < VISUAL_PRESENCE_GRACE_MS; } };
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
  /** Drivers reused from the device library on a repeat selection (labelled "from your library" when a wiring is written). */
  const libraryDrivers = new Map<string, { driverId: string; modelId?: string }>();
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
    if (t.driver && t.specId) libraryDrivers.set(t.cardId, { driverId: t.driver.driverId, modelId: t.driver.modelId });
    return t;
  };
  for (const tag of tags.list()) restoreTarget({ ...tag, state: tag.armed ? 'armed' : tag.card ? 'identified' : 'scanned' });
  const connected = (t: Target) => tags.has(t.cardId) && evaluateConnection(t, roster).connection !== 'offline';
  const canControl = (t: Target) => midiPermissionsCurrent(t) && mode === 'control' && tags.has(t.cardId) && Boolean(t.specId && verifiedControlCount(deviceSpec(t.specId), t)) && evaluateConnection(t, roster).connection === 'ready';
  // Actions being verified for a wiring program while the card is armed (the setup-time gate below would refuse them).
  const wireVerifying = new Map<string, Set<string>>();
  const wireReleasing = new Map<string, symbol>();
  const connectorPorts = (executorId: string) => hub.devices().filter(d => d.deviceId === executorId && d.online && d.app?.includes('+generated-midi-v1'))
    .flatMap(d => (d.ports ?? []).filter(p => p.kind === 'midi-out'));
  const connectors = new GeneratedConnectorRegistry(connectorPorts);
  // Connectors the Muse agent wrote and deployed (one background Node process per device card).
  let connectorHost: ConnectorHost | undefined;
  const dispatcher = new Dispatcher({ hub, macLocal, log, prepareMidi: request => connectors.encode(request), canExec: (request) => {
    if (request.actionId?.startsWith('agent:') && request.cardId) {
      const match = /^agent:(\d+):(run|release):/.exec(request.actionId);
      const release = match?.[2] === 'release';
      return Boolean(match && connectorHost?.allows(request.cardId, Number(match[1]), release)
        && (!release || isNeutralConnectorRelease(request)));
    }
    // The owner's explicit "move the gimbal a little" check from the Mac (localhost route); BLE moves only.
    if (request.actionId === 'owner:gimbal-test') return request.op.kind === 'ble';
    const t = request.cardId ? targets.get(request.cardId) : undefined;
    const verifying = request.cardId ? wireVerifying.get(request.cardId) : undefined;
    if (t && wireReleasing.has(t.cardId) && request.priorityRelease && isNeutralSoftwareRelease(request)) {
      return mode === 'control' && connected(t) && t.driver?.executor.deviceId === request.executorDeviceId && t.driver.executor.port === request.port;
    }
    if (t && verifying && request.actionId && (verifying.has(request.actionId) || verifying.has(request.actionId.split(':')[0]!) || request.actionId === 'restore-visual-defaults')) {
      return mode === 'control' && connected(t) && t.driver?.executor.deviceId === request.executorDeviceId && (!request.port || t.driver.executor.port === request.port);
    }
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
    // Standalone HTTP samples have no saved device intent; a prefetched visual synth waits for its setup.
    if (!t) return cardId !== VISUAL_SYNTH_CARD_ID && !tags.get(cardId);
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
    if (visualPaused(target)) return { ...status, sentence: 'Visuals closed on the Mac', hint: VISUAL_PAUSED_HINT, detail: 'paused: the Mac visuals are not open' };
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
    wire: (ev) => wireService.resolve(ev),
    manualReady: (t) => !demoMode() || !!wireService.readyFor(t.cardId),
    paused: (t) => (visualPaused(t) ? 'Visuals closed on the Mac: controls paused' : undefined),
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
  // A dial at 20 Hz must not mean 20 library writes and 40 room-wide broadcasts per second (the Mac page re-renders
  // on each): value-only changes are written lazily and published at most every PUBLISH_VALUES_MS.
  let publishedAt = 0;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publishTagsSoon = () => {
    if (publishTimer) return;
    const wait = PUBLISH_VALUES_MS - (Date.now() - publishedAt);
    if (wait <= 0) { publishedAt = Date.now(); publishTags(); return; }
    publishTimer = setTimeout(() => { publishTimer = undefined; publishedAt = Date.now(); publishTags(); }, wait);
    publishTimer.unref?.();
  };
  const unsubscribeTags = targets.onChange((t, kind) => {
    if (!tags.has(t.cardId)) return;
    if (kind === 'value') {
      tags.syncValues(t);
      publishTagsSoon();
      return;
    }
    const spec = t.specId ? specs.get(t.specId) : undefined;
    tags.sync(t, spec, spec ? setupContext(spec) : undefined);
    publishTags();
  });
  const stop = (t: Target, reason = 'cancelled') => {
    wireService.clear(t.cardId);
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
    wireService.clear(cardId);
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
      wireService.clear();
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
    wireService.clear(cardId);
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
    // The visual synth with its screen closed: ask the Mac to open it and continue from there (never a dead end).
    if (t && tags.has(cardId) && mode === 'control' && virtualScreenExecutor(t.card) && !(t.abort && !t.abort.signal.aborted)) {
      const where = visualHost(from);
      if (!where.executor && where.host) return selectVisualSynth({ virtual: 'visual-synth' }, from);
    }
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
    // This explicit setup validates the transport/capability catalog, not a hand
    // program. A retired generated connector must not prevent a new handshake.
    // WIRE stays closed until the subsequent request produces checked new glue.
    if (wireService.readyFor(cardId)) wireService.clear(cardId);
    connectors.useAuthored(cardId);
    steps.failRun(t.runId, CANCELLED_GUIDANCE);
    t.runId = newId('run-');
    setups.add(t.cardId);
    // A completed setup that was declined only needs a fresh ARM confirmation.
    if (!rerun && !visualSynthNeedsUpgrade(t.driver) && midiPermissionsCurrent(t) && t.specId && t.driver && verifiedControlCount(specs.get(t.specId), t) > 0) {
      // Every saved device, including musical synth, discloses reuse before either automatic or explicit re-arm.
      const passed = t.driver.actions.filter((a) => t.verification[a.actionId] === 'pass').length;
      libraryDrivers.set(t.cardId, { driverId: t.driver.driverId, modelId: t.driver.modelId });
      steps.note('drive', `${libraryDriverNote(t.driver)} · ${passed}/${t.driver.actions.length} previously verified`,
        { cardId: t.cardId, runId: t.runId, kind: 'proof', model: t.driver.modelId, source: t.driver.source, evidence: 'saved driver', sentence: 'Saved driver', hint: libraryDriverNote(t.driver) });
      if (demoMode() && virtualScreenExecutor(t.card) && !t.driver.actions.some((a) => a.confirm === 'hold')) {
        showControls(t, from.deviceId);
        arm.auto(t, t.driver, 'ControlAnything demo (CE_DEMO=1, verified silent visuals)');
        setups.delete(t.cardId);
        publishTags();
        return t;
      }
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
    if (virtualScreenExecutor(t.card) && !visualHost(from).executor) return selectVisualSynth({ virtual: 'visual-synth' }, from);
    return setup(t.cardId, from);
  };
  /** The pinched frame (or the sender's latest scan frame) as a detection for Muse to identify. Never a verify ROI. */
  const visualDetection = (from: { deviceId: string }, o: { frameId?: string; detId?: string; label?: string }): TargetDetection | undefined => {
    const frame = o.frameId ? scan.frame(o.frameId) : scan.latest(from.deviceId);
    return frame ? scan.tagDetection(frame.frame.frameId, o.detId, o.label ?? 'laptop') : undefined;
  };
  const hostLine = (seen: DeviceCardPayload, r: Omit<IdentifyResult, 'card'>) =>
    `${r.recordedFrom ?? r.model}${r.source === 'fixture' ? ' (FIXTURE)' : ''} identified the host: ${hostName(seen)} (${Math.round(seen.confidence * 100)} %)`;
  const known = (s?: string) => s && !/^(unknown|unsure|n\/a)?$/i.test(s.trim()) ? s.trim() : '';
  const hostName = (seen: DeviceCardPayload) => [known(seen.maker), known(seen.model)].filter(Boolean).join(' ') || seen.name;
  /** The visual synth card keeps its authored identity; its evidence and work log gain the model's view of the Mac. */
  const adoptHostIdentity = (t: Target, seen: DeviceCardPayload, identity: Omit<IdentifyResult, 'card'>) => {
    if (!t.card) return;
    tagIdentity.set(t.cardId, identity);
    const line = hostLine(seen, identity);
    t.card = { ...t.card, modelId: identity.recordedFrom ?? identity.model, evidence: [line.slice(0, 300), ...t.card.evidence.filter((e) => !/ identified the host: /.test(e))].slice(0, 12) };
    tags.sync(t);
    hub.broadcast('device.card', t.card);
    steps.note('identify', line.slice(0, 200), { cardId: t.cardId, kind: 'opinion', model: identity.recordedFrom ?? identity.model, latencyMs: identity.latencyMs, source: identity.source });
    publishTags();
  };
  /** One quiet Muse identify call on the pinched Mac: the card keeps its authored identity, the evidence gains the model's view. */
  const identifyVisualHost = (t: Target, detection?: TargetDetection) => {
    if (!detection || identifying.has(t.cardId) || tagIdentity.has(t.cardId)) return;
    const abort = new AbortController();
    identifying.set(t.cardId, abort);
    void (async () => {
      try {
        const crop = cropJpeg(decodeJpeg(detection.jpeg), detection.box);
        const r = await identify(muse, detection, crop, detection.jpeg, { cardId: t.cardId, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
        if (abort.signal.aborted || !tags.has(t.cardId) || !t.card) return;
        const { card: seen, ...identity } = r;
        tagIdentity.set(t.cardId, identity);
        adoptHostIdentity(t, seen, identity);
        log(`[visual] ${hostLine(seen, identity)} · ${r.latencyMs} ms`);
      } catch (e) {
        if (!abort.signal.aborted) log(`[visual] could not identify the Mac: ${(e as Error).message}`);
      } finally {
        if (identifying.get(t.cardId) === abort) identifying.delete(t.cardId);
      }
    })();
  };
  /** The one visual synth card (stable id), rebound to whichever paired Mac hosts the renderer now. */
  const bindVisualSynth = (executor: DeviceInfo, from: { deviceId: string }, position?: Vec3, label = 'Visual synth'): Target | undefined => {
    const card = visualSynthCard(executor);
    // Older builds keyed the card on the executor; keep one card in the room.
    if (card.cardId === VISUAL_SYNTH_CARD_ID) for (const tag of tags.list()) {
      if (tag.cardId !== card.cardId && !tag.cardId.startsWith('visual-synth-reviewer-') && virtualScreenExecutor(tag.card)) removeTag(tag.cardId);
    }
    const saved = tags.get(card.cardId);
    if (!saved && tags.library().length >= 64) return undefined;
    let target = targets.get(card.cardId);
    if (!target) target = restoreTarget({ ...(saved ?? {}), cardId: card.cardId, card, selectedBy: from.deviceId, state: saved?.armed ? 'armed' : 'identified' });
    const running = !!(target.abort && !target.abort.signal.aborted);
    const previous = target.driver?.executor.deviceId;
    if (previous && previous !== executor.deviceId && !running) {
      // A re-paired Mac keeps its card; the old companion's proof does not carry over, so it is set up again.
      arm.cancel(target, 'Mac re-paired'); control.cancel(target);
      target.armed = false; target.driver = undefined; target.specId = undefined; target.controlCount = undefined;
      target.verification = {}; target.evidence = []; target.link = undefined;
      tags.setEnabled(card.cardId, false);
      targets.setState(target, 'identified', 'Mac re-paired', { sentence: 'Mac re-paired', hint: 'Set up control again', action: 'retry' });
    }
    const identified = target.card?.evidence.find((e) => / identified the host: /.test(e));
    target.card = { ...card, ...(target.card?.modelId ? { modelId: target.card.modelId } : {}), evidence: identified ? [identified, ...card.evidence] : card.evidence };
    target.selectedBy = from.deviceId;
    target.selection = { preferDeviceId: executor.deviceId, userText: 'Use the built-in silent visual synth on this Mac screen.' };
    // A known software instrument has no fabricated physical detection: verification aims at the centre of view.
    target.detection = undefined;
    tags.add(target, label, position ?? saved?.position);
    canvas.select(from.deviceId, target.cardId);
    hub.broadcast('device.card', target.card);
    publishTags();
    return target;
  };
  /** Pick the paired Mac that hosts the visual synth: an open renderer first, else the only (or remembered) host. */
  const visualHost = (from: { deviceId: string }, deviceId?: string): { executor?: DeviceInfo; host?: DeviceInfo; reason?: string } => {
    const eligible = hub.devices().filter(d => deviceId || !d.app?.startsWith('reviewer-software@'));
    const candidates = visualSynthCompanions(eligible);
    const executor = deviceId ? candidates.find((device) => device.deviceId === deviceId) : candidates.length === 1 ? candidates[0] : undefined;
    if (executor) return { executor, host: executor };
    const hosts = visualSynthHosts(eligible);
    const previousOwners = new Set(targets.list()
      .filter((target) => tags.has(target.cardId) && target.selectedBy === from.deviceId)
      .map((target) => virtualScreenExecutor(target.card)).filter((id) => hosts.some((host) => host.deviceId === id)));
    const savedVisualTags = tags.list().filter((tag) => virtualScreenExecutor(tag.card));
    const savedOwners = new Set(savedVisualTags.map((tag) => virtualScreenExecutor(tag.card)));
    const rememberedOwners = previousOwners.size ? previousOwners : savedOwners;
    const remembered = rememberedOwners.size === 1 ? hosts.find((host) => rememberedOwners.has(host.deviceId)) : undefined;
    // With several renderers open, the one this headset used last wins.
    if (!deviceId && candidates.length > 1 && remembered && candidates.some((c) => c.deviceId === remembered.deviceId)) return { executor: remembered, host: remembered };
    const host = deviceId ? hosts.find((device) => device.deviceId === deviceId) : hosts.length === 1 ? hosts[0] : remembered;
    if (host) return { host };
    return { reason: candidates.length > 1 && !deviceId
      ? 'More than one Mac has visuals open. Keep only the screen you want open, then try again.'
      : hosts.length > 1 && !deviceId ? 'More than one paired companion can open visuals. Keep only the Mac companion you want connected, then try again.'
      : 'Open ControlAnything on the Mac (paired companion) and keep it visible.' };
  };
  /**
   * A selection waiting for the Mac renderer. It never hangs silently: the headset (and the Mac, every client gets
   * target.status) hears "Opening the visuals on the Mac…", then "Open visuals on the Mac" with the request sent
   * again after VISUAL_REMIND_MS, and "The Mac's visuals did not open" after VISUAL_WAIT_MS. CE_DEMO=1 continues
   * into setup by itself once the renderer advertises.
   */
  const clearVisualIntent = () => { for (const timer of visualIntent?.timers ?? []) clearTimeout(timer); visualIntent = undefined; };
  const visualWaitStatus = (state: 'needs-companion' | 'failed', sentence: string, hint: string, action?: 'retry' | 'cancel') => {
    const t = targets.get(VISUAL_SYNTH_CARD_ID);
    if (!t || setups.has(t.cardId)) return;
    // Broadcast only: an armed card keeps its own state (and its controls) for when the screen comes back.
    hub.broadcast('target.status', { ...targets.status(t), state: t.armed ? t.state : state, since: Date.now(), sentence, hint, detail: 'waiting for the Mac visuals', ...(action ? { action } : {}) });
  };
  const awaitVisuals = (host: DeviceInfo, from: { deviceId: string; name?: string }, requestId?: string) => {
    const again = visualIntent?.hostId === host.deviceId;
    clearVisualIntent();
    const at = Date.now();
    hub.sendToDevice(host.deviceId, 'visual.open', { requestId: requestId ?? newId('visual-') });
    log(`[visual] asked ${host.deviceId} to open the visuals for ${from.deviceId}${again ? ' (again)' : ''}`);
    visualWaitStatus('needs-companion', 'Opening the visuals on the Mac…', 'Keep the ControlAnything window in front on the Mac');
    const timers = [
      setTimeout(() => {
        if (visualIntent?.at !== at) return;
        hub.sendToDevice(host.deviceId, 'visual.open', { requestId: newId('visual-') });
        // Only the companion tab that runs the local bridges opens the visuals; a second tab is a common reason for "nothing happens".
        const tabs = hub.clients().devices.find((d) => d.deviceId === host.deviceId)?.connections.filter((c) => c.state !== 'superseded' && c.role === 'companion').length ?? 0;
        log(`[visual] still waiting for ${host.deviceId}'s screen after ${VISUAL_REMIND_MS / 1000} s; asked again (${tabs} companion tab${tabs === 1 ? '' : 's'})`);
        visualWaitStatus('needs-companion', 'Open visuals on the Mac', tabs > 1
          ? `ControlAnything is open in ${tabs} tabs on the Mac: click Open visuals in the tab that says “Runs local bridges”, or close the others`
          : 'Waiting for the Mac’s screen: click Open visuals in ControlAnything on the Mac and keep it in front', 'cancel');
      }, VISUAL_REMIND_MS),
      setTimeout(() => {
        if (visualIntent?.at !== at) return;
        clearVisualIntent();
        log(`[visual] gave up waiting for ${host.deviceId}'s screen after ${VISUAL_WAIT_MS / 1000} s`);
        visualWaitStatus('failed', 'The Mac’s visuals did not open', 'On the Mac, click Open visuals in ControlAnything, then pinch the Mac again', 'retry');
      }, VISUAL_WAIT_MS),
    ];
    for (const timer of timers) timer.unref?.();
    visualIntent = { from, at, hostId: host.deviceId, timers };
  };
  const continueVisualIntent = () => {
    const intent = visualIntent;
    if (!intent || mode !== 'control') return;
    if (!visualHost(intent.from).executor) return;
    clearVisualIntent();
    log(`[visual] ${intent.hostId}'s screen is up after ${((Date.now() - intent.at) / 1000).toFixed(1)} s${demoMode() ? '; continuing into setup' : ''}`);
    if (demoMode() && !agentEnabled) selectVisualSynth({ virtual: 'visual-synth' }, intent.from);
    else { const t = targets.get(VISUAL_SYNTH_CARD_ID); if (t) hub.broadcast('target.status', targets.status(t)); }
  };
  /** Explicit selection of the Mac visual synth. In CE_DEMO=1 it also starts setup. */
  const selectVisualSynth = (p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    const reply = (ok: boolean, cardId?: string, reason?: string, autoSetup?: boolean) => {
      if (p.requestId) hub.sendToDevice(from.deviceId, 'target.select.result', { requestId: p.requestId, ok, cardId, reason, ...(autoSetup ? { autoSetup } : {}) });
    };
    // Choosing the software demo explicitly may enter Control from Annotate.
    if (mode !== 'control') setMode('control');
    const { executor, host, reason } = visualHost(from, p.deviceId);
    const detection = visualDetection(from, { frameId: p.frameId, detId: p.detId, label: p.label });
    if (!executor) {
      if (host) {
        // Bind now so the card (and Muse's identify) is there while the Mac opens its visuals.
        const pending = bindVisualSynth(host, from, p.position);
        if (pending) {
          identifyVisualHost(pending, detection);
        }
        awaitVisuals(host, from, p.requestId);
        // The headset's presence recovery retries selection once the renderer advertises its port.
        reply(false, undefined, 'Opening the Mac visuals… selection continues automatically.');
        return;
      }
      reply(false, undefined, reason);
      return;
    }
    clearVisualIntent();
    const target = bindVisualSynth(executor, from, p.position);
    if (!target) { reply(false, undefined, 'Your device library is full. Forget an unused device, then try again.'); return; }
    identifyVisualHost(target, detection);
    if (target.specId) showControls(target, from.deviceId);
    const running = setups.has(target.cardId) || !!(target.abort && !target.abort.signal.aborted);
    // With the Muse agent there is no setup ceremony: the wearer asks, Muse writes and tests the connector.
    const auto = demoMode() && !agentEnabled && !canControl(target);
    reply(true, target.cardId, agentEnabled ? 'Mac visuals open. Ask Muse what you want.' : auto ? 'Setting up the Mac visuals…' : canControl(target) ? 'Mac visuals ready: your controls are on' : VIRTUAL_SCREEN_GUIDANCE, auto || running);
    if (auto && !running) setup(target.cardId, from);
    return target;
  };
  /** Explicit software selection. Opening the panel never grants sound authority. */
  const selectMusicalSynth = (p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    const reply = (ok: boolean, cardId?: string, reason?: string, autoSetup?: boolean) => {
      if (p.requestId) hub.sendToDevice(from.deviceId, 'target.select.result', { requestId: p.requestId, ok, cardId, reason, ...(autoSetup ? { autoSetup } : {}) });
    };
    if (mode !== 'control') setMode('control');
    const hosts = musicalSynthHosts(hub.devices()).filter(device => p.deviceId || !device.app?.startsWith('reviewer-software@'));
    const selected = p.deviceId ?? musicalSynthExecutor(targets.list().find(t => musicalSynthExecutor(t.card))?.card);
    const host = selected ? hosts.find(d => d.deviceId === selected) : hosts.length === 1 ? hosts[0] : undefined;
    if (!host) { reply(false, undefined, hosts.length > 1 ? 'More than one Mac can host the synth. Keep the Mac companion you want connected.' : 'Open the paired Mac companion to use ControlAnything Synth.'); return; }
    const card = musicalSynthCard(host);
    const saved = tags.get(card.cardId);
    if (!saved && tags.library().length >= 64) { reply(false, undefined, 'Your device library is full. Forget an unused device, then retry.'); return; }
    let target = targets.get(card.cardId);
    if (!target) target = restoreTarget({ ...(saved ?? {}), cardId: card.cardId, card, selectedBy: from.deviceId, state: 'identified' });
    if (target.driver && target.driver.executor.deviceId !== host.deviceId) {
      stop(target, 'Mac re-paired'); target.armed = false; target.driver = undefined; target.specId = undefined;
      target.controlCount = undefined; target.verification = {}; target.evidence = []; target.link = undefined; tags.setEnabled(card.cardId, false);
    }
    target.card = card; target.selectedBy = from.deviceId; target.detection = undefined;
    target.selection = { preferDeviceId: host.deviceId, userText: 'Use the authored ControlAnything browser software instrument. Muse must write the hand wiring when I ask.' };
    tags.add(target, 'ControlAnything Synth', p.position ?? saved?.position); canvas.select(from.deviceId, card.cardId);
    hub.broadcast('device.card', card); publishTags();
    const ready = musicalSynthHosts([host], true).length > 0;
    if (!ready) {
      hub.sendToDevice(host.deviceId, 'musical.open', { requestId: p.requestId ?? newId('musical-') });
      reply(false, card.cardId, MUSICAL_SYNTH_GUIDANCE); return target;
    }
    const running = setups.has(card.cardId) || !!(target.abort && !target.abort.signal.aborted);
    const auto = demoMode() && !agentEnabled && !canControl(target);
    if (target.specId) showControls(target, from.deviceId);
    reply(true, card.cardId, auto ? 'Setting up ControlAnything Synth…' : 'Ask Muse how your hands should play this synth.', auto || running);
    if (auto && !running) setup(card.cardId, from);
    return target;
  };
  const select = (p: TargetSelectPayload, from: { deviceId: string; name?: string }): Target | undefined => {
    if (p.cardId && tags.has(p.cardId)) canvas.select(from.deviceId, p.cardId);
    if (p.virtual === 'visual-synth') return selectVisualSynth(p, from);
    if (p.virtual === 'musical-synth') return selectMusicalSynth(p, from);
    if (mode === 'control') {
      const existing = p.cardId ? targets.get(p.cardId) : undefined;
      if (!existing || !tags.has(existing.cardId)) return undefined;
      if (musicalSynthExecutor(existing.card)) return selectMusicalSynth({ ...p, virtual: 'musical-synth', position: p.position ?? tags.get(existing.cardId)?.position }, from);
      if (virtualScreenExecutor(existing.card)) return selectVisualSynth({ ...p, virtual: 'visual-synth', position: p.position ?? tags.get(existing.cardId)?.position }, from);
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
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const enforcePresence = () => {
    for (const t of targets.list()) {
      if (!tags.has(t.cardId) || connected(t)) continue;
      if (setups.has(t.cardId)) stop(t, 'companion disconnected');
      control.cancel(t, { preserveArmed: true });
    }
  };
  const unsubscribePresence = hub.onPresence((presence) => {
    if (trackVisualPresence()) {
      // Re-check once the grace has run out: a renderer that stayed away loses its setup and live controls then.
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => { trackVisualPresence(); enforcePresence(); publishTags(); }, VISUAL_PRESENCE_GRACE_MS + 250);
      graceTimer.unref?.();
    }
    if (presence.deviceId && !hub.devices().some((device) => device.deviceId === presence.deviceId && device.online)) {
      // A real executor disconnect retires its current programs, including pending
      // native connector writers. A later reconnect must not resume old gestures.
      // Renderer visibility updates still use the existing transient-screen grace.
      for (const cardId of wireService.disconnectExecutor(presence.deviceId)) {
        wireVerifying.delete(cardId);
        const target = targets.get(cardId);
        if (!target) continue;
        control.cancel(target, { preserveArmed: true });
        hub.broadcast('target.status', { ...targets.status(target), sentence: 'Mac disconnected',
          hint: 'Reconnect the Mac, then ask Muse for new controls.', action: 'open-companion' });
      }
      for (const cardId of wireService.disconnectOwner(presence.deviceId)) {
        const target = targets.get(cardId);
        if (!target) continue;
        stop(target, 'The headset that requested this wiring disconnected');
        const driver = target.driver;
        // Only that instrument is silenced. A global panic broadcast would stop other owners and physical ports.
        if (driver?.transport === 'midi' && driver.executor.port) dispatcher.fire(driver.executor.deviceId,
          { kind: 'midi', msg: 'panic', channel: 1 }, { port: driver.executor.port, cardId, driverId: driver.driverId });
      }
      assistant?.disconnect(presence.deviceId);
      voice.disconnect(presence.deviceId);
      canvas.disconnect(presence.deviceId);
    }
    if (presence.deviceId && (presence.reason === 'join' || presence.reason === 'update')) hub.sendToDevice(presence.deviceId, 'mode.state', { mode });
    enforcePresence();
    publishTags();
    continueVisualIntent();
    // Opt-in rehearsal only (CE_PREFETCH=1): Muse writes the Mac visual synth's driver as soon as a Mac advertises it. By default
    // nothing is asked of Muse before the wearer pinches the Mac, and the hand-to-device wiring only after they ask (wire.request).
    if (prefetchEnabled()) for (const host of visualSynthHosts(hub.devices())) {
      // Controls are prefetched only for a first setup: a saved, verified card keeps its own forge entry untouched.
      const saved = targets.get(VISUAL_SYNTH_CARD_ID);
      const running = setups.has(VISUAL_SYNTH_CARD_ID);
      // A repeat selection reuses the saved verified driver (~1 s): no Muse call for it, however much later it is.
      const reusable = !!saved?.driver && saved.driver.executor.deviceId === host.deviceId && !visualSynthNeedsUpgrade(saved.driver)
        && midiPermissionsCurrent(saved) && !!saved.specId && verifiedControlCount(specs.get(saved.specId), saved) > 0;
      prefetchVisualDriver(loopDeps, host, visualSynthCard(host), { forge: !saved?.specId && !running, skip: reusable || running, why: `presence ${presence.reason ?? 'update'}` });
    }
    if (presence.reason === 'join' && presence.deviceId) {
      // a companion that opens late shows the code of the wiring that is running (the headset asks for its own)
      if (hub.devices().find((d) => d.deviceId === presence.deviceId)?.role !== 'hmd') wireService.replayTo(presence.deviceId);
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

  // --- WIRE: Muse writes the hand-to-device wiring after the wearer asks (agent/wire.ts) ---------------------------
  const wireReady = (cardId: string): boolean => {
    const x = targets.get(cardId);
    return !!x && !!x.driver && x.armed && tags.has(cardId) && canControl(x);
  };
  const setupRunning = (cardId: string): boolean => setups.has(cardId) || !!(targets.get(cardId)?.abort && !targets.get(cardId)!.abort!.signal.aborted);
  /** A wire.request on a card without a driver runs setup first, as a pinch would, and waits for it. */
  const ensureWireDriver = async (cardId: string, from: { deviceId: string; name?: string }, signal: AbortSignal): Promise<{ ok: true; note?: string } | { ok: false; reason: string }> => {
    const t = targets.get(cardId);
    if (!t || !tags.has(cardId)) return { ok: false, reason: 'This device is not selected. Pinch it first.' };
    if (mode !== 'control') return { ok: false, reason: 'Switch to Control, pinch the device, then ask again.' };
    // A retained, ready driver is reused for this ask even without a new re-arm/library restoration.
    const readyDriverId = wireReady(cardId) ? t.driver?.driverId : undefined;
    const started = Date.now();
    if (!wireReady(cardId) && !setupRunning(cardId) && !visualIntent && !setup(cardId, from)) {
      return { ok: false, reason: t.hint ?? t.sentence ?? 'The device could not be set up. Pinch it again.' };
    }
    while (!wireReady(cardId)) {
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      const cur = targets.get(cardId);
      if (!cur || !tags.has(cardId)) return { ok: false, reason: 'The device was removed while it was being set up.' };
      if (mode !== 'control') return { ok: false, reason: 'Control mode was left while the device was being set up.' };
      if (cur.state === 'failed' && cur.since >= started) return { ok: false, reason: cur.sentence ?? cur.hint ?? 'Setting the device up failed. Pinch it to try again.' };
      if (Date.now() - started > 150_000) return { ok: false, reason: 'The device is still not ready. Check the Mac and pinch it again.' };
      await new Promise((r) => setTimeout(r, 200));
    }
    const lib = libraryDrivers.get(cardId);
    const driver = targets.get(cardId)!.driver!;
    return { ok: true, ...(readyDriverId === driver.driverId || lib?.driverId === driver.driverId ? { note: libraryDriverNote(driver) } : {}) };
  };
  /** The visual synth's driver plus the manifest's touch inputs (Touch X / Y / pressure), unverified until a wiring uses them. */
  const prepareWireDriver = (t: Target): Driver => {
    const d = t.driver!;
    const musical = isMusicalSynthPort(d.executor.port);
    const ext = musical ? extendWithMusicalCapabilities(d) : extendWithTouch(d);
    if (!ext.added.length) return d;
    const ccs = new Set<number>((musical ? MUSICAL_SYNTH_MANIFEST : VISUAL_SYNTH_MANIFEST).controls.map((c) => c.cc));
    const v = validateDriver(ext.driver, { driverId: d.driverId, executor: d.executor }, { expectedTransport: 'midi', allowedCcs: ccs, emitsLight: false, visualMaxSets: 12 });
    if (!v.ok) {
      log(`[wire] could not add the manifest's touch controls (${ext.added.join(', ')}) to ${t.cardId}'s driver: ${v.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ').slice(0, 300)}`);
      return d;
    }
    t.driver = { ...d, actions: v.driver.actions };
    log(`[wire] ${t.cardId}: the driver gains ${ext.added.join(', ')} from the device's capability manifest (verified when a wiring uses them)`);
    hub.broadcast('driver.spec', t.driver);
    targets.changed(t);
    return t.driver;
  };
  /** Verify actions a wiring uses that have not passed yet (renderer receipt, no camera), then put the visuals back. */
  const verifyWireActions = async (t: Target, ids: string[], signal: AbortSignal): Promise<string[]> => {
    const driver = t.driver;
    if (!driver) return ids;
    const verifying = new Set(ids);
    wireVerifying.set(t.cardId, verifying);
    try {
      const summary = await verifyDriver({ dispatcher, sam, silentSpeech, log, settleMs: () => 350 }, t, driver, {
        actionIds: ids, signal, cleanupAllowed: () => wireVerifying.get(t.cardId) === verifying, onEvidence: (e) => { t.evidence.push(e); hub.broadcast('verify.result', e); },
      });
      for (const id of ids) t.verification[id] = summary.verification[id] ?? 'untested';
      const cur = t.driver!;
      t.driver = { ...cur, actions: cur.actions.map((a) => (ids.includes(a.actionId) ? { ...a, verified: t.verification[a.actionId] } : a)) };
      hub.broadcast('driver.spec', t.driver);
      hub.broadcast('driver.status', { driverId: cur.driverId, cardId: t.cardId, phase: t.armed ? 'armed' : 'verified', actions: t.driver.actions.map((a) => ({ actionId: a.actionId, label: a.label.slice(0, 40), verified: t.verification[a.actionId] ?? 'untested' })), modelId: cur.modelId });
      targets.changed(t);
      if (isVisualSynthPort(driver.executor.port)) {
        // verification freezes the animation and moves parameters: restore the defaults
        await dispatcher.exec(driver.executor.deviceId, { kind: 'midi', msg: 'panic', channel: 1 }, { port: driver.executor.port, cardId: t.cardId, driverId: driver.driverId, actionId: 'restore-visual-defaults', timeoutMs: 1500, signal })
          .catch((err) => log(`[wire] could not restore visual defaults: ${(err as Error).message}`));
      }
    } finally {
      if (wireVerifying.get(t.cardId) === verifying) wireVerifying.delete(t.cardId);
    }
    return ids.filter((id) => t.verification[id] !== 'pass');
  };
  const streamClient = muse.mode === 'live' ? new StreamClient({ apiKey: ctx.config.muse.apiKey, baseUrl: ctx.config.muse.baseUrl }) : undefined;
  const harness = new MuseBridgeHarness({ model: muse.model, mode: muse.mode, callLog: ctx.calls, log,
    ...(streamClient ? { stream: { model: muse.model, stream: streamClient.stream.bind(streamClient) } } : {}),
  });
  const coding = new CodingAgentService({ root: REPO_ROOT, dataDir: ctx.config.dataDir,
    apiKey: ctx.config.muse.apiKey, baseUrl: ctx.config.muse.baseUrl, log, callLog: ctx.calls });
  const freshConnectors = new FreshConnectorGenerator({ dataDir: ctx.config.dataDir,
    apiKey: ctx.config.muse.apiKey, baseUrl: ctx.config.muse.baseUrl, log, callLog: ctx.calls });
  /** The paired Mac companion (the client app with the QR code): it runs Web MIDI, the visual and musical synths. */
  const companionDevice = (cardId?: string): DeviceInfo | undefined => agentCompanion(hub.devices(), cardId ? targets.get(cardId) : undefined);
  /** The DJI Osmo bridge's loopback device (CE_OSMO=web|ble|mock), when it is online. */
  const gimbalDevice = (): DeviceInfo | undefined => hub.devices().find((d) => d.online && d.capabilities.includes('ble') && d.ports?.some((p) => p.id === 'dji-osmo'));
  connectorHost = new ConnectorHost({ log,
    send: (out, done) => {
      const actionId = `agent:${out.generation}:${out.release ? 'release' : 'run'}:${out.target}`;
      if (out.target === 'gimbal') {
        if (virtualAgentRoute(targets.get(out.cardId))) { done(false, 'The selected software instrument cannot move physical hardware.'); return; }
        const g = gimbalDevice();
        if (!g) { done(false, 'no DJI gimbal is connected (Bluetooth bridge off or gimbal not paired)'); return; }
        dispatcher.fire(g.deviceId, out.op, { port: 'dji-osmo', cardId: out.cardId, actionId: `${actionId}-${out.op.op}`, onResult: done });
        return;
      }
      const target = targets.get(out.cardId);
      if (!agentPortAllowed(target, out.port)) { done(false, 'The selected software instrument only permits its own virtual output.'); return; }
      const mac = companionDevice(out.cardId);
      if (!mac) { done(false, 'the Mac companion is not connected'); return; }
      if (out.release && out.op.msg !== 'panic') {
        void dispatcher.exec(mac.deviceId, out.op, { port: out.port, cardId: out.cardId, actionId: `${actionId}-${out.op.msg}`, priorityRelease: true,
          waitForSlot: true, timeoutMs: 1400, signal: AbortSignal.timeout(1500) }).then(ack => done(ack.ok, ack.detail)).catch(error => done(false, (error as Error).message));
      } else dispatcher.fire(mac.deviceId, out.op, { port: out.port, cardId: out.cardId, actionId: `${actionId}-${out.op.msg}:${out.op.channel}:${out.op.number ?? ''}`, onResult: done });
    },
  });
  const agentWorkspace = process.env.CE_AGENT_WORKSPACE?.trim() || join(ctx.config.dataDir, 'muse-agent');
  const museAgent = new MuseAgent({ model: muse.model, mode: muse.mode, workspace: agentWorkspace, repoRoot: REPO_ROOT, host: connectorHost, log, callLog: ctx.calls,
    ...(streamClient ? { stream: { model: muse.model, stream: streamClient.stream.bind(streamClient) } } : {}),
    // Muse narrates its progress through macOS speech (an OS voice, not a model). CE_MAC_SILENT=1 mutes it.
    speak: (text) => { void macLocal.exec({ kind: 'local', op: 'say', arg: text.slice(0, 160) }).catch(() => {}); },
    openVisuals: (cardId) => {
      const mac = companionDevice(cardId);
      if (!mac) return 'The Mac companion is not connected: open ControlAnything on the Mac first.';
      hub.sendToDevice(mac.deviceId, 'visual.open', { requestId: newId('visual-') });
      return `Asked ${mac.name} to open the visual synth.`;
    },
  });
  void museAgent.init().catch((e) => log(`[muse-agent] workspace: ${(e as Error).message}`));
  log(`[muse-agent] ${muse.mode} · workspace ${agentWorkspace}`);
  const agentEnabled = process.env.CE_AGENT !== '0';
  const agentContext = (cardId: string): AgentContext => {
    const t = targets.get(cardId);
    const tag = tags.get(cardId) as unknown as { card?: DeviceCardPayload; label?: string } | undefined;
    const card = t?.card ?? tag?.card;
    const mac = companionDevice(cardId);
    const virtual = virtualAgentRoute(t);
    const outs = (mac?.ports ?? []).filter((p) => p.kind === 'midi-out' && (!virtual || p.id === virtual.portId));
    return {
      cardId, deviceName: card?.name ?? t?.detection?.label ?? tag?.label ?? cardId, ...(card ? { card } : {}),
      ...(t?.detection?.jpeg ? { observation: { jpeg: t.detection.jpeg, capturedAt: t.detection.capturedAt, label: t.detection.label } } : {}),
      companion: { online: !!mac, ...(mac ? { deviceId: mac.deviceId, name: mac.name, ...(mac.app ? { app: mac.app } : {}) } : {}),
        midiOutputs: outs.map((p) => p.name), visualsOpen: outs.some((p) => p.id === 'ce-visual-synth' && p.state === 'connected'),
        musicalOpen: outs.some((p) => p.id === MUSICAL_SYNTH_PORT_ID && p.state === 'connected') },
      gimbal: (() => {
        if (virtual) return { bridge: 'off' as const };
        const g = gimbalDevice(), port = g?.ports?.find((p) => p.id === 'dji-osmo');
        if (!g) return { bridge: 'off' as const };
        return port?.state === 'connected' ? { bridge: 'connected' as const, name: port.name }
          : { bridge: 'waiting' as const, howToConnect: process.env.CE_OSMO === 'web' ? 'Tell the wearer: on the Mac, open http://localhost:8799 in Chrome and click Connect, then pick the Osmo (switch it on; close the DJI Mimo app).' : 'Tell the wearer to switch the Osmo on and close the DJI Mimo app.' };
      })(),
    };
  };
  const wireService = new WireService({
    ...(agentEnabled ? {
      agentBuild: async (cardId: string, request: string, emit: Parameters<MuseAgent['build']>[3], o: { signal: AbortSignal }) => {
        const built = await museAgent.build(cardId, agentContext(cardId), request, emit, { signal: o.signal });
        const info = connectorHost!.info(cardId);
        return { ...built, ...(built.ok && info ? { connector: { entry: info.entry, ...(info.pid ? { pid: info.pid } : {}) } } : {}) };
      },
      agentSet: (cardId: string, actionId: string, value: number | boolean) => connectorHost!.set(cardId, actionId, value),
      agentRelease: (cardId: string) => connectorHost!.waitForRelease(cardId),
    } : {}),
    hub, targets, spark: muse, wonder, log, callLog: ctx.calls, harness,
    ...(streamClient ? { stream: { model: muse.model, stream: streamClient.stream.bind(streamClient) } } : {}),
    chunkDelayMs: Number.isFinite(Number(process.env.CE_WIRE_CHUNK_MS)) && process.env.CE_WIRE_CHUNK_MS !== undefined ? Number(process.env.CE_WIRE_CHUNK_MS) : 70,
    ensureDriver: ensureWireDriver, prepareDriver: prepareWireDriver, verifyActions: verifyWireActions,
    stopOutputs: (target) => {
      // Retire verification cleanup before neutral release: old restores cannot cross a new ask.
      wireVerifying.delete(target.cardId);
      if (setups.has(target.cardId)) {
        target.abort?.abort(new Error('Wiring stopped')); arm.cancel(target, 'Wiring stopped'); setups.delete(target.cardId);
      }
      const release = Symbol('wire release'); wireReleasing.set(target.cardId, release);
      return releaseWireOutputs(target, { dispatcher, cancelQueued: (t) => control.cancel(t, { preserveArmed: true }) })
        .finally(() => { if (wireReleasing.get(target.cardId) === release) wireReleasing.delete(target.cardId); });
    },
    cardOfSpec: (specId) => specs.get(specId)?.cardId,
    ...(muse.mode === 'live' ? { buildConnector: freshConnectorWriter({ generator: freshConnectors, registry: connectors, ports: connectorPorts }) } : {}),
    retireConnector: cardId => { connectors.clear(cardId); if (cardId) connectorHost!.stop(cardId, 'wiring retired'); else connectorHost!.stopAll('wiring retired'); },
    useAuthoredTransport: cardId => connectors.useAuthored(cardId),
    developConnector: async (task, onProgress, signal) => {
      if (signal.aborted) throw new RequestCancelledError();
      const job = await coding.start({ task });
      const cancel = () => { void coding.cancel(job.jobId); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          if (signal.aborted) { await coding.cancel(job.jobId); throw new RequestCancelledError(); }
          const current = coding.get(job.jobId)!;
          if (['completed_unverified', 'failed', 'cancelled'].includes(current.state)) return current;
          onProgress(`Muse Code: ${current.state}. Review progress in the Mac Connector Workshop; changes are not applied.`);
          await cancellableDelay(1000, signal);
        }
      } finally { signal.removeEventListener('abort', cancel); }
    },
  });
  let lastWireLog = 0;

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
      case 'audio.speak':
        // UI/Buddy speech is feedback, not model inference or a device driver.
        // Native OS speech supplies the fallback when Quest lacks speechSynthesis.
        if (from.canApprove || from.local) {
          void macLocal.exec({ kind: 'local', op: 'say', arg: m.payload.text })
            .then(result => { if (!result.ok) hub.sendToDevice(from.deviceId, 'log', { level: 'warn', code: 'audio_speech_unavailable', message: result.detail ?? 'Mac speech is unavailable.' }); })
            .catch(error => log(`[audio] OS speech failed: ${(error as Error).message}`));
        } else hub.sendToDevice(from.deviceId, 'log', { level: 'warn', code: 'forbidden', message: 'Only the paired owner may use Mac speech.' });
        return;
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
        const agentRoute = wireService.routeAgent(m.payload);
        if (agentRoute) {
          if (!agentRoute.ok && Date.now() - lastWireLog > 2000) { lastWireLog = Date.now(); log(`[control] ${m.payload.widgetId}: ${agentRoute.reason}`); }
          return;
        }
        const r = control.onControlEvent(m.payload, from.deviceId);
        if (!r.ok && r.reason && r.reason !== 'not armed' && r.reason !== 'rate limited' && r.reason !== 'paused') {
          // a wiring program can send 60 events a second: one line per 2 s is enough
          if (!m.payload.widgetId.startsWith('wire:') || Date.now() - lastWireLog > 2000) { lastWireLog = Date.now(); log(`[control] ${m.payload.widgetId}: ${r.reason}`); }
        }
        return;
      }
      case 'wire.request':
        // the wearer asks (chip, voice or text); only an owner or local device may have Muse write anything
        if (!from.canApprove && !from.local) { hub.sendToDevice(from.deviceId, 'log', { level: 'error', code: 'forbidden', message: 'Only an owner may ask Muse to wire a device.' }); return; }
        wireService.request(m.payload, from);
        return;
      case 'wire.stop':
        void wireService.stop(m.payload, from);
        return;
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
    coding,
    freshConnectors,
    connectors,
    harness,
    museAgent,
    connectorHost: connectorHost!,
    agentWorkspace,
    wireReady: (cardId: string) => wireService.readyFor(cardId),
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
      void coding.close();
      void freshConnectors.close();
      clearTimeout(graceTimer);
      clearTimeout(publishTimer);
      clearVisualIntent();
      wireService.close();
      connectorHost?.stopAll('server closing');
      tags.flushPending();
      canvas.invalidate();
      voice.invalidate();
      assistant?.invalidate();
      unsubscribe();
      unsubscribePresence();
      unsubscribeAudio();
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
