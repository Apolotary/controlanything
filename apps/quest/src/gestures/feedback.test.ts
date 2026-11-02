import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Mesh, Quaternion, Scene, Vector3 } from 'three';
import type { ShellFrame, ShellHand } from '../app/hud-contract';
import { GestureFeedback, type GestureFeedbackState } from './feedback';

function frame(time = 0): ShellFrame {
  const hand = (x: number): ShellHand => ({
    joints: { wrist: { position: new Vector3(x, 1, -0.5), quaternion: new Quaternion(), radius: 0.01 } },
    ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) }, pinchPoint: new Vector3(),
    controller: false, palmUp: false, palmUpMs: 0, pinching: false, justPinched: false, justReleased: false,
  });
  return { time, dt: 1 / 90, head: { position: new Vector3(0, 1.4, 0), quaternion: new Quaternion(), ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) } }, hands: { left: hand(-0.2), right: hand(0.2) } };
}
const state = (engaged: boolean, value = 25): GestureFeedbackState => ({ engaged, axes: [{ axis: 'right_height', actionId: 'visual_warp', label: 'Warp', value, normalized: value / 100 }] });

describe('performance feedback', () => {
  it('anchors three renderables near the hands and hides everything when Perform ends', () => {
    const scene = new Scene(), feedback = new GestureFeedback(scene), f = frame();
    expect(feedback.root.visible).toBe(false);
    feedback.update(f, state(false));
    const status = feedback.root.getObjectByName('gesture-live') as Mesh & { text: string };
    expect(status.text).toBe('Hold left fist');
    expect(status.position.x).toBeCloseTo(-0.25);
    expect(feedback.root.getObjectByName('gesture-ribbons')!.position.x).toBeCloseTo(0.33);
    let draws = 0; feedback.root.traverseVisible((node) => { if ((node as Mesh).isMesh) draws++; });
    expect(draws).toBe(3);
    feedback.update(f, state(true)); expect(status.text).toBe('LIVE');
    feedback.update(f, state(false)); expect(status.text).toBe('Frozen · Hold left fist');
    feedback.update(f, null); expect(feedback.root.visible).toBe(false);
    feedback.dispose(); expect(scene.children).toHaveLength(0);
  });

  it('moves meters at frame rate while throttling numeric labels and reusing geometry', () => {
    const feedback = new GestureFeedback(new Scene()), f = frame();
    feedback.update(f, state(true));
    const labels = feedback.root.getObjectByName('gesture-axis-labels') as Mesh & { text: string };
    const bars = feedback.root.getObjectByName('gesture-meters') as InstancedMesh;
    const geometry = bars.geometry, matrix = new Matrix4();
    expect(labels.text).toBe('Warp  25');
    f.time = 50; feedback.update(f, state(true, 75)); bars.getMatrixAt(2, matrix);
    expect(matrix.elements[0]).toBeCloseTo((0.22 - 0.018) * 0.75);
    expect(labels.text).toBe('Warp  25');
    f.time = 200; feedback.update(f, state(true, 75));
    expect(labels.text).toBe('Warp  75'); expect(bars.geometry).toBe(geometry);
    feedback.dispose();
  });
});
