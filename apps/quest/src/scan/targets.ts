/**
 * Scanned devices as world-anchored targets. Detections from successive scan frames are merged into one
 * target by device id, or by label + 3D proximity (devices are static; the head moves), with smoothing.
 */
import type { Channel, HudStatus } from '@ce/gen3d';
import { Vector3 } from 'three';
import type { HudTarget, V3 } from '../app/hud-contract';
import type { Det } from '../io/v1';
import type { Placement } from './placement';

export interface Target {
  id: string;
  label: string;
  prompt?: string;
  score: number;
  modelId?: string;
  position: Vector3;
  normal?: Vector3;
  facing: Vector3;
  confirmed: boolean;
  /** The user confirmed this device's anchor; matching detections may continue tracking it. */
  refined: boolean;
  method: string;
  sizeM: [number, number, number];
  contour?: [number, number][];
  status: HudStatus;
  subtitle?: string;
  channel?: Channel;
  deviceId?: string;
  cardId?: string;
  /** Persistent anchor tracking can temporarily lose its pose without losing the saved device. */
  locating?: boolean;
  /** The latest detection that produced or updated it (included in tag.add). */
  frameId: string;
  detId: string;
  seen: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

const GENERIC = /^(electronic device|electronics|device|object|gadget)$/i;
const SHORT: [RegExp, string][] = [
  [/ceiling light/i, 'Ceiling light'],
  [/^electronic device$/i, 'Device'],
  [/synthesizer/i, 'Synth'],
  [/air conditioner/i, 'Air conditioner'],
  [/device with screen and keyboard/i, 'Pocket computer'],
];

export function displayLabel(label: string): string {
  label = label.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const [re, s] of SHORT) if (re.test(label)) return s;
  if (!label) return 'Device';
  const short = label.length <= 22 ? label : `${label.slice(0, 21).trimEnd()}…`;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

const norm = (s: string) => s.trim().toLowerCase();
const EMA = 0.35;

export class TargetStore {
  readonly targets = new Map<string, Target>();
  private nextId = 1;
  private readonly sessionId = globalThis.crypto.randomUUID();

  get(id: string): Target | undefined {
    return this.targets.get(id);
  }

  list(): Target[] {
    return [...this.targets.values()];
  }

  byCard(cardId: string): Target | undefined {
    return this.list().find((t) => t.cardId === cardId);
  }

  byDevice(deviceId: string): Target | undefined {
    return this.list().find((t) => t.deviceId === deviceId);
  }

  /** Merge a placed detection into an existing target or create one. */
  upsert(det: Det, pl: Placement, frameId: string, modelId?: string, now = Date.now()): { target: Target; created: boolean } {
    const existing = this.match(det, pl);
    if (existing) {
      const t = existing;
      if (GENERIC.test(t.label) && !GENERIC.test(det.label)) {
        t.label = det.label;
        t.prompt = det.prompt ?? det.label;
      }
      t.score = Math.max(t.score * 0.9, det.score);
      if (pl.confirmed && !t.confirmed && !t.refined) {
        t.position.copy(pl.position);
        t.confirmed = true;
        t.method = pl.method;
      } else if (pl.confirmed === t.confirmed || t.refined) {
        t.position.lerp(pl.position, EMA);
      }
      t.facing.lerp(pl.facing, EMA).normalize();
      if (pl.normal) t.normal = pl.normal.clone();
      t.sizeM = pl.sizeM;
      if (pl.contour) t.contour = pl.contour;
      if (det.deviceId) t.deviceId = det.deviceId;
      if (det.cardId) t.cardId = det.cardId;
      if (modelId) t.modelId = modelId;
      t.frameId = frameId;
      t.detId = det.detId;
      t.seen++;
      t.lastSeenAt = now;
      return { target: t, created: false };
    }
    const t: Target = {
      id: `tgt:${this.sessionId}:${this.nextId++}`,
      label: det.label,
      prompt: det.prompt ?? det.label,
      score: det.score,
      modelId,
      position: pl.position.clone(),
      normal: pl.normal?.clone(),
      facing: pl.facing.clone(),
      confirmed: pl.confirmed,
      refined: false,
      method: pl.method,
      sizeM: pl.sizeM,
      contour: pl.contour,
      status: 'scanned',
      subtitle: 'unverified',
      deviceId: det.deviceId,
      cardId: det.cardId,
      frameId,
      detId: det.detId,
      seen: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.targets.set(t.id, t);
    return { target: t, created: true };
  }

  /** Confirm the existing device anchor; a hand ray point must not move it toward the user. */
  refine(id: string, _point: Vector3): Target | undefined {
    const t = this.targets.get(id);
    if (!t) return undefined;
    t.confirmed = true;
    t.refined = true;
    t.method = 'pinch';
    return t;
  }

  remove(id: string): boolean {
    return this.targets.delete(id);
  }

  /** Adopt a fresh observation under the saved chip's stable id; no previous-session pose participates. */
  reattach(targetId: string, fresh: Target, cardId: string): Target {
    this.targets.delete(fresh.id);
    fresh.id = targetId;
    fresh.cardId = cardId;
    fresh.method = 'reassociated';
    fresh.locating = false;
    this.targets.set(targetId, fresh);
    return fresh;
  }

  /** A new scan starts: drop everything the user has not locked, linked or controlled. Returns removed ids. */
  clearTransient(keep: (t: Target) => boolean): string[] {
    const removed: string[] = [];
    for (const t of this.targets.values()) {
      if (keep(t)) continue;
      this.targets.delete(t.id);
      removed.push(t.id);
    }
    return removed;
  }

  private match(det: Det, pl: Placement): Target | undefined {
    let best: Target | undefined;
    let bestD = Infinity;
    for (const t of this.targets.values()) {
      if (det.cardId && t.cardId === det.cardId) return t;
      if (det.cardId && t.cardId && t.cardId !== det.cardId) continue;
      if (det.deviceId && t.deviceId === det.deviceId) return t;
      const d = t.position.distanceTo(pl.position);
      const size = Math.max(...t.sizeM, ...pl.sizeM, 0.1);
      // depth guesses are uncertain along the ray: be more tolerant for unconfirmed placements
      const slack = pl.confirmed && t.confirmed ? 0 : 0.25 * pl.depth;
      const sameLabel = norm(t.label) === norm(det.label) || norm(t.prompt ?? '') === norm(det.prompt ?? det.label);
      const generic = GENERIC.test(det.label) || GENERIC.test(t.label);
      const tol = sameLabel ? Math.max(0.3, 0.6 * size, slack) : generic ? Math.max(0.15, 0.4 * size, slack * 0.6) : -1;
      if (d <= tol && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }
}

export function toHudTarget(t: Target): HudTarget {
  const v = (p: Vector3): V3 => [round(p.x), round(p.y), round(p.z)];
  const out: HudTarget = {
    id: t.id,
    label: displayLabel(t.label),
    status: t.status,
    position: v(t.position),
    confirmed: t.confirmed,
    sizeM: t.sizeM,
    facing: v(t.facing),
    score: Math.round(t.score * 100) / 100,
    locating: t.locating,
  };
  if (t.subtitle) out.subtitle = t.subtitle;
  if (t.channel) out.channel = t.channel;
  if (t.normal) out.normal = v(t.normal);
  if (t.contour) out.contour = t.contour;
  if (t.modelId) out.modelId = t.modelId;
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
