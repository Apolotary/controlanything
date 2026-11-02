/**
 * CONTROL: the deterministic hot path. control.event -> hack (by control id) -> driver actions -> resolved op ->
 * exec.command, with no model, no await before the send, per-hack and per-executor rate limits, the human
 * arm gate and panic. Target: under 50 ms on the LAN (the server part is well under 1 ms).
 */
import type { ControlEventPayload, ControlResultPayload, Driver, DriverAction, Hack, HackCommand, UiSpecPayload } from '@ce/protocol';
import { clamp, planSteps, resolveOp } from '../devices/encode';
import type { Hub } from '../hub';
import { Dispatcher, RateLimiter, type ExecResult } from './dispatch';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';
import { gestureHack } from './gesture-route';

export interface SpecSource {
  get(specId: string): UiSpecPayload | undefined;
  list(): UiSpecPayload[];
}

export interface ControlDeps {
  targets: TargetStore;
  dispatcher: Dispatcher;
  specs: SpecSource;
  steps: StepLog;
  hub: Pick<Hub, 'broadcast'>;
  log?: (line: string) => void;
  now?: () => number;
  /** Space mode, tag membership and connection policy, rechecked for scheduled operations. */
  canControl?: (target: Target) => boolean;
  onResult?: (result: ControlResultPayload, from: string) => void;
  /** room hacks (combos, daemons) are not fired here: the owner of the hook runs them */
  onRoomHack?: (hack: Hack, spec: UiSpecPayload, value: number | boolean, from?: string) => RouteResult;
}

export interface RouteResult {
  ok: boolean;
  reason?: string;
  cardId?: string;
  hackId?: string;
  /** ops handed to the dispatcher */
  fired: number;
  /** server time spent, ms */
  ms: number;
}

interface LastRun {
  hackId: string;
  previousParam?: { paramId: string; value: number };
}

/** Reserve every operation before sealing; success means every actual executor ack succeeded. */
class CommandBatch {
  private pending = 1;
  private completed = false;
  constructor(private readonly result: ExecResult) {}
  next(): ExecResult {
    this.pending++;
    let called = false;
    return (ok, detail) => {
      if (called) return;
      called = true;
      this.finish(ok, detail);
    };
  }
  seal(): void { this.finish(true); }
  private finish(ok: boolean, detail?: string): void {
    this.pending--;
    if (this.completed || ok && this.pending > 0) return;
    this.completed = true;
    this.result?.(ok, detail);
  }
}

export class ControlRouter {
  private readonly hackLimiters = new Map<string, RateLimiter>();
  private readonly gestureSentAt = new Map<string, number>();
  private readonly stepTimers = new Map<string, { cardId: string; timer: ReturnType<typeof setTimeout>; cancel?: () => void }>();
  private readonly commandTimers = new Map<ReturnType<typeof setTimeout>, { cardId: string; sourceCardId: string; cancel?: () => void }>();
  private readonly trailingControls = new Map<string, { cardId: string; timer: ReturnType<typeof setTimeout>; event: ControlEventPayload; from?: string }>();
  private readonly lastRun = new Map<string, LastRun>();
  private readonly latestCommand = new Map<string, number>();
  private commandSerial = 0;
  private readonly log: (line: string) => void;
  private lastDisarmedLog = 0;

  constructor(private readonly d: ControlDeps) {
    this.log = d.log ?? (() => {});
  }

  /** Find the target + spec + hack a control event refers to. */
  resolve(ev: Pick<ControlEventPayload, 'widgetId' | 'specId'>): { target: Target; spec: UiSpecPayload; hack: Hack; driver: Driver } | { reason: string } {
    if (ev.widgetId.startsWith('gesture:') && !ev.specId) return { reason: 'gesture control requires a target spec' };
    const specs = ev.specId ? [this.d.specs.get(ev.specId)].filter(Boolean) : this.d.specs.list();
    for (const spec of specs as UiSpecPayload[]) {
      const gestureTarget = ev.widgetId.startsWith('gesture:') && spec.cardId ? this.d.targets.get(spec.cardId) : undefined;
      const hack = ev.widgetId.startsWith('gesture:')
        ? gestureTarget?.driver && gestureHack(ev.widgetId, spec, gestureTarget.driver, gestureTarget.verification)
        : spec.hackset?.hacks.find((h) => h.id === ev.widgetId) ?? spec.hackset?.hacks.find((h) => spec.gen3d?.controls.some((c) => c.id === ev.widgetId && (c.binding.args?.hack === h.id || c.id === h.id)));
      if (!hack) continue;
      const target = spec.cardId ? this.d.targets.get(spec.cardId) : this.d.targets.list().find((t) => t.specId === spec.specId);
      if (!target) return { reason: `no target for ${spec.cardId ?? spec.specId}` };
      // room hacks have no driver of their own: their commands name the device per step
      if (!target.driver) {
        if (hack.commands.every((c) => c.cardId)) return { target, spec, hack, driver: { driverId: 'room', cardId: target.cardId, transport: 'local', executor: { deviceId: 'room' }, provenance: [], actions: [] } };
        return { reason: `no driver for ${spec.cardId ?? spec.specId}` };
      }
      return { target, spec, hack, driver: target.driver };
    }
    return { reason: `no hack or control "${ev.widgetId}"${ev.specId ? ` in spec ${ev.specId}` : ''}` };
  }

  onControlEvent(ev: ControlEventPayload, from?: string): RouteResult {
    const result = this.routeControlEvent(ev, from);
    if (!result.ok && ev.phase !== 'start') this.report(ev, from, false, result.reason);
    return result;
  }

  private report(ev: ControlEventPayload, from: string | undefined, ok: boolean, detail?: string, specId = ev.specId): void {
    if (from && specId) this.d.onResult?.({ specId, widgetId: ev.widgetId, ts: ev.ts, ok, detail: detail?.slice(0, 512) }, from);
  }

  private routeControlEvent(ev: ControlEventPayload, from?: string): RouteResult {
    const t0 = performance.now();
    const r = this.resolve(ev);
    if ('reason' in r) return { ok: false, reason: r.reason, fired: 0, ms: performance.now() - t0 };
    const { target, spec, hack, driver } = r;
    if (!this.allowed(target)) return { ok: false, reason: 'control is not authorized for this device', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    // combos and daemons: handed to their runner (they ask for their own tap)
    if (hack.kind === 'daemon' || hack.commands.some((c) => c.cardId && c.cardId !== target.cardId)) {
      if (!this.d.onRoomHack) return { ok: false, reason: 'no room hack runner', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
      if (ev.phase === 'start' || ev.phase === 'move') return { ok: true, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
      const v = typeof ev.value === 'number' || typeof ev.value === 'boolean' ? ev.value : (ev.value as { x: number }).x;
      return { ...this.d.onRoomHack(hack, spec, v, from), ms: performance.now() - t0 };
    }
    if (!target.armed) {
      const now = Date.now();
      if (now - this.lastDisarmedLog > 2000) {
        this.lastDisarmedLog = now;
        this.log(`[control] ${hack.id} ignored: ${target.cardId} is not armed`);
      }
      return { ok: false, reason: 'not armed', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    }
    if (ev.phase === 'start') return { ok: true, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    // actions must have passed verification (controls bound to unverified actions stay disarmed)
    const unverified = hack.commands.filter((c) => target.verification[c.action] !== 'pass').map((c) => c.action);
    if (unverified.length) return { ok: false, reason: `unverified actions: ${unverified.join(', ')}`, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    if (hack.kind === 'action' && ev.phase !== undefined && ev.phase !== 'end') return { ok: true, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    const key = `${target.cardId}:${hack.id}`;
    const gesture = ev.widgetId.startsWith('gesture:');
    const limiter = gesture ? undefined : this.limiter(target.cardId, hack);
    const now = (this.d.now ?? Date.now)();
    const lastGesture = this.gestureSentAt.get(key) ?? -Infinity;
    if (gesture ? now - lastGesture < 1000 / hack.max_rate_hz : !limiter!.take()) {
      // A released performance clutch must never leave a delayed move waiting in this router.
      if (ev.widgetId.startsWith('gesture:')) return { ok: false, reason: 'rate limited', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
      if (hack.kind !== 'control') return { ok: false, reason: 'rate limited', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
      const pending = this.trailingControls.get(key);
      if (pending) {
        this.report(pending.event, pending.from, false, 'Superseded by a newer command');
        pending.event = ev;
        pending.from = from;
      } else {
        const runId = target.runId;
        const entry = { cardId: target.cardId, event: ev, from, timer: setTimeout(() => {
          this.trailingControls.delete(key);
          if (target.runId === runId) this.onControlEvent(entry.event, entry.from);
          else this.report(entry.event, entry.from, false, 'Command cancelled');
        }, Math.max(1, limiter!.waitMs())) };
        this.trailingControls.set(key, entry);
      }
      return { ok: true, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    }
    if (gesture) this.gestureSentAt.set(key, now);
    const pending = this.trailingControls.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.report(pending.event, pending.from, false, 'Superseded by a newer command');
    }
    this.trailingControls.delete(key);

    const value = typeof ev.value === 'number' ? ev.value : ev.value === true ? 1 : ev.value === false ? 0 : (ev.value as { x: number }).x;
    const stepper = spec.gen3d?.controls.find((c) => c.id === ev.widgetId)?.binding.args?.drive === 'stepper';
    let fired = 0;
    const param = hack.params?.find((p) => p.id === hack.control?.param) ?? hack.params?.[0];
    const prev = param ? target.paramValues[param.id] : undefined;
    const serial = ++this.commandSerial;
    const runId = target.runId;
    this.latestCommand.set(key, serial);
    const batch = new CommandBatch((ok, detail) => {
      if (this.latestCommand.get(key) === serial && target.runId === runId) {
        this.latestCommand.delete(key);
        if (ok && param && !stepper) {
          target.paramValues[param.id] = clamp(value, param.min, param.max);
          this.d.targets.changed(target);
        }
      }
      this.report(ev, from, ok, detail, spec.specId);
    });
    if (stepper && param && hack.commands.length >= 2) {
      fired += this.fireStepper(target, driver, hack, param.id, prev, value, batch.next());
    } else {
      for (const cmd of hack.commands) fired += this.fireCommand(target, driver, hack, cmd, value, cmd.delayMs ?? 0, batch.next());
    }
    batch.seal();
    this.lastRun.set(target.cardId, { hackId: hack.id, previousParam: param && prev !== undefined ? { paramId: param.id, value: prev } : undefined });
    if (target.state !== 'controlling') this.d.targets.setState(target, 'controlling', hack.name);
    return { ok: true, cardId: target.cardId, hackId: hack.id, fired, ms: performance.now() - t0 };
  }

  private limiter(cardId: string, hack: Hack): RateLimiter {
    const key = `${cardId}:${hack.id}`;
    let l = this.hackLimiters.get(key);
    if (!l) {
      l = new RateLimiter(hack.max_rate_hz, 1, this.d.now);
      this.hackLimiters.set(key, l);
    }
    return l;
  }

  private action(driver: Driver, id: string): DriverAction | undefined {
    return driver.actions.find((a) => a.actionId === id);
  }

  private allowed(target: Target): boolean {
    return this.d.canControl?.(target) ?? true;
  }

  /** One hack command -> op(s). Returns the number of ops fired now (steps may schedule more). */
  private fireCommand(target0: Target, driver0: Driver, hack: Hack, cmd: HackCommand, value: number, delayMs: number, onResult?: ExecResult): number {
    // a command may name another device (room combos); it must be armed and verified there
    let target = target0;
    let driver = driver0;
    if (cmd.cardId && cmd.cardId !== target0.cardId) {
      const other = this.d.targets.get(cmd.cardId);
      if (!other?.driver || !other.armed || other.verification[cmd.action] !== 'pass') { onResult?.(false, 'Device is not ready'); return 0; }
      target = other;
      driver = other.driver;
    }
    const a = this.action(driver, cmd.action);
    if (!a) { onResult?.(false, 'Control action is unavailable'); return 0; }
    const runId = target.runId;
    const sourceRunId = target0.runId;
    const v = cmd.param !== undefined ? (() => {
      const p = hack.params?.find((x) => x.id === cmd.param);
      return p ? clamp(value, p.min, p.max) : value;
    })() : cmd.value;
    const send = () => {
      if (!target.armed || target.runId !== runId || !target0.armed || target0.runId !== sourceRunId || !this.allowed(target) || !this.allowed(target0) || target.verification[a.actionId] !== 'pass') { onResult?.(false, 'Command cancelled'); return 0; }
      if (a.encode.kind === 'step') return this.fireSteps(target, driver, a, v ?? 0, onResult, hack.id.startsWith('gesture:'));
      try {
        const op = resolveOp(a, a.kind === 'set' ? (v ?? 0) : undefined);
        return this.d.dispatcher.fire(driver.executor.deviceId, op, { port: driver.executor.port, cardId: target.cardId, driverId: driver.driverId, actionId: a.actionId, lightCap: driver.transport === 'ir', onResult, dropIfLimited: hack.id.startsWith('gesture:') }) ? 1 : 0;
      } catch (e) {
        this.log(`[control] ${a.actionId}: ${(e as Error).message}`);
        onResult?.(false, (e as Error).message);
        return 0;
      }
    };
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.commandTimers.delete(timer);
        send();
      }, delayMs);
      this.commandTimers.set(timer, { cardId: target.cardId, sourceCardId: target0.cardId, cancel: () => onResult?.(false, 'Command cancelled') });
      return 0;
    }
    return send();
  }

  /** A step composite: fire the first trigger now, schedule the rest at the device's settle time. */
  private fireSteps(target: Target, driver: Driver, a: DriverAction, value: number, onResult?: ExecResult, singleStep = false): number {
    const current = target.stepIndex[a.actionId] ?? (a.encode.kind === 'step' ? Math.floor(a.encode.steps / 2) : 0);
    const plan = planSteps(driver, a, current, value);
    const key = `${target.cardId}:${a.actionId}`;
    const pending = this.stepTimers.get(key);
    if (pending) { clearTimeout(pending.timer); pending.cancel?.(); }
    this.stepTimers.delete(key);
    if (!plan.actionIds.length) { onResult?.(true); return 0; }
    const batch = onResult ? new CommandBatch(onResult) : undefined;
    const scheduled = batch?.next();
    const cancel = () => scheduled?.(false, 'Command cancelled');
    const runId = target.runId;
    const active = () => target.armed && target.runId === runId && this.allowed(target);
    let i = 0;
    let fired = 0;
    const fireOne = (): boolean => {
      if (!active()) { cancel(); return false; }
      const t = this.action(driver, plan.actionIds[i]);
      if (!t || target.verification[t.actionId] !== 'pass') { cancel(); return false; }
      const direction = plan.actionIds[i] === (a.encode as { upActionId: string }).upActionId ? 1 : -1;
      const result = batch?.next();
      const acknowledged: ExecResult | undefined = result ? (ok, detail) => {
        if (ok && target.runId === runId) {
          target.stepIndex[a.actionId] = (target.stepIndex[a.actionId] ?? current) + direction;
          this.d.targets.changed(target);
        }
        result(ok, detail);
      } : undefined;
      const ok = this.d.dispatcher.fire(driver.executor.deviceId, resolveOp(t), { port: driver.executor.port, cardId: target.cardId, driverId: driver.driverId, actionId: t.actionId, lightCap: driver.transport === 'ir', onResult: acknowledged, dropIfLimited: singleStep });
      if (ok) {
        if (!onResult) target.stepIndex[a.actionId] = current + direction * (i + 1);
        i++;
      }
      return ok;
    };
    batch?.seal();
    if (!fireOne()) { cancel(); return 0; }
    fired++;
    // A gesture sends one brightness step per movement event; release leaves no scheduled remainder.
    if (singleStep) { scheduled?.(true); return fired; }
    const tick = () => {
      this.stepTimers.delete(key);
      if (!active()) { cancel(); return; }
      if (i >= plan.actionIds.length) { scheduled?.(true); return; }
      if (!fireOne()) { cancel(); return; }
      if (active() && i < plan.actionIds.length) schedule();
      else scheduled?.(true);
    };
    const schedule = () => this.stepTimers.set(key, { cardId: target.cardId, timer: setTimeout(tick, Math.max(plan.settleMs, 334)), cancel });
    if (active() && i < plan.actionIds.length) schedule();
    else scheduled?.(true);
    return fired;
  }

  /** gen3d-forge's fallback: a control over two triggers [raise, lower] with no param. */
  private fireStepper(target: Target, driver: Driver, hack: Hack, paramId: string, prev: number | undefined, value: number, onResult?: ExecResult): number {
    const param = hack.params!.find((p) => p.id === paramId)!;
    const step = param.step ?? Math.max(1, (param.max - param.min) / 10);
    const from = prev ?? param.default ?? (param.min + param.max) / 2;
    const presses = Math.round((value - from) / step);
    if (!presses) { onResult?.(true); return 0; }
    const cmd = presses > 0 ? hack.commands[0] : hack.commands[1];
    const a = this.action(driver, cmd.action);
    if (!a || a.encode.kind === 'step') { onResult?.(false, 'Control action is unavailable'); return 0; }
    const op = resolveOp(a);
    const runId = target.runId;
    const active = () => target.armed && target.runId === runId && this.allowed(target);
    const batch = onResult ? new CommandBatch(onResult) : undefined;
    const scheduled = batch?.next();
    const cancel = () => scheduled?.(false, 'Command cancelled');
    const fire = () => {
      if (!active() || target.verification[a.actionId] !== 'pass') { cancel(); return false; }
      const result = batch?.next();
      const acknowledged: ExecResult | undefined = result ? (ok, detail) => {
        if (ok && target.runId === runId) {
          target.paramValues[paramId] = clamp((target.paramValues[paramId] ?? from) + (presses > 0 ? step : -step), param.min, param.max);
          this.d.targets.changed(target);
        }
        result(ok, detail);
      } : undefined;
      return this.d.dispatcher.fire(driver.executor.deviceId, op, { port: driver.executor.port, cardId: target.cardId, driverId: driver.driverId, actionId: a.actionId, lightCap: driver.transport === 'ir', onResult: acknowledged });
    };
    batch?.seal();
    let fired = fire() ? 1 : 0;
    const key = `${target.cardId}:${hack.id}:stepper`;
    const pending = this.stepTimers.get(key);
    if (pending) { clearTimeout(pending.timer); pending.cancel?.(); }
    this.stepTimers.delete(key);
    if (!fired) { cancel(); return 0; }
    let left = Math.abs(presses) - 1;
    const interval = Math.max(334, Math.round(1000 / hack.max_rate_hz));
    const tick = () => {
      this.stepTimers.delete(key);
      if (!active()) { cancel(); return; }
      if (left-- <= 0) { scheduled?.(true); return; }
      if (fire()) fired++;
      else { cancel(); return; }
      if (active() && left > 0) schedule();
      else scheduled?.(true);
    };
    const schedule = () => this.stepTimers.set(key, { cardId: target.cardId, timer: setTimeout(tick, interval), cancel });
    if (active() && left > 0) schedule();
    else scheduled?.(true);
    return fired;
  }

  /** Daemons write a hack param on a device spec through the normal gate (arm, verification, rate limits, steps). */
  setParam(specId: string, hackId: string, _paramId: string | undefined, value: number): boolean {
    const r = this.onControlEvent({ widgetId: hackId, value, ts: Date.now(), specId, phase: 'end' }, 'daemon');
    return r.ok && r.fired > 0;
  }

  /** Run a hack by id (voice, 2D menus). */
  runHack(target: Target, hackId: string, value?: number): RouteResult {
    if (!this.allowed(target)) return { ok: false, reason: 'control is not authorized for this device', cardId: target.cardId, fired: 0, ms: 0 };
    const spec = target.specId ? this.d.specs.get(target.specId) : undefined;
    const hack = spec?.hackset?.hacks.find((h) => h.id === hackId || h.name.toLowerCase() === hackId.toLowerCase());
    if (!spec || !hack) return { ok: false, reason: `no hack "${hackId}"`, cardId: target.cardId, fired: 0, ms: 0 };
    const param = hack.params?.find((p) => p.id === hack.control?.param) ?? hack.params?.[0];
    const v = value ?? param?.default ?? (param ? (param.min + param.max) / 2 : 1);
    return this.onControlEvent({ widgetId: hack.id, value: hack.kind === 'action' ? true : v, ts: Date.now(), specId: spec.specId, phase: 'end' });
  }

  /** UNDO: the inverse of the last hack run on a target. */
  undo(target: Target): RouteResult {
    if (!this.allowed(target)) return { ok: false, reason: 'control is not authorized for this device', cardId: target.cardId, fired: 0, ms: 0 };
    if (!target.armed) return { ok: false, reason: 'not armed', cardId: target.cardId, fired: 0, ms: 0 };
    const last = this.lastRun.get(target.cardId);
    const spec = target.specId ? this.d.specs.get(target.specId) : undefined;
    const hack = spec?.hackset?.hacks.find((h) => h.id === last?.hackId);
    if (!last || !spec || !hack || !target.driver) return { ok: false, reason: 'nothing to undo', cardId: target.cardId, fired: 0, ms: 0 };
    let fired = 0;
    if (hack.inverse?.restore && last.previousParam) {
      const r = this.onControlEvent({ widgetId: hack.id, value: last.previousParam.value, ts: Date.now(), specId: spec.specId, phase: 'end' });
      fired += r.fired;
    } else if (hack.inverse?.commands?.length) {
      for (const cmd of hack.inverse.commands) fired += this.fireCommand(target, target.driver, hack, cmd, cmd.value ?? 0, cmd.delayMs ?? 0);
    } else {
      // fall back to the driver's inverse actions
      for (const cmd of hack.commands) {
        const a = this.action(target.driver, cmd.action);
        const inv = a?.inverseActionId ? this.action(target.driver, a.inverseActionId) : undefined;
        if (inv && inv.encode.kind !== 'step') fired += this.fireCommand(target, target.driver, hack, { action: inv.actionId }, 0, 0);
      }
    }
    this.lastRun.delete(target.cardId);
    this.d.steps.note('control', `undo ${hack.name}`, { cardId: target.cardId, kind: 'proof', evidence: `${fired} op(s) sent` });
    return { ok: fired > 0, reason: fired ? undefined : 'no inverse available', cardId: target.cardId, hackId: hack.id, fired, ms: 0 };
  }

  /** Stop scheduled work; mode and connection changes can retain the owner's arm approval. */
  cancel(target: Target, opts: { preserveArmed?: boolean } = {}): void {
    if (!opts.preserveArmed) target.armed = false;
    for (const [key, pending] of this.trailingControls) {
      if (pending.cardId !== target.cardId) continue;
      clearTimeout(pending.timer);
      this.trailingControls.delete(key);
      this.report(pending.event, pending.from, false, 'Command cancelled');
    }
    for (const [key, pending] of this.stepTimers) {
      if (pending.cardId !== target.cardId) continue;
      clearTimeout(pending.timer);
      this.stepTimers.delete(key);
      pending.cancel?.();
    }
    for (const [timer, pending] of this.commandTimers) {
      if (pending.cardId !== target.cardId && pending.sourceCardId !== target.cardId) continue;
      clearTimeout(timer);
      this.commandTimers.delete(timer);
      pending.cancel?.();
    }
    this.d.dispatcher.flushQueued(target.cardId);
    this.lastRun.delete(target.cardId);
  }

  /** PANIC: all notes off on every MIDI executor, every target disarmed, pending steps cancelled. */
  panic(reason = 'panic', cardId?: string): { disarmed: string[]; sent: number } {
    const disarmed: string[] = [];
    let sent = 0;
    const executorsDone = new Set<string>();
    if (!cardId) this.d.dispatcher.flushQueued();
    for (const t of this.d.targets.list()) {
      if (cardId && t.cardId !== cardId) continue;
      const armed = t.armed;
      const d = t.driver;
      if (d?.transport === 'midi' && !executorsDone.has(d.executor.deviceId)) {
        executorsDone.add(d.executor.deviceId);
        if (this.d.dispatcher.fire(d.executor.deviceId, { kind: 'midi', msg: 'panic', channel: 1 }, { cardId: t.cardId, driverId: d.driverId })) sent++;
      }
      this.cancel(t);
      if (armed) {
        disarmed.push(t.cardId);
        this.d.targets.setState(t, t.specId ? 'forged' : 'verified', `disarmed: ${reason}`);
      }
    }
    this.d.steps.note('control', 'panic: everything stopped and disarmed', { kind: 'proof', evidence: `${disarmed.length} target(s), ${sent} MIDI panic op(s)`, status: 'ok' });
    return { disarmed, sent };
  }

  close(): void {
    for (const pending of this.trailingControls.values()) clearTimeout(pending.timer);
    this.trailingControls.clear();
    for (const t of this.stepTimers.values()) clearTimeout(t.timer);
    this.stepTimers.clear();
    for (const timer of this.commandTimers.keys()) clearTimeout(timer);
    this.commandTimers.clear();
    this.d.dispatcher.flushQueued();
  }
}
