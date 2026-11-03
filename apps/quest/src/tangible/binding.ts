/**
 * Object motion → control values. Two axes, both relative to where the object was when it was bound (or
 * re-found), so binding never makes a value jump:
 *   lift  — world height change; LIFT_M of travel sweeps the whole range (default: the device's Warp)
 *   slide — change along the wearer's right at bind time, horizontal; SLIDE_M sweeps the range (Ripples)
 * Past either end the origin ratchets along, so moving back responds at once. Values are quantised to the
 * control's step (MIDI 0–127 → 1) and a small dead band keeps a still object from chattering.
 */
import { Vector3 } from 'three';
import type { Control } from '@ce/gen3d';

export type TangibleAxis = 'lift' | 'slide';

export interface AxisBinding {
  axis: TangibleAxis;
  controlId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 0..1 */
  fraction: number;
  /** last value handed to the control path */
  sent: number;
}

export const LIFT_M = 0.22;
export const SLIDE_M = 0.3;
const DEAD = 0.004;

const continuous = (c: Control) => c.armed !== false && (c.kind === 'continuous' || c.kind === 'stepped');

/** Pick the device's verified continuous controls for lift and slide (Warp / Water ripples on the visual synth). */
export function chooseControls(controls: readonly Control[]): { lift?: Control; slide?: Control } {
  const usable = controls.filter(continuous);
  const lift = usable.find((c) => /warp/i.test(`${c.id} ${c.label}`)) ?? usable[0];
  const slide = usable.find((c) => c !== lift && /ripple|water/i.test(`${c.id} ${c.label}`)) ?? usable.find((c) => c !== lift);
  return { lift, slide };
}

export const shortLabel = (label: string) => {
  const l = label.trim();
  if (/ripple|water/i.test(l)) return 'Ripples';
  return l.length > 10 ? l.slice(0, 10) : l.charAt(0) + l.slice(1).toLowerCase();
};

export class MotionBinding {
  readonly axes: AxisBinding[] = [];
  readonly origin = new Vector3();
  readonly right = new Vector3(1, 0, 0);
  private readonly base: number[] = [];
  private readonly d = new Vector3();

  /** Bind controls; `current` gives each control's present value (no jump on bind). */
  configure(controls: { axis: TangibleAxis; control: Control }[], current: (controlId: string) => number | undefined): void {
    this.axes.length = 0;
    for (const { axis, control } of controls) {
      const min = control.range?.min ?? 0, max = control.range?.max ?? 1;
      const span = max - min || 1;
      const now = current(control.id) ?? (typeof control.default === 'number' ? control.default : min + span / 2);
      const step = control.range?.step ?? (span >= 16 ? 1 : 0);
      const fraction = Math.min(1, Math.max(0, (now - min) / span));
      this.axes.push({ axis, controlId: control.id, label: shortLabel(control.label), min, max, step, fraction, sent: NaN });
    }
  }

  /** Re-anchor at `pos`: the current fractions continue from here. `forward` = the wearer's view direction. */
  rebase(pos: Vector3, forward?: Vector3): void {
    this.origin.copy(pos);
    if (forward) {
      // right = forward × up, kept horizontal
      this.right.set(-forward.z, 0, forward.x);
      if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
      this.right.normalize();
    }
    this.base.length = 0;
    for (const a of this.axes) this.base.push(a.fraction);
  }

  /** New object position → fractions. True when any value moved past the dead band. */
  update(pos: Vector3): boolean {
    const d = this.d.copy(pos).sub(this.origin);
    let changed = false;
    for (let i = 0; i < this.axes.length; i++) {
      const a = this.axes[i]!;
      const travel = a.axis === 'lift' ? d.y / LIFT_M : d.dot(this.right) / SLIDE_M;
      let f = (this.base[i] ?? a.fraction) + travel;
      // ratchet: past an end, drag the origin along so the way back responds immediately
      if (f > 1 || f < 0) {
        const over = f > 1 ? f - 1 : f;
        if (a.axis === 'lift') this.origin.y += over * LIFT_M;
        else this.origin.addScaledVector(this.right, over * SLIDE_M);
        f = f > 1 ? 1 : 0;
      }
      if (Math.abs(f - a.fraction) >= DEAD || (f === 0 || f === 1) && f !== a.fraction) { a.fraction = f; changed = true; }
    }
    return changed;
  }

  value(a: AxisBinding): number {
    const v = a.min + a.fraction * (a.max - a.min);
    return a.step > 0 ? Math.round(v / a.step) * a.step : Math.round(v * 1000) / 1000;
  }
}
