/**
 * The agent: wires the discovery loop and the control loop to the hub. One per server context (getAgent).
 *
 *   scan.frame -> ScanService (SAM 3.1 + QR pairing) -> scan.result
 *   target.select -> a Target -> runLoop (identify, link, research, drive, verify, forge, arm)
 *   exec.ack / sense.result -> Dispatcher · arm.confirm -> ArmService · control.event / panic -> ControlRouter
 *   voice.audio / voice.text -> VoiceRelay · gen3d.generate / gen3d.edit -> the forge
 */
import { type DeviceCardPayload, EXPERIMENTAL_TYPE, type Message, type TargetSelectPayload } from '@ce/protocol';
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
import { ControlRouter } from './control';
import { Dispatcher } from './dispatch';
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
  const specs = {
    get: (specId: string) => forge()?.get(specId),
    list: () => forge()?.list() ?? [],
  };
  const control = new ControlRouter({ targets, dispatcher, specs, steps, hub, log });
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
      panic: (reason) => void control.panic(reason),
      undo: (cardId) => {
        const t = latestSpecTarget(cardId);
        return t ? control.undo(t).ok : false;
      },
      hack: (text, cardId) => {
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
        control.panic(m.payload.reason ?? `panic from ${from.name}`, m.payload.cardId);
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
    profiles,
    sam,
    roster,
    forge,
    select,
    close: () => {
      unsubscribe();
      for (const t of targets.list()) t.abort?.abort();
      control.close();
      arm.close();
      dispatcher.close();
    },
  };
}
