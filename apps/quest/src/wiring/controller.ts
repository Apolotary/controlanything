/**
 * "Muse writes the glue", headset half. Owns the whole flow for the selected device:
 *
 *   ask (chip / voice) -> wire.request -> wire.progress (code streams into the code card) -> wire.ready
 *   -> run the program in the sandbox -> stop
 *
 * A program that reads the screen starts at once too: the plane is guessed from the detected screen and the wearer's
 * first touch on the glass fixes it (gestures/screen-auto.ts). The two-corner calibration is only a manual fallback
 * behind the card's "Recalibrate screen".
 *
 * Until a wire.ready has arrived and is running, the hands do nothing to the device: this class is the only thing that
 * turns signals into control events, and only through the sandbox (wiring/runtime.ts).
 */
import { Vector3 } from 'three';
import { newId, type WireControl, type WireProgressPayload, type WireReadyPayload, type WireStoppedPayload, type WireStopPayload } from '@ce/protocol';
import type { ShellFrame } from '../app/hud-contract';
import type { WireCalibrationView, WireCodeView, WirePhase, WireView, WireOutputStream, WireLiveScreen } from '../hud/contract';
import { SignalTracker, SIGNAL_RANGE } from '../gestures/signals';
import { ScreenCalibrator } from '../gestures/screen-calibration';
import { clearPlane, loadPlane, planePoint, savePlane, type ScreenPlane } from '../gestures/screen-plane';
import { ScreenTouchFinder, autoScreenPlane, confirmPlane, planeAtTouch, planeCentre, type ScreenGuess } from '../gestures/screen-auto';
import { WiringRuntime, type StopKind, type WireEmit, type WiringProgram } from './runtime';
import { SceneRuntime, SceneSignalBuilder } from './scene-runtime';

export const WIRE_CHIPS = ['Touch the water', 'Give me knobs for the visuals', 'Hands as knobs'] as const;
export const MUSICAL_WIRE_CHIPS = ['Play like a theremin', 'Pinch to play notes', 'Give me filter knobs'] as const;
export const PHYSICAL_WIRE_CHIPS = ['Give me knobs for this', 'Play it with my hands', 'Surprise me'] as const;
/** A laptop/Mac: Muse can drive the visual synth running on it. */
export const LAPTOP_WIRE_CHIPS = ['Give me knobs for this', 'Swipe my hand to scroll Instagram Reels', 'Open the visual synth demo'] as const;
/** One ask for an interactive XR visualization, offered with every chip set. */
export const SCENE_CHIP = 'Visualize my hands in 3D';
export const VISUAL_SCENE_CHIP = 'Show the ripples as a 3D field';
const isLaptop = (label: string) => /\b(laptop|macbook|mac|computer|notebook|monitor|screen|display|visual synth)\b/i.test(label);
export const WIRE_TIMING = {
  /** title + explanation stay up this long once the program runs, then the card collapses to a pill */
  explainMs: 6000,
  /** no progress at all for this long after asking = Muse did not answer */
  silenceMs: 90_000,
  /** a tap on the mic (not a hold) keeps listening; it is sent after this at the latest */
  maxListenMs: 15_000,
  /** holding the mic button longer than this = hold-to-talk (release sends) */
  holdMs: 450,
} as const;

export interface WiringHost {
  /** The selected, set-up device the wiring applies to; undefined when none (or not in Control). */
  selected(): { cardId: string; targetId: string; anchor: Vector3; label: string; instrument?: 'visual-synth' | 'musical-synth' } | undefined;
  canControl(cardId: string): boolean;
  /** The physical screen a screen program is touched on: the detected laptop/monitor (SAM direction, guessed depth).
   *  Undefined when none was detected (the first touch then places the plane by itself). */
  screen?(): ScreenGuess | undefined;
  /** Send a client message to the server. */
  send(type: 'wire.request', payload: { cardId: string; text: string; source: 'chip' | 'voice' | 'text'; requestId: string }): boolean;
  /** One program output as control.event on the card. */
  sendControl(cardId: string, event: WireEmit): boolean;
  render(view: WireView | null): void;
  setHandsBusy(busy: boolean): void;
  /** Withdraw only this request's wiring authority; preserve the verified device and selection. */
  userStopped?(reason: string, request: Omit<WireStopPayload, 'reason'>): void;
  toast(text: string, level?: 'info' | 'ok' | 'warn' | 'error'): void;
  log(text: string, level?: 'info' | 'ok' | 'warn' | 'error'): void;
  /** Actual accepted lifecycle only; stale server replies must not make audible success cues. */
  feedback?(event: 'asking' | 'ready' | 'stop' | 'idle'): void;
  /** hold-to-talk plumbing (voice/ptt.ts, local mode) */
  voice: {
    /** why the microphone cannot be used right now, or undefined */
    error(): string | undefined;
    /** false = no microphone path at all (hide the button) */
    available(): boolean;
    press(cardId: string): Promise<void>;
    release(): void;
    cancel(): void;
  };
  /** the right/left hand is working UI right now (a pinch is a press, not a pinch-tap) */
  tapBlocked(hand: 'left' | 'right'): boolean;
  /** The deliberate palm-recall hand remains available when the calibration fingertip withdraws. */
  menuHand?: 'left' | 'right';
  now?(): number;
  /** tests: stand-in sandbox */
  runtime?: WiringRuntime;
  /** tests: stand-in scene sandbox */
  sceneRuntime?: SceneRuntime;
}

interface Wiring {
  cardId: string; targetId: string; label: string;
  request: string; source: 'chip' | 'voice' | 'text';
  requestId: string;
  wiringId: string;
  phase: WirePhase;
  code: string; model: string; wireSource: 'live' | 'fixture' | 'template';
  phaseLine: string;
  title?: string; explanation?: string;
  program?: WiringProgram; needsScreen: boolean;
  runStartedAt?: number;
  stopped: boolean;
  askedAt: number;
  /** AR controls Muse generated for this wiring (knobs/buttons beside the device). */
  controls?: WireControl[];
  ui?: WireReadyPayload['ui'];
  visualizer?: WireReadyPayload['visualizer'];
  /** Muse's XR visualization for this wiring (runs in its own sandbox beside the hand program). */
  scene?: WireReadyPayload['scene'];
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** Saved screen planes from an earlier page load belong to another XR reference space: the first touch finds it again. */
const PAGE_LOADED = Date.now();

export class WiringController {
  readonly tracker = new SignalTracker();
  readonly calibrator = new ScreenCalibrator();
  /** The resting fingertip that fixes an automatic screen plane. */
  readonly finder = new ScreenTouchFinder();
  readonly runtime: WiringRuntime;
  /** Muse's XR scene sandbox and the hand/head signals it reads, in the scene's own frame. */
  readonly scene: SceneRuntime;
  private readonly sceneSignals = new SceneSignalBuilder();
  /** Latest value sent per action (controls and hand program): what a scene reads as s.values. */
  private values: Record<string, number> = {};
  private palmsSince: number | undefined;
  private readonly headForward = new Vector3();
  // Readiness broadcasts can belong to another/previous headset session. This
  // session starts accepting code only after its wearer explicitly asks.
  private acceptServerWiring = false;
  private readonly retiredWirings = new Set<string>();
  private w: Wiring | null = null;
  /** Values sent by generated AR controls (counts as use, like a hand program's outputs). */
  private controlSends = 0;
  private outgoing: WireOutputStream = { seq: 0, slots: Array.from({ length: 96 }, () => ({ seq: 0, actionId: '', value: 0, at: 0 })) };
  private recordOutput(actionId: string, value: number | boolean): void {
    const seq = ++this.outgoing.seq, e = this.outgoing.slots[(seq - 1) % this.outgoing.slots.length]!;
    e.seq = seq; e.actionId = actionId; e.value = value; e.at = this.now();
    this.values[actionId] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  private plane: ScreenPlane | null = null;
  /** A screen program runs, but its screen is not found yet: the program sees no screen until the first touch. */
  private screenPending = false;
  private screenGuess: ScreenGuess | null = null;
  /** The guessed, unconfirmed plane (never given to the program). */
  private autoPlane: ScreenPlane | null = null;
  private outlineMessage = 'Screen calibrated';
  private mic: 'idle' | 'listening' | 'busy' = 'idle';
  private micStartedAt = 0;
  private micTimer?: ReturnType<typeof setTimeout>;
  private voiceId: string | undefined;
  private calibrationOutline: [number, number, number][] | undefined;
  private outlineUntil = 0;
  private lastRender = -Infinity;
  private dirty = true;
  private lastBusy = false;
  private lastCardId: string | undefined;
  private readonly corners: (Vector3 | null)[] = [null, null];
  /** Current measured contact, exposed only for tutorial/debug observation. */
  private screenTouching = false;
  /** The fingertip on the screen for the HUD's small live panel (shared by reference, updated every frame). */
  private readonly live: WireLiveScreen = { found: false, near: false, touching: false, u: 0.5, v: 0.5 };

  constructor(private readonly host: WiringHost) {
    this.runtime = host.runtime ?? new WiringRuntime({
      send: (event, program) => {
        const ok = this.host.sendControl(program.cardId, { ...event, wiringId: program.wiringId, ...(program.requestId ? { requestId: program.requestId } : {}) });
        if (ok) this.recordOutput(event.widgetId.replace(/^wire:/, ''), event.value);
        return ok;
      },
      onStop: (reason, kind) => this.onRuntimeStop(reason, kind),
    });
    this.scene = host.sceneRuntime ?? new SceneRuntime({ onStop: (reason, kind) => this.onSceneStop(reason, kind) });
  }

  private now(): number { return this.host.now ? this.host.now() : performance.now(); }

  // --- public state ------------------------------------------------------------------------------------------------

  get phase(): WirePhase { return this.w?.phase ?? 'idle'; }
  get running(): boolean { return this.w?.phase === 'running' && this.runtime.running; }
  get request(): string | undefined { return this.w?.request; }
  /** Debug/test view of the whole thing. */
  snapshot(): Record<string, unknown> {
    const w = this.w;
    return { phase: this.phase, request: w?.request, requestId: w?.requestId, wiringId: w?.wiringId, title: w?.title, model: w?.model, source: w?.wireSource, codeChars: w?.code.length,
      running: this.running, calibrated: !!this.plane, needsScreen: w?.needsScreen ?? false,
      screen: !w?.needsScreen ? 'none' : this.screenPending ? (this.autoPlane ? 'guessed' : 'waiting') : this.plane ? (this.plane.auto ? 'found' : 'calibrated') : 'none',
      plane: (this.screenPending ? this.autoPlane : this.plane) ?? undefined,
      touching: this.running && this.screenTouching, mic: this.mic, stats: { ...this.runtime.stats, sent: (this.runtime.stats.sent ?? 0) + this.controlSends }, step: this.calibrator.step,
      controls: w?.controls?.length ?? 0, instrument: w?.ui?.controls.length ?? 0, visualizerEvents: this.outgoing.seq,
      scene: w?.scene ? { title: w.scene.title, running: this.scene.running, ...this.scene.stats, counts: { ...this.scene.view.counts }, placed: this.scene.view.placed } : undefined };
  }

  // --- asking -----------------------------------------------------------------------------------------------------

  /** A chip, a transcript or typed text. Nothing is wired until Muse answers and the program is running. */
  ask(text: string, source: 'chip' | 'voice' | 'text'): boolean {
    const sel = this.host.selected();
    const request = text.trim();
    if (!sel || !request) return false;
    if (request.length > 500) {
      this.host.toast('That request is too long. Ask in one or two sentences.', 'warn');
      return false;
    }
    if (!this.host.canControl(sel.cardId)) { this.host.toast('Set up this device first, then tell it what your hands should do', 'info'); return false; }
    this.cancelVoice();
    this.retireCurrent();
    this.acceptServerWiring = true;
    // A new request replaces whatever was wired: the hands go quiet until the new program is ready and running.
    if (this.runtime.running) this.runtime.stop('asking Muse for something new', 'external', true);
    if (this.scene.running) this.scene.stop('asking Muse for something new', 'external');
    this.calibrator.reset(); this.corners[0] = this.corners[1] = null; this.calibrationOutline = undefined;
    this.clearScreenSearch();
    const requestId = newId('wire-request');
    if (!this.host.send('wire.request', { cardId: sel.cardId, text: request, source, requestId })) {
      this.host.toast('Not connected to the server. Try again in a moment.', 'warn');
      this.w = null; this.changed();
      return false;
    }
    this.w = { cardId: sel.cardId, targetId: sel.targetId, label: sel.label, request, requestId, source, wiringId: '', phase: 'asked', code: '', model: '', wireSource: 'live', phaseLine: 'sent to Muse…',
      needsScreen: false, stopped: false, askedAt: this.now() };
    this.host.log(`wire.request (${source}): "${request}" for ${sel.cardId}`, 'info');
    this.host.feedback?.('asking');
    this.changed();
    return true;
  }

  // --- server messages --------------------------------------------------------------------------------------------

  onProgress(p: WireProgressPayload): void {
    const sel = this.host.selected();
    const w = this.w;
    if (!this.acceptServerWiring || !w || w.cardId !== p.cardId || p.requestId !== w.requestId || this.retiredWirings.has(p.wiringId) || !sel || sel.cardId !== p.cardId || !this.host.canControl(p.cardId)) return;
    // A response already on the socket when a new request was sent must not
    // replace that new request before its first progress message arrives.
    if (w?.phase === 'asked' && p.request && p.request !== w.request) return;
    if (w.wiringId && p.wiringId !== w.wiringId && w.phase === 'running') { this.runtime.stop('a new program is being written', 'external', true); this.scene.stop('a new program is being written', 'external'); }
    if (w.wiringId !== p.wiringId) { w.wiringId = p.wiringId; w.code = ''; w.stopped = false; w.program = undefined; }
    if (p.request) w.request = p.request;
    w.model = p.model; w.wireSource = p.source;
    w.askedAt = this.now();
    if (p.code !== undefined) w.code = p.code;
    else if (p.codeDelta) w.code += p.codeDelta;
    if (p.title) w.title = p.title;
    if (p.explanation) w.explanation = p.explanation;
    switch (p.phase) {
      case 'writing': w.phase = 'writing'; w.phaseLine = p.note ?? 'writing…'; break;
      case 'validating': w.phase = 'validating'; w.phaseLine = p.note ?? 'validating…'; break;
      case 'dry-run': w.phase = 'dry-run'; w.phaseLine = p.note ?? 'dry-run…'; break;
      case 'verifying': w.phase = 'verifying'; w.phaseLine = p.note ?? 'verifying…'; break;
      case 'ready': if (w.phase !== 'running' && w.phase !== 'calibrating') { w.phase = 'ready'; w.phaseLine = p.note ?? 'ready'; } break;
      case 'failed': {
        w.phase = 'failed';
        const why = p.issues?.[0] ?? p.note ?? 'Muse could not finish it';
        w.phaseLine = why;
        this.host.toast(`Muse could not wire that: ${why}`, 'warn');
        break;
      }
    }
    this.host.feedback?.(p.phase === 'failed' || p.phase === 'ready' ? 'idle' : 'asking');
    this.changed();
  }

  onReady(p: WireReadyPayload): void {
    const sel = this.host.selected();
    const w = this.w;
    if (!this.acceptServerWiring || !w || w.cardId !== p.cardId || p.requestId !== w.requestId || this.retiredWirings.has(p.wiringId) || !sel || sel.cardId !== p.cardId || !this.host.canControl(p.cardId)) return;
    // Replayed readiness is a state snapshot, not another instruction to start
    // or recalibrate a program that already arrived.
    if (w?.program?.wiringId === p.wiringId) return;
    if (w.wiringId && w.wiringId !== p.wiringId && this.runtime.running) this.runtime.stop('a new program arrived', 'external', true);
    w.wiringId = p.wiringId; w.code = p.code || w.code; w.model = p.model; w.wireSource = p.source; w.title = p.title; w.explanation = p.explanation;
    w.needsScreen = !!p.code.trim() && p.needs.includes('screen');
    w.controls = p.controls?.length ? p.controls : undefined;
    w.ui = p.ui; w.visualizer = p.visualizer; this.outgoing.seq = 0;
    w.program = { wiringId: p.wiringId, requestId: w.requestId, cardId: p.cardId, code: p.code, title: p.title, explanation: p.explanation, model: p.model, source: p.source, actions: p.actions };
    w.scene = p.scene; this.values = {};
    w.stopped = false; w.phase = 'ready'; w.phaseLine = 'ready';
    // The scene starts with the wiring; it is placed in the room on the next frame.
    if (p.scene) { this.sceneSignals.reset(); this.scene.start({ wiringId: p.wiringId, cardId: p.cardId, title: p.scene.title, code: p.scene.code }); }
    else if (this.scene.running) this.scene.stop('a new program arrived', 'external');
    this.host.feedback?.('ready');
    this.host.log(`wire.ready "${p.title}" · ${p.model} · ${p.source} · ${p.actions.length} actions · ${p.controls?.length ?? 0} controls · needs ${p.needs.join(',') || 'hands'}`, 'ok');
    if (!p.code.trim()) {
      // AR controls only: nothing runs per frame; the knobs send their own values.
      this.collapsed = false;
      w.phase = 'running'; w.runStartedAt = this.now();
      this.host.toast(p.scene && !p.ui && !p.controls?.length ? `${p.title || 'Scene'} · in 3D in front of you` : `${p.title || 'Controls'} ready · ${p.ui ? 'touch or press to play' : 'pinch a knob and twist'}`, 'ok');
      this.changed();
      return;
    }
    this.clearScreenSearch();
    if (w.needsScreen) {
      // No setup step: a saved plane, else a guess from the detected screen that the first touch fixes.
      const guess = this.screenGuess = this.guessScreen(sel);
      this.plane = loadPlane(w.cardId, guess.position, undefined, PAGE_LOADED);
      if (!this.plane) { this.screenPending = true; this.finder.reset(); }
    }
    this.start();
  }

  private guessScreen(sel: NonNullable<ReturnType<WiringHost['selected']>>): ScreenGuess {
    return this.host.screen?.() ?? { position: sel.anchor.clone(), label: sel.label, measured: false };
  }

  private clearScreenSearch(): void {
    this.screenPending = false; this.autoPlane = null; this.finder.reset();
  }

  /** What the wearer is asked to do while the screen is not found yet. */
  private touchHint(): string {
    const w = this.w;
    return this.host.selected()?.instrument === 'visual-synth' || /water|ripple|splash/i.test(w?.request ?? '') || /water/i.test(w?.title ?? '')
      ? 'Touch the water on your screen' : 'Touch your screen';
  }

  // --- running ------------------------------------------------------------------------------------------------------

  private start(): void {
    const w = this.w;
    if (!w?.program) return;
    const err = this.runtime.start(w.program);
    if (err) {
      // the runtime has already told onRuntimeStop
      return;
    }
    this.tracker.reset(this.now());
    this.collapsed = false;
    w.phase = 'running'; w.runStartedAt = this.now(); w.stopped = false;
    this.host.toast(this.screenPending ? this.touchHint() : `${w.title || 'Wiring'} is running`, 'ok');
    this.changed();
  }

  /** A generated AR control moved: send its value to the connector, like a hand program output. */
  control(actionId: string, value: number | boolean, phase: 'start' | 'move' | 'end'): boolean {
    const w = this.w;
    if (!w || w.phase !== 'running' || !w.program || !w.program.actions.some((a) => a.actionId === actionId) || !this.acceptServerWiring) return false;
    if (phase === 'start') return true;
    this.controlSends++;
    const sent = this.host.sendControl(w.cardId, { widgetId: `wire:${actionId}`, value, phase, requestId: w.requestId, ...(w.wiringId ? { wiringId: w.wiringId } : {}) });
    if (sent) this.recordOutput(actionId, value);
    return sent;
  }

  /** The wearer (or the app) stops the wiring. Safe at any time. */
  stop(reason: string, kind: StopKind = 'user'): void {
    const w = this.w;
    const alreadyStopped = !this.acceptServerWiring;
    this.host.feedback?.(kind === 'user' && !alreadyStopped && w ? 'stop' : 'idle');
    this.acceptServerWiring = false;
    this.retireCurrent();
    if (this.scene.running) this.scene.stop(reason, 'external');
    if (!w) return;
    if (w.phase === 'calibrating') { this.cancelCalibration(); w.phase = 'stopped'; w.stopped = true; this.changed(); }
    // The server releases this request's outputs. Terminate a user-stopped worker
    // immediately so an asynchronous final result cannot leak into an ask-again.
    else if (this.runtime.running) this.runtime.stop(reason, kind, kind !== 'user');
    else { w.phase = 'stopped'; w.stopped = true; w.phaseLine = reason; this.changed(); }
    if (kind === 'user' && !alreadyStopped) this.host.userStopped?.(reason, {
      cardId: w.cardId, requestId: w.requestId, ...(w.wiringId ? { wiringId: w.wiringId } : {}),
    });
  }

  /** A scoped server receipt may explain release, but can never change a newer request. */
  onStopped(p: WireStoppedPayload): void {
    const w = this.w;
    if (!w || p.cardId !== w.cardId || p.requestId !== w.requestId
      || p.wiringId && w.wiringId && p.wiringId !== w.wiringId) return;
    if (p.ok && w.phase !== 'stopped' && w.phase !== 'failed') this.stop(p.reason ?? 'Wiring stopped by the server', 'external');
    if (!p.ok || p.releaseConfirmed === false) {
      this.host.toast(p.reason || 'Wiring stopped locally; device release was not confirmed.', 'warn');
    }
  }

  /** Disconnect, deselect, leaving Control: stop quietly and forget the card. */
  reset(reason = 'reset', invalidatePlane = false): void {
    this.host.feedback?.('idle');
    if (invalidatePlane) {
      const cardId = this.w?.cardId ?? this.host.selected()?.cardId;
      if (cardId) clearPlane(cardId);
      this.plane = null;
    }
    this.acceptServerWiring = false;
    this.retireCurrent();
    this.cancelVoice();
    if (this.runtime.running) this.runtime.stop(reason, 'external', false);
    if (this.scene.running) this.scene.stop(reason, 'external');
    this.cancelCalibration();
    this.clearScreenSearch();
    this.w = null; this.host.setHandsBusy(false); this.lastBusy = false;
    this.changed();
  }

  private retireCurrent(): void {
    if (!this.w?.wiringId) return;
    this.retiredWirings.add(this.w.wiringId);
    if (this.retiredWirings.size > 32) this.retiredWirings.delete(this.retiredWirings.values().next().value!);
  }

  /** The scene sandbox stopped on its own (it threw, overran, hung): say so; a scene-only wiring is over. */
  private onSceneStop(reason: string, kind: StopKind): void {
    if (kind === 'external' || kind === 'user' || reason === 'replaced') return;
    const w = this.w;
    this.host.toast(`Muse's 3D scene stopped: ${reason}`, 'warn');
    this.host.log(`scene stopped (${kind}): ${reason}`, 'warn');
    if (w && w.phase === 'running' && !w.program?.code.trim() && !w.controls?.length && !w.ui && this.acceptServerWiring) {
      w.phase = 'failed'; w.stopped = true; w.phaseLine = reason;
      this.acceptServerWiring = false;
      this.retireCurrent();
      this.host.userStopped?.(reason, { cardId: w.cardId, requestId: w.requestId, ...(w.wiringId ? { wiringId: w.wiringId } : {}) });
    }
    this.changed();
  }

  private onRuntimeStop(reason: string, kind: StopKind): void {
    this.host.feedback?.('idle');
    const w = this.w;
    this.host.setHandsBusy(false); this.lastBusy = false;
    if (!w) return;
    if (reason === 'replaced' || kind === 'external') { if (w.phase === 'running') { w.phase = 'stopped'; w.stopped = true; } this.changed(); return; }
    // A failed hand program ends the whole wiring, scene included.
    if (kind !== 'user' && this.scene.running) this.scene.stop(reason, 'external');
    w.phase = kind === 'user' ? 'stopped' : 'failed';
    w.stopped = true;
    w.phaseLine = kind === 'user' ? 'stopped' : reason;
    // A failed sandbox cannot produce a reliable final lift. Revoke and release
    // its exact request once, without turning a failure into a user Stop or
    // disarming the selected device. External replacements/full Stop own their
    // own server lifecycle and must never retire a newer request here.
    if (kind !== 'user' && this.acceptServerWiring) {
      this.acceptServerWiring = false;
      this.retireCurrent();
      this.host.userStopped?.(reason, { cardId: w.cardId, requestId: w.requestId, ...(w.wiringId ? { wiringId: w.wiringId } : {}) });
    }
    if (kind === 'user') this.host.toast(`Wiring stopped · ${reason}`, 'info');
    else this.host.toast(`Muse's wiring stopped: ${reason}`, 'warn');
    this.host.log(`wiring stopped (${kind}): ${reason}`, kind === 'user' ? 'info' : 'warn');
    this.changed();
  }

  // --- screen calibration -------------------------------------------------------------------------------------------

  private beginCalibration(): void {
    const w = this.w;
    if (!w) return;
    this.calibrator.reset(); this.corners[0] = this.corners[1] = null; this.calibrationOutline = undefined;
    w.phase = 'calibrating'; w.phaseLine = 'calibrating…';
    this.host.toast('Move your fingertip to the top-left corner, then hold still', 'info');
  }

  private cancelCalibration(): void {
    this.calibrator.reset(); this.corners[0] = this.corners[1] = null;
  }

  /** "Recalibrate screen" in the card menu: the manual two-corner fallback. It never starts by itself. */
  recalibrate(): void {
    const w = this.w, sel = this.host.selected();
    if (!w || !sel || !w.program) return;
    clearPlane(w.cardId);
    this.plane = null;
    this.clearScreenSearch();
    this.screenGuess = this.guessScreen(sel);
    if (this.runtime.running) this.runtime.stop('recalibrating', 'external', true);
    this.beginCalibration();
    this.changed();
  }

  private calibrationView(): WireCalibrationView | undefined {
    const w = this.w;
    if (!w || w.phase !== 'calibrating') return undefined;
    const step = this.calibrator.step;
    return {
      step, progress: this.calibrator.progress,
      message: step === 'top-left' ? 'Move your fingertip to the top-left corner, then hold still' : 'Now touch the bottom-right corner',
      corners: this.corners.map((c) => (c ? [c.x, c.y, c.z] as [number, number, number] : null)),
      ...(this.calibrator.hasTip ? { tip: [this.calibrator.tip.x, this.calibrator.tip.y, this.calibrator.tip.z] as [number, number, number] } : {}),
      ...(this.calibrationOutline ? { outline: this.calibrationOutline } : {}),
    };
  }

  // --- per frame ---------------------------------------------------------------------------------------------------

  private lastControllable = false;
  frame(frame: ShellFrame, timeMs: number): void {
    this.screenTouching = false;
    const sel = this.host.selected();
    const w = this.w;
    // The card's ask section appears and disappears with "selected and under control"; redraw when that flips.
    const controllable = !!sel && this.host.canControl(sel.cardId);
    if (controllable !== this.lastControllable) { this.lastControllable = controllable; this.dirty = true; this.lastRender = -Infinity; }
    if (!sel || !this.host.canControl(sel.cardId)) {
      // Leaving Control (or deselecting) while Muse writes or the controls run must also stop the server side:
      // otherwise the agent run and its connector keep going with no UI left to stop them.
      if (w && this.acceptServerWiring && !['idle', 'stopped', 'failed'].includes(w.phase)) {
        this.host.userStopped?.('left Control', { cardId: w.cardId, requestId: w.requestId, ...(w.wiringId ? { wiringId: w.wiringId } : {}) });
      }
      if (w) this.reset('the device is not under control any more');
      this.setBusy(false);
      this.syncView(sel?.cardId);
      return;
    }
    if (w && w.cardId !== sel.cardId) {
      // Another device was selected: the wiring belongs to the old one.
      this.reset('another device was selected');
    }
    const cur = this.w;
    if (cur) {
      if (cur.phase === 'asked' && this.now() - cur.askedAt > WIRE_TIMING.silenceMs) { cur.phase = 'failed'; cur.phaseLine = 'Muse did not answer'; this.host.feedback?.('idle'); this.host.toast('Muse did not answer in time. Try again.', 'warn'); this.changed(); }
      if (cur.phase === 'calibrating') this.calibrateFrame(frame, timeMs, this.screenGuess?.position ?? sel.anchor);
      else if (cur.phase === 'running') {
        if (cur.needsScreen && this.runtime.running) this.findScreen(frame, timeMs);
        const sf = this.tracker.update(frame, timeMs, { plane: this.screenPending ? null : this.plane, tapBlocked: (hand) => this.host.tapBlocked(hand) });
        this.screenTouching = !!sf.signals.screen?.touching;
        const screen = sf.signals.screen;
        this.live.found = !this.screenPending && !!this.plane;
        this.live.near = !!screen && screen.hover > 0; this.live.touching = this.screenTouching;
        if (screen) { this.live.u = clamp(screen.u, 0, 1); this.live.v = clamp(screen.v, 0, 1); }
        // Both palms out stops, but not while the hands are playing AR controls (two flat hands on a pad look alike).
        // A scene invites pushing with open palms, so while one runs the palms must also be held still for a moment.
        let stopNow = false;
        const free = !this.host.tapBlocked('left') && !this.host.tapBlocked('right');
        if (!this.scene.running) stopNow = sf.stop && free;
        else if (free && !!sf.signals.right?.palmOut && !!sf.signals.left?.palmOut) {
          const still = (sf.signals.right?.speed ?? 1) < 0.25 && (sf.signals.left?.speed ?? 1) < 0.25;
          if (!still || this.palmsSince === undefined) this.palmsSince = this.now();
          else stopNow = this.now() - this.palmsSince >= 900;
        } else this.palmsSince = undefined;
        if (stopNow) this.stop('both palms out', 'user');
        else {
          this.runtime.tick(sf.signals);
          if (this.scene.running) {
            if (!this.sceneSignals.placed) {
              this.headForward.set(0, 0, -1).applyQuaternion(frame.head.quaternion);
              this.sceneSignals.place(frame.head.position, this.headForward, sel.anchor, timeMs, !!cur.controls?.length || !!cur.ui);
              this.scene.setAnchor(this.sceneSignals.anchor, this.sceneSignals.yaw);
            }
            this.scene.tick(this.sceneSignals.build(frame, sf.signals, this.values, sel.anchor, timeMs));
          }
        }
        this.setBusy(this.runtime.running && (sf.rightInZone || sf.hovering || this.finder.near));
        if (cur.runStartedAt !== undefined && this.now() - cur.runStartedAt >= WIRE_TIMING.explainMs && !this.collapsed) { this.collapsed = true; this.changed(); }
      } else this.setBusy(false);
    } else this.setBusy(false);
    if (this.mic === 'listening' && this.now() - this.micStartedAt > WIRE_TIMING.maxListenMs) this.micRelease();
    this.syncView(sel.cardId);
  }

  private collapsed = false;

  /**
   * Before the first touch: a fingertip resting near the guessed plane (or, with no detected screen, anywhere within
   * reach ahead) was stopped by the glass, so the screen is there. Afterwards: a fingertip resting clearly behind an
   * automatic plane means the glass is farther, so the plane moves back to it.
   */
  private findScreen(frame: ShellFrame, timeMs: number): void {
    const w = this.w!, head = frame.head.position;
    if (this.screenPending) {
      const guess = this.screenGuess;
      if (!guess) { this.screenPending = false; return; }
      if (guess.measured && !this.autoPlane) this.autoPlane = autoScreenPlane(guess, head);
      const tip = this.finder.update(frame, timeMs, guess.measured ? this.autoPlane : null, 'first');
      if (!tip) return;
      const before = this.autoPlane ? planeCentre(this.autoPlane) : undefined;
      const plane = this.autoPlane ? confirmPlane(this.autoPlane, tip, head) : planeAtTouch(tip, head, guess.label, guess.position);
      this.useFoundPlane(w, plane, before ? `moved ${Math.round(planeCentre(plane).distanceTo(before) * 100)} cm from the guess` : 'placed at the touch');
    } else if (this.plane?.auto) {
      const tip = this.finder.update(frame, timeMs, this.plane, 'deeper');
      if (!tip) return;
      const before = planeCentre(this.plane);
      this.plane = confirmPlane(this.plane, tip, head);
      savePlane(w.cardId, this.plane);
      this.host.log(`screen plane moved back ${Math.round(planeCentre(this.plane).distanceTo(before) * 100)} cm: the fingertip rested behind it`, 'info');
    }
  }

  private useFoundPlane(w: Wiring, plane: ScreenPlane, how: string): void {
    this.plane = plane; this.autoPlane = null; this.screenPending = false; this.finder.reset();
    savePlane(w.cardId, plane);
    const at = (u: number, v: number) => { const p = planePoint(plane, u, v); return [p.x, p.y, p.z] as [number, number, number]; };
    this.calibrationOutline = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    this.outlineUntil = this.now() + 3000; this.outlineMessage = 'Found your screen';
    this.host.log(`screen found by the first touch (${how})`, 'ok');
    this.changed();
  }

  private calibrateFrame(frame: ShellFrame, timeMs: number, anchor: Vector3): void {
    const w = this.w!;
    const before = this.calibrator.step;
    const update = this.calibrator.update(frame, timeMs, anchor);
    // Block accidental recall while a fingertip is doing corner work, but not
    // merely because calibration is open. A withdrawn control hand plus the
    // deliberate menu palm must still give the wearer a recovery/Exit route.
    const menuHand = frame.hands[this.host.menuHand ?? 'left'];
    const menuTip = menuHand?.joints['index-finger-tip']?.position;
    const recallingMenu = !!menuHand?.palmUp && !!menuTip && menuTip.distanceToSquared(this.calibrator.tip) < 1e-8;
    // Once the first corner is known, it stays a screen point even while the
    // calibrator is looking elsewhere for the second corner.
    const topLeft = this.calibrator.topLeft;
    const nearCapturedCorner = !!topLeft && (['left', 'right'] as const).some(side => {
      const hand = frame.hands[side], tip = hand && !hand.controller ? hand.joints['index-finger-tip']?.position : undefined;
      return !!tip && tip.distanceTo(topLeft) < SIGNAL_RANGE.hoverRange;
    });
    this.setBusy(nearCapturedCorner || this.calibrator.hasTip && !recallingMenu);
    if (update.kind === 'corner') {
      this.corners[0] = update.point;
      this.host.toast('Got it. Now touch the bottom-right corner', 'ok');
      this.changed();
    } else if (update.kind === 'rejected') {
      this.corners[0] = this.corners[1] = null;
      this.host.toast(update.message, 'warn');
      this.changed();
    } else if (update.kind === 'done') {
      this.plane = update.plane;
      savePlane(w.cardId, update.plane);
      this.corners[1] = this.calibrator.tip.clone();
      const at = (u: number, v: number) => { const p = planePoint(update.plane, u, v); return [p.x, p.y, p.z] as [number, number, number]; };
      this.calibrationOutline = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
      this.outlineUntil = this.now() + 3000; this.outlineMessage = 'Screen calibrated';
      this.host.toast('Screen calibrated', 'ok');
      this.calibrator.reset();
      this.start();
      return;
    } else if (before !== this.calibrator.step) this.changed();
    this.dirty = true;
  }

  private setBusy(busy: boolean): void {
    if (busy === this.lastBusy) return;
    this.lastBusy = busy;
    this.host.setHandsBusy(busy);
  }

  // --- voice ---------------------------------------------------------------------------------------------------------

  /** Mic button pressed. A second press while listening sends. */
  micPress(): void {
    const sel = this.host.selected();
    if (!sel || !this.host.canControl(sel.cardId)) return;
    if (this.mic === 'listening') { this.micRelease(); return; }
    if (this.mic === 'busy') return;
    const err = this.host.voice.error();
    if (err) { this.host.toast(err, 'warn'); return; }
    this.mic = 'listening'; this.micStartedAt = this.now(); this.voiceId = undefined;
    this.changed();
    void this.host.voice.press(sel.cardId).catch(() => this.cancelVoice());
  }

  /** Mic button released: a hold sends, a tap keeps listening until the next press. */
  micLetGo(): void {
    if (this.mic !== 'listening') return;
    if (this.now() - this.micStartedAt >= WIRE_TIMING.holdMs) this.micRelease();
  }

  private micRelease(): void {
    if (this.mic !== 'listening') return;
    this.mic = 'busy'; this.changed();
    this.host.voice.release();
  }

  private cancelVoice(): void {
    if (this.mic === 'idle') return;
    this.mic = 'idle'; this.voiceId = undefined;
    clearTimeout(this.micTimer);
    this.host.voice.cancel();
    this.changed();
  }

  /** ptt 'listening' events: remember which utterance is ours. */
  onVoiceListening(listening: boolean, utteranceId?: string): void {
    if (this.mic === 'idle') return;
    if (listening) this.voiceId = utteranceId;
  }

  /** ptt 'text' events. */
  onVoiceText(text: string, utteranceId: string | undefined, final: boolean): void {
    if (this.mic === 'idle' || !final) return;
    if (this.voiceId && utteranceId && utteranceId !== this.voiceId) return;
    this.mic = 'idle'; this.voiceId = undefined;
    const said = text.trim();
    if (!said) { this.host.toast('I did not catch that. Hold the mic and try again.', 'info'); this.changed(); return; }
    this.host.toast(`Heard: "${said.slice(0, 60)}"`, 'info');
    if (!this.ask(said, 'voice')) this.changed();
  }

  onVoiceError(message: string): void {
    if (this.mic === 'idle') return;
    this.mic = 'idle'; this.voiceId = undefined;
    this.host.toast(message, 'warn');
    this.changed();
  }

  // --- view ------------------------------------------------------------------------------------------------------------

  private changed(): void {
    this.dirty = true;
    if (this.w?.phase !== 'running') this.collapsed = false;
    this.lastRender = -Infinity;
  }

  private syncView(cardId: string | undefined): void {
    const t = this.now();
    if (cardId !== this.lastCardId) { this.lastCardId = cardId; this.dirty = true; }
    const calibrating = this.w?.phase === 'calibrating';
    // streamed code arrives often: the card is refreshed at most ~12 Hz, calibration progress every frame
    if (!this.dirty && !calibrating) return;
    if (!calibrating && t - this.lastRender < 80) return;
    this.lastRender = t; this.dirty = false;
    this.host.render(cardId ? this.view(cardId) : null);
  }

  /** The prompt line and chips for the device card, and the code card, for the selected device. */
  view(cardId: string): WireView | null {
    const sel = this.host.selected();
    if (!sel || sel.cardId !== cardId || !this.host.canControl(cardId)) return null;
    const w = this.w && this.w.cardId === cardId ? this.w : null;
    const phase: WirePhase = w?.phase ?? 'idle';
    const busy = phase === 'asked' || phase === 'writing' || phase === 'validating' || phase === 'dry-run' || phase === 'verifying' || phase === 'calibrating';
    const prompt = !w ? 'What should your hands do?'
      : phase === 'asked' ? `Asking Muse: ${w.request}`
        : phase === 'calibrating' ? 'Touch your screen\'s two corners'
          : busy ? `Muse is wiring: ${w.request}`
            : phase === 'running' ? `${w.title || 'Wiring'} · running`
              : phase === 'failed' ? 'Could not wire that · try again'
                : phase === 'stopped' ? 'Stopped · ask again' : `${w.title || 'Wiring'} · ready`;
    const chips = busy ? [] : [...(sel.instrument === 'musical-synth' ? MUSICAL_WIRE_CHIPS
      : sel.instrument === 'visual-synth' ? WIRE_CHIPS : isLaptop(sel.label) ? LAPTOP_WIRE_CHIPS : PHYSICAL_WIRE_CHIPS),
    sel.instrument === 'visual-synth' ? VISUAL_SCENE_CHIP : SCENE_CHIP];
    const code: WireCodeView | undefined = w ? {
      wiringId: w.wiringId || 'pending', requestId: w.requestId, phase, model: w.model || 'Muse', source: w.wireSource, request: w.request, code: w.code, phaseLine: w.phaseLine,
      ...(w.title ? { title: w.title } : {}), ...(w.explanation ? { explanation: w.explanation } : {}),
      mode: (phase === 'running' && (this.collapsed || !!w?.ui || !!w?.controls?.length)) || phase === 'stopped' ? 'pill' : 'full', stopped: w.stopped,
    } : undefined;
    const calibration = this.calibrationView();
    if (this.calibrationOutline && this.now() > this.outlineUntil) this.calibrationOutline = undefined;
    const outline = this.calibrationOutline && this.now() <= this.outlineUntil ? this.calibrationOutline : undefined;
    return {
      targetId: sel.targetId, phase, prompt, chips: chips as string[], ...(w?.request && !busy && w.source === 'chip' ? { activeChip: w.request } : {}),
      mic: this.host.voice.available() ? this.mic : 'off',
      ...(code ? { code } : {}),
      ...(calibration ? { calibration } : outline ? { calibration: { step: 'bottom-right' as const, progress: 1, message: this.outlineMessage, corners: [], outline } } : {}),
      ...(phase === 'running' && this.screenPending ? { touchHint: this.touchHint() } : {}),
      canRecalibrate: !!w?.needsScreen && !!w.program && (phase === 'running' || phase === 'stopped' || phase === 'ready'),
      ...(w?.controls && phase === 'running' ? { controls: w.controls } : {}),
      ...(w?.ui && phase === 'running' ? { ui: w.ui, visualizer: w.visualizer, outgoing: this.outgoing } : {}),
      ...(w?.scene && phase === 'running' ? { scene: this.scene.view } : {}),
      ...(w?.needsScreen && w.program && phase === 'running' ? { screenProgram: { live: this.live, actions: w.program.actions, ...(w.title ? { title: w.title } : {}) }, outgoing: this.outgoing } : {}),
    };
  }

  /** For the HUD's own chip ids. */
  chipText(index: number): string | undefined {
    const instrument = this.host.selected()?.instrument;
    const chips = instrument === 'musical-synth' ? MUSICAL_WIRE_CHIPS
      : instrument === 'visual-synth' ? WIRE_CHIPS : PHYSICAL_WIRE_CHIPS;
    return chips[clamp(index, 0, chips.length - 1)];
  }
}
