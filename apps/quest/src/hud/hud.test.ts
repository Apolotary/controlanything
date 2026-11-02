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

describe('HUD declutter', () => {
  const light = { id: 'light', label: 'CEILING LIGHT', status: 'verified' as const, channel: 'ir' as const, position: [0.5, 1.95, -1.7] as [number, number, number], confirmed: true, sizeM: [0.45, 0.06, 0.45] as [number, number, number] };

  it('shows exactly one hack list per device: the spec\u2019s embedded list hides behind the HUD menu', async () => {
    const { h, frame } = hud();
    const { EXAMPLES } = await import('@ce/gen3d');
    h.upsertTarget(light);
    h.showHackMenu('light', { title: 'CEILING LIGHT', items: items('l') });
    h.renderSpec(EXAMPLES['ceiling-dimmer']!, { targetId: 'light' }); // this example carries its own hack-list part "hacks"
    h.update(frame());
    const spec = h.root.children.find((o) => o.name === 'spec:ex_ceiling_dimmer')!;
    expect(spec.getObjectByName('hacks')!.visible).toBe(false);
    expect(h.root.children.filter((o) => o.name.startsWith('spec:hack_'))).toHaveLength(1);
  });

  it('with a device locked, other menus collapse to a chip that a pinch expands', () => {
    const { h, frame } = hud();
    h.upsertTarget(light);
    h.setLocked('light');
    h.showHackMenu('light', { title: 'CEILING LIGHT', items: items('l') });
    h.showHackMenu('room', { title: 'ROOM', items: items('r') });
    h.update(frame());
    const lightMenu = h.root.children.find((o) => o.name === 'spec:hack_light')!;
    const room = h.root.children.find((o) => o.name === 'spec:hack_room')!;
    expect(lightMenu.getObjectByName('list.row0')).toBeTruthy();
    expect(room.getObjectByName('list.row0')).toBeFalsy();
    expect(room.getObjectByName('plate')).toBeTruthy();
    expect(room.position.distanceTo(lightMenu.position)).toBeGreaterThan(0.25);
    const p = room.getObjectByName('plate')!.getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: p.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: p.clone(), justReleased: true }));
    h.update(frame());
    const expanded = h.root.children.find((o) => o.name === 'spec:hack_room')!;
    expect(expanded.getObjectByName('list.row0')).toBeTruthy();
  });

  it('once controls are armed the work log becomes a 3-line ticker; a pinch brings the full log back', async () => {
    const { h, frame } = hud();
    const { EXAMPLES } = await import('@ce/gen3d');
    for (let i = 0; i < 6; i++) h.logStep({ stepId: `s${i}`, title: `STEP ${i}`, status: 'ok' });
    h.renderSpec(EXAMPLES['op1-knobs']!, { position: [0.4, 1.2, -0.6] });
    h.update(frame());
    const rows = (o: { getObjectByName(n: string): unknown }) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => o.getObjectByName(`log.r${i}.t`)).length;
    let log = h.root.children.find((o) => o.name === 'spec:worklog')!;
    expect(rows(log)).toBe(6);
    h.setArmed('ex_op1_knobs', true, 'heard');
    h.update(frame());
    log = h.root.children.find((o) => o.name === 'spec:worklog')!;
    expect(rows(log)).toBe(3);
    const p = log.getObjectByName('hit')!.getWorldPosition(new Vector3());
    h.update(frame({ pinchPoint: p.clone(), pinching: true, justPinched: true }));
    h.update(frame({ pinchPoint: p.clone(), justReleased: true }));
    h.update(frame());
    log = h.root.children.find((o) => o.name === 'spec:worklog')!;
    expect(rows(log)).toBe(6);
  });
});
