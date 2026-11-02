import { describe, expect, it } from 'vitest';
import { DoubleSide, Mesh, PerspectiveCamera, Scene, Vector3, Quaternion, type ShaderMaterial, Object3D, type WebGLRenderer } from 'three';
import { EXAMPLES, type Gen3dSpec } from '@ce/gen3d';
import type { HandState, HudFrame, HudTarget } from '../contract';
import { HandFeedback } from '../../app/hand-feedback';
import { createHud, THEME } from './index';
import { BoxField } from './boxes';

const target: HudTarget = { id: 'device', tagged: true, connection: 'ready', label: 'Laptop', source: 'yolo', status: 'scanned', position: [0, 1.4, -1], facing: [0, 0, 1], confirmed: false, sizeM: [0.3, 0.2, 0.05] };
const spec = (armed = true): Gen3dSpec => ({
  ...EXAMPLES['ceiling-dimmer']!, specId: 'device_controls', state: { armed },
  controls: [
    { id: 'level', label: 'Brightness', kind: 'continuous', range: { min: 0, max: 100, step: 1 }, default: 50, binding: { action: 'sim.set' } },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `action${i}`, label: `Action ${i}`, kind: 'trigger' as const, binding: { action: 'sim.action' } })),
  ],
});
function setup(mode: 'annotate' | 'control' = 'control') {
  const scene = new Scene(), camera = new PerspectiveCamera();
  camera.position.set(0, 1.4, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene, camera, renderer: {} as WebGLRenderer });
  hud.setHome?.({ mode, filter: 'electronics', tagged: 0, status: mode === 'annotate' ? 'Tag the devices you want to control' : 'Choose a tagged device' });
  const renderSpec = hud.renderSpec.bind(hud);
  hud.renderSpec = (spec, at) => { renderSpec(spec, at); if (spec.state?.armed) hud.setArmed(spec.specId, true); };
  let time = 0;
  function frame(hand?: Partial<HandState>, elapsedMs = 1000 / 72): HudFrame {
    time += elapsedMs;
    return { time, dt: elapsedMs / 1000, head: { position: camera.position, quaternion: camera.quaternion }, hands: hand ? { right: { joints: hand.pinchPoint && !hand.controller ? { 'index-finger-tip': { position: hand.pinchPoint, quaternion: new Quaternion(), radius: 0.008 } } : {}, pinchPoint: new Vector3(10, 10, 10), ray: { origin: camera.position.clone(), dir: new Vector3(0, 0, -1) }, pinching: false, justPinched: false, justReleased: false, ...hand } } : {} };
  }
  function pinch(object: Object3D, heldMs = 20) {
    hud.update(frame(undefined, 200));
    const point = object.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.update(frame({ pinchPoint: point, pinching: true }, heldMs));
    hud.update(frame({ pinchPoint: point, justReleased: true }));
  }
  return { hud, scene, camera, frame, pinch };
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
  it.each(['brightness', 'synth'] as const)('keeps six labeled boxes, one armed %s card and both hands within the stereo budget', (kind) => {
    const { hud, scene, frame } = setup();
    const feedback = new HandFeedback(false);
    feedback.setAppearance({ accent: THEME.color.accent, showHover: false });
    scene.add(feedback.root);
    const controls = kind === 'brightness' ? spec() : { ...EXAMPLES['op1-knobs']!, controls: [...EXAMPLES['op1-knobs']!.controls, ...spec().controls.slice(1)] };
    for (let i = 0; i < 6; i++) hud.upsertTarget({ ...target, id: i ? `device${i}` : target.id, status: i ? 'scanned' : 'verified', position: [(i % 5 - 2) / 3, 1.1 + Math.floor(i / 5) / 3, -1] });
    hud.setLocked(target.id); hud.renderSpec(controls, { targetId: target.id }); hud.update(frame(undefined, 200));
    const handsFrame = frame({ pinchPoint: new Vector3(0, 1, -0.3) });
    handsFrame.hands.left = handsFrame.hands.right;
    hud.update(handsFrame);
    const shellHand = { ...handsFrame.hands.right!, palmUp: false, palmUpMs: 0, controller: false, joints: { 'index-finger-tip': { position: new Vector3(0, 1, -0.3), quaternion: handsFrame.head.quaternion, radius: 0.008 } } };
    const diagnostic = { tracked: true, jointCount: 1, pinchDistanceCm: null, selectEvents: 0, selectDown: false };
    feedback.update({ ...handsFrame, head: { ...handsFrame.head, ray: shellHand.ray }, hands: { left: shellHand, right: shellHand } }, { left: diagnostic, right: diagnostic }, 0);
    const counts = budget(scene);
    for (let i = 0; i < 6; i++) expect(hud.root.getObjectByName(`target-label:${i ? `device${i}` : target.id}`)).toBeTruthy();
    expect(counts.text).toBeGreaterThan(6);
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
    expect(hud.root.getObjectByName(`main-control:${controls.controls.find((control) => control.kind === 'continuous')!.id}`)).toBeTruthy();
    expect(hud.root.getObjectByName(`main-control:${controls.controls.filter((control) => control.kind === 'continuous')[1]?.id}`)).toBeUndefined();
    expect(hud.root.getObjectByName('control:action2')).toBeTruthy();
    expect(hud.root.getObjectByName('control:action3')).toBeUndefined();
    feedback.dispose(); hud.dispose();
  });
  it('keeps annotation focused on tags and only opens a selected card in Control', () => {
    const { hud, frame } = setup('annotate');
    hud.upsertTarget(target); hud.setScanning(true); hud.setLocked(target.id); hud.update(frame());
    const card = hud.root.getObjectByName('device-card')!;
    expect(card.visible).toBe(false);
    expect(hud.root.getObjectByName('filter:electronics')).toBeTruthy();
    expect(hud.root.getObjectByName('tag-remove:device')).toBeTruthy();
    hud.renderSpec(spec(), { targetId: target.id });
    expect(hud.root.getObjectByName('control:action0')).toBeUndefined();
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a tagged device' });
    hud.update(frame()); expect(card.visible).toBe(true);
    expect(hud.root.getObjectByName('filter:electronics')).toBeUndefined();
    hud.setScanning(true); expect(card.visible).toBe(true);
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
  it.each([
    [0.4, 2.2, -3],
    [0.3, 1.9, -0.6],
    [0, 2.4, 0],
    [0, -1, -2],
  ] as [number, number, number][])('docks a distant or elevated target at arm’s length (%s, %s, %s)', (x, y, z) => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget({ ...target, position: [x, y, z] }); hud.setLocked(target.id);
    hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 200));
    const card = hud.root.getObjectByName('device-card')!;
    const head = new Vector3(0, 1.4, 0), offset = card.position.clone().sub(head);
    expect(Math.hypot(offset.x, offset.z)).toBeCloseTo(THEME.card.dockDistance);
    expect(offset.y).toBeCloseTo(THEME.panel.headY);
    const normal = new Vector3(0, 0, 1).applyQuaternion(card.quaternion);
    expect(normal.y).toBe(0);
    expect(normal.dot(offset.clone().setY(0).normalize())).toBeCloseTo(-1);
    expect(card.scale.toArray()).toEqual([1, 1, 1]);
    const heading = hud.root.getObjectByName('device-name') as Object3D & { fontSize: number };
    expect(heading.fontSize).toBe(THEME.font.title);
    const button = hud.root.getObjectByName('control:action0')!;
    expect(button.getWorldPosition(new Vector3()).distanceTo(head)).toBeLessThan(0.8);
    const events: string[] = [];
    hud.on('control', (event) => events.push(`${event.controlId}:${event.phase}`));
    pinch(button);
    expect(events).toEqual(['action0:start', 'action0:end']);
    const tether = hud.root.getObjectByName('target-tether') as Mesh;
    expect(tether.visible).toBe(true);
    expect(tether.geometry.drawRange.count).toBe(6);
    hud.removeTarget(target.id); hud.update(frame());
    expect(tether.visible).toBe(false);
    expect(tether.geometry.drawRange.count).toBe(0);
    hud.dispose();
  });
});

describe('Calm Glass HUD controls and details', () => {
  it('retains armed lamp presets when a room spec arrives and emits the selected hack id', () => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget({ ...target, label: 'Ceiling light', position: [0.4, 2.2, -3] }); hud.setLocked(target.id);
    const light: Gen3dSpec = { ...spec(false), controls: [
      spec().controls[0]!,
      { id: 'h_dim', kind: 'trigger', label: 'Dim room', binding: { action: 'dimmer' } },
      { id: 'h_full', kind: 'trigger', label: 'Turn full on', binding: { action: 'full-on' } },
      { id: 'h_off', kind: 'trigger', label: 'Lights out', binding: { action: 'off' } },
      { id: 'h_night', kind: 'trigger', label: 'Low glow', binding: { action: 'night-light' } },
    ] };
    hud.renderSpec(light, { targetId: target.id });
    expect(hud.root.getObjectByName('control:h_off')).toBeUndefined();
    hud.setArmed(light.specId, true);
    hud.renderSpec({ ...spec(false), specId: 'room_controls' }, {});
    hud.showHackMenu('room', { title: 'Room', items: [{ id: 'blackout', label: 'Blackout', kind: 'action', status: 'ready' }] });
    hud.update(frame(undefined, 200));
    const buttons = ['h_full', 'h_off', 'h_night'].map((id) => hud.root.getObjectByName(`control:${id}`)!);
    expect(buttons.every(Boolean)).toBe(true);
    expect(buttons[0]!.position.x).toBeLessThan(buttons[1]!.position.x);
    expect(buttons[1]!.position.x).toBeLessThan(buttons[2]!.position.x);
    expect(hud.root.getObjectByName('control:h_dim')).toBeUndefined();
    expect(hud.root.getObjectByName('action:blackout')).toBeUndefined();
    const events: unknown[] = []; hud.on('control', (event) => events.push(event));
    pinch(buttons[1]!);
    expect(events).toContainEqual(expect.objectContaining({ specId: light.specId, controlId: 'h_off', value: true, phase: 'start' }));
    hud.dispose();
  });
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
    hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', canStop: true });
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
    const phases: string[] = []; hud.on('deck', (e) => { if (e.key === 'panic') phases.push(e.phase); });
    const point = hud.root.getObjectByName('deck:panic')!.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.setHome?.({ mode: 'annotate', filter: 'electronics', tagged: 1, status: 'Tag devices' });
    expect(phases).toEqual(['press', 'release']); hud.dispose();
  });
  it('ignores evidence for another device while an overhead card is docked', () => {
    const { hud, frame } = setup();
    hud.upsertTarget({ ...target, position: [0, 2.4, 0] }); hud.setLocked(target.id); hud.update(frame(undefined, 200));
    hud.showEvidence({ targetId: 'other', sent: 'on', expect: 'brighter', seen: 'no change', verdict: 'fail' });
    const card = hud.root.getObjectByName('device-card')!;
    expect(card.children.some((o) => 'text' in o && o.text === 'Confirm to enable controls')).toBe(true); hud.dispose();
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

describe('HUD button interaction feedback', () => {
  it('opens the same home bar at the wrist once and restores its world anchor when closed', () => {
    const { hud, frame } = setup();
    hud.update(frame(undefined, 200));
    const bar = hud.root.getObjectByName('home-bar')!, anchor = bar.position.clone();
    hud.setDeck({ open: true, at: [0.4, 1, -0.4] }); hud.update(frame());
    hud.setDeck({ open: true, at: [0.8, 1, -0.4] }); hud.update(frame());
    expect(bar.position.toArray()).toEqual([0.4, 1, -0.4]);
    hud.setDeck({ open: false }); hud.update(frame());
    expect(bar.position.equals(anchor)).toBe(true);
    expect(bar.visible).toBe(true);
    expect(hud.root.getObjectByName('deck-close')).toBeUndefined();
    hud.dispose();
  });

  it('accepts a fresh pinch after tracking loss without replaying a held pinch', () => {
    const { hud, camera, frame } = setup();
    hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', canStop: true });
    hud.update(frame(undefined, 200));
    const point = hud.root.getObjectByName('deck:panic')!.getWorldPosition(new Vector3());
    const ray = { origin: camera.position.clone(), dir: point.sub(camera.position).normalize() };
    const phases: string[] = [];
    hud.on('deck', (e) => phases.push(e.phase));
    hud.update(frame({ ray, pinching: true, justPinched: true }));
    hud.update(frame());
    hud.update(frame({ ray, pinching: true }));
    expect(phases).toEqual(['press', 'release']);
    hud.update(frame());
    hud.update(frame({ ray, pinching: true, justPinched: true }));
    expect(phases).toEqual(['press', 'release', 'press']);
    hud.dispose();
  });

  it('uses the index tip for hover and crossing, requires withdrawal before another poke, and never pokes with missing joints', () => {
    const { hud, frame } = setup();
    hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', canStop: true });
    hud.update(frame(undefined, 200));
    const button = hud.root.getObjectByName('deck:panic')!;
    const phases: string[] = [];
    hud.on('deck', (e) => phases.push(e.phase));
    const fingertip = (z: number, x = 0) => button.localToWorld(new Vector3(x, 0, z));
    const update = (z: number, x = 0) => hud.update(frame({
      joints: { 'index-finger-tip': { position: fingertip(z, x), quaternion: new Quaternion(), radius: 0.008 } },
      pinchPoint: new Vector3(20, 20, 20), ray: { origin: new Vector3(20, 20, 20), dir: new Vector3(0, 0, -1) },
    }));
    const material = () => (button.getObjectByName('button-plate') as Mesh).material as ShaderMaterial;
    update(-0.003); // Appearing behind the face is not a crossing.
    expect(phases).toEqual([]);
    update(0.02);
    expect(button.userData.hovered).toBe(true);
    expect(material().uniforms.edgeAlpha!.value).toBe(1);
    update(-0.003);
    expect(phases).toEqual(['press']);
    expect(button.scale.x).toBe(0.96);
    expect(material().uniforms.fillAlpha!.value).toBe(0.48);
    for (const z of [0.004, -0.002, 0.006, -0.004]) update(z);
    expect(phases).toEqual(['press']);
    update(0.02);
    expect(phases).toEqual(['press', 'release']);
    update(-0.003);
    expect(phases).toEqual(['press', 'release', 'press']);
    hud.update(frame({ joints: {}, pinchPoint: fingertip(-0.003), ray: { origin: new Vector3(20, 20, 20), dir: new Vector3(0, 0, -1) } }, 200));
    expect(phases).toEqual(['press', 'release', 'press', 'release']);
    expect(button.userData.hovered).toBe(false);
    expect(button.scale.x).toBe(1);
    expect(material().uniforms.edgeAlpha!.value).toBe(0.26);
    hud.dispose();
  });

  it.each(['mode', 'details', 'deck', 'confirm', 'approval', 'control', 'hack'] as const)('supports a 48 mm hit area, ray hover and open-finger poke on %s buttons', (kind) => {
    const { hud, camera, frame } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id);
    let name = 'mode-annotate';
    if (kind === 'details') name = 'details-toggle';
    if (kind === 'deck') { hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', canStop: true }); hud.setDeck({ open: true }); name = 'deck:panic'; }
    if (kind === 'confirm') { hud.showConfirm({ id: 'ok', title: 'Allow?' }); name = 'confirm-yes'; }
    if (kind === 'approval') { hud.showApprovals([{ pairingId: 'mac', name: 'Mac', kind: 'companion', display: '123' }]); name = 'approval-yes'; }
    if (kind === 'control' || kind === 'hack') {
      hud.upsertTarget({ ...target, status: 'verified' }); hud.setLocked(target.id);
      if (kind === 'control') { hud.renderSpec(spec(), { targetId: target.id }); name = 'control:action0'; }
      else { hud.renderSpec({ ...spec(), controls: [spec().controls[0]!] }, { targetId: target.id }); hud.showHackMenu(target.id, { title: 'Actions', items: [{ id: 'on', label: 'On', controlId: 'on', kind: 'action', status: 'ready' }] }); name = 'action:on'; }
    }
    hud.update(frame(undefined, 200));
    const button = hud.root.getObjectByName(name)!;
    const plate = button.getObjectByName('button-plate')!;
    expect(plate.scale.x).toBeGreaterThanOrEqual(0.048);
    expect(plate.scale.y).toBeGreaterThanOrEqual(0.048);
    const point = button.localToWorld(new Vector3(0, 0.023, 0));
    const ray = { origin: camera.position.clone(), dir: point.clone().sub(camera.position).normalize() };
    const consumed: string[] = [];
    hud.on('consumed', (event) => consumed.push(event.widget));
    hud.update(frame({ ray }));
    expect(button.userData.hovered).toBe(true);
    hud.update(frame({ ray, pinching: true, justPinched: true }));
    expect(hud.root.getObjectByName(name)!.userData.pressed).toBe(true);
    expect(consumed.length).toBeGreaterThan(0);
    hud.update(frame({ ray, justReleased: true }));
    hud.update(frame(undefined, 200));
    const current = hud.root.getObjectByName(name)!;
    const poke = (z: number) => hud.update(frame({ joints: { 'index-finger-tip': { position: current.localToWorld(new Vector3(0, 0.023, z)), quaternion: new Quaternion(), radius: 0.008 } } }));
    consumed.length = 0;
    poke(0.025); poke(-0.005);
    expect(consumed.length).toBeGreaterThan(0);
    expect(hud.root.getObjectByName(name)!.userData.pressed).toBe(true);
    hud.dispose();
  });
});

describe('explicit annotation and control modes', () => {
  it('starts with only the home bar, automatically scans without adding a card, and offers tag removal', () => {
    const scene = new Scene(), camera = new PerspectiveCamera();
    const hud = createHud({ scene, camera, renderer: {} as WebGLRenderer });
    hud.upsertTarget(target); hud.setLocked(target.id); hud.setScanning(true);
    hud.renderSpec(spec(true), { targetId: target.id }); hud.setArmed('device_controls', true);
    hud.update({ time: 0, dt: 0, head: { position: new Vector3(0, 1.4, 0), quaternion: new Quaternion() }, hands: {} });
    expect(hud.root.getObjectByName('device-card')!.visible).toBe(false);
    expect(hud.root.getObjectByName('home-bar')!.visible).toBe(true);
    expect(hud.root.getObjectByName('tag-remove:device')).toBeTruthy();
    expect(hud.root.getObjectByName('filter:everything')!.userData.selected).toBe(true);
    for (const name of ['scan-toggle', 'deck:panic', 'deck:mic', 'deck:ping', 'control:action0']) expect(hud.root.getObjectByName(name)).toBeUndefined();
    hud.dispose();
  });

  it('shows one setup, cancel, pairing or unknown state card and sends only its explicit action', () => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget({ ...target, connection: 'setup' }); hud.setLocked(target.id);
    const actions: string[] = [];
    for (const event of ['setup', 'cancel', 'pair'] as const) hud.on(event, ({ targetId }) => actions.push(`${event}:${targetId}`));
    hud.setDeviceState?.({ targetId: target.id, connection: 'setup' }); hud.update(frame());
    pinch(hud.root.getObjectByName('control-setup')!);
    expect(actions).toEqual(['setup:device']);
    hud.setDeviceState?.({ targetId: target.id, connection: 'setup', busy: true, sentence: 'Checking the physical response.' });
    expect((hud.root.getObjectByName('device-status') as Object3D & { text: string }).text).toBe('Checking the physical response.');
    expect(hud.root.getObjectByName('control-setup')).toBeUndefined();
    pinch(hud.root.getObjectByName('control-cancel')!);
    hud.setDeviceState?.({ targetId: target.id, connection: 'offline', hint: 'Pair the Cardputer IR node.' });
    expect((hud.root.getObjectByName('device-status') as Object3D & { text: string }).text).toBe('Pair the Cardputer IR node.');
    pinch(hud.root.getObjectByName('control-pair')!);
    expect(actions).toEqual(['setup:device', 'cancel:device', 'pair:device']);
    hud.setDeviceState?.({ targetId: target.id, connection: 'unknown' });
    expect(hud.root.getObjectByName('control-pair')).toBeUndefined();
    expect(hud.root.getObjectByName('device-card')!.visible).toBe(true);
    hud.setHome?.({ mode: 'annotate', filter: 'lights', tagged: 1, status: 'Tag the devices you want to control' });
    expect(hud.root.getObjectByName('device-card')!.visible).toBe(false);
    hud.dispose();
  });

  it('requires an explicit arm confirmation even when a generated spec claims it is armed', () => {
    const hud = createHud({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: {} as WebGLRenderer });
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a device' });
    hud.upsertTarget(target); hud.setLocked(target.id);
    hud.renderSpec(spec(true), { targetId: target.id });
    expect(hud.root.getObjectByName('control:action0')).toBeUndefined();
    hud.setArmed('device_controls', true);
    expect(hud.root.getObjectByName('control:action0')).toBeTruthy();
    hud.setArmed('device_controls', false);
    hud.renderSpec(spec(true), { targetId: target.id });
    expect(hud.root.getObjectByName('control:action0')).toBeUndefined();
    hud.dispose();
  });

  it('keeps unverified actions unavailable after global ARM and a disarm/rearm cycle', () => {
    const { hud } = setup();
    const controls = spec();
    controls.controls.find((control) => control.id === 'action0')!.armed = false;
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(controls, { targetId: target.id });
    hud.setArmed(controls.specId, false); hud.setArmed(controls.specId, true);
    expect(hud.root.getObjectByName('control:action0')).toBeUndefined();
    expect(hud.root.getObjectByName('control:action1')).toBeTruthy();
    hud.dispose();
  });

  it('consumes the card background and keeps a near slider drag on its captured plane', () => {
    const { hud, frame, pinch } = setup();
    hud.upsertTarget(target); hud.setLocked(target.id); hud.renderSpec(spec(), { targetId: target.id }); hud.update(frame(undefined, 200));
    const consumed: string[] = [], values: number[] = [];
    hud.on('consumed', ({ widget }) => consumed.push(widget));
    hud.on('control', ({ value }) => values.push(Number(value)));
    const card = hud.root.getObjectByName('device-card')!;
    const background = new Object3D(); card.add(background); background.position.set(0.18, 0.13, 0);
    pinch(background);
    expect(consumed).toContain('handle'); expect(values).toEqual([]);
    const slider = hud.root.getObjectByName('main-control:level')!;
    const start = slider.localToWorld(new Vector3(0, 0, 0));
    hud.update(frame({ pinchPoint: start, pinching: true, justPinched: true }));
    const drift = slider.localToWorld(new Vector3(0.03, 0, 0.08));
    const ray = { origin: new Vector3(), dir: new Vector3(0, 0, -1) };
    hud.update(frame({ pinchPoint: drift, ray, pinching: true }, 100));
    hud.update(frame({ pinchPoint: drift, ray, justReleased: true }));
    expect(values.at(-1)).toBe(58);
    hud.dispose();
  });
});

describe('bounded card wording and stable home updates', () => {
  it('updates the next-step hint and count, compact bar in Control', () => {
    const { hud, frame } = setup('annotate');
    hud.update(frame());
    const bar = hud.root.getObjectByName('home-bar')!;
    const hint = hud.root.getObjectByName('home-hint') as Object3D & { text: string };
    const dimensions = () => bar.children.find((node) => node instanceof Mesh)!.scale.toArray();
    const top = () => bar.position.y + dimensions()[1]! / 2;
    const originalTop = top(), originalSize = dimensions();
    const toggle = hud.root.getObjectByName('mode-control')!;
    const buttonY = toggle.position.y;
    expect(hint.text).toBe('Pinch a device to tag it');
    hud.setHome?.({ mode: 'annotate', filter: 'electronics', tagged: 2, status: 'stale hint' });
    expect(hint.text).toBe("Switch to Control when you're ready");
    expect(hud.root.getObjectByName('mode-control')).toBe(toggle);
    expect(toggle.children.some((child) => 'text' in child && child.text === 'Control · 2')).toBe(true);
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 2, status: 'stale hint' });
    hud.update(frame());
    // Control has no filter row: the bar is compact (0.16 m) so it stays in view below an open card
    expect(dimensions()[1]).toBeCloseTo(originalSize[1]! * 0.16 / 0.22, 5);
    expect(top()).toBeLessThanOrEqual(originalTop);
    expect(hud.root.getObjectByName('mode-control')!.position.y).toBeLessThan(buttonY);
    expect(hud.root.getObjectByName('filter:electronics')).toBeUndefined();
    expect(hint.text).toBe('Pinch a tagged device to open it');
    hud.upsertTarget(target); hud.setLocked(target.id);
    expect(hint.visible).toBe(false);
    hud.setLocked(null);
    expect(hint.visible).toBe(true);
    hud.dispose();
  });

  it('shows Stop only during setup or while a device is armed, and only in Control', () => {
    const { hud } = setup();
    const stop = () => hud.root.getObjectByName('deck:panic');
    expect(stop()).toBeUndefined();
    hud.upsertTarget({ ...target, connection: 'setup' }); hud.setLocked(target.id);
    hud.setDeviceState?.({ targetId: target.id, connection: 'setup', busy: true });
    expect(stop()).toBeTruthy();
    hud.setDeviceState?.({ targetId: target.id, connection: 'setup', busy: false });
    expect(stop()).toBeUndefined();
    hud.renderSpec(spec(false), { targetId: target.id });
    hud.setArmed('device_controls', true); hud.setLocked(null);
    expect(stop()).toBeTruthy();
    hud.setArmed('device_controls', false);
    expect(stop()).toBeUndefined();
    hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', canStop: true });
    expect(stop()).toBeTruthy();
    hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: 1, status: '', canStop: true });
    expect(stop()).toBeUndefined();
    hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', canStop: false });
    expect(stop()).toBeUndefined();
    hud.dispose();
  });

  it('renders the tag check, identification, untag hover and live setup status on the chip', () => {
    const { hud } = setup('annotate');
    const label = () => hud.root.getObjectByName('target-label:device')!;
    const text = () => label().getObjectByName('sdf') as Object3D & { text: string };
    hud.upsertTarget({ ...target, label: 'Ceiling light', tagged: false });
    expect(text().text).toBe('Ceiling light');
    expect(label().getObjectByName('tagged-check')).toBeUndefined();
    hud.upsertTarget({ ...target, label: 'Ceiling light', identifying: true });
    expect(text().text).toBe('Ceiling light · Identifying…');
    expect(label().getObjectByName('tagged-check')).toBeTruthy();
    hud.upsertTarget({ ...target, label: 'KOIZUMI ceiling light', identifying: false, connection: 'setup' });
    expect(text().text).toBe('KOIZUMI ceiling light');
    hud.setCandidate(target.id);
    expect(text().text).toBe('Pinch to untag');
    hud.setCandidate(null);
    expect(text().text).toBe('KOIZUMI ceiling light');
    hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '' });
    expect(text().text).toBe('KOIZUMI ceiling light · Needs setup');
    hud.setLocked(target.id);
    hud.setDeviceState?.({ targetId: target.id, connection: 'setup', busy: true });
    expect(text().text).toBe('KOIZUMI ceiling light · Setting up…');
    hud.setLocked(null); hud.setDeviceState?.(null);
    expect(text().text).toBe('KOIZUMI ceiling light · Setting up…');
    hud.dispose();
  });

  it('keeps equal action pills and shows Off until brightness changes or an on action runs', () => {
    const { hud, frame, pinch } = setup();
    const light: Gen3dSpec = { ...spec(), controls: [spec().controls[0]!,
      { id: 'full', label: 'Turn full on', kind: 'trigger', binding: { action: 'ir.fullOn' } },
      { id: 'off', label: 'Turn off', kind: 'trigger', binding: { action: 'ir.off' } },
      { id: 'night', label: 'Night', kind: 'trigger', binding: { action: 'ir.nightLight' } },
      { id: 'warm', label: 'Warmth', kind: 'continuous', binding: { action: 'ir.warmer' } },
    ] };
    hud.upsertTarget({ ...target, status: 'verified' }); hud.setLocked(target.id);
    hud.renderSpec(light, { targetId: target.id }); hud.update(frame(undefined, 200));
    const buttons = ['full', 'off', 'night'].map((id) => hud.root.getObjectByName(`control:${id}`)!);
    expect(buttons[0]!.getObjectByName('sdf')).toMatchObject({ text: 'Full on' });
    for (const button of buttons) {
      const plate = button.getObjectByName('button-plate') as Mesh;
      expect(button.position.y).toBe(THEME.card.buttonsY);
      expect(plate.scale.toArray()).toEqual([THEME.control.buttonWidth, THEME.control.buttonHeight, 1]);
      expect((plate.material as ShaderMaterial).uniforms.fillAlpha!.value).toBe(0.1);
      expect((plate.material as ShaderMaterial).uniforms.edgeAlpha!.value).toBe(0.26);
      expect(button.getObjectByName('sdf')!.position.y).toBe(0);
    }
    expect(hud.root.getObjectByName('device-status')!.visible).toBe(false);
    hud.setControlValue(light.specId, 'level', 80);
    const value = () => hud.root.getObjectByName('control-value') as Object3D & { text: string; color: string };
    pinch(buttons[1]!);
    expect(value()).toMatchObject({ text: 'Off', color: '#94A3B8' });
    expect(hud.root.getObjectByName('slider-fill')!.visible).toBe(false);
    hud.setControlValue(light.specId, 'level', 80);
    hud.setControlValue(light.specId, 'warm', 30);
    hud.setLocked(null); hud.setLocked(target.id);
    expect(value().text).toBe('Off');
    hud.setControlValue(light.specId, 'level', 70);
    expect(value()).toMatchObject({ text: '70%', color: THEME.color.accent });
    pinch(hud.root.getObjectByName('control:off')!);
    expect(value().text).toBe('Off');
    pinch(hud.root.getObjectByName('control:full')!);
    expect(value().text).toBe('70%');
    hud.dispose();
  });

  it('keeps the ARM primary accent and requires two seconds for a risky device', () => {
    const { hud, frame, pinch } = setup();
    const approvals: boolean[] = []; hud.on('confirm', ({ approve }) => approvals.push(approve));
    hud.showConfirm({ id: 'arm', kind: 'arm', title: 'Device is ready', hold: true });
    const primary = hud.root.getObjectByName('confirm-yes')!;
    hud.update(frame());
    const material = (primary.getObjectByName('button-plate') as Mesh).material as ShaderMaterial;
    expect(material.uniforms.fillAlpha!.value).toBe(0.28);
    expect(material.uniforms.stroke!.value).toBe(THEME.surface.stroke * 1.5);
    pinch(primary, 650); pinch(primary, 1900);
    expect(approvals).toEqual([]);
    pinch(primary, 2050);
    expect(approvals).toEqual([true]);
    hud.dispose();
  });

  it.each([false, true])('names the arm action explicitly with hold=%s', (hold) => {
    const { hud } = setup();
    hud.showConfirm({ id: 'arm', kind: 'arm', title: 'Ceiling light is ready', hold, summary: 'W'.repeat(200) });
    const button = hud.root.getObjectByName('confirm-yes')!;
    expect(button.children.some((child) => 'text' in child && child.text === 'Enable controls')).toBe(true);
    expect(hud.root.getObjectByName('confirm-no')!.children.some((child) => 'text' in child && child.text === 'Not now')).toBe(true);
    const summary = hud.root.getObjectByName('confirmation-summary') as Object3D & { text: string };
    expect(summary.text).toHaveLength(200);
    expect(summary.userData.fitHeight).toBe(0.11);
    hud.showConfirm({ id: 'approve', title: 'Allow pairing' });
    expect(hud.root.getObjectByName('confirm-yes')!.children.some((child) => 'text' in child && child.text === 'Allow')).toBe(true);
    hud.dispose();
  });

  it('keeps complete 200 character hints within a defined status area and reuses home widgets across unchanged snapshots', () => {
    const { hud, frame } = setup();
    hud.upsertTarget({ ...target, connection: 'offline' }); hud.setLocked(target.id);
    const hint = 'Connect your companion and confirm that the device is attached. '.repeat(4).slice(0, 200);
    hud.setDeviceState?.({ targetId: target.id, connection: 'offline', hint });
    const text = hud.root.getObjectByName('device-status') as Object3D & { text: string };
    expect(text.text).toBe(hint); expect(text.userData.fitHeight).toBe(0.105);
    const toggle = hud.root.getObjectByName('mode-control'), pair = hud.root.getObjectByName('control-pair');
    for (let i = 0; i < 100; i++) {
      hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a tagged device' });
      hud.setDeviceState?.({ targetId: target.id, connection: 'offline', hint });
      hud.update(frame());
    }
    expect(hud.root.getObjectByName('mode-control')).toBe(toggle);
    expect(hud.root.getObjectByName('control-pair')).toBe(pair);
    hud.dispose();
  });
});
