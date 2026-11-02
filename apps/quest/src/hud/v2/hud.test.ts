import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Scene, Vector3, type Object3D, type WebGLRenderer } from 'three';
import { EXAMPLES, type Gen3dSpec } from '@ce/gen3d';
import type { HandState, HudFrame, HudTarget } from '../contract';
import { createHud, THEME } from './index';
import { BoxField } from './boxes';

const target: HudTarget = { id: 'device', label: 'Laptop', source: 'yolo', status: 'scanned', position: [0, 1.4, -1], facing: [0, 0, 1], confirmed: false, sizeM: [0.3, 0.2, 0.05] };
const spec = (armed = true): Gen3dSpec => ({
  ...EXAMPLES['ceiling-dimmer']!, specId: 'device_controls', state: { armed },
  controls: [
    { id: 'level', label: 'Brightness', kind: 'continuous', range: { min: 0, max: 100, step: 1 }, default: 50, binding: { action: 'sim.set' } },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `action${i}`, label: `Action ${i}`, kind: 'trigger' as const, binding: { action: 'sim.action' } })),
  ],
});
function setup() {
  const scene = new Scene(), camera = new PerspectiveCamera();
  camera.position.set(0, 1.4, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene, camera, renderer: {} as WebGLRenderer });
  let time = 0;
  function frame(hand?: Partial<HandState>, elapsedMs = 1000 / 72): HudFrame {
    time += elapsedMs;
    return { time, dt: elapsedMs / 1000, head: { position: camera.position, quaternion: camera.quaternion }, hands: hand ? { right: { joints: {}, pinchPoint: new Vector3(10, 10, 10), ray: { origin: camera.position.clone(), dir: new Vector3(0, 0, -1) }, pinching: false, justPinched: false, justReleased: false, ...hand } } : {} };
  }
  function pinch(object: Object3D, heldMs = 20) {
    hud.update(frame());
    const point = object.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.update(frame({ pinchPoint: point, pinching: true }, heldMs));
    hud.update(frame({ pinchPoint: point, justReleased: true }));
  }
  return { hud, scene, frame, pinch };
}
function budget(root: Object3D) {
  let calls = 0, triangles = 0, text = 0, lineObjects = 0;
  root.traverseVisible((object) => {
    const renderable = object as Mesh;
    if (renderable.isMesh || 'isLine' in object) {
      calls += Array.isArray(renderable.material) ? renderable.material.length : 1;
      if (renderable.isMesh) triangles += (renderable.geometry.index?.count ?? renderable.geometry.getAttribute('position')?.count ?? 0) / 3;
      if ('sync' in object) text++;
      if ('isLine' in object) lineObjects++;
    }
  });
  return { calls, triangles, text, lineObjects };
}

describe('lean HUD scene budget', () => {
  it('renders ten real text labels, one batched box field, one card and at most four controls well within budget', () => {
    const { hud, frame } = setup();
    for (let i = 0; i < 10; i++) hud.upsertTarget({ ...target, id: i ? `device${i}` : target.id, position: [(i % 5 - 2) / 3, 1.1 + Math.floor(i / 5) / 3, -1] });
    hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame());
    const handsFrame = frame({ pinchPoint: new Vector3(0, 1, -0.3) });
    handsFrame.hands.left = handsFrame.hands.right;
    hud.update(handsFrame);
    const counts = budget(hud.root);
    expect(counts.lineObjects).toBe(1);
    expect(counts.text).toBe(17); // ten labels, name/status/details, main label, three buttons
    expect(counts.calls).toBe(27);
    expect(counts.calls * 2).toBeLessThanOrEqual(THEME.limits.drawCalls); // conservative stereo estimate
    expect(counts.triangles * 2).toBeLessThanOrEqual(THEME.limits.triangles);
    expect(hud.root.getObjectByName('main-control:level')).toBeTruthy();
    expect(hud.root.getObjectByName('control:action2')).toBeTruthy();
    expect(hud.root.getObjectByName('control:action3')).toBeUndefined();
    hud.dispose();
  });
  it('keeps scanning as boxes only and reveals a card only after a box is picked', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setScanning(true); hud.update(frame());
    const card = hud.root.getObjectByName('device-card')!;
    expect(card.visible).toBe(false);
    expect(budget(hud.root).calls).toBe(2);
    hud.setLocked(target.id); hud.update(frame()); expect(card.visible).toBe(true);
    hud.renderSpec(spec(), { targetId: target.id });
    hud.showHackMenu(target.id, { title: 'Laptop', items: [] });
    hud.setLocked(null); hud.update(frame()); expect(card.visible).toBe(false);
    hud.dispose();
  });
  it('reuses the same geometry and label on tracking updates, then removes the old outline immediately on handover', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.update(frame());
    const field = hud.root.getObjectByName('boxField') as BoxField, label = hud.root.getObjectByName('target-label:device');
    const geometry = field.geometry;
    hud.upsertTarget({ ...target, position: [0.1, 1.4, -1] }); hud.update(frame());
    expect(field.geometry).toBe(geometry); expect(hud.root.getObjectByName('target-label:device')).toBe(label);
    hud.upsertTarget({ ...target, id: 'sam-device', source: 'sam' }); hud.removeTarget(target.id); hud.setLocked('sam-device'); hud.update(frame());
    expect(field.boxes.size).toBe(1); expect(hud.root.getObjectByName('target-label:device')).toBeUndefined();
    hud.dispose();
  });
  it('retains the capture plane when the box is above eye level', () => {
    const field = new BoxField(), center = new Vector3(0, 2, -1);
    field.set('screen', center, 0.4, 0.2, THEME.color.line, true);
    const normal = new Vector3(0, -1, 1).normalize();
    field.setFacing('screen', normal.toArray()); field.update(1 / 72, new Vector3(1, 1.4, 0));
    const positions = field.geometry.getAttribute('position');
    for (let i = 0; i < field.geometry.drawRange.count; i++) expect(new Vector3().fromBufferAttribute(positions, i).sub(center).dot(normal)).toBeCloseTo(0, 6);
    field.dispose();
  });
});

describe('lean HUD controls and details', () => {
  it('keeps unarmed controls inert, emits one command stream after arming, and disarming overrides per-control flags', () => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id);
    const original = spec(false); original.controls[1]!.armed = true; hud.renderSpec(original, { targetId: target.id }); hud.update(frame());
    expect(hud.root.getObjectByName('control:action0')).toBeUndefined();
    hud.setArmed('device_controls', true);
    const events: string[] = [], consumed: string[] = [];
    hud.on('control', (event) => events.push(`${event.controlId}:${event.phase}:${event.value}`));
    hud.on('consumed', (event) => consumed.push(event.widget));
    pinch(hud.root.getObjectByName('control:action0')!);
    expect(events).toEqual(['action0:start:true', 'action0:end:false']);
    expect(consumed).toContain('control');
    expect(original.state?.armed).toBe(false);
    hud.setArmed('device_controls', false);
    expect(hud.root.getObjectByName('control:action0')).toBeUndefined();
    hud.dispose();
  });
  it('accepts controller rays away from the hand and preserves the final slider position on release', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame());
    const slider = hud.root.getObjectByName('main-control:level')!;
    const end = slider.localToWorld(new Vector3(THEME.control.width / 2, 0, 0));
    const origin = new Vector3(0, 1.4, 0), ray = { origin, dir: end.clone().sub(origin).normalize() };
    const events: { phase: string; value: unknown }[] = [];
    hud.on('control', (event) => events.push(event));
    hud.update(frame({ controller: true, ray, pinching: true, justPinched: true }));
    hud.update(frame({ controller: true, ray, justReleased: true }));
    expect(events.at(-1)).toMatchObject({ phase: 'end', value: 100 });
    hud.dispose();
  });
  it('shows logs, evidence and model ids only when Details is opened', () => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id);
    hud.logStep({ stepId: 'learn', title: 'Learning device', detail: 'Driver created', status: 'ok' });
    hud.setModelChips([{ id: 'sam-3.1', state: 'done' }]);
    hud.showEvidence({ targetId: target.id, sent: 'on', expect: 'brighter', seen: 'Brightness rose', verdict: 'ok' });
    hud.update(frame());
    const details = hud.root.getObjectByName('details-panel')!;
    expect(details.visible).toBe(false);
    pinch(hud.root.getObjectByName('details-toggle')!);
    expect(details.visible).toBe(true);
    const text = details.children.find((o) => 'text' in o) as Object3D & { text: string };
    expect(text.text).toContain('Driver created'); expect(text.text).toContain('sam-3.1'); expect(text.text).toContain('Brightness rose');
    pinch(hud.root.getObjectByName('details-toggle')!);
    expect(details.visible).toBe(false); hud.dispose();
  });
  it('requires a real 600 ms hold for confirmation and cancels a hold when tracking is lost', () => {
    const { hud, frame, pinch } = setup();
    const approvals: boolean[] = []; hud.on('confirm', (event) => approvals.push(event.approve));
    hud.showConfirm({ id: 'arm', title: 'Allow control?', hold: true });
    pinch(hud.root.getObjectByName('confirm-yes')!, 100);
    expect(approvals).toEqual([]);
    pinch(hud.root.getObjectByName('confirm-yes')!, 650);
    expect(approvals).toEqual([true]);
    const point = hud.root.getObjectByName('confirm-yes')!.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.update(frame(undefined, 700));
    hud.update(frame({ pinchPoint: point, justReleased: true }));
    expect(approvals).toEqual([true]); hud.dispose();
  });

  it('restores queued approvals and pairing after a confirmation, and releases a held deck key when rebuilding', () => {
    const { hud, frame } = setup();
    hud.showPairing({ display: '123456', qr: '' });
    hud.showConfirm({ id: 'arm', title: 'Allow control?' });
    hud.showApprovals([{ pairingId: 'new', name: 'Mac', kind: 'companion', display: '789123' }]);
    expect(hud.root.getObjectByName('approval-yes')).toBeUndefined();
    hud.showConfirm(null);
    expect(hud.root.getObjectByName('approval-yes')).toBeTruthy();
    hud.showApprovals([]);
    expect(hud.root.getObjectByName('confirmation-panel')!.children.some((o) => 'text' in o && o.text === '123456')).toBe(true);
    hud.showPairing(null);
    hud.setDeck({ open: true }); hud.update(frame());
    const phases: string[] = []; hud.on('deck', (e) => { if (e.key === 'mic') phases.push(e.phase); });
    const point = hud.root.getObjectByName('deck:mic')!.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.setDeck({ open: true });
    expect(phases).toEqual(['press', 'release']); hud.dispose();
  });
  it('keeps an overhead device card beside its box and ignores evidence for another device', () => {
    const { hud, frame } = setup();
    hud.upsertTarget({ ...target, position: [0, 2.4, 0] }); hud.setLocked(target.id); hud.update(frame());
    expect(Math.abs(hud.root.getObjectByName('device-card')!.position.x)).toBeGreaterThan(THEME.card.width / 2);
    hud.showEvidence({ targetId: 'other', sent: 'on', expect: 'brighter', seen: 'no change', verdict: 'fail' });
    const card = hud.root.getObjectByName('device-card')!;
    expect(card.children.some((o) => 'text' in o && o.text === 'Learning…')).toBe(true); hud.dispose();
  });

  it('caps continuous move events at 15 Hz and keeps toasts visible for seconds', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame());
    const point = hud.root.getObjectByName('main-control:level')!.getWorldPosition(new Vector3());
    const moves: number[] = []; hud.on('control', (event) => { if (event.phase === 'move') moves.push(Number(event.value)); });
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    for (let i = 0; i < 90; i++) hud.update(frame({ pinchPoint: point, pinching: true }, 1000 / 90));
    expect(moves.length).toBeLessThanOrEqual(15);
    hud.toast('Connected'); hud.update(frame(undefined, 1000)); expect(hud.root.getObjectByName('notice')!.visible).toBe(true);
    hud.update(frame(undefined, 2100)); expect(hud.root.getObjectByName('notice')!.visible).toBe(false); hud.dispose();
  });
});
