/**
 * Single-object tracker for tangible control, with no detector model: the object is followed through the hand that
 * holds it (WebXR hand joints are the headset's own hand tracking). SAM 3.1 (the server scan) says where the object
 * is and what it is; from the moment a hand closes around it, the object rides that hand: its offset in the wrist's
 * frame is locked at the grab, the position is One Euro filtered, and the render loop eases a display position
 * toward it (allocation-free).
 *
 * Grab: a tracked hand's palm comes within reach of the object for 150 ms. Put down: the hand opens wide for 400 ms
 * (not for flat objects such as a book, which are held with open fingers). Hand tracking lost: the object stays where
 * it was ('lost') until a hand takes it again.
 *
 * Modes: 'pick' lists the tangible objects SAM 3.1 has placed in view (`objects`); 'follow' tracks one. A scripted
 * path (`setSim`) replaces the hand in the desktop emulator so the whole chain can be exercised.
 */
import { Quaternion, Vector3 } from 'three';
import type { HandState } from '../hud/contract';
import type { PoseLike } from '../scan/projection';
import { clsForLabel, tangibleKind } from './objects';
import { OneEuro3 } from './one-euro';

export type TrackMode = 'off' | 'pick' | 'follow';
export type FollowState = 'searching' | 'tracking' | 'held' | 'lost';

/** A tangible object SAM 3.1 has placed in the room (an annotation target). */
export interface SeenObject {
  id: string;
  label: string;
  position: Vector3;
  sizeM: readonly number[];
}

export interface TrackDeps {
  /** current head pose (render time) */
  head: () => PoseLike | undefined;
  hands: () => { left?: HandState; right?: HandState } | undefined;
  log: (msg: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  /** tangible objects in view from the SAM 3.1 scan (pick mode) */
  objects?: () => readonly SeenObject[];
}

export interface Candidate {
  id: number;
  cls: number;
  label: string;
  position: Vector3;
  sizeM: number;
  score: number;
  seenAt: number;
}

export interface FollowSeed {
  position: Vector3;
  /** largest dimension, metres */
  sizeM: number;
  label: string;
  cls: number;
}

export type SimPath = 'demo' | 'lift' | 'slide' | 'still';

const GRAB_MS = 150;
const RELEASE_MS = 400;
/** palm-to-object distance that counts as holding it, beyond half the object's size */
const REACH = 0.1;
/** mean fingertip-to-wrist distance of a wide-open hand (holding a cup is ~0.11–0.14 m) */
const OPEN_HAND = 0.165;
const MAX_CANDIDATES = 4;
const PALM: XRHandJoint[] = ['wrist', 'index-finger-metacarpal', 'pinky-finger-metacarpal', 'thumb-tip', 'middle-finger-tip'];
const TIPS: XRHandJoint[] = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];

export class ObjectTracker {
  mode: TrackMode = 'off';
  state: FollowState = 'searching';
  /** filtered world position at the latest measurement */
  readonly position = new Vector3();
  /** eased per render frame: draw here */
  readonly display = new Vector3();
  sizeM = 0.12;
  label = 'Object';
  cls = 41;
  lastSeenAt = -Infinity;
  readonly candidates: Candidate[] = [];
  readonly stats = { state: 'ready' as 'off' | 'loading' | 'ready' | 'error', source: 'hand' as string, hz: 0, frames: 0, matched: 0, sim: '' as SimPath | '' };

  private hold: { hand: 'left' | 'right'; offset: Vector3; openSince: number } | null = null;
  private near: { hand: 'left' | 'right'; since: number } | null = null;
  private readonly ids = new Map<string, number>();
  private nextId = 1;
  private readonly pool: Candidate[] = [];
  private readonly filter = new OneEuro3(1.0, 4, 1);
  private sim: { path: SimPath; t0: number; center: Vector3; right: Vector3 } | null = null;
  // scratch (no per-frame allocations)
  private readonly v = new Vector3();
  private readonly palm = new Vector3();
  private readonly dir = new Vector3();
  private readonly q = new Quaternion();

  constructor(private readonly d: TrackDeps) {}

  /** Nothing to load: hand tracking is the headset's own. Kept for callers. */
  load(): Promise<void> { return Promise.resolve(); }

  startPick(): void {
    this.mode = 'pick';
    this.candidates.length = 0;
  }

  /** Track one object, seeded from where SAM 3.1 placed it (an annotation target or a picked candidate). */
  follow(seed: FollowSeed, now = performance.now()): void {
    this.mode = 'follow';
    this.state = 'searching';
    this.cls = seed.cls;
    this.label = seed.label;
    this.sizeM = seed.sizeM;
    this.position.copy(seed.position);
    this.display.copy(seed.position);
    this.filter.reset(seed.position, now);
    this.lastSeenAt = now;
    this.hold = null;
    this.near = null;
    this.candidates.length = 0;
  }

  pickCandidate(id: number): FollowSeed | null {
    const c = this.candidates.find((x) => x.id === id);
    if (!c) return null;
    return { position: c.position.clone(), sizeM: c.sizeM, label: c.label, cls: c.cls };
  }

  stop(): void {
    this.mode = 'off';
    this.candidates.length = 0;
    this.hold = null;
    this.near = null;
  }

  dispose(): void { this.stop(); }

  /** Replace the hand with a scripted object path in front of the head (emulator). */
  setSim(path: SimPath | null, now = performance.now()): void {
    if (!path) { this.sim = null; this.stats.sim = ''; return; }
    const head = this.d.head();
    const center = new Vector3(0, 1.1, -0.65), right = new Vector3(1, 0, 0);
    if (head) {
      right.set(1, 0, 0).applyQuaternion(head.quaternion); right.y = 0;
      if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
      right.normalize();
      this.dir.set(0, 0, -1).applyQuaternion(head.quaternion); this.dir.y = 0;
      if (this.dir.lengthSq() < 1e-4) this.dir.set(0, 0, -1);
      this.dir.normalize();
      // on the desk, a little to the right of where the device card spawns
      center.copy(head.position).addScaledVector(this.dir, 0.72).addScaledVector(right, 0.26); center.y = head.position.y - 0.42;
    }
    this.sim = { path, t0: now, center, right };
    this.stats.sim = path;
  }

  get simCenter(): Vector3 | undefined { return this.sim?.center; }
  get simT0(): number { return this.sim?.t0 ?? 0; }

  /** Per render frame: follow the holding hand, age the state, ease the display position. */
  tick(now: number, dtMs: number): void {
    if (this.mode === 'off') return;
    if (this.mode === 'pick') { this.updateCandidates(now); return; }
    if (this.sim) this.followSim(now);
    else this.followHand(now);
    // ~45 ms time constant: smooth without visible lag
    const a = 1 - Math.exp(-Math.max(0, dtMs) / 45);
    this.display.lerp(this.position, a);
  }

  /** For a crop hint (buddy): the followed object's world pose while it is held. */
  visible(): boolean { return this.mode === 'follow' && (this.state === 'tracking' || this.state === 'held'); }

  private joints(hand: 'left' | 'right'): HandState['joints'] | undefined {
    const h = this.d.hands()?.[hand];
    return h && !h.controller ? h.joints : undefined;
  }

  /** Palm centre (wrist, knuckles, thumb and middle tips). False when the hand is not tracked. */
  private palmOf(hand: 'left' | 'right', out: Vector3): boolean {
    const j = this.joints(hand);
    if (!j) return false;
    out.set(0, 0, 0);
    let n = 0;
    for (const name of PALM) { const p = j[name]?.position; if (p) { out.add(p); n++; } }
    if (n < 3) return false;
    out.multiplyScalar(1 / n);
    return true;
  }

  private openness(hand: 'left' | 'right'): number {
    const j = this.joints(hand), w = j?.wrist?.position;
    if (!j || !w) return 0;
    let sum = 0, n = 0;
    for (const name of TIPS) { const p = j[name]?.position; if (p) { sum += p.distanceTo(w); n++; } }
    return n ? sum / n : 0;
  }

  private followHand(now: number): void {
    const hold = this.hold;
    if (hold) {
      const wrist = this.joints(hold.hand)?.wrist;
      if (!wrist) { this.state = 'lost'; this.hold = null; this.near = null; return; }
      // put down: a wide-open hand for 400 ms (a book is held with open fingers: never auto-released)
      const flat = tangibleKind(this.cls)?.family === 'flat';
      if (!flat && this.openness(hold.hand) > OPEN_HAND) {
        if (!hold.openSince) hold.openSince = now;
        else if (now - hold.openSince > RELEASE_MS) { this.hold = null; this.near = null; this.state = 'searching'; return; }
      } else hold.openSince = 0;
      this.v.copy(hold.offset).applyQuaternion(wrist.quaternion).add(wrist.position);
      this.position.copy(this.filter.filter(this.v, now));
      this.lastSeenAt = now;
      this.state = 'tracking';
      this.stats.frames++;
      return;
    }
    // waiting for a hand to take it: the nearest tracked palm within reach for 150 ms, fingers not wide open
    // (an open hand that just put the object down must not pick it straight back up)
    const flat = tangibleKind(this.cls)?.family === 'flat';
    let best: 'left' | 'right' | null = null, bestD = REACH + this.sizeM / 2;
    for (const hand of ['left', 'right'] as const) {
      if (!this.palmOf(hand, this.palm) || !flat && this.openness(hand) > OPEN_HAND) continue;
      const dist = this.palm.distanceTo(this.position);
      if (dist < bestD) { bestD = dist; best = hand; }
    }
    if (!best) { this.near = null; return; }
    if (!this.near || this.near.hand !== best) { this.near = { hand: best, since: now }; return; }
    if (now - this.near.since < GRAB_MS) return;
    const wrist = this.joints(best)?.wrist;
    if (!wrist) return;
    this.q.copy(wrist.quaternion).invert();
    this.hold = { hand: best, offset: this.position.clone().sub(wrist.position).applyQuaternion(this.q), openSince: 0 };
    this.filter.reset(this.position, now);
    this.state = 'tracking';
    this.lastSeenAt = now;
    this.stats.matched++;
    this.d.log(`tangible: ${this.label} is in your ${best} hand`);
  }

  private followSim(now: number): void {
    const t = (now - this.sim!.t0) / 1000;
    const world = this.simPosition(t, this.sim!.path, this.v);
    // a short dropout every ~9 s shows coasting / re-acquire
    if (this.sim!.path === 'demo' && t % 9 > 8.4) { if (now - this.lastSeenAt > 450) this.state = 'lost'; return; }
    this.position.copy(this.filter.filter(world, now));
    if (this.state !== 'tracking') this.display.copy(this.position);
    this.lastSeenAt = now;
    this.state = 'tracking';
  }

  /** Pick mode: the tangible objects SAM 3.1 has placed in view, nearest first. */
  private updateCandidates(now: number): void {
    this.candidates.length = 0;
    const head = this.d.head();
    const seen = this.d.objects?.() ?? [];
    const sorted = head ? [...seen].sort((a, b) => a.position.distanceTo(head.position) - b.position.distanceTo(head.position)) : seen;
    for (const o of sorted) {
      let id = this.ids.get(o.id);
      if (id === undefined) { id = this.nextId++; this.ids.set(o.id, id); }
      let c = this.pool.find((p) => p.id === id);
      const cls = clsForLabel(o.label) ?? 41;
      if (!c) {
        c = { id, cls, label: tangibleKind(cls)?.label ?? o.label, position: new Vector3(), sizeM: 0.12, score: 1, seenAt: now };
        this.pool.push(c);
        if (this.pool.length > 16) this.pool.shift();
      }
      c.position.copy(o.position);
      c.sizeM = Math.max(0.06, Math.min(0.5, Math.max(o.sizeM[0] ?? 0.12, o.sizeM[1] ?? 0.12)));
      c.cls = cls; c.seenAt = now;
      this.candidates.push(c);
      if (this.candidates.length >= MAX_CANDIDATES) break;
    }
  }

  simPosition(t: number, path: SimPath, out: Vector3): Vector3 {
    const c = this.sim?.center ?? this.position;
    const lift = path === 'slide' || path === 'still' ? 0 : path === 'lift' ? 0.11 * (1 - Math.cos(t * 1.3)) : 0.1 * (1 - Math.cos(t * 1.05));
    const slide = path === 'lift' || path === 'still' ? 0 : path === 'slide' ? 0.14 * Math.sin(t * 1.1) : 0.13 * Math.sin(t * 0.62);
    // slide along the head's right at sim start (= the binding's slide axis)
    const r = this.sim?.right;
    const rx = r?.x ?? 1, rz = r?.z ?? 0;
    return out.set(c.x + rx * slide, c.y + lift, c.z + rz * slide);
  }
}
