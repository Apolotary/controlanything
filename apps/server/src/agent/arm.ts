/**
 * ARM: the one-tap human confirmation before the first real drive of a target (platform terms). The server
 * sends arm.request to every client; an approver (paired quest/mac/iphone or localhost) answers arm.confirm.
 * Irreversible drivers need a pinch-and-hold (`hold: true`). Requests expire on their own.
 */
import type { ArmConfirmPayload, ArmRequestPayload, ArmResultPayload, Driver } from '@ce/protocol';
import { newId } from '@ce/protocol';
import type { Hub } from '../hub';
import { stateGuidance } from './guidance';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';

export const ARM_TIMEOUT_MS = 120_000;

interface PendingArm {
  target: Target;
  payload: ArmRequestPayload;
  driverId: string;
  irreversible: boolean;
  resolve: (r: ArmResultPayload) => void;
}

export interface Approver {
  deviceId?: string;
  name?: string;
  canApprove: boolean;
  local?: boolean;
}

export class ArmService {
  private readonly pending = new Map<string, PendingArm>();

  constructor(
    private readonly d: { hub: Pick<Hub, 'broadcast'>; targets: TargetStore; steps: StepLog; log?: (line: string) => void; timeoutMs?: number; canArm?: (target: Target) => boolean },
  ) {}

  /** Build and send the request; resolves with the result (approved, declined or expired). */
  request(target: Target, driver: Driver, summary?: string, signal?: AbortSignal): Promise<ArmResultPayload> {
    const irreversible = driver.actions.some((a) => a.confirm === 'hold');
    const actions = driver.actions.map((a) => ({ actionId: a.actionId, label: a.label.slice(0, 40), verified: target.verification[a.actionId] ?? a.verified ?? 'untested' }));
    const passed = actions.filter((a) => a.verified === 'pass').length;
    return this.ask(target, {
      driverId: driver.driverId,
      title: `${target.card?.name ?? target.detection?.label ?? 'Device'} is ready`,
      summary: summary ?? (passed === actions.length
        ? `All ${actions.length} commands worked on the real device.`
        : `${passed} of ${actions.length} commands worked; only those are enabled.`),
      actions,
      irreversible,
    }, signal);
  }

  /** A one-tap question about any target (a device to arm, a room combo to run). */
  ask(target: Target, q: { driverId?: string; title: string; summary: string; actions: ArmRequestPayload['actions']; irreversible?: boolean }, signal?: AbortSignal): Promise<ArmResultPayload> {
    const armId = newId('arm');
    const driverId = q.driverId ?? target.driver?.driverId ?? 'room';
    if (signal?.aborted) return Promise.resolve({ armId, cardId: target.cardId, driverId, armed: false, reason: 'cancelled' });
    if (this.d.canArm && !this.d.canArm(target)) {
      this.cancel(target, 'control is not authorized for this device');
      return Promise.resolve({ armId, cardId: target.cardId, driverId, armed: false, reason: 'control is not authorized for this device' });
    }
    this.cancel(target, 'replaced by a new confirmation');
    const payload: ArmRequestPayload = {
      armId,
      cardId: target.cardId,
      driverId,
      specId: target.specId,
      title: q.title.slice(0, 120),
      summary: q.summary.slice(0, 500),
      actions: q.actions.slice(0, 64),
      irreversible: q.irreversible || undefined,
      expiresAt: Date.now() + (this.d.timeoutMs ?? ARM_TIMEOUT_MS),
    };
    target.armId = armId;
    return new Promise<ArmResultPayload>((resolve) => {
      const finish = (result: ArmResultPayload) => {
        if (!this.pending.delete(armId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.finish(target, result);
        resolve(result);
      };
      const onAbort = () => finish({ armId, cardId: target.cardId, driverId, armed: false, reason: 'cancelled' });
      const timer = setTimeout(() => {
        finish({ armId, cardId: target.cardId, driverId, armed: false, reason: 'no confirmation in time' });
      }, this.d.timeoutMs ?? ARM_TIMEOUT_MS);
      this.pending.set(armId, { target, payload, driverId, irreversible: Boolean(q.irreversible), resolve: finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      this.d.targets.setState(target, 'arming', 'waiting for a pinch', {
        sentence: 'Tap once to enable these controls',
        hint: q.irreversible ? 'Hold to confirm actions that cannot be undone, or cancel.' : 'Confirm when you are ready, or cancel.',
        action: 'cancel',
      });
      if (this.pending.has(armId)) this.d.hub.broadcast('arm.request', payload);
    });
  }

  /** Feed an arm.confirm from the hub. */
  onConfirm(p: ArmConfirmPayload, by: Approver): boolean {
    const pend = this.pending.get(p.armId);
    if (!pend) return false;
    if (!by.canApprove && !by.local) {
      this.d.log?.(`[arm] ${by.deviceId ?? 'unknown'} may not arm devices`);
      return false;
    }
    const { target } = pend;
    const { driverId } = pend;
    let r: ArmResultPayload;
    if (!p.approve) r = { armId: p.armId, cardId: target.cardId, driverId, armed: false, by: by.name ?? by.deviceId, reason: 'declined' };
    else if (this.d.canArm && !this.d.canArm(target)) r = { armId: p.armId, cardId: target.cardId, driverId, armed: false, by: by.name ?? by.deviceId, reason: 'control is not authorized for this device' };
    else if (pend.irreversible && !p.hold) r = { armId: p.armId, cardId: target.cardId, driverId, armed: false, by: by.name ?? by.deviceId, reason: 'this driver has an irreversible action: pinch and hold to arm' };
    else r = { armId: p.armId, cardId: target.cardId, driverId, armed: true, by: by.name ?? by.deviceId };
    if (r.reason === 'this driver has an irreversible action: pinch and hold to arm') {
      // keep waiting for the hold
      this.d.hub.broadcast('arm.result', r);
      return true;
    }
    pend.resolve(r);
    return true;
  }

  private finish(target: Target, r: ArmResultPayload): void {
    target.armed = r.armed;
    target.armId = undefined;
    this.d.hub.broadcast('arm.result', r);
    const guidance = r.armed
      ? stateGuidance(target, 'armed')
      : { sentence: r.reason === 'no confirmation in time' ? 'Confirmation timed out' : 'Controls remain off', hint: 'Retry when you are ready, or pick another device.', action: 'retry' as const };
    this.d.steps.note('arm', r.armed ? `armed by ${r.by ?? 'the owner'}` : `not armed: ${r.reason ?? 'declined'}`, { cardId: target.cardId, kind: 'proof', status: r.armed ? 'ok' : 'fail', evidence: r.armed ? 'human confirmed' : r.reason, ...guidance });
    const isRoom = target.cardId === 'room';
    this.d.targets.setState(target, r.armed && !isRoom ? 'armed' : target.specId ? 'forged' : 'verified', r.armed ? `${isRoom ? 'confirmed' : 'armed'} by ${r.by ?? 'the owner'}` : r.reason, guidance);
  }

  /** Remove confirmation immediately so a late tap cannot enable a cancelled target. */
  cancel(target: Target, reason = 'cancelled'): boolean {
    let cancelled = false;
    for (const [armId, pending] of this.pending) {
      if (pending.target !== target) continue;
      pending.resolve({ armId, cardId: target.cardId, driverId: pending.driverId, armed: false, reason });
      cancelled = true;
    }
    return cancelled;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Replay the same confirmation after a reload, with its original expiry and approval rules. */
  pendingRequests(): ArmRequestPayload[] {
    return [...this.pending.values()].map((p) => structuredClone(p.payload));
  }

  close(): void {
    for (const [armId, p] of this.pending) {
      p.resolve({ armId, cardId: p.target.cardId, driverId: p.driverId, armed: false, reason: 'server closing' });
    }
    this.pending.clear();
  }
}
