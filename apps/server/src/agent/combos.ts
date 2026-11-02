/**
 * The room: combos and daemons that span the devices the loop has verified, assembled deterministically from
 * their drivers (no model writes a room hack; every step is a verified action of a device-level driver).
 *
 *   Blackout      light off (IR) + Mac muted (local volume 0) + a receipt on the DevTerm (local print);
 *                 devices that are not online are skipped and said so; each step produces its own evidence;
 *                 one tap confirms; UNDO restores what can be restored (light, volume) and names what cannot (paper).
 *   Breathe       a daemon: the light's brightness breathes to the synth's tempo (see daemons.ts).
 *   Say line      the Mac speaks its driver's line; a microphone client records it and Muse Voice Transcribe
 *                 must hear it back (evidence: transcript similarity, see heard.ts). Nothing to undo.
 *
 * The room is published as ui.spec "spec_room" (hack set + a small gen3d hack-list and daemon-link).
 */
import { type Gen3dSpec, GEN3D_SPEC_VERSION } from '@ce/gen3d';
import type { Daemon, Driver, DriverAction, Evidence, Hack, HackSet, UiSpecPayload } from '@ce/protocol';
import { resolveOp } from '../devices/encode';
import type { Hub } from '../hub';
import { cancellableDelay, forwardCancellation, throwIfCancelled } from '../muse/cancellation';
import type { Sam } from '../scan/sam';
import type { ArmService } from './arm';
import type { DaemonRunner } from './daemons';
import type { Dispatcher } from './dispatch';
import { pickSensor, type Roster } from './executors';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';
import { type VerifyDeps, verifyOnce } from './verify';

export const ROOM_CARD_ID = 'room';
export const ROOM_SPEC_ID = 'spec_room';
export const BLACKOUT_ID = 'blackout';
export const BREATHE_ID = 'breathe';
export const BREATHE_DAEMON_ID = 'd_breathe';
export const SAY_LINE_ID = 'say-line';

export interface RoomDevices {
  light?: Target;
  mac?: Target;
  devterm?: Target;
  synth?: Target;
}

const usable = (t: Target) => Boolean(t.driver) && ['verified', 'forged', 'arming', 'armed', 'controlling'].includes(t.state);

/** Which verified targets play which part in the room. */
export function roomDevices(targets: Target[]): RoomDevices {
  const list = targets.filter((t) => t.cardId !== ROOM_CARD_ID && usable(t));
  const light = list.find((t) => t.driver!.transport === 'ir');
  const synth = list.find((t) => t.driver!.transport === 'midi');
  const locals = list.filter((t) => t.driver!.transport === 'local');
  const mac = locals.find((t) => t.driver!.executor.deviceId === 'mac-local' || /mac/i.test(t.card?.name ?? '') || t.card?.notes?.startsWith('device:mac'));
  const devterm = locals.find((t) => /devterm/i.test(`${t.card?.name} ${t.card?.notes}`) || t.driver!.actions.some((a) => a.encode.kind === 'local' && a.encode.op === 'print'));
  return { light, mac, devterm, synth };
}

const verifiedAction = (t: Target | undefined, pick: (a: DriverAction) => boolean): DriverAction | undefined =>
  t?.driver?.actions.find((a) => pick(a) && t.verification[a.actionId] === 'pass');

/** The light's "off" action, its inverse, and its brightness control hack (in the light's own spec). */
function lightParts(light: Target | undefined, lightSpec: UiSpecPayload | undefined) {
  const off = verifiedAction(light, (a) => a.expect?.effect === 'off');
  const on = off?.inverseActionId ? light?.driver?.actions.find((a) => a.actionId === off.inverseActionId) : verifiedAction(light, (a) => a.expect?.effect === 'on');
  const level = light?.driver?.actions.find((a) => a.kind === 'set' && a.encode.kind === 'step');
  const levelHack = lightSpec?.hackset?.hacks.find((h) => h.kind === 'control' && h.commands.some((c) => c.action === level?.actionId));
  return { off, on, level, levelHack };
}

/** Build the room's hack set + spec from the verified targets. Undefined when the room has nothing to combine. */
export function buildRoomSpec(targets: Target[], specOf: (specId: string) => UiSpecPayload | undefined, rev = 1): UiSpecPayload | undefined {
  const dev = roomDevices(targets);
  const lightSpec = dev.light?.specId ? specOf(dev.light.specId) : undefined;
  const { off, on, levelHack } = lightParts(dev.light, lightSpec);
  const volume = verifiedAction(dev.mac, (a) => a.encode.kind === 'local' && a.encode.op === 'volume') ?? dev.mac?.driver?.actions.find((a) => a.encode.kind === 'local' && a.encode.op === 'volume');
  const print = dev.devterm?.driver?.actions.find((a) => a.encode.kind === 'local' && a.encode.op === 'print');
  const hacks: Hack[] = [];
  const daemons: Daemon[] = [];
  const skipped: string[] = [];

  if (off && dev.light) {
    const commands: Hack['commands'] = [{ cardId: dev.light.cardId, action: off.actionId }];
    if (volume && dev.mac) commands.push({ cardId: dev.mac.cardId, action: volume.actionId, value: 0 });
    else skipped.push('Mac');
    if (print && dev.devterm) commands.push({ cardId: dev.devterm.cardId, action: print.actionId, delayMs: 200 });
    else skipped.push('DevTerm');
    const inverse: Hack['commands'] = [];
    if (on) inverse.push({ cardId: dev.light.cardId, action: on.actionId });
    if (volume && dev.mac) inverse.push({ cardId: dev.mac.cardId, action: volume.actionId, param: 'restore' });
    hacks.push({
      id: BLACKOUT_ID,
      name: 'Blackout',
      kind: 'action',
      blurb: `lights out, Mac muted${print && dev.devterm ? ', receipt prints' : ''}`.slice(0, 40),
      commands,
      oracle: { type: 'camera', region: 'mask', expect: 'off' },
      reversible: true,
      inverse: { commands: inverse },
      confirm: 'tap',
      max_rate_hz: 0.2,
      status: 'ready',
    });
  }

  // Say line: the Mac speaks its driver's line; a microphone client records it and Muse Voice Transcribe must hear it back
  const say = verifiedAction(dev.mac, (a) => a.encode.kind === 'local' && a.encode.op === 'say') ?? dev.mac?.driver?.actions.find((a) => a.encode.kind === 'local' && a.encode.op === 'say');
  if (say && dev.mac) {
    hacks.push({
      id: SAY_LINE_ID,
      name: 'Say line',
      kind: 'action',
      blurb: 'Mac speaks; the mic must hear it back',
      commands: [{ cardId: dev.mac.cardId, action: say.actionId }],
      oracle: { type: 'mic', expect: 'louder' },
      reversible: false,
      confirm: 'tap',
      max_rate_hz: 0.2,
      status: dev.mac.verification[say.actionId] === 'pass' ? 'verified' : 'ready',
    });
  }

  if (levelHack && dev.light) {
    const param = levelHack.params?.[0];
    const source = dev.synth ? `device.${dev.synth.cardId}.clock_bpm` : 'tempo';
    hacks.push({
      id: BREATHE_ID,
      name: 'Breathe to tempo',
      kind: 'daemon',
      blurb: dev.synth ? 'light breathes with the synth' : 'light breathes at a set tempo',
      params: [{ id: 'bpm', name: 'Tempo', min: 40, max: 200, default: 120, unit: 'bpm', step: 1 }],
      commands: [{ cardId: dev.light.cardId, action: levelHack.commands[0].action, param: 'bpm' }],
      oracle: { type: 'camera', region: 'mask', expect: 'luminance_tracks_param' },
      reversible: true,
      inverse: { restore: 'bpm' },
      max_rate_hz: 1,
      status: 'ready',
    });
    daemons.push({
      id: BREATHE_DAEMON_ID,
      name: 'Breathe to tempo',
      blurb: 'brightness follows the beat, <= 0.5 Hz',
      trigger: { source },
      map: { curve: 'sine', range: [param?.min ?? 0, param?.max ?? 100], period_bars: 2 },
      targets: [{ hack: levelHack.id, param: param?.id }],
      max_rate_hz: 1,
      status: 'proposed',
    });
  }
  if (!hacks.length) return undefined;

  const hackset: HackSet = {
    spec: 'ce.hackset/1',
    device: { id: ROOM_CARD_ID, name: 'Room', kind: 'room', channel: { type: 'local' } },
    hacks,
    daemons: daemons.length ? daemons : undefined,
    notes: `Assembled by the server from verified device drivers; no model wrote these combos.${skipped.length ? ` Not online: ${skipped.join(', ')} (skipped).` : ''}`.slice(0, 400),
  };
  const parts: Gen3dSpec['parts'] = [
    { id: 'menu', kind: 'archetype', archetype: 'hack-list', params: { title: 'ROOM', items: hacks.map((h) => ({ id: h.id, label: h.name.slice(0, 24), kind: h.kind, controlId: h.id, status: 'ready' as const })) } },
  ];
  if (daemons.length) parts.push({ id: 'link', kind: 'archetype', archetype: 'daemon-link', controlId: BREATHE_ID, params: { title: 'BREATHE', from: [-0.25, 0.05, 0], to: [0.25, 0.05, 0], active: false } });
  parts.push({ id: 'handle', kind: 'archetype', archetype: 'handle' });
  const gen3d: Gen3dSpec = {
    spec: GEN3D_SPEC_VERSION,
    specId: ROOM_SPEC_ID,
    rev,
    title: 'Room',
    anchor: { mode: 'floating', distance: 0.7, pitchDeg: -10 },
    state: { armed: false, reason: 'each room hack asks for a tap when it runs' },
    controls: hacks.map((h) =>
      h.kind === 'daemon'
        ? { id: h.id, kind: 'toggle' as const, label: 'BREATHE', binding: { action: h.commands[0].action, args: { hack: h.id } }, armed: true }
        : { id: h.id, kind: 'trigger' as const, label: h.name.slice(0, 16).toUpperCase(), binding: { action: h.commands[0].action, args: { hack: h.id } }, armed: true },
    ),
    parts,
    behaviors: [],
    feedback: [],
    source: 'hand',
    notes: hackset.notes,
  };
  return { specId: ROOM_SPEC_ID, title: 'Room', cardId: ROOM_CARD_ID, rev, gen3d, hackset, notes: hackset.notes, modelId: 'none' };
}

// --- running a combo ------------------------------------------------------------------------

export interface ComboDeps {
  hub: Pick<Hub, 'broadcast'>;
  targets: TargetStore;
  steps: StepLog;
  dispatcher: Dispatcher;
  sam: Sam;
  roster: Roster;
  arm: ArmService;
  daemons: DaemonRunner;
  heard?: VerifyDeps['heard'];
  /** read the Mac's output volume before muting it (osascript), for UNDO */
  readVolume?: () => Promise<number | undefined>;
  /** CE_MAC_SILENT: a recorded clip stands in for the Mac's voice */
  silentSpeech?: VerifyDeps['silentSpeech'];
  log?: (line: string) => void;
  canControl?: (target: Target) => boolean;
}

interface ComboStep {
  cardId: string;
  name: string;
  actionId: string;
  ok: boolean;
  skipped?: string;
  /** how to undo: an action to run, a value to restore, or nothing */
  undo?: { actionId: string; value?: number } | 'none';
  undone?: boolean;
}

export interface ComboRun {
  hackId: string;
  startedAt: number;
  steps: ComboStep[];
  evidence: Evidence[];
  confirmed: boolean;
}

export class ComboRunner {
  lastRun?: ComboRun;
  private busy = false;
  private active?: { abort: AbortController; cardIds: Set<string> };

  constructor(private readonly d: ComboDeps) {}

  /** Run a room hack: one tap, then every step for real with its own evidence. Offline devices are skipped and named. */
  async run(hack: Hack, spec: UiSpecPayload, opts: { signal?: AbortSignal; confirm?: boolean } = {}): Promise<ComboRun> {
    if (this.busy) throw new Error('a room hack is already running');
    this.busy = true;
    const abort = new AbortController();
    const detach = forwardCancellation(opts.signal, abort);
    const signal = abort.signal;
    this.active = { abort, cardIds: new Set([ROOM_CARD_ID, ...hack.commands.flatMap((c) => c.cardId ? [c.cardId] : [])]) };
    const room = this.roomTarget(spec.specId);
    const run: ComboRun = { hackId: hack.id, startedAt: Date.now(), steps: [], evidence: [], confirmed: false };
    try {
      throwIfCancelled(signal);
      const names = hack.commands.map((c) => this.d.targets.get(c.cardId ?? '')?.card?.name ?? c.cardId ?? '?');
      if (opts.confirm !== false) {
        const r = await this.d.arm.ask(room, { title: `Run ${hack.name}?`, summary: `${hack.blurb ?? hack.name}: ${names.join(', ')}`, actions: hack.commands.map((c) => ({ actionId: `${c.cardId}.${c.action}`, label: `${this.d.targets.get(c.cardId ?? '')?.card?.name ?? c.cardId}: ${c.action}`.slice(0, 40), verified: (this.d.targets.get(c.cardId ?? '')?.verification[c.action] ?? 'untested') as 'pass' | 'fail' | 'untested' | 'pending' })), irreversible: hack.commands.some((c) => c.action === 'print') }, signal);
        throwIfCancelled(signal);
        if (!r.armed) {
          this.d.steps.note('control', `${hack.name} not run: ${r.reason ?? 'declined'}`, { cardId: ROOM_CARD_ID, kind: 'proof', status: 'fail' });
          this.lastRun = run;
          return run;
        }
      }
      run.confirmed = true;
      this.d.targets.setState(room, 'controlling', hack.name);
      const camera = pickSensor(this.d.roster, 'camera');
      const mic = pickSensor(this.d.roster, 'mic');
      const vdeps: VerifyDeps = { dispatcher: this.d.dispatcher, sam: this.d.sam, heard: this.d.heard, silentSpeech: this.d.silentSpeech, log: this.d.log, settleMs: (_t, a) => (a.encode.kind === 'ir' ? 1800 : 350) }; // the lamp's fade is 1.2 s: let it finish before the 'after' frame
      for (const cmd of hack.commands) {
        throwIfCancelled(signal);
        const t = cmd.cardId ? this.d.targets.get(cmd.cardId) : undefined;
        const name = t?.card?.name ?? cmd.cardId ?? '?';
        const a = t?.driver?.actions.find((x) => x.actionId === cmd.action);
        const step: ComboStep = { cardId: cmd.cardId ?? '', name, actionId: cmd.action, ok: false };
        run.steps.push(step);
        if (!t?.driver || !a) {
          step.skipped = 'no verified driver';
          this.d.steps.note('control', `${hack.name}: ${name} skipped (no driver)`, { cardId: ROOM_CARD_ID, kind: 'proof', status: 'fail' });
          continue;
        }
        const online = this.d.roster.devices().some((dv) => dv.deviceId === t.driver!.executor.deviceId && dv.online) || (t.driver.executor.deviceId === 'mac-local' && this.d.roster.macLocal);
        if (!online) {
          step.skipped = 'offline';
          this.d.steps.note('control', `${hack.name}: ${name} is offline, skipped`, { cardId: ROOM_CARD_ID, kind: 'proof', status: 'fail', evidence: `${t.driver.executor.deviceId} offline` });
          continue;
        }
        if (cmd.delayMs) await cancellableDelay(cmd.delayMs, signal);
        if (!t.armed || t.verification[a.actionId] !== 'pass' || this.d.canControl?.(t) === false) {
          step.skipped = 'control is not authorized for this device';
          continue;
        }
        // remember how to come back
        if (a.encode.kind === 'local' && a.encode.op === 'volume') {
          const prev = (await this.d.readVolume?.()) ?? t.paramValues[a.actionId];
          step.undo = { actionId: a.actionId, value: prev ?? 50 };
          if (prev === undefined) this.d.log?.(`[combo] previous volume unknown; UNDO restores 50`);
        } else if (a.encode.kind === 'local' && a.encode.op === 'print') step.undo = 'none';
        else if (a.inverseActionId) step.undo = { actionId: a.inverseActionId };
        else step.undo = 'none';
        throwIfCancelled(signal);
        if (!t.armed || this.d.canControl?.(t) === false) continue;
        try {
          const { evidence } = await verifyOnce(vdeps, t, t.driver, a, 1, { cameraDeviceId: camera?.deviceId, micDeviceId: mic?.deviceId, signal, confirmations: 1, value: cmd.value, retainVolume: true }, t.detection?.polygon);
          throwIfCancelled(signal);
          run.evidence.push(evidence);
          this.d.hub.broadcast('verify.result', evidence);
          step.ok = evidence.pass;
          this.d.steps.note('control', `${hack.name}: ${name} ${a.label} · ${evidence.note ?? ''}`, { cardId: ROOM_CARD_ID, kind: 'proof', status: step.ok ? 'ok' : 'fail', evidence: evidence.pass ? 'seen ✓' : 'sent, not seen ✗' });
          if (a.encode.kind === 'local' && a.encode.op === 'volume' && cmd.value !== undefined) t.paramValues[a.actionId] = cmd.value;
        } catch (e) {
          throwIfCancelled(signal);
          step.skipped = (e as Error).message.slice(0, 120);
          this.d.steps.note('control', `${hack.name}: ${name} failed: ${step.skipped}`, { cardId: ROOM_CARD_ID, kind: 'proof', status: 'fail' });
        }
      }
      const done = run.steps.filter((s) => s.ok).length;
      this.d.steps.note('control', `${hack.name}: ${done} of ${run.steps.length} steps done${run.steps.some((s) => s.skipped) ? ` · skipped: ${run.steps.filter((s) => s.skipped).map((s) => `${s.name} (${s.skipped})`).join(', ')}` : ''}`, { cardId: ROOM_CARD_ID, kind: 'proof', evidence: `${done}/${run.steps.length} ✓` });
      this.d.targets.setState(room, 'forged', `${hack.name} done`);
      this.lastRun = run;
      return run;
    } finally {
      detach();
      this.active = undefined;
      this.busy = false;
    }
  }

  /** UNDO the last combo: restore what can be restored, name what cannot. */
  async undo(): Promise<{ restored: string[]; cannot: string[] }> {
    if (this.busy) throw new Error('a room hack is already running');
    const run = this.lastRun;
    const restored: string[] = [];
    const cannot: string[] = [];
    if (!run) return { restored, cannot };
    this.busy = true;
    const abort = new AbortController();
    this.active = { abort, cardIds: new Set([ROOM_CARD_ID, ...run.steps.map((step) => step.cardId)]) };
    try {
      for (const step of [...run.steps].reverse()) {
        throwIfCancelled(abort.signal);
        if (!step.ok || step.undone) continue;
        const t = this.d.targets.get(step.cardId);
        const said = t?.driver?.actions.find((x) => x.actionId === step.actionId)?.encode;
        if (said?.kind === 'local' && said.op === 'say') continue; // words are not undone, and nothing is left to restore
        if (!step.undo || step.undo === 'none' || !t?.driver) {
          cannot.push(step.actionId === 'print' ? 'paper' : `${step.name}: ${step.actionId}`);
          continue;
        }
        const a = t.driver.actions.find((x) => x.actionId === (step.undo as { actionId: string }).actionId);
        if (!a || a.encode.kind === 'step' || !t.armed || t.verification[a.actionId] !== 'pass' || this.d.canControl?.(t) === false) {
          cannot.push(`${step.name}: ${step.actionId}`);
          continue;
        }
        try {
          const op = resolveOp(a, step.undo.value);
          await this.d.dispatcher.exec(t.driver.executor.deviceId, op, { port: t.driver.executor.port, cardId: t.cardId, driverId: t.driver.driverId, actionId: a.actionId, lightCap: t.driver.transport === 'ir', waitForSlot: true, timeoutMs: 4000, signal: abort.signal });
          throwIfCancelled(abort.signal);
          if (step.undo.value !== undefined) t.paramValues[a.actionId] = step.undo.value;
          step.undone = true;
          restored.push(step.undo.value !== undefined ? `${step.name} ${a.label.toLowerCase()} ${step.undo.value}` : `${step.name} ${a.label.toLowerCase()}`);
        } catch (e) {
          throwIfCancelled(abort.signal);
          cannot.push(`${step.name}: ${(e as Error).message.slice(0, 60)}`);
        }
      }
      const summary = `undone · ${restored.join(' · ') || 'nothing restored'}${cannot.length ? ` · ${cannot.length} of ${run.steps.filter((s) => s.ok).length} cannot be undone: ${cannot.join(', ')}` : ''}`;
      this.d.steps.note('control', summary.slice(0, 200), { cardId: ROOM_CARD_ID, kind: 'proof', evidence: `${restored.length} restored`, status: restored.length ? 'ok' : 'fail' });
      return { restored, cannot };
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  /** Stop confirmations, spacing waits and dispatches owned by a running combo or undo. */
  cancel(cardId?: string): void {
    if (!cardId || this.active?.cardIds.has(cardId)) this.active?.abort.abort();
    if (!cardId || cardId === ROOM_CARD_ID || this.lastRun?.steps.some((step) => step.cardId === cardId)) this.lastRun = undefined;
  }

  roomTarget(specId: string): Target {
    let room = this.d.targets.get(ROOM_CARD_ID);
    if (!room) {
      room = this.d.targets.create({ cardId: ROOM_CARD_ID, card: { cardId: ROOM_CARD_ID, name: 'Room', maker: '', model: '', category: 'other', confidence: 1, protocols: ['other'], evidence: ['combos of verified devices'], source: 'live' }, specId });
      room.state = 'forged';
    }
    room.specId = specId;
    return room;
  }
}

/** The driver of a room step, for callers that need the executor. */
export function stepDriver(targets: TargetStore, cardId: string | undefined): Driver | undefined {
  return cardId ? targets.get(cardId)?.driver : undefined;
}
