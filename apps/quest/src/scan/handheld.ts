/**
 * Hand-held devices (the IR remote in the LEARN flow): a detection that lands within reach of a tracked wrist
 * is attached to that hand, and then follows the wrist pose every frame instead of waiting for the next SAM
 * result (research/04 §3 step 7: track the hand, not the object, while it is held).
 */
import { Quaternion, Vector3 } from 'three';

export interface WristPose {
  position: Vector3;
  quaternion: Quaternion;
}

interface Attachment {
  hand: 'left' | 'right';
  /** device position in the wrist frame */
  offset: Vector3;
  lastSeen: number;
  lastSent: Vector3;
  lastSentAt: number;
}

const HELD = /remote|phone|controller|cardputer|screen and keyboard|handheld/i;

export class HandheldTracker {
  private readonly attached = new Map<string, Attachment>();
  /** attach when the device is this close to a wrist, metres */
  reach = 0.18;
  /** detach after the hand has been lost this long, ms */
  lostMs = 1000;

  isAttached(id: string): boolean {
    return this.attached.has(id);
  }

  /**
   * A fresh detection of a device: attach it to the nearest wrist within reach (only devices people hold),
   * or detach it when it was put down (detected far from the hand that held it).
   */
  observe(id: string, label: string, position: Vector3, wrists: { left?: WristPose; right?: WristPose }, now: number): 'attached' | 'detached' | 'none' {
    const cur = this.attached.get(id);
    if (cur) {
      const w = wrists[cur.hand];
      if (w && w.position.distanceTo(position) > this.reach + 0.05) {
        this.attached.delete(id);
        return 'detached';
      }
      return 'none';
    }
    if (!HELD.test(label)) return 'none';
    let best: { hand: 'left' | 'right'; d: number; w: WristPose } | null = null;
    for (const hand of ['left', 'right'] as const) {
      const w = wrists[hand];
      if (!w) continue;
      const d = w.position.distanceTo(position);
      if (d <= this.reach && (!best || d < best.d)) best = { hand, d, w };
    }
    if (!best) return 'none';
    const inv = best.w.quaternion.clone().invert();
    const offset = position.clone().sub(best.w.position).applyQuaternion(inv);
    this.attached.set(id, { hand: best.hand, offset, lastSeen: now, lastSent: position.clone(), lastSentAt: now });
    return 'attached';
  }

  /**
   * Per frame: new positions for attached devices that moved enough to redraw (≥ 5 mm, ≤ 15 Hz).
   * Devices whose hand has been lost for `lostMs` are released where they were last seen.
   */
  update(wrists: { left?: WristPose; right?: WristPose }, now: number): { id: string; position: Vector3 }[] {
    const moved: { id: string; position: Vector3 }[] = [];
    for (const [id, a] of this.attached) {
      const w = wrists[a.hand];
      if (!w) {
        if (now - a.lastSeen > this.lostMs) this.attached.delete(id);
        continue;
      }
      a.lastSeen = now;
      const p = a.offset.clone().applyQuaternion(w.quaternion).add(w.position);
      if (p.distanceTo(a.lastSent) >= 0.005 && now - a.lastSentAt >= 66) {
        a.lastSent.copy(p);
        a.lastSentAt = now;
        moved.push({ id, position: p });
      }
    }
    return moved;
  }

  detach(id: string): void {
    this.attached.delete(id);
  }
}
