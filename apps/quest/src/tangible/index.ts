/**
 * TANGIBLE CONTROL: any everyday object (a mug, bottle, book, phone) becomes a controller for the selected
 * device. Pick it (Annotate: "Use as controller" on its label; or the wrist palette's "Use an object" while a
 * device is selected), and the object is tracked through the hand that holds it (tangible/track.ts: WebXR hand
 * joints + One Euro, no detector model; SAM 3.1 placed it) with a crisp ring that follows it. Lift/lower drives the device's first verified control (Warp on the visual synth),
 * sliding it left/right the second (Water ripples). Values go out as ordinary control.events through the shell's
 * deterministic control path (ControlSender → server router, no model in the loop) and stop cleanly with a
 * phase 'end' when the object leaves view, the device is stopped, or the object is released.
 */
import { Vector3 } from 'three';
import type { Control } from '@ce/gen3d';
import type { HandState } from '../hud/contract';
import type { CameraSource } from '../scan/camera';
import type { PoseRing } from '../scan/poses';
import { chooseControls, MotionBinding, type TangibleAxis } from './binding';
import { clsForLabel, isTangibleLabel, tangibleKind } from './objects';
import { type FollowSeed, ObjectTracker, type SeenObject, type SimPath } from './track';
import { type BoundView, TangibleVisuals } from './visuals';

export { isTangibleLabel } from './objects';

/** The device the object will drive (resolved by the shell every frame). */
export interface TangibleDevice {
  cardId: string;
  targetId: string;
  label: string;
  /** the server's ui spec id (control.event specId) and the rendered gen3d spec id (HUD mirror) */
  uiSpecId: string;
  gen3dSpecId: string;
  controls: readonly Control[];
  /** armed and verified, whether or not it is the selected device right now */
  armed: boolean;
  /** the shell will accept control events for it right now (control mode, selected, armed) */
  controllable: boolean;
  value: (controlId: string) => number | undefined;
}

export interface TangibleHost {
  parent: { add(o: TangibleVisuals): unknown };
  camera: () => CameraSource | undefined;
  poses: PoseRing;
  frame: () => { head: { position: Vector3; quaternion: import('three').Quaternion }; hands: { left?: HandState; right?: HandState } } | undefined;
  log: (msg: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
  /** tangible objects SAM 3.1 has placed in view (pick mode candidates) */
  objects?: () => readonly SeenObject[];
  toast: (msg: string, kind?: 'info' | 'ok' | 'warn') => void;
  device: () => TangibleDevice | null;
  /** push one control value through the deterministic control path */
  send: (device: TangibleDevice, controlId: string, value: number, phase: 'start' | 'move' | 'end') => void;
  /** go back to controlling this device (control mode, device selected) */
  resume: (device: TangibleDevice) => void;
  ensureCamera: () => void;
  /** leave hand Perform (two inputs must not fight over one control) */
  stopPerform?: () => void;
}

export type TangibleState = 'idle' | 'picking' | 'bound';

const WAIT_DEVICE_MS = 12_000;

export class Tangible {
  state: TangibleState = 'idle';
  readonly tracker: ObjectTracker;
  readonly visuals: TangibleVisuals;
  readonly binding = new MotionBinding();
  private device: TangibleDevice | null = null;
  private engaged = false;
  private boundAt = 0;
  private lastMirror = 0;
  private lastTrackState = '';
  private readonly view: BoundView = { position: new Vector3(), sizeM: 0.1, state: 'searching', title: '', detail: '', lift: 0, slide: 0, liftLabel: '', slideLabel: '', hasSlide: false };
  private readonly fwd = new Vector3();
  private readonly simP = new Vector3();
  private readonly held = { position: new Vector3(), sizeM: [0.1, 0.1, 0.1] as [number, number, number], label: '' };
  private sends = 0;
  private textAt = -Infinity;
  private textState = '';
  private cached: TangibleDevice | null = null;
  private cachedAt = -Infinity;

  constructor(private readonly h: TangibleHost) {
    this.tracker = new ObjectTracker({ head: () => h.frame()?.head, hands: () => h.frame()?.hands, log: h.log, objects: h.objects });
    this.visuals = new TangibleVisuals((id) => this.pickCandidate(id));
    h.parent.add(this.visuals);
    this.publish();
  }

  get bound(): boolean { return this.state === 'bound'; }
  get objectLabel(): string { return this.tracker.label; }

  /** Palette: "Use an object" while a device is selected. */
  canPick(): boolean { return this.state === 'idle' && !!this.h.device()?.controllable; }

  /** Show candidate rings on nearby everyday objects; pinch one to bind it. */
  startPick(): void {
    const d = this.h.device();
    if (!d?.controllable) { this.h.toast('Select a device first (wrist · Visual synth), then choose Use an object.', 'info'); return; }
    this.h.ensureCamera();
    this.state = 'picking';
    this.tracker.startPick();
    this.h.toast('Look at a cup, bottle or book (Objects or All), then pinch its ring.', 'info');
    this.publish();
  }

  /** Annotate: "Use as controller" on a tagged/hovered object. */
  useTarget(target: { label: string; position: Vector3 | readonly [number, number, number]; sizeM?: readonly number[] }): boolean {
    const d = this.h.device();
    if (!d?.armed) { this.h.toast('Set up a device first (wrist · Visual synth), then choose Use as controller.', 'info'); return false; }
    const cls = clsForLabel(target.label) ?? 41;
    const position = target.position instanceof Vector3 ? target.position.clone() : new Vector3(target.position[0], target.position[1], target.position[2]);
    const size = target.sizeM ? Math.max(target.sizeM[0] ?? 0.1, target.sizeM[1] ?? 0.1) : tangibleKind(cls)?.sizeM ?? 0.12;
    const label = tangibleKind(cls)?.label ?? target.label;
    // back to the device first (the shell's mode change releases any previous object), then bind
    this.h.resume(d);
    this.bind({ position, sizeM: size, label, cls });
    return true;
  }

  private pickCandidate(id: number): void {
    if (this.state !== 'picking') return;
    const seed = this.tracker.pickCandidate(id);
    if (seed) this.bind(seed);
  }

  bind(seed: FollowSeed): void {
    const d = this.h.device();
    if (!d) return;
    this.h.ensureCamera();
    this.h.stopPerform?.();
    const { lift, slide } = chooseControls(d.controls);
    if (!lift) { this.h.toast(`${d.label} has no verified continuous control to map.`, 'warn'); return; }
    const axes: { axis: TangibleAxis; control: Control }[] = [{ axis: 'lift', control: lift }];
    if (slide) axes.push({ axis: 'slide', control: slide });
    this.binding.configure(axes, (id) => d.value(id));
    this.device = d;
    this.cached = d; this.cachedAt = performance.now();
    this.state = 'bound';
    this.engaged = false;
    this.boundAt = performance.now();
    this.tracker.follow(seed, this.boundAt);
    this.lastTrackState = '';
    const map = this.binding.axes.map((a) => `${a.axis === 'lift' ? 'lift it' : 'slide it'} for ${a.label}`).join(', ');
    this.h.log(`tangible: ${seed.label} controls ${d.label} (${map})`, 'ok');
    this.h.toast(`${seed.label} is now a controller: ${map}.`, 'ok');
    this.publish();
  }

  /** Stop cleanly: one phase 'end' per engaged control, then forget the object. */
  release(reason?: string): void {
    if (this.state === 'idle') return;
    if (this.state === 'bound') {
      this.disengage();
      if (reason) this.h.log(`tangible: released (${reason})`);
    }
    this.state = 'idle';
    this.device = null;
    this.tracker.stop();
    this.tracker.setSim(null);
    this.publish();
  }

  /** Another controller (hand Perform) takes the device: one 'end' per control, the ring fades, a short status. */
  yieldTo(other: string): void {
    if (this.state === 'idle') return;
    const was = this.state;
    this.release(other);
    if (was === 'bound') this.h.toast(`Object released · ${other} is on`, 'info');
  }

  /** The followed object's world pose while tracked (a crop hint for the buddy). */
  heldObject(): { position: Vector3; sizeM: [number, number, number]; label: string } | null {
    if (this.state !== 'bound' || !this.tracker.visible()) return null;
    this.held.position.copy(this.tracker.display);
    this.held.sizeM[0] = this.held.sizeM[1] = this.held.sizeM[2] = this.tracker.sizeM;
    this.held.label = this.tracker.label;
    return this.held;
  }

  /** Emulator: drive the tracker with a scripted object path instead of the camera. */
  simulate(path: SimPath | null = 'demo'): string {
    this.tracker.setSim(path);
    if (!path) return 'sim off';
    const c = this.tracker.simCenter;
    if (this.state === 'bound' && c) this.tracker.follow({ position: c.clone(), sizeM: 0.11, label: 'Cup', cls: 41 });
    return `sim ${path}`;
  }

  /** Emulator shortcut: scripted mug, bound straight away (skips the pinch). */
  simBind(path: SimPath = 'demo'): boolean {
    this.tracker.setSim(path);
    const c = this.tracker.simCenter;
    if (!c || !this.h.device()) return false;
    this.bind({ position: c.clone(), sizeM: 0.11, label: 'Cup', cls: 41 });
    return this.state === 'bound';
  }

  /** The shell's device, re-resolved at most every 120 ms (the control path re-checks every send anyway). */
  private currentDevice(now: number): TangibleDevice | null {
    if (now - this.cachedAt > 120) { this.cached = this.h.device(); this.cachedAt = now; }
    return this.cached;
  }

  /** Per render frame (shell frame hook). No allocations on this path. */
  tick(now: number, dtMs: number): void {
    const frame = this.h.frame();
    if (this.state === 'idle') {
      if (frame) { this.visuals.updateBound(null, frame.head, now, dtMs); this.visuals.updateCandidates(null, frame.head, now, dtMs); this.visuals.updateProxy(null, frame.head); }
      return;
    }
    if (!frame) return;
    this.tracker.tick(now, dtMs);
    const c = this.tracker.simCenter;
    this.visuals.updateProxy(c ? this.tracker.simPosition((now - this.tracker.simT0) / 1000, this.tracker.stats.sim as SimPath, this.simP) : null, frame.head);
    if (this.state === 'picking') {
      if (!this.currentDevice(now)?.controllable) { this.release('device not selected'); return; }
      this.visuals.updateCandidates(this.tracker.candidates, frame.head, now, dtMs);
      this.visuals.updateBound(null, frame.head, now, dtMs);
      return;
    }
    this.visuals.updateCandidates(null, frame.head, now, dtMs);
    this.drive(now, frame.head.quaternion);
    const v = this.view;
    v.position.copy(this.tracker.display);
    v.sizeM = this.tracker.sizeM;
    const a0 = this.binding.axes[0], a1 = this.binding.axes[1];
    v.lift = a0?.fraction ?? 0; v.slide = a1?.fraction ?? 0; v.hasSlide = !!a1;
    v.liftLabel = a0?.label ?? ''; v.slideLabel = a1?.label ?? '';
    const ts = this.tracker.state;
    const deviceReady = !!this.device?.controllable;
    v.state = !deviceReady ? 'waiting' : ts;
    // label text is rebuilt at most 5 Hz (and on state changes), so this path allocates no strings per frame
    if (now - this.textAt > 200 || v.state !== this.textState) {
      this.textAt = now; this.textState = v.state;
      const name = this.tracker.label;
      const detail = !deviceReady ? 'connecting…'
        : ts === 'lost' ? `show the ${name.toLowerCase()} again`
        : ts === 'searching' ? 'pick it up'
        : this.valueText();
      v.title = `${name} · ${detail}`;
      v.detail = detail;
    }
    this.visuals.updateBound(v, frame.head, now, dtMs);
    if (ts !== this.lastTrackState) { this.lastTrackState = ts; this.publish(); }
  }

  private valueText(): string {
    let s = '';
    for (const a of this.binding.axes) s += `${s ? ' · ' : ''}${a.label} ${Math.round(this.binding.value(a))}`;
    return s;
  }

  /** Map the tracked pose to control values and push them while the device accepts them. */
  private drive(now: number, headQ: import('three').Quaternion): void {
    const fresh = this.currentDevice(now);
    if (fresh && this.device && fresh.cardId === this.device.cardId) this.device = fresh;
    const d = this.device;
    if (!d || !fresh || fresh.cardId !== d.cardId || !fresh.armed) {
      if (now - this.boundAt > 1500) { this.release('device stopped'); this.h.toast('Released the object: the device is no longer set up.', 'info'); }
      return;
    }
    const tracking = this.tracker.state === 'tracking' || this.tracker.state === 'held';
    if (!d.controllable) {
      // resuming the device after Annotate takes a moment; give up after WAIT_DEVICE_MS
      if (this.engaged) this.disengage();
      if (now - this.boundAt > WAIT_DEVICE_MS) { this.release('device not selected'); this.h.toast('Released the object: select the device, then try again.', 'info'); }
      return;
    }
    if (!tracking) { if (this.engaged) this.disengage(); return; }
    if (!this.engaged) {
      // (re)engage where the object is now: values continue from their current level, no jump
      this.fwd.set(0, 0, -1).applyQuaternion(headQ);
      this.binding.rebase(this.tracker.display, this.fwd);
      this.engaged = true;
      for (const a of this.binding.axes) { a.sent = this.binding.value(a); this.h.send(d, a.controlId, a.sent, 'start'); this.sends++; }
      this.publish();
      return;
    }
    if (!this.binding.update(this.tracker.display)) return;
    for (const a of this.binding.axes) {
      const value = this.binding.value(a);
      if (value === a.sent) continue;
      a.sent = value;
      this.h.send(d, a.controlId, value, 'move');
      this.sends++;
    }
    if (now - this.lastMirror > 200) { this.lastMirror = now; this.publish(); }
  }

  private disengage(): void {
    const d = this.device;
    if (this.engaged && d) for (const a of this.binding.axes) if (Number.isFinite(a.sent)) { this.h.send(d, a.controlId, a.sent, 'end'); this.sends++; }
    const was = this.engaged;
    this.engaged = false;
    if (was) this.publish();
  }

  /** Debug / e2e surface: window.__ce.tangibleState (the instance itself is window.__ce.tangible) */
  private publish(): void {
    if (typeof window === 'undefined') return;
    const ce = (window as unknown as { __ce?: Record<string, unknown> }).__ce;
    if (!ce) return;
    const t = this.tracker;
    ce.tangibleState = {
      state: this.state, track: t.state, mode: t.mode, label: t.label, engaged: this.engaged, sends: this.sends,
      device: this.device?.label ?? null,
      axes: this.binding.axes.map((a) => ({ axis: a.axis, control: a.controlId, label: a.label, value: this.binding.value(a), fraction: Math.round(a.fraction * 1000) / 1000 })),
      position: t.display.toArray().map((n) => Math.round(n * 1000) / 1000), stats: { ...t.stats },
    };
  }

  /** Debug readout line. */
  summary(): string {
    const t = this.tracker;
    return `tangible · ${this.state}${this.state === 'bound' ? ` · ${t.label} ${t.state} · ${this.valueText()}` : ''} · via ${t.stats.sim ? `sim ${t.stats.sim}` : 'hand'}`;
  }

  dispose(): void { this.release('dispose'); this.tracker.dispose(); this.visuals.dispose(); }
}
