import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { EXAMPLES, type ControlEvent } from '@ce/gen3d';
import { SpecObject } from './build';
import { MaterialClock } from './materials';
import { MouseCursor, newCursor, type Cursor } from './interact';

/** Headless harness: a SpecObject at the origin, a camera 0.6 m in front, one hand cursor. */
function harness(name: string) {
  const events: ControlEvent[] = [];
  const obj = new SpecObject(EXAMPLES[name]!, { clock: new MaterialClock(), sink: { control: (e) => events.push(e) } });
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
  return { obj, events, cursor, step };
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
    const value = obj.getValue('blue') as number;
    expect(value).toBeGreaterThan(64);
    expect(events.some((e) => e.controlId === 'blue' && e.phase === 'move')).toBe(true);
    expect(events.at(-1)?.phase).toBe('end');
  });

  it('a disarmed object moves but emits nothing', () => {
    const { obj, events, cursor, step } = harness('resonance-lever');
    const arm = obj.nodes.get('arm')!;
    const p = arm.getWorldPosition(new Vector3());
    cursor.position.copy(p);
    cursor.tip.copy(p);
    step({ pinching: true, justPinched: true });
    cursor.position.set(p.x, p.y, p.z + 0.05);
    step({ pinching: true });
    step({ pinching: false, justReleased: true });
    expect(events).toHaveLength(0);
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
