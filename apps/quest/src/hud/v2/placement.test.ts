import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import type { Hud, HudTarget } from '../contract';
import { createHud } from './index';
import { THEME } from './theme';

const UP = new Vector3(0, 1, 0);
const target: HudTarget = {
  id: 'lamp', tagged: true, connection: 'ready', label: 'Ceiling light', status: 'scanned', position: [0.4, 2.4, -3],
  confirmed: true, facing: [0, 0, 1], sizeM: [0.3, 0.2, 0.05],
};
const instances: Hud[] = [];

function setup(kind: 'idle' | 'card' | 'modal' = 'idle') {
  const camera = new PerspectiveCamera();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
  instances.push(hud);
  hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a device' });
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  if (kind === 'card') { hud.upsertTarget(target); hud.setLocked(target.id); }
  if (kind === 'modal') hud.showConfirm({ id: 'allow', title: 'Allow device control' });
  const panel = hud.root.getObjectByName(kind === 'modal' ? 'confirmation-panel' : kind === 'idle' ? 'hand-dock' : 'device-card')!;
  const update = (time: number) => hud.update({ time, dt: 1 / 72, head, hands: {} });
  return { hud, head, panel, update };
}

function projectedBounds(panel: Hud['root'], head: { position: Vector3; quaternion: Quaternion }, width: number, height: number) {
  const inverse = head.quaternion.clone().invert();
  const corners = [-1, 1].flatMap((x) => [-1, 1].map((y) => {
    const point = new Vector3(x * width / 2, y * height / 2, 0).applyQuaternion(panel.quaternion)
      .add(panel.position).sub(head.position).applyQuaternion(inverse);
    return { x: point.x / -point.z, y: point.y / -point.z, front: point.z < -0.01 };
  }));
  return { bottom: Math.min(...corners.map((p) => p.y)), top: Math.max(...corners.map((p) => p.y)),
    left: Math.min(...corners.map((p) => p.x)), right: Math.max(...corners.map((p) => p.x)),
    inView: corners.every((point) => point.front && Math.abs(point.x) < 1 && Math.abs(point.y) < 1) };
}

afterEach(() => { for (const hud of instances.splice(0)) hud.dispose(); });

describe('HUD world placement', () => {
  it('uses the first frame pose instead of the constructor camera pose', () => {
    const { head, panel, update } = setup();
    head.position.set(2, 1.75, 3);
    head.quaternion.setFromAxisAngle(UP, Math.PI / 4);
    update(0);
    const expected = new Vector3(-0.24, -0.4, -0.6).applyQuaternion(head.quaternion).add(head.position);
    expect(panel.position.distanceTo(expected)).toBeLessThan(1e-6);
    expect(panel.quaternion.angleTo(head.quaternion)).toBeLessThan(1e-6);
  });

  it.each(['idle', 'card', 'modal'] as const)('keeps the %s panel fixed during short looks away and small head movements', (kind) => {
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

  it.each(['idle', 'card', 'modal'] as const)('recentres the %s panel after a sustained look away without chasing the head during the transition', (kind) => {
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
    const distance = kind === 'card' ? THEME.card.dockDistance : 0.6;
    const lateral = kind === 'idle' ? -0.24 : 0;
    expect(panel.position.x).toBeCloseTo((lateral - distance) / 2);
    expect(panel.position.z).toBeCloseTo((-distance - lateral) / 2);
    update(1901);
    expect(panel.position.x).toBeCloseTo(-distance);
    expect(panel.position.z).toBeCloseTo(-lateral);
    expect(panel.quaternion.angleTo(new Quaternion().setFromAxisAngle(UP, Math.PI / 2))).toBeLessThan(1e-6);
  });

  it('smoothly recentres the fallback dock after a step exceeds .75m', () => {
    const { head, panel, update } = setup();
    update(0);
    head.position.x = 0.75;
    update(100);
    expect(panel.position.x).toBe(-0.24);
    head.position.x = 0.8;
    update(200);
    expect(panel.position.x).toBe(-0.24);
    update(350);
    expect(panel.position.x).toBeCloseTo(0.4 - 0.24);
    update(500);
    expect(panel.position.x).toBeCloseTo(0.8 - 0.24);
    expect(panel.position.z).toBeCloseTo(-0.6);
  });

  it('holds the device card across head movement, target updates and arming, then anchors a newly selected target', () => {
    const { hud, head, panel, update } = setup('card');
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
    const expected = new Vector3(0, -0.14, -THEME.card.dockDistance).applyQuaternion(head.quaternion).add(head.position);
    expect(panel.position.distanceTo(expected)).toBeLessThan(1e-6);
    expect(panel.quaternion.angleTo(head.quaternion)).toBeLessThan(1e-6);
  });

  it('holds the open card and fallback dock through a sustained 20 degree turn', () => {
    const { hud, head, panel, update } = setup('card');
    update(200);
    const dock = hud.root.getObjectByName('hand-dock')!;
    expect(dock.userData.anchor).toBe('fallback');
    expect(dock.userData.width).toBeGreaterThan(0);
    expect(dock.userData.height).toBe(0.032);
    const cardPosition = panel.position.clone(), dockPosition = dock.position.clone();
    head.quaternion.setFromAxisAngle(UP, 20 * Math.PI / 180);
    for (let time = 300; time <= 3000; time += 100) update(time);
    expect(panel.position).toEqual(cardPosition);
    expect(dock.position).toEqual(dockPosition);
    expect(Math.abs(panel.position.z - dock.position.z)).toBeGreaterThanOrEqual(0.01);
    expect(projectedBounds(dock, head, dock.userData.width, dock.userData.height).top)
      .toBeLessThan(projectedBounds(panel, head, 0.4, 0.32).bottom);

    head.quaternion.setFromAxisAngle(UP, 100 * Math.PI / 180);
    update(3100); update(4601); update(4901);
    for (const node of [panel, dock]) {
      expect(node.position.distanceTo(head.position)).toBeGreaterThan(0.5);
      expect(node.position.distanceTo(head.position)).toBeLessThan(1);
      expect(new Vector3(0, 1, 0).applyQuaternion(node.quaternion).distanceTo(UP)).toBeLessThan(1e-6);
      expect(node.quaternion.angleTo(head.quaternion)).toBeLessThan(1e-6);
    }
    const inverse = head.quaternion.clone().invert();
    const depth = (node: typeof panel) => node.position.clone().sub(head.position).applyQuaternion(inverse).z;
    expect(Math.abs(depth(panel) - depth(dock))).toBeGreaterThanOrEqual(0.01);
    const dockBounds = projectedBounds(dock, head, dock.userData.width, dock.userData.height);
    const cardBounds = projectedBounds(panel, head, 0.4, 0.32);
    expect(dockBounds.inView).toBe(true);
    expect(cardBounds.inView).toBe(true);
    expect(dockBounds.top).toBeLessThan(cardBounds.bottom);
  });

  it('keeps a nearby card fixed after opening and lazily brings it back when looking away', () => {
    const { hud, head, panel, update } = setup('card');
    hud.upsertTarget({ ...target, id: 'nearby', position: [0, 1.46, -0.8] });
    hud.setLocked('nearby');
    update(200);
    const position = panel.position.clone(), rotation = panel.quaternion.clone();
    for (let frame = 1; frame <= 30; frame++) {
      head.position.x = frame * 0.001;
      head.quaternion.setFromAxisAngle(UP, frame * 0.002);
      hud.upsertTarget({ ...target, id: 'nearby', position: [frame * 0.001, 1.46, -0.8] });
      update(200 + frame * 16);
      expect(panel.position).toEqual(position);
      expect(panel.quaternion.equals(rotation)).toBe(true);
    }
    head.quaternion.setFromAxisAngle(UP, 100 * Math.PI / 180);
    update(700); update(2201); update(2501);
    expect(panel.position.distanceTo(head.position)).toBeGreaterThan(0.5);
    expect(panel.position.distanceTo(head.position)).toBeLessThan(1);
    expect(new Vector3(0, 1, 0).applyQuaternion(panel.quaternion).distanceTo(UP)).toBeLessThan(1e-6);
    expect(panel.quaternion.angleTo(head.quaternion)).toBeLessThan(1e-6);
  });
});
