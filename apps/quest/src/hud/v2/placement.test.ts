import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import type { Hud, HudTarget } from '../contract';
import { createHud } from './index';

const UP = new Vector3(0, 1, 0);
const target: HudTarget = {
  id: 'lamp', tagged: true, connection: 'ready', label: 'Ceiling light', status: 'scanned', position: [0.4, 2.4, -3],
  confirmed: true, facing: [0, 0, 1], sizeM: [0.3, 0.2, 0.05],
};
const instances: Hud[] = [];

function setup(kind: 'idle' | 'dock' | 'modal' = 'idle') {
  const camera = new PerspectiveCamera();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
  instances.push(hud);
  hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a device' });
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  if (kind === 'dock') { hud.upsertTarget(target); hud.setLocked(target.id); }
  if (kind === 'modal') hud.showConfirm({ id: 'allow', title: 'Allow device control' });
  const panel = hud.root.getObjectByName(kind === 'modal' ? 'confirmation-panel' : kind === 'idle' ? 'home-bar' : 'device-card')!;
  const update = (time: number) => hud.update({ time, dt: 1 / 72, head, hands: {} });
  return { hud, head, panel, update };
}

afterEach(() => { for (const hud of instances.splice(0)) hud.dispose(); });

describe('HUD world placement', () => {
  it('uses the first frame pose instead of the constructor camera pose', () => {
    const { head, panel, update } = setup();
    head.position.set(2, 1.75, 3);
    head.quaternion.setFromAxisAngle(UP, Math.PI / 4);
    update(0);
    const expected = new Vector3(0, -0.4, -0.6).applyQuaternion(head.quaternion).add(head.position);
    expect(panel.position.distanceTo(expected)).toBeLessThan(1e-6);
    expect(panel.quaternion.angleTo(head.quaternion)).toBeLessThan(1e-6);
  });

  it.each(['idle', 'dock', 'modal'] as const)('keeps the %s panel fixed during short looks away and small head movements', (kind) => {
    const { head, panel, update } = setup(kind);
    update(0);
    const position = panel.position.clone(), rotation = panel.quaternion.clone();
    head.position.x = 0.1;
    head.quaternion.setFromAxisAngle(UP, 0.15);
    update(100);
    update(2000);
    expect(panel.position.equals(position)).toBe(true);
    expect(panel.quaternion.equals(rotation)).toBe(true);
    head.quaternion.setFromAxisAngle(UP, Math.PI / 2);
    update(2100);
    update(3600);
    expect(panel.position.equals(position)).toBe(true);
    expect(panel.quaternion.equals(rotation)).toBe(true);
    head.quaternion.identity();
    update(3601);
    update(5000);
    expect(panel.position.equals(position)).toBe(true);
    expect(panel.quaternion.equals(rotation)).toBe(true);
  });

  it.each(['idle', 'dock', 'modal'] as const)('recentres the %s panel after a sustained look away without chasing the head during the transition', (kind) => {
    const { head, panel, update } = setup(kind);
    update(0);
    const position = panel.position.clone();
    head.quaternion.setFromAxisAngle(UP, Math.PI / 2);
    update(100);
    update(1600);
    expect(panel.position.equals(position)).toBe(true);
    update(1601);
    expect(panel.position.equals(position)).toBe(true);
    head.position.x = 0.1;
    head.quaternion.setFromAxisAngle(UP, Math.PI);
    update(1751);
    expect(panel.position.x).toBeCloseTo(-0.3);
    expect(panel.position.z).toBeCloseTo(-0.3);
    update(1901);
    expect(panel.position.x).toBeCloseTo(-0.6);
    expect(panel.position.z).toBeCloseTo(0);
    expect(panel.quaternion.angleTo(new Quaternion().setFromAxisAngle(UP, Math.PI / 2))).toBeLessThan(1e-6);
  });

  it('smoothly recentres the idle card after a step exceeds .75m', () => {
    const { head, panel, update } = setup();
    update(0);
    head.position.x = 0.75;
    update(100);
    expect(panel.position.x).toBe(0);
    head.position.x = 0.8;
    update(200);
    expect(panel.position.x).toBe(0);
    update(350);
    expect(panel.position.x).toBeCloseTo(0.4);
    update(500);
    expect(panel.position.x).toBeCloseTo(0.8);
    expect(panel.position.z).toBeCloseTo(-0.6);
  });

  it('holds the dock across head movement, target updates and arming, then anchors a newly selected target', () => {
    const { hud, head, panel, update } = setup('dock');
    const spec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'lamp-controls', state: { armed: false } };
    hud.renderSpec(spec, { targetId: target.id });
    update(0);
    const position = panel.position.clone(), rotation = panel.quaternion.clone();
    head.position.x = 0.15;
    head.quaternion.setFromAxisAngle(UP, Math.PI / 4);
    update(100);
    hud.upsertTarget({ ...target, position: [0.1, 1.6, -0.2], status: 'verified' });
    hud.setArmed(spec.specId, true);
    hud.setLocked(target.id);
    update(300);
    expect(panel.position.equals(position)).toBe(true);
    expect(panel.quaternion.equals(rotation)).toBe(true);
    const next = { ...target, id: 'second-lamp', position: [2, 2.4, -3] as [number, number, number] };
    hud.upsertTarget(next);
    hud.setLocked(next.id);
    update(400);
    const expected = new Vector3(0, -0.14, -0.6).applyQuaternion(head.quaternion).add(head.position);
    expect(panel.position.distanceTo(expected)).toBeLessThan(1e-6);
    expect(panel.quaternion.angleTo(head.quaternion)).toBeLessThan(1e-6);
  });
});
