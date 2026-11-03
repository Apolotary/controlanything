/**
 * Pending pairing requests (in memory) and the rules for approving them.
 *
 * Who may approve: a paired device whose registry record has canApprove (quest, mac, iphone),
 * any request from localhost (the Mac on the same machine is the owner), or the server console.
 * Codes expire after 5 minutes and are single use; the device token is handed out exactly once.
 */
import {
  formatCode,
  normalizeCode,
  PAIRING_TTL_MS,
  type PairApproveRequest,
  type PairDenyRequest,
  type PairingStatus,
  type PairStartRequest,
  type PairStartResponse,
  type PairStatusResponse,
  type PendingPairing,
} from '@ce/protocol';
import { generateCode, randomId, randomSecret, safeEqual } from './crypto';
import { RateLimiter } from './rateLimit';
import type { DeviceRecord, DeviceRegistry } from './registry';

export type Approver = { type: 'device'; deviceId: string } | { type: 'local'; address?: string } | { type: 'console' };

export type PairingErrorCode = 'not_found' | 'forbidden' | 'bad_code' | 'bad_secret' | 'rate_limited' | 'bad_request';

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

interface Pairing {
  pairingId: string;
  code: string;
  pollSecret: string;
  name: string;
  kind: PairStartRequest['kind'];
  capabilities: NonNullable<PairStartRequest['capabilities']>;
  origin?: string;
  requestedAt: number;
  expiresAt: number;
  status: PairingStatus;
  failedAttempts: number;
  deviceId?: string;
  /** held only until delivered once */
  deviceToken?: string;
  approvedBy?: string;
  reason?: 'denied' | 'expired' | 'too_many_attempts';
  settledAt?: number;
}

export interface ApprovedEvent {
  pairingId: string;
  device: DeviceRecord;
  approvedBy: string;
}
export interface DeniedEvent {
  pairingId: string;
  reason: 'denied' | 'expired' | 'too_many_attempts';
}

type Events = { pending: PendingPairing; approved: ApprovedEvent; denied: DeniedEvent };

export interface PairingOptions {
  now?: () => number;
  ttlMs?: number;
  /** base for the QR URL, e.g. https://192.168.1.20:8443 */
  qrBase: () => string;
  /** auto-approve the first device when the registry is empty (CE_TRUST_FIRST_DEVICE=1) */
  trustFirstDevice?: boolean;
  /** wrong codes allowed per approver per minute */
  approveFailuresPerMinute?: number;
  /** pair/start calls allowed per origin per minute */
  startsPerMinute?: number;
  /** wrong codes for one pairing before it is cancelled */
  maxFailedPerPairing?: number;
  /** how long a settled request is kept so the device can still read its result */
  keepSettledMs?: number;
}

export class PairingManager {
  private readonly pairings = new Map<string, Pairing>();
  private readonly listeners: { [K in keyof Events]: Set<(e: Events[K]) => void> } = {
    pending: new Set(),
    approved: new Set(),
    denied: new Set(),
  };
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly approveLimiter: RateLimiter;
  private readonly startLimiter: RateLimiter;

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly opts: PairingOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PAIRING_TTL_MS;
    this.approveLimiter = new RateLimiter(opts.approveFailuresPerMinute ?? 5, 60_000, this.now);
    this.startLimiter = new RateLimiter(opts.startsPerMinute ?? 10, 60_000, this.now);
  }

  on<K extends keyof Events>(event: K, fn: (e: Events[K]) => void): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof Events>(event: K, e: Events[K]): void {
    for (const fn of this.listeners[event]) fn(e);
  }

  /** Start a request. `autoApprove` = the caller is trusted (localhost); the response then carries the token. */
  start(req: PairStartRequest, ctx: { origin?: string; autoApprove?: boolean } = {}): PairStartResponse {
    if (!this.startLimiter.hit(ctx.origin ?? 'unknown')) {
      throw new PairingError('rate_limited', 'Too many pairing requests; wait a minute and try again.', 429);
    }
    this.sweep();
    const t = this.now();
    let code = generateCode();
    while (this.pendingList().some((p) => p.code === code)) code = generateCode();
    const p: Pairing = {
      pairingId: randomId(10),
      code,
      pollSecret: randomSecret(24),
      name: req.name.trim().slice(0, 120) || req.kind,
      kind: req.kind,
      capabilities: [...new Set(req.capabilities ?? [])],
      origin: ctx.origin,
      requestedAt: t,
      expiresAt: t + this.ttlMs,
      status: 'pending',
      failedAttempts: 0,
    };
    this.pairings.set(p.pairingId, p);
    const base: Omit<PairStartResponse, 'status'> = {
      pairingId: p.pairingId,
      code: p.code,
      display: formatCode(p.code),
      qr: `${this.opts.qrBase().replace(/\/+$/, '')}/p/${p.pairingId}#${p.code}`,
      expiresAt: p.expiresAt,
      pollSecret: p.pollSecret,
    };
    const trustFirst = this.opts.trustFirstDevice && this.registry.size === 0;
    // requireApproval: the companion pairs on behalf of a Cardputer and wants the QR moment to really happen
    // Once the room has a headset, a new helper (Mac companion etc.) is approved by that headset (QR look or code),
    // never by same-machine trust: otherwise a stale companion tab silently re-pairs itself after being revoked.
    const headsetOwnsRoom = req.kind !== 'quest' && req.kind !== 'sim' && this.registry.list().some((d) => d.kind === 'quest');
    if (((ctx.autoApprove && !headsetOwnsRoom) || trustFirst) && !req.requireApproval) {
      const device = this.complete(p, ctx.autoApprove ? 'localhost' : 'trust-first-device');
      const deviceToken = this.takeToken(p.pairingId);
      return { ...base, status: 'approved', deviceId: device.deviceId, deviceToken };
    }
    this.emit('pending', this.toPending(p));
    return { ...base, status: 'pending' };
  }

  /** Poll result. The token is included once, on the first read after approval. */
  status(pairingId: string, pollSecret: string): PairStatusResponse {
    this.sweep();
    const p = this.pairings.get(pairingId);
    if (!p) throw new PairingError('not_found', 'Unknown or expired pairing request; start again.', 404);
    if (!safeEqual(pollSecret, p.pollSecret)) throw new PairingError('bad_secret', 'Wrong pollSecret for this pairing request.', 403);
    const out: PairStatusResponse = { pairingId, status: p.status, expiresAt: p.expiresAt };
    if (p.deviceId) out.deviceId = p.deviceId;
    if (p.reason) out.reason = p.reason;
    const token = this.takeToken(pairingId);
    if (token) out.deviceToken = token;
    return out;
  }

  /** Hand out the token of an approved request once (used by status() and the WebSocket push). */
  takeToken(pairingId: string): string | undefined {
    const p = this.pairings.get(pairingId);
    if (!p || p.status !== 'approved' || !p.deviceToken) return undefined;
    const token = p.deviceToken;
    p.deviceToken = undefined;
    return token;
  }

  canApprove(approver: Approver): boolean {
    if (approver.type !== 'device') return true;
    return Boolean(this.registry.get(approver.deviceId)?.canApprove);
  }

  approve(req: PairApproveRequest, approver: Approver): ApprovedEvent {
    const target = this.match(req.code, req.pairingId, approver);
    const device = this.complete(target, approverLabel(approver, this.registry));
    return { pairingId: target.pairingId, device, approvedBy: target.approvedBy ?? '' };
  }

  deny(req: PairDenyRequest, approver: Approver): DeniedEvent {
    let target: Pairing | undefined;
    if (req.code) target = this.match(req.code, req.pairingId, approver);
    else {
      this.checkRights(approver);
      this.sweep();
      const p = req.pairingId ? this.pairings.get(req.pairingId) : undefined;
      if (!p || p.status !== 'pending') throw new PairingError('not_found', 'No pending request with that id.', 404);
      target = p;
    }
    this.settle(target, 'denied');
    return { pairingId: target.pairingId, reason: 'denied' };
  }

  listPending(): PendingPairing[] {
    this.sweep();
    return this.pendingList().map((p) => this.toPending(p));
  }

  /** Expire old requests and forget settled ones once their result had time to be read. */
  sweep(): void {
    const t = this.now();
    const keep = this.opts.keepSettledMs ?? 2 * 60_000;
    for (const p of this.pairings.values()) {
      if (p.status === 'pending' && t >= p.expiresAt) this.settle(p, 'expired');
      else if (p.status !== 'pending' && p.settledAt !== undefined && t - p.settledAt > keep) this.pairings.delete(p.pairingId);
    }
  }

  private checkRights(approver: Approver): void {
    if (!this.canApprove(approver)) {
      throw new PairingError('forbidden', 'This device may not approve others (only a quest, mac or iphone, or localhost).', 403);
    }
  }

  /** Find the pending request a code belongs to. Wrong codes count against the approver (and the pairing). */
  private match(rawCode: string, pairingId: string | undefined, approver: Approver): Pairing {
    this.checkRights(approver);
    const key = approverKey(approver);
    if (this.approveLimiter.blocked(key)) throw new PairingError('rate_limited', 'Too many wrong codes; wait a minute.', 429);
    this.sweep();
    const code = normalizeCode(rawCode);
    let found: Pairing | undefined;
    if (pairingId) {
      const p = this.pairings.get(pairingId);
      if (p?.status === 'pending') {
        if (safeEqual(code, p.code)) found = p;
        else if (++p.failedAttempts >= (this.opts.maxFailedPerPairing ?? 5)) this.settle(p, 'too_many_attempts');
      }
    } else {
      // compare against every pending code so the time taken does not depend on which one matches
      for (const p of this.pendingList()) if (safeEqual(code, p.code)) found = p;
    }
    if (!found) {
      this.approveLimiter.hit(key);
      throw new PairingError('bad_code', 'No device waiting to pair shows that code.', 400);
    }
    return found;
  }

  private complete(p: Pairing, approvedBy: string): DeviceRecord {
    const { device, token } = this.registry.add({ name: p.name, kind: p.kind, capabilities: p.capabilities });
    p.status = 'approved';
    p.deviceId = device.deviceId;
    p.deviceToken = token;
    p.approvedBy = approvedBy;
    p.settledAt = this.now();
    this.emit('approved', { pairingId: p.pairingId, device, approvedBy });
    return device;
  }

  private settle(p: Pairing, reason: 'denied' | 'expired' | 'too_many_attempts'): void {
    p.status = reason === 'expired' ? 'expired' : 'denied';
    p.reason = reason;
    p.settledAt = this.now();
    this.emit('denied', { pairingId: p.pairingId, reason });
  }

  private pendingList(): Pairing[] {
    return [...this.pairings.values()].filter((p) => p.status === 'pending');
  }

  private toPending(p: Pairing): PendingPairing {
    const out: PendingPairing = {
      pairingId: p.pairingId,
      name: p.name,
      kind: p.kind,
      capabilities: p.capabilities,
      code: p.code,
      display: formatCode(p.code),
      requestedAt: p.requestedAt,
      expiresAt: p.expiresAt,
    };
    if (p.origin) out.origin = p.origin;
    return out;
  }
}

function approverKey(a: Approver): string {
  return a.type === 'device' ? `device:${a.deviceId}` : a.type === 'local' ? `local:${a.address ?? ''}` : 'console';
}

function approverLabel(a: Approver, registry: DeviceRegistry): string {
  if (a.type === 'device') return registry.get(a.deviceId)?.name ?? a.deviceId;
  return a.type === 'local' ? 'localhost' : 'server console';
}
