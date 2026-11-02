import { describe, expect, it } from 'vitest';
import { DoubleSide, Mesh, PerspectiveCamera, Scene, Vector3, type Object3D, type WebGLRenderer } from 'three';
import { EXAMPLES, type Gen3dSpec } from '@ce/gen3d';
import type { HandState, HudFrame, HudTarget } from '../contract';
import { HandFeedback } from '../../app/hand-feedback';
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
    hud.update(frame(undefined, 200));
    const point = object.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.update(frame({ pinchPoint: point, pinching: true }, heldMs));
    hud.update(frame({ pinchPoint: point, justReleased: true }));
  }
  return { hud, scene, frame, pinch };
}
function budget(root: Object3D) {
  let calls = 0, triangles = 0, text = 0;
  root.traverseVisible((object) => {
    const renderable = object as Mesh;
    if (renderable.isMesh || 'isLine' in object) {
      const geometry = renderable.geometry;
      const available = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
      const start = geometry.drawRange.start;
      const end = Math.min(available, start + geometry.drawRange.count);
      const groups = Array.isArray(renderable.material) ? geometry.groups : [{ start, count: end - start, materialIndex: 0 }];
      for (const group of groups) {
        const material = Array.isArray(renderable.material) ? renderable.material[group.materialIndex ?? 0] : renderable.material;
        const count = Math.max(0, Math.min(end, group.start + group.count) - Math.max(start, group.start));
        if (!material?.visible || !count) continue;
        const passes = renderable.isMesh && material.transparent && material.side === DoubleSide && !material.forceSinglePass ? 2 : 1;
        calls += passes;
        const instances = 'isInstancedMesh' in object ? Number((object as Object3D & { count: number }).count) : 1;
        if (renderable.isMesh) triangles += count / 3 * instances * passes;
      }
      if ('sync' in object) text++;
    }
  });
  return { calls, triangles, text };
}

describe('Calm Glass HUD scene budget', () => {
  it.each(['brightness', 'synth'] as const)('keeps ten labeled boxes, one armed %s card and both hands within the stereo budget', (kind) => {
    const { hud, scene, frame } = setup();
    const feedback = new HandFeedback(false);
    feedback.setAppearance({ accent: THEME.color.accent, showHover: false });
    scene.add(feedback.root);
    const controls = kind === 'brightness' ? spec() : { ...EXAMPLES['op1-knobs']!, controls: [...EXAMPLES['op1-knobs']!.controls, ...spec().controls.slice(1)] };
    for (let i = 0; i < 10; i++) hud.upsertTarget({ ...target, id: i ? `device${i}` : target.id, status: i ? 'scanned' : 'verified', position: [(i % 5 - 2) / 3, 1.1 + Math.floor(i / 5) / 3, -1] });
    hud.setLocked(target.id); hud.renderSpec(controls, { targetId: target.id }); hud.update(frame(undefined, 200));
    const handsFrame = frame({ pinchPoint: new Vector3(0, 1, -0.3) });
    handsFrame.hands.left = handsFrame.hands.right;
    hud.update(handsFrame);
    const shellHand = { ...handsFrame.hands.right!, palmUp: false, palmUpMs: 0, controller: false, joints: { 'index-finger-tip': { position: new Vector3(0, 1, -0.3), quaternion: handsFrame.head.quaternion, radius: 0.008 } } };
    const diagnostic = { tracked: true, jointCount: 1, pinchDistanceCm: null, selectEvents: 0, selectDown: false };
    feedback.update({ ...handsFrame, head: { ...handsFrame.head, ray: shellHand.ray }, hands: { left: shellHand, right: shellHand } }, { left: diagnostic, right: diagnostic }, 0);
    const counts = budget(scene);
    for (let i = 0; i < 10; i++) expect(hud.root.getObjectByName(`target-label:${i ? `device${i}` : target.id}`)).toBeTruthy();
    expect(counts.text).toBeGreaterThan(10);
    expect(counts.calls).toBeGreaterThan(counts.text);
    expect(counts.calls * 2).toBeLessThanOrEqual(THEME.limits.drawCalls); // conservative stereo estimate
    expect(counts.triangles * 2).toBeLessThanOrEqual(THEME.limits.triangles);
    expect(THEME.limits.drawCalls).toBeLessThanOrEqual(120);
    expect(THEME.limits.triangles).toBeLessThanOrEqual(60_000);
    expect(hud.root.getObjectByName('verdict-chip')?.visible).toBe(true);
    expect(hud.root.getObjectByName('verification-progress')).toBeTruthy();
    expect(hud.root.getObjectByName('target-tether')?.visible).toBe(true);
    expect(hud.root.getObjectByName('left-reticle')?.visible).toBe(true);
    expect(hud.root.getObjectByName('right-reticle')?.visible).toBe(true);
    expect(feedback.root.getObjectByName('fingertip-left')?.visible).toBe(true);
    expect(feedback.root.getObjectByName('fingertip-right')?.visible).toBe(true);
    for (const control of controls.controls.filter((control) => control.kind === 'continuous')) expect(hud.root.getObjectByName(`main-control:${control.id}`)).toBeTruthy();
    expect(hud.root.getObjectByName('control:action2')).toBeTruthy();
    expect(hud.root.getObjectByName('control:action3')).toBeUndefined();
    feedback.dispose(); hud.dispose();
  });
  it('keeps scanning as boxes only and reveals a card only after a box is picked', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setScanning(true); hud.update(frame());
    const card = hud.root.getObjectByName('device-card')!;
    expect(card.visible).toBe(false);
    expect(hud.root.getObjectByName('target-label:device')?.visible).toBe(true);
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
    const index = field.geometry.index!;
    for (let i = 0; i < field.geometry.drawRange.count; i++) expect(new Vector3().fromBufferAttribute(positions, index.getX(i)).sub(center).dot(normal)).toBeCloseTo(0, 6);
    field.dispose();
  });
  it('never adds a person box or label and removes an existing target relabeled as a person', () => {
    const { hud, frame } = setup();
    for (const label of ['person', 'Person', ' PERSON ']) hud.upsertTarget({ ...target, id: label, label });
    hud.upsertTarget(target);
    hud.upsertTarget({ ...target, label: 'person' });
    hud.update(frame());
    const field = hud.root.getObjectByName('boxField') as BoxField;
    expect(field.boxes.size).toBe(0);
    const labels: Object3D[] = [];
    hud.root.traverse((object) => { if (object.name.startsWith('target-label:')) labels.push(object); });
    expect(labels).toEqual([]);
    hud.dispose();
  });
  it('unfolds the card horizontally from the picked box edge in 180 ms', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.update(frame(undefined, 0));
    const card = hud.root.getObjectByName('device-card')!;
    const edge = target.position[0] + target.sizeM![0] / 2 + THEME.card.gap;
    expect(card.scale.x).toBeLessThan(0.01);
    expect(card.scale.y).toBe(1);
    expect(card.position.x - THEME.card.width / 2 * card.scale.x).toBeCloseTo(edge);
    hud.update(frame(undefined, 90));
    expect(card.scale.x).toBeGreaterThan(0.5);
    expect(card.scale.x).toBeLessThan(1);
    expect(card.scale.y).toBe(1);
    expect(card.position.x - THEME.card.width / 2 * card.scale.x).toBeCloseTo(edge);
    hud.update(frame(undefined, 90));
    expect(card.scale.x).toBeCloseTo(1);
    expect(card.position.x - THEME.card.width / 2).toBeCloseTo(edge);
    hud.dispose();
  });
});

describe('Calm Glass HUD controls and details', () => {
  it('shows Verified only after physical verification and withdraws it for a failed or pending check', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 200));
    const chip = hud.root.getObjectByName('verdict-chip')!;
    expect(chip.visible).toBe(false);
    const evidence = { targetId: target.id, sent: 'on', expect: 'brighter', seen: 'Brightness rose' };
    hud.showEvidence({ ...evidence, verdict: 'ok' });
    expect(chip.visible).toBe(true);
    hud.showEvidence({ ...evidence, verdict: 'fail', seen: 'No change' });
    expect(chip.visible).toBe(false);
    hud.showEvidence({ ...evidence, verdict: 'pending' });
    expect(chip.visible).toBe(false);
    hud.showEvidence(null); hud.upsertTarget({ ...target, status: 'verified' });
    expect(chip.visible).toBe(true);
    hud.setUpload({ hackId: 'check', label: 'Checking', stepsDone: 0, verdict: 'pending' });
    expect(chip.visible).toBe(false);
    hud.dispose();
  });
  it('updates the top-right numeric value and keeps the last pressed preset selected', () => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 200));
    hud.setControlValue('device_controls', 'level', 80);
    const value = hud.root.getObjectByName('control-value') as Object3D & { text: string; anchorX: string };
    expect(value.text).toBe('80%');
    expect(value.anchorX).toBe('right');
    expect(value.position.x).toBeGreaterThan(0);
    const first = hud.root.getObjectByName('control:action0')!, second = hud.root.getObjectByName('control:action1')!;
    pinch(first);
    expect(first.userData.selected).toBe(true);
    expect(second.userData.selected).toBe(false);
    pinch(second);
    expect(first.userData.selected).toBe(false);
    expect(second.userData.selected).toBe(true);
    hud.dispose();
  });
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
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 200));
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
  it('keeps controller ray distances in world metres while the card unfolds', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 1));
    const button = hud.root.getObjectByName('control:action0')!;
    const point = button.getWorldPosition(new Vector3());
    const origin = new Vector3(0, 1.4, 0), ray = { origin, dir: point.clone().sub(origin).normalize() };
    const events: { controlId: string; phase: string; value: unknown }[] = [];
    hud.on('control', (event) => events.push(event));
    expect(hud.root.getObjectByName('device-card')!.scale.x).toBeLessThan(0.1);
    hud.update(frame({ controller: true, ray, pinching: true, justPinched: true }, 0));
    expect(events).toContainEqual(expect.objectContaining({ controlId: 'action0', phase: 'start', value: true }));
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
    hud.upsertTarget({ ...target, position: [0, 2.4, 0] }); hud.setLocked(target.id); hud.update(frame(undefined, 200));
    expect(Math.abs(hud.root.getObjectByName('device-card')!.position.x)).toBeGreaterThan(THEME.card.width / 2);
    hud.showEvidence({ targetId: 'other', sent: 'on', expect: 'brighter', seen: 'no change', verdict: 'fail' });
    const card = hud.root.getObjectByName('device-card')!;
    expect(card.children.some((o) => 'text' in o && o.text === 'Learning this device…')).toBe(true); hud.dispose();
  });

  it('caps continuous move events at 15 Hz and keeps toasts visible for seconds', () => {
    const { hud, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 200));
    const point = hud.root.getObjectByName('main-control:level')!.getWorldPosition(new Vector3());
    const moves: number[] = []; hud.on('control', (event) => { if (event.phase === 'move') moves.push(Number(event.value)); });
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    for (let i = 0; i < 90; i++) hud.update(frame({ pinchPoint: point, pinching: true }, 1000 / 90));
    expect(moves.length).toBeLessThanOrEqual(15);
    hud.toast('Connected'); hud.update(frame(undefined, 1000)); expect(hud.root.getObjectByName('notice')!.visible).toBe(true);
    hud.update(frame(undefined, 2100)); expect(hud.root.getObjectByName('notice')!.visible).toBe(false); hud.dispose();
  });
});
