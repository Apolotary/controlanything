import { describe, expect, it } from 'vitest';
import { Mesh, Quaternion, Scene, Vector3 } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { GestureFeedback, liveGesture, type GestureFeedbackState } from './feedback';

function frame(time = 0): ShellFrame {
  const hand = (x: number): ShellHand => ({
    joints: { wrist: { position: new Vector3(x, 1, -0.5), quaternion: new Quaternion(), radius: 0.01 } },
    ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) }, pinchPoint: new Vector3(),
    controller: false, palmUp: false, palmUpMs: 0, pinching: false, justPinched: false, justReleased: false,
  });
  return { time, dt: 1000 / 90, head: { position: new Vector3(0, 1.4, 0), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } }, hands: { left: hand(-0.2), right: hand(0.2) } };
}
const state = (engaged: boolean, value = 25): GestureFeedbackState => ({ engaged, axes: [{ axis: 'right_height', actionId: 'cc71', label: 'Warp', value, normalized: value / 100 }] });

describe('performance feedback', () => {
  it('shows a clutch ring, a value ring and a short hint, and publishes live values', () => {
    const scene = new Scene(), feedback = new GestureFeedback(scene), f = frame();
    expect(feedback.root.visible).toBe(false);
    feedback.update(f, state(false));
    const status = feedback.root.getObjectByName('gesture-live') as Mesh & { text: string };
    expect(status.text).toBe('Hold left fist');
    let draws = 0; feedback.root.traverseVisible((node) => { if ((node as Mesh).isMesh) draws++; });
    expect(draws).toBeLessThanOrEqual(3);
    feedback.update(f, state(true, 60));
    expect(liveGesture.engaged).toBe(true);
    expect(liveGesture.values.get('cc71')).toBeCloseTo(0.6);
    feedback.update(f, null); expect(feedback.root.visible).toBe(false);
    feedback.dispose(); expect(scene.children).toHaveLength(0);
  });
});
