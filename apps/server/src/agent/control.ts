/**
 * CONTROL: the deterministic hot path. control.event -> hack (by control id) -> driver actions -> resolved op ->
 * exec.command, with no model, no await before the send, per-hack and per-executor rate limits, the human
 * arm gate and panic. Target: under 50 ms on the LAN (the server part is well under 1 ms).
 */
import type { ControlEventPayload, Driver, DriverAction, Hack, HackCommand, UiSpecPayload } from '@ce/protocol';
import { clamp, planSteps, resolveOp } from '../devices/encode';
import type { Hub } from '../hub';
import { Dispatcher, RateLimiter } from './dispatch';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';

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

export class ControlRouter {
  private readonly hackLimiters = new Map<string, RateLimiter>();
  private readonly stepTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastRun = new Map<string, LastRun>();
  private readonly log: (line: string) => void;
  private lastDisarmedLog = 0;

  constructor(private readonly d: ControlDeps) {
    this.log = d.log ?? (() => {});
  }

  /** Find the target + spec + hack a control event refers to. */
  resolve(ev: Pick<ControlEventPayload, 'widgetId' | 'specId'>): { target: Target; spec: UiSpecPayload; hack: Hack; driver: Driver } | { reason: string } {
    const specs = ev.specId ? [this.d.specs.get(ev.specId)].filter(Boolean) : this.d.specs.list();
    for (const spec of specs as UiSpecPayload[]) {
      const hack = spec.hackset?.hacks.find((h) => h.id === ev.widgetId) ?? spec.hackset?.hacks.find((h) => spec.gen3d?.controls.some((c) => c.id === ev.widgetId && (c.binding.args?.hack === h.id || c.id === h.id)));
      if (!hack) continue;
      const target = spec.cardId ? this.d.targets.get(spec.cardId) : this.d.targets.list().find((t) => t.specId === spec.specId);
      if (!target?.driver) return { reason: `no driver for ${spec.cardId ?? spec.specId}` };
      return { target, spec, hack, driver: target.driver };
    }
    return { reason: `no hack or control "${ev.widgetId}"${ev.specId ? ` in spec ${ev.specId}` : ''}` };
  }

  onControlEvent(ev: ControlEventPayload, from?: string): RouteResult {
    const t0 = performance.now();
    const r = this.resolve(ev);
    if ('reason' in r) return { ok: false, reason: r.reason, fired: 0, ms: performance.now() - t0 };
    const { target, spec, hack, driver } = r;
    if (!target.armed) {
      const now = Date.now();
      if (now - this.lastDisarmedLog > 2000) {
        this.lastDisarmedLog = now;
        this.log(`[control] ${hack.id} ignored: ${target.cardId} is not armed`);
      }
      return { ok: false, reason: 'not armed', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    }
    if (hack.kind === 'daemon') return { ok: false, reason: 'daemons are not fired by controls', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    if (ev.phase === 'start') return { ok: true, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    // actions must have passed verification (controls bound to unverified actions stay disarmed)
    const unverified = hack.commands.filter((c) => target.verification[c.action] !== 'pass').map((c) => c.action);
    if (unverified.length) return { ok: false, reason: `unverified actions: ${unverified.join(', ')}`, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    if (hack.kind === 'action' && ev.phase !== undefined && ev.phase !== 'end') return { ok: true, cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };
    const limiter = this.limiter(target.cardId, hack);
    if (!limiter.take()) return { ok: false, reason: 'rate limited', cardId: target.cardId, hackId: hack.id, fired: 0, ms: performance.now() - t0 };

    const value = typeof ev.value === 'number' ? ev.value : ev.value === true ? 1 : ev.value === false ? 0 : (ev.value as { x: number }).x;
    const stepper = spec.gen3d?.controls.find((c) => c.id === ev.widgetId)?.binding.args?.drive === 'stepper';
    let fired = 0;
    const param = hack.params?.find((p) => p.id === hack.control?.param) ?? hack.params?.[0];
    const prev = param ? target.paramValues[param.id] : undefined;
    if (stepper && param && hack.commands.length >= 2) {
      fired += this.fireStepper(target, driver, hack, param.id, prev, value);
    } else {
      for (const cmd of hack.commands) fired += this.fireCommand(target, driver, hack, cmd, value, cmd.delayMs ?? 0);
    }
    if (param) target.paramValues[param.id] = clamp(value, param.min, param.max);
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

  /** One hack command -> op(s). Returns the number of ops fired now (steps may schedule more). */
  private fireCommand(target: Target, driver: Driver, hack: Hack, cmd: HackCommand, value: number, delayMs: number): number {
    const a = this.action(driver, cmd.action);
    if (!a) return 0;
    const v = cmd.param !== undefined ? (() => {
      const p = hack.params?.find((x) => x.id === cmd.param);
      return p ? clamp(value, p.min, p.max) : value;
    })() : cmd.value;
    const send = () => {
      if (a.encode.kind === 'step') return this.fireSteps(target, driver, a, v ?? 0);
      try {
        const op = resolveOp(a, a.kind === 'set' ? (v ?? 0) : undefined);
        return this.d.dispatcher.fire(driver.executor.deviceId, op, { port: driver.executor.port, cardId: target.cardId, driverId: driver.driverId, actionId: a.actionId, lightCap: driver.transport === 'ir' }) ? 1 : 0;
      } catch (e) {
        this.log(`[control] ${a.actionId}: ${(e as Error).message}`);
        return 0;
      }
    };
    if (delayMs > 0) {
      setTimeout(send, delayMs);
      return 0;
    }
    return send();
  }

  /** A step composite: fire the first trigger now, schedule the rest at the device's settle time. */
  private fireSteps(target: Target, driver: Driver, a: DriverAction, value: number): number {
    const current = target.stepIndex[a.actionId] ?? (a.encode.kind === 'step' ? Math.floor(a.encode.steps / 2) : 0);
    const plan = planSteps(driver, a, current, value);
    const key = `${target.cardId}:${a.actionId}`;
    const pending = this.stepTimers.get(key);
    if (pending) clearTimeout(pending);
    if (!plan.actionIds.length) return 0;
    let i = 0;
    let fired = 0;
    const fireOne = (): boolean => {
      const t = this.action(driver, plan.actionIds[i]);
      if (!t) return false;
      const ok = this.d.dispatcher.fire(driver.executor.deviceId, resolveOp(t), { port: driver.executor.port, cardId: target.cardId, driverId: driver.driverId, actionId: t.actionId, lightCap: driver.transport === 'ir' });
      if (ok) {
        target.stepIndex[a.actionId] = current + (plan.actionIds[i] === (a.encode as { upActionId: string }).upActionId ? 1 : -1) * (i + 1);
        i++;
      }
      return ok;
    };
    if (fireOne()) fired++;
    const tick = () => {
      if (i >= plan.actionIds.length) return;
      fireOne();
      this.stepTimers.set(key, setTimeout(tick, Math.max(plan.settleMs, 334)));
    };
    if (i < plan.actionIds.length) this.stepTimers.set(key, setTimeout(tick, Math.max(plan.settleMs, 334)));
    return fired;
  }

  /** gen3d-forge's fallback: a control over two triggers [raise, lower] with no param. */
  private fireStepper(target: Target, driver: Driver, hack: Hack, paramId: string, prev: number | undefined, value: number): number {
    const param = hack.params!.find((p) => p.id === paramId)!;
    const step = param.step ?? Math.max(1, (param.max - param.min) / 10);
    const from = prev ?? param.default ?? (param.min + param.max) / 2;
    const presses = Math.round((value - from) / step);
    if (!presses) return 0;
    const cmd = presses > 0 ? hack.commands[0] : hack.commands[1];
    const a = this.action(driver, cmd.action);
    if (!a || a.encode.kind === 'step') return 0;
    const op = resolveOp(a);
    const fire = () => this.d.dispatcher.fire(driver.executor.deviceId, op, { port: driver.executor.port, cardId: target.cardId, driverId: driver.driverId, actionId: a.actionId, lightCap: driver.transport === 'ir' });
    let fired = fire() ? 1 : 0;
    const key = `${target.cardId}:${hack.id}:stepper`;
    const pending = this.stepTimers.get(key);
    if (pending) clearTimeout(pending);
    let left = Math.abs(presses) - 1;
    const interval = Math.max(334, Math.round(1000 / hack.max_rate_hz));
    const tick = () => {
      if (left-- <= 0) return;
      if (fire()) fired++;
      this.stepTimers.set(key, setTimeout(tick, interval));
    };
    if (left > 0) this.stepTimers.set(key, setTimeout(tick, interval));
    return fired;
  }

  /** Run a hack by id (voice, 2D menus). */
  runHack(target: Target, hackId: string, value?: number): RouteResult {
    const spec = target.specId ? this.d.specs.get(target.specId) : undefined;
    const hack = spec?.hackset?.hacks.find((h) => h.id === hackId || h.name.toLowerCase() === hackId.toLowerCase());
    if (!spec || !hack) return { ok: false, reason: `no hack "${hackId}"`, cardId: target.cardId, fired: 0, ms: 0 };
    const param = hack.params?.find((p) => p.id === hack.control?.param) ?? hack.params?.[0];
    const v = value ?? param?.default ?? (param ? (param.min + param.max) / 2 : 1);
    return this.onControlEvent({ widgetId: hack.id, value: hack.kind === 'action' ? true : v, ts: Date.now(), specId: spec.specId, phase: 'end' });
  }

  /** UNDO: the inverse of the last hack run on a target. */
  undo(target: Target): RouteResult {
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
        if (inv && inv.encode.kind !== 'step') fired += this.d.dispatcher.fire(target.driver.executor.deviceId, resolveOp(inv), { port: target.driver.executor.port, cardId: target.cardId, driverId: target.driver.driverId, actionId: inv.actionId, lightCap: target.driver.transport === 'ir' }) ? 1 : 0;
      }
    }
    this.lastRun.delete(target.cardId);
    this.d.steps.note('control', `undo ${hack.name}`, { cardId: target.cardId, kind: 'proof', evidence: `${fired} op(s) sent` });
    return { ok: fired > 0, reason: fired ? undefined : 'no inverse available', cardId: target.cardId, hackId: hack.id, fired, ms: 0 };
  }

  /** PANIC: all notes off on every MIDI executor, every target disarmed, pending steps cancelled. */
  panic(reason = 'panic', cardId?: string): { disarmed: string[]; sent: number } {
    for (const t of this.stepTimers.values()) clearTimeout(t);
    this.stepTimers.clear();
    this.d.dispatcher.flushQueued();
    const disarmed: string[] = [];
    let sent = 0;
    const executorsDone = new Set<string>();
    for (const t of this.d.targets.list()) {
      if (cardId && t.cardId !== cardId) continue;
      if (t.armed) {
        t.armed = false;
        disarmed.push(t.cardId);
        this.d.targets.setState(t, t.specId ? 'forged' : 'verified', `disarmed: ${reason}`);
      }
      const d = t.driver;
      if (d?.transport === 'midi' && !executorsDone.has(d.executor.deviceId)) {
        executorsDone.add(d.executor.deviceId);
        if (this.d.dispatcher.fire(d.executor.deviceId, { kind: 'midi', msg: 'panic', channel: 1 }, { port: d.executor.port, cardId: t.cardId, driverId: d.driverId })) sent++;
      }
    }
    this.d.steps.note('control', 'panic: everything stopped and disarmed', { kind: 'proof', evidence: `${disarmed.length} target(s), ${sent} MIDI panic op(s)`, status: 'ok' });
    return { disarmed, sent };
  }

  close(): void {
    for (const t of this.stepTimers.values()) clearTimeout(t);
    this.stepTimers.clear();
  }
}
