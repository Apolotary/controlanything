import { Vector3, type Object3D } from 'three';
import type { ShellFrame } from '../app/hud-contract';
import { TutorialBubble } from './bubble';
import { STEP_IDS, TUTORIAL_KEY, TutorialSteps, type StepId, type TutorialProbe } from './steps';

export interface TutorialHost {
  parent: Object3D;
  probe(): TutorialProbe;
  /** Existing UI/device world anchor, never a new control or detection. */
  anchor(step: StepId): Vector3 | undefined;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** One quiet bubble. Progress is driven by measured app state, never scripted demo actions. */
export class TutorialController {
  readonly steps = new TutorialSteps();
  readonly bubble: TutorialBubble;
  private probe?: TutorialProbe;
  private lastProbeAt = -Infinity;
  private placedStep?: StepId;
  private stored = false;
  private readonly offset = new Vector3();

  constructor(private readonly host: TutorialHost) {
    this.bubble = new TutorialBubble(() => this.skip());
    host.parent.add(this.bubble);
    try { if (host.storage?.getItem(TUTORIAL_KEY)) { this.steps.skip(); this.stored = true; } } catch { /* Private browsing: this session still works. */ }
  }

  replay(): void {
    this.steps.restart(); this.placedStep = undefined; this.lastProbeAt = -Infinity; this.stored = false;
    this.bubble.hideNow();
  }
  skip(): void { this.steps.skip(); this.bubble.hideNow(); this.remember('skipped'); }
  private remember(result: 'completed' | 'skipped'): void {
    if (this.stored) return;
    this.stored = true;
    try { this.host.storage?.setItem(TUTORIAL_KEY, result); } catch { /* Storage is optional. */ }
  }

  frame(frame: ShellFrame, dtSec: number, timeMs: number): void {
    if (this.steps.finished) { if (!this.bubble.hidden) this.bubble.hideNow(); return; }
    if (timeMs - this.lastProbeAt >= 100 || !this.probe) {
      this.lastProbeAt = timeMs; this.probe = this.host.probe();
      this.steps.update(this.probe, timeMs);
      if (this.steps.finished) { this.bubble.hideNow(); this.remember('completed'); return; }
      const view = this.steps.view(this.probe, timeMs), step = this.steps.step;
      if (!view || !step) this.bubble.hideNow();
      else {
        this.bubble.set({ ...view, counter: `${this.steps.index + 1}/${STEP_IDS.length}`, tail: step === 'pinch' ? 'right' : 'none' });
        if (step !== this.placedStep || !this.bubble.shown) this.place(step, frame);
        this.bubble.show();
      }
    }
    this.bubble.update(Math.min(.1, Math.max(0, dtSec)) * 1000);
  }

  private place(step: StepId, frame: ShellFrame): void {
    this.placedStep = step;
    const anchor = step === 'pinch' ? this.host.anchor(step) : undefined;
    if (anchor) {
      this.bubble.position.copy(anchor);
      this.bubble.position.add(this.offset.set(-.27, .06, .04).applyQuaternion(frame.head.quaternion));
    } else {
      // Beside the central task, leaving the code, calibration prompt and screen unobscured.
      const height = ['wiring', 'calibrate', 'touch'].includes(step) ? .26 : .13;
      this.bubble.position.copy(frame.head.position).add(this.offset.set(-.28, height, -.62).applyQuaternion(frame.head.quaternion));
    }
    this.bubble.quaternion.copy(frame.head.quaternion);
    this.bubble.updateMatrixWorld(true);
  }

  snapshot(): { step?: StepId; finished: boolean; visible: boolean } {
    return { step: this.steps.step, finished: this.steps.finished, visible: this.bubble.visible };
  }
  dispose(): void { this.bubble.dispose(); }
}
