/**
 * ARM: the one-tap human confirmation before the first real drive of a target (platform terms). The server
 * sends arm.request to every client; an approver (paired quest/mac/iphone or localhost) answers arm.confirm.
 * Irreversible drivers need a pinch-and-hold (`hold: true`). Requests expire on their own.
 */
import type { ArmConfirmPayload, ArmRequestPayload, ArmResultPayload, Driver } from '@ce/protocol';
import { newId } from '@ce/protocol';
import type { Hub } from '../hub';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';

export const ARM_TIMEOUT_MS = 120_000;

interface PendingArm {
  target: Target;
  irreversible: boolean;
  resolve: (r: ArmResultPayload) => void;
  timer: ReturnType<typeof setTimeout>;
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
    private readonly d: { hub: Pick<Hub, 'broadcast'>; targets: TargetStore; steps: StepLog; log?: (line: string) => void; timeoutMs?: number },
  ) {}

  /** Build and send the request; resolves with the result (approved, declined or expired). */
  request(target: Target, driver: Driver, summary?: string): Promise<ArmResultPayload> {
    const irreversible = driver.actions.some((a) => a.confirm === 'hold');
    const actions = driver.actions.map((a) => ({ actionId: a.actionId, label: a.label.slice(0, 40), verified: target.verification[a.actionId] ?? a.verified ?? 'untested' }));
    const passed = actions.filter((a) => a.verified === 'pass').length;
    return this.ask(target, {
      driverId: driver.driverId,
      title: `Arm ${target.card?.name ?? target.cardId}?`,
      summary: summary ?? `${passed} of ${actions.length} actions verified on the real device. Controls bound to unverified actions stay disarmed.`,
      actions,
      irreversible,
    });
  }

  /** A one-tap question about any target (a device to arm, a room combo to run). */
  ask(target: Target, q: { driverId?: string; title: string; summary: string; actions: ArmRequestPayload['actions']; irreversible?: boolean }): Promise<ArmResultPayload> {
    const armId = newId('arm');
    const driverId = q.driverId ?? target.driver?.driverId ?? 'room';
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
    this.d.targets.setState(target, 'arming', 'waiting for a pinch');
    this.d.hub.broadcast('arm.request', payload);
    return new Promise<ArmResultPayload>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(armId);
        const r: ArmResultPayload = { armId, cardId: target.cardId, driverId, armed: false, reason: 'no confirmation in time' };
        this.finish(target, r);
        resolve(r);
      }, this.d.timeoutMs ?? ARM_TIMEOUT_MS);
      this.pending.set(armId, { target, irreversible: Boolean(q.irreversible), resolve, timer });
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
    const driverId = target.driver?.driverId ?? '';
    let r: ArmResultPayload;
    if (!p.approve) r = { armId: p.armId, cardId: target.cardId, driverId, armed: false, by: by.name ?? by.deviceId, reason: 'declined' };
    else if (pend.irreversible && !p.hold) r = { armId: p.armId, cardId: target.cardId, driverId, armed: false, by: by.name ?? by.deviceId, reason: 'this driver has an irreversible action: pinch and hold to arm' };
    else r = { armId: p.armId, cardId: target.cardId, driverId, armed: true, by: by.name ?? by.deviceId };
    if (!r.armed && pend.irreversible && p.approve && !p.hold) {
      // keep waiting for the hold
      this.d.hub.broadcast('arm.result', r);
      return true;
    }
    clearTimeout(pend.timer);
    this.pending.delete(p.armId);
    this.finish(target, r);
    pend.resolve(r);
    return true;
  }

  private finish(target: Target, r: ArmResultPayload): void {
    target.armed = r.armed;
    target.armId = undefined;
    this.d.hub.broadcast('arm.result', r);
    this.d.steps.note('arm', r.armed ? `armed by ${r.by ?? 'the owner'}` : `not armed: ${r.reason ?? 'declined'}`, { cardId: target.cardId, kind: 'proof', status: r.armed ? 'ok' : 'fail', evidence: r.armed ? 'human confirmed' : r.reason });
    const isRoom = target.cardId === 'room';
    this.d.targets.setState(target, r.armed && !isRoom ? 'armed' : target.specId ? 'forged' : 'verified', r.armed ? `${isRoom ? 'confirmed' : 'armed'} by ${r.by ?? 'the owner'}` : r.reason);
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  close(): void {
    for (const [armId, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ armId, cardId: p.target.cardId, driverId: p.target.driver?.driverId ?? '', armed: false, reason: 'server closing' });
    }
    this.pending.clear();
  }
}
