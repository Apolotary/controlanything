import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { EXAMPLES, type ControlEvent } from '@ce/gen3d';
import { SpecObject } from './build';
import { MaterialClock } from './materials';
import { handCursor, MouseCursor, newCursor, type Cursor, type HandInput } from './interact';

describe('hand cursor tracking loss', () => {
  it('keeps system pinch input without inventing a fingertip or retaining wrist rotation', () => {
    const cursor = newCursor('right', 'right');
    const pose = { position: new Vector3(0.1, 1, -0.5), quaternion: new Quaternion() };
    const hand: HandInput = {
      joints: { wrist: pose, 'index-finger-tip': pose },
      pinchPoint: pose.position.clone(), pinching: false, justPinched: false, justReleased: false,
    };
    handCursor('right', hand, cursor);
    expect(cursor.canPoke).toBe(true);
    expect(cursor.wristQuat).toBeDefined();
    handCursor('right', { ...hand, joints: {}, pinching: true, justPinched: true }, cursor);
    expect(cursor).toMatchObject({ tracked: true, pinching: true, justPinched: true, canPoke: false });
    expect(cursor.wristQuat).toBeUndefined();
  });

  it('clears the ray and pinch when the source disappears', () => {
    const cursor = newCursor('left', 'left');
    const hand: HandInput = {
      joints: {}, pinchPoint: new Vector3(), pinching: true, justPinched: true, justReleased: false,
      ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
    };
    handCursor('left', hand, cursor);
    handCursor('left', undefined, cursor);
    expect(cursor).toMatchObject({ tracked: false, pinching: false, canPoke: false });
    expect(cursor.ray).toBeUndefined();
  });
});

/** Headless harness: a SpecObject at the origin, a camera 0.6 m in front, one hand cursor. */
function harness(name: string) {
  const events: ControlEvent[] = [];
  const obj = new SpecObject(structuredClone(EXAMPLES[name]!), { clock: new MaterialClock(), sink: { control: (e) => events.push(e) } });
  const camera = new PerspectiveCamera(60, 1, 0.02, 50);
  camera.position.set(0, 0, 0.6);
  obj.updateMatrixWorld(true);
  const cursor = newCursor('right', 'right');
  cursor.tracked = true;
  let t = 0;
  const step = (edits: Partial<Cursor>) => {
    Object.assign(cursor, { justPinched: false, justReleased: false }, edits);
    t += 1 / 72;
    obj.update(1 / 72, t, [cursor], camera);
  };
  return { obj, events, cursor, step, camera };
}

describe('gen3d interaction (headless)', () => {
  it('a pinch 8 cm from the centre of a 250 mm hack-list row still presses that row', () => {
    const { obj, events, cursor, step } = harness('ceiling-dimmer');
    const row = obj.nodes.get('hacks.row1')!;
    const p = row.getWorldPosition(new Vector3());
    p.x += 0.08; // near the row's right end: far outside the 24 mm grab radius of its centre
    p.z += 0.004;
    cursor.position.copy(p);
    cursor.tip.copy(p);
    step({ pinching: false });
    step({ pinching: true, justPinched: true });
    step({ pinching: false, justReleased: true });
    expect(events.map((e) => [e.controlId, e.phase, e.value])).toEqual([
      ['night', 'start', true],
      ['night', 'end', false],
    ]);
  });

  it('a sub-frame click (press and release delivered on consecutive frames) still fires start and end', () => {
    const { obj, events, cursor, step } = harness('ceiling-dimmer');
    const row = obj.nodes.get('hacks.row0')!;
    const p = row.getWorldPosition(new Vector3());
    cursor.position.copy(p);
    cursor.tip.copy(p);
    step({ pinching: true, justPinched: true });
    step({ pinching: false, justReleased: true });
    expect(events.map((e) => `${e.controlId}:${e.phase}`)).toEqual(['full:start', 'full:end']);
  });

  it('a vertical pinch-drag on a knob raises its value and emits move events', () => {
    const { obj, events, cursor, step } = harness('op1-knobs');
    const cap = obj.nodes.get('k1.cap')!;
    const p = cap.getWorldPosition(new Vector3());
    cursor.position.copy(p);
    cursor.tip.copy(p);
    step({ pinching: false });
    step({ pinching: true, justPinched: true });
    for (let i = 1; i <= 20; i++) {
      cursor.position.set(p.x, p.y + i * 0.003, p.z); // 6 cm up over 20 frames
      step({ pinching: true });
    }
    step({ pinching: false, justReleased: true });
    // a flick keeps the knob turning for a moment (momentum), then it settles with its own 'end'
    for (let i = 0; i < 60; i++) step({ pinching: false });
    const value = obj.getValue('blue') as number;
    expect(value).toBeGreaterThan(64);
    expect(events.some((e) => e.controlId === 'blue' && e.phase === 'move')).toBe(true);
    expect(events.at(-1)?.phase).toBe('end');
  });

  it('a disarmed object cannot acquire a control or change its value', () => {
    const { obj, events, cursor, step } = harness('resonance-lever');
    const arm = obj.nodes.get('arm')!;
    const p = arm.getWorldPosition(new Vector3());
    const before = [...obj.controls.values()].map((c) => c.value);
    cursor.position.copy(p);
    cursor.tip.copy(p);
    step({ pinching: true, justPinched: true });
    expect(obj.interacting).toBe(false);
    cursor.position.set(p.x, p.y, p.z + 0.05);
    step({ pinching: true });
    step({ pinching: false, justReleased: true });
    expect(events).toHaveLength(0);
    expect([...obj.controls.values()].map((c) => c.value)).toEqual(before);
  });

  it('cancels a held control when disarmed and requires a fresh pinch after rearming', () => {
    const { obj, events, cursor, step } = harness('op1-knobs');
    const p = obj.nodes.get('k1.cap')!.getWorldPosition(new Vector3());
    cursor.position.copy(p);
    step({ pinching: true, justPinched: true });
    expect(obj.interacting).toBe(true);
    obj.setArmed(false);
    expect(obj.interacting).toBe(false);
    const before = obj.getValue('blue');
    const count = events.length;
    for (let i = 0; i < 10; i++) {
      cursor.position.y += 0.01;
      step({ pinching: true });
    }
    obj.setArmed(true);
    step({ pinching: true });
    step({ pinching: false, justReleased: true });
    expect(obj.getValue('blue')).toEqual(before);
    expect(events).toHaveLength(count);
    expect(obj.interacting).toBe(false);
  });

  it('cancels a lost hand without continuing knob momentum or emitting a release command', () => {
    const { obj, events, cursor, step, camera } = harness('op1-knobs');
    cursor.position.copy(obj.nodes.get('k1.cap')!.getWorldPosition(new Vector3()));
    step({ pinching: true, justPinched: true });
    for (let i = 0; i < 5; i++) {
      cursor.position.y += 0.003;
      step({ pinching: true });
    }
    const count = events.length;
    const before = obj.getValue('blue');
    for (let i = 0; i < 20; i++) obj.update(1 / 72, 1 + i / 72, [], camera);
    expect(obj.interacting).toBe(false);
    expect(obj.getValue('blue')).toEqual(before);
    expect(events).toHaveLength(count);
  });

  it('does not emit a trigger release after cancel and starts the next press with true', () => {
    const { obj, events, cursor, step } = harness('ceiling-dimmer');
    cursor.position.copy(obj.nodes.get('hacks.row0')!.getWorldPosition(new Vector3()));
    step({ pinching: true, justPinched: true });
    obj.setArmed(false);
    step({ pinching: false, justReleased: true });
    expect(events.map((e) => [e.phase, e.value])).toEqual([['start', true]]);
    obj.setArmed(true);
    step({ pinching: true, justPinched: true });
    expect(events.map((e) => [e.phase, e.value])).toEqual([['start', true], ['start', true]]);
  });

  it('preserves arc buffers throughout value changes', () => {
    const { obj, step } = harness('op1-knobs');
    step({ pinching: false });
    const arc = obj.meshes.find((mesh) => mesh.geometry.type === 'RingGeometry' && mesh.userData.arcKey !== undefined)!;
    obj.setValue('blue', 5, { emit: false, immediate: true });
    step({ pinching: false });
    const geometry = arc.geometry;
    const positions = geometry.getAttribute('position').array;
    const first = [...positions];
    obj.setValue('blue', 115, { emit: false, immediate: true });
    step({ pinching: false });
    expect(arc.geometry).toBe(geometry);
    expect(geometry.getAttribute('position').array).toBe(positions);
    expect([...positions]).not.toEqual(first);
  });
});

describe('mouse raycast vs. HUD effects', () => {
  it('a mouse ray through the room-dim plane (even while visible) still lands on a knob', async () => {
    const { Group, PerspectiveCamera: Cam } = await import('three');
    const { RoomDim } = await import('../fx/roomDim');
    const camera = new Cam(60, 1, 0.02, 50);
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld(true);
    const root = new Group();
    const dim = new RoomDim();
    dim.target = 0.5;
    dim.update(camera, 1); // parked 0.3 m in front of the eyes, visible
    root.add(dim);
    const obj = new SpecObject(EXAMPLES['op1-knobs']!, { clock: new MaterialClock(), sink: { control: () => {} } });
    obj.position.set(0, 0, -0.6);
    root.add(obj);
    root.updateMatrixWorld(true);
    const cap = obj.nodes.get('k1.cap')!.getWorldPosition(new Vector3());
    const ndc = cap.clone().project(camera);
    const el = { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const mouse = new MouseCursor(el, camera);
    (mouse as unknown as { ndc: { set(x: number, y: number): void } }).ndc.set(ndc.x, ndc.y);
    mouse.setTargets([root]);
    const c = mouse.update();
    expect(dim.visible).toBe(true);
    expect(c.tracked).toBe(true);
    expect(c.position.distanceTo(cap)).toBeLessThan(0.03);
  });
});
