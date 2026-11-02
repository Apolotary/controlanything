import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import { createHud } from './index';
import type { HandState, HudFrame } from './contract';
import { MouseCursor } from '../gen3d/interact';

/** Headless HUD: a real Scene/camera, a stub renderer (only its canvas listener is touched). */
function hud() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.02, 50);
  camera.position.set(0, 1.4, 0);
  camera.lookAt(0, 1.4, -1);
  camera.updateMatrixWorld(true);
  const renderer = { domElement: { addEventListener() {} } } as unknown as WebGLRenderer;
  const h = createHud({ scene, camera, renderer });
  let t = 0;
  const frame = (right?: Partial<HandState>): HudFrame => {
    t += 1 / 72;
    const hand: HandState | undefined = right
      ? { joints: {}, pinching: false, justPinched: false, justReleased: false, pinchPoint: new Vector3(), ray: { origin: camera.position.clone(), dir: new Vector3(0, 0, -1) }, ...right }
      : undefined;
    return { time: t, dt: 1 / 72, head: { position: camera.position.clone(), quaternion: camera.quaternion.clone() }, hands: hand ? { right: hand } : {} };
  };
  return { h, camera, frame, scene };
}

const items = (prefix: string) => [
  { id: `${prefix}_a`, label: 'FULL ON', kind: 'action' as const },
  { id: `${prefix}_b`, label: 'OFF', kind: 'action' as const },
];

describe('HUD floating menus', () => {
  it('menus without a placed target take distinct slots and one pinch fires exactly one hack', () => {
    const { h, frame } = hud();
    h.showHackMenu('room', { title: 'ROOM', items: items('r') });
    h.showHackMenu('unseen', { title: 'UNSEEN', items: items('u') });
    h.showHackMenu('other', { title: 'OTHER', items: items('o') });
    h.update(frame());
    const menus = h.root.children.filter((o) => o.name.startsWith('spec:hack_'));
    expect(menus).toHaveLength(3);
    for (let i = 0; i < menus.length; i++) for (let j = i + 1; j < menus.length; j++) expect(menus[i]!.position.distanceTo(menus[j]!.position)).toBeGreaterThan(0.2);

    const hacks: string[] = [];
    h.on('hack', (e) => hacks.push(`${e.targetId}:${e.itemId}`));
    // pinch on the first row of the ROOM menu, 8 cm off its centre
    const room = menus.find((m) => m.name === 'spec:hack_room')!;
    const row = room.getObjectByName('list.row0')!;
    const p = row.getWorldPosition(new Vector3());
    p.add(new Vector3(0.08, 0, 0.004).applyQuaternion(room.getWorldQuaternion(new Quaternion())));
    h.update(frame({ pinchPoint: p.clone() }));
    h.update(frame({ pinchPoint: p.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: p.clone(), justReleased: true }));
    expect(hacks).toEqual(['room:r_a']);
  });

  it('HUD chrome does not forward generic control events; generated specs do', async () => {
    const { h, frame } = hud();
    const { EXAMPLES } = await import('@ce/gen3d');
    const controls: string[] = [];
    h.on('control', (e) => controls.push(`${e.specId}:${e.controlId}:${e.phase}`));
    h.showHackMenu('room', { title: 'ROOM', items: items('r') });
    h.renderSpec(EXAMPLES['op1-knobs']!, { position: [0.4, 1.2, -0.6] });
    h.update(frame());
    const menu = h.root.children.find((o) => o.name === 'spec:hack_room')!;
    const row = menu.getObjectByName('list.row0')!.getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: row.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: row.clone(), justReleased: true }));
    expect(controls.filter((c) => c.startsWith('hack_'))).toHaveLength(0);
    const knobs = h.root.children.find((o) => o.name === 'spec:ex_op1_knobs')!;
    const cap = knobs.getObjectByName('k1.cap')!.getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: cap.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: cap.clone().add(new Vector3(0, 0.03, 0)), pinching: true }));
    h.update(frame({ pinchPoint: cap.clone().add(new Vector3(0, 0.03, 0)), justReleased: true }));
    expect(controls.some((c) => c.startsWith('ex_op1_knobs:blue:'))).toBe(true);
  });
});

describe('MouseCursor raycaster', () => {
  it('uses a millimetre line/point threshold, not three.js’s one-metre default', () => {
    const el = { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
    const m = new MouseCursor(el, new PerspectiveCamera());
    const rc = (m as unknown as { raycaster: { params: { Line: { threshold: number }; Points: { threshold: number } } } }).raycaster;
    expect(rc.params.Line.threshold).toBeLessThanOrEqual(0.005);
    expect(rc.params.Points.threshold).toBeLessThanOrEqual(0.005);
  });
});

describe('HUD redesign: one focal object, anchored to the device', () => {
  const light = { id: 'light', label: 'CEILING LIGHT', status: 'verified' as const, channel: 'ir' as const, position: [0.5, 1.95, -1.7] as [number, number, number], confirmed: true, sizeM: [0.45, 0.06, 0.45] as [number, number, number] };
  const byName = (h: { root: { children: { name: string }[] } }, name: string) => h.root.children.find((o) => o.name === name) as unknown as { getObjectByName(n: string): unknown; position: Vector3 } | undefined;

  it('shows exactly one hack list per device: the spec\u2019s embedded list hides behind the HUD menu', async () => {
    const { h, frame } = hud();
    const { EXAMPLES } = await import('@ce/gen3d');
    h.upsertTarget(light);
    h.showHackMenu('light', { title: 'CEILING LIGHT', items: items('l') });
    h.renderSpec(EXAMPLES['ceiling-dimmer']!, { targetId: 'light' });
    h.update(frame());
    const spec = byName(h, 'spec:ex_ceiling_dimmer')!;
    expect((spec.getObjectByName('hacks') as { visible: boolean }).visible).toBe(false);
    expect(h.root.children.filter((o) => o.name.startsWith('spec:hack_'))).toHaveLength(1);
  });

  it('the focal device gets a one-sentence status pill above it and <= 4 big hack buttons below; other menus collapse to chips', () => {
    const { h, frame } = hud();
    h.upsertTarget(light);
    h.setLocked('light');
    h.showHackMenu('light', { title: 'CEILING LIGHT', items: [
      { id: 'a', label: 'TURN FULL ON', kind: 'action' }, { id: 'b', label: 'TURN OFF', kind: 'action' }, { id: 'c', label: 'SET NIGHT GLOW', kind: 'action' },
      { id: 'd', label: 'BLINK', kind: 'action' }, { id: 'e', label: 'STROBE', kind: 'action' }, { id: 'f', label: 'SET BRIGHTNESS', kind: 'control' },
    ] });
    h.showHackMenu('room', { title: 'ROOM', items: items('r') });
    h.update(frame());
    const status = byName(h, 'spec:status')!;
    expect(status).toBeTruthy();
    expect(status.position.y).toBeGreaterThan(1.0);
    const buttons = byName(h, 'spec:hack_light')!;
    expect(buttons.getObjectByName('b0')).toBeTruthy();
    expect(buttons.getObjectByName('b3')).toBeTruthy();
    expect(buttons.getObjectByName('b4')).toBeFalsy(); // 5 actions → 4 buttons + "more"
    expect(buttons.getObjectByName('more')).toBeTruthy();
    expect(buttons.getObjectByName('list.row0')).toBeFalsy();
    const room = byName(h, 'spec:hack_room')!;
    expect(room.getObjectByName('plate')).toBeTruthy();
    expect(room.getObjectByName('list.row0')).toBeFalsy();
    // a pinch on the room chip expands it to the full list
    const p = (room.getObjectByName('plate') as Vector3Holder).getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: p.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: p.clone(), justReleased: true }));
    h.update(frame());
    expect(byName(h, 'spec:hack_room')!.getObjectByName('list.row0')).toBeTruthy();
  });

  it('the work log lives in a Details chip; a pinch opens the full log and another closes it', () => {
    const { h, frame } = hud();
    for (let i = 0; i < 6; i++) h.logStep({ stepId: `s${i}`, title: `STEP ${i}`, status: 'ok' });
    h.update(frame());
    const rows = (o: { getObjectByName(n: string): unknown }) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => o.getObjectByName(`log.r${i}.t`)).length;
    let det = byName(h, 'spec:details')!;
    expect(rows(det)).toBe(0);
    expect(det.getObjectByName('plate')).toBeTruthy();
    const p = (det.getObjectByName('plate') as Vector3Holder).getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: p.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: p.clone(), justReleased: true }));
    h.update(frame());
    det = byName(h, 'spec:details')!;
    expect(rows(det)).toBe(6);
    const q = (det.getObjectByName('hit') as Vector3Holder).getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: q.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: q.clone(), justReleased: true }));
    h.update(frame());
    expect(rows(byName(h, 'spec:details')!)).toBe(0);
  });

  it('a verdict pulses the device and reads on the sentence; evidence history goes to details', () => {
    const { h, frame } = hud();
    h.upsertTarget(light);
    h.setLocked('light');
    h.update(frame());
    h.showEvidence({ targetId: 'light', sent: '0x20DF10EF', expect: 'on', seen: 'brighter', verdict: 'ok' });
    h.update(frame());
    const status = byName(h, 'spec:status')!;
    const text = (status.getObjectByName('text') as { text: string }).text;
    expect(text.toLowerCase()).toContain('seen');
    expect(h.root.children.some((o) => o.name === 'spec:evidence')).toBe(false);
  });

  it('yolo targets draw as thin boxes, move cheaply and are never lockable', () => {
    const { h, frame } = hud();
    h.upsertTarget({ id: 'y1', label: 'KEYBOARD', status: 'scanned', position: [0, 1, -1], confirmed: false, sizeM: [0.3, 0.1, 0.2], score: 0.82, source: 'yolo' });
    h.update(frame());
    const y = byName(h, 'spec:yolo_y1')!;
    expect(y).toBeTruthy();
    expect((y.getObjectByName('tag') as { text: string }).text).toBe('KEYBOARD 82');
    h.upsertTarget({ id: 'y1', label: 'KEYBOARD', status: 'scanned', position: [0.1, 1, -1], confirmed: false, sizeM: [0.3, 0.1, 0.2], score: 0.9, source: 'yolo' });
    h.update(frame());
    expect(byName(h, 'spec:yolo_y1')).toBe(y); // same object, moved
    expect(y.position.x).toBeCloseTo(0.1, 5);
    h.setLocked('y1');
    expect(h.root.children.some((o) => o.name === 'spec:tgt_y1')).toBe(false);
  });
});

type Vector3Holder = { getWorldPosition(v: Vector3): Vector3 };
