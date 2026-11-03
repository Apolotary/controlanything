import { afterEach, describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Quaternion, Scene, Vector3, type Object3D, type WebGLRenderer } from 'three';
import type { HandState, Hud, HudFrame, HudTarget } from '../contract';
import { createHud } from './index';
import { makeGestureHand, moveHand, setPosture } from '../../gestures/fixtures.test-support';

const UP = new Vector3(0, 1, 0);
const target: HudTarget = { id: 'lamp', tagged: true, connection: 'ready', label: 'Ceiling light', status: 'scanned',
  position: [0.4, 0.4, -3], confirmed: true, facing: [0, 0, 1], sizeM: [0.3, 0.2, 0.05] };
const instances: Hud[] = [];
function setup(kind: 'idle' | 'card' | 'modal' | 'menu' = 'idle', nonDominant: 'left' | 'right' = 'left') {
  const hud = createHud({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: {} as WebGLRenderer, nonDominant }); instances.push(hud);
  hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Choose a device' });
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  if (kind === 'card') { hud.upsertTarget(target); hud.setLocked(target.id); }
  if (kind === 'modal') hud.showConfirm({ id: 'allow', title: 'Allow device control' });
  if (kind === 'menu') hud.setDeck({ open: true });
  const node = (name: string) => hud.root.getObjectByName(name)!;
  const panel = node(kind === 'modal' ? 'confirmation-panel' : kind === 'menu' ? 'main-menu' : kind === 'idle' ? 'hand-dock' : 'device-card');
  const update = (time: number, hands: HudFrame['hands'] = {}, tracked = false) => hud.update({ time, dt: 1 / 72, ...(tracked ? {} : { pointer: 'mouse' as const }), head, hands });
  return { hud, head, panel, node, update };
}
function local(panel: Object3D, head: HudFrame['head']): Vector3 { return panel.position.clone().sub(head.position).applyQuaternion(head.quaternion.clone().invert()); }
afterEach(() => instances.splice(0).forEach((hud) => hud.dispose()));

describe('comfortable and explicitly recoverable HUD placement', () => {
  it('uses the first headset pose and keeps navigation above the desk even when looking down', () => {
    const f = setup('card'); f.head.position.set(2, 1.2, 3); f.head.quaternion.setFromEuler(new Euler(-0.9, Math.PI / 4, 0, 'YXZ')); f.update(0);
    const launcher = f.node('hand-dock');
    expect(launcher.position.y).toBeCloseTo(f.head.position.y - 0.06 + 0.378);
    expect(f.panel.position.y).toBeCloseTo(f.head.position.y - 0.06);
    expect(f.panel.position.distanceTo(f.head.position)).toBeCloseTo(Math.hypot(0.65, 0.06));
    expect(new Vector3(0, 1, 0).applyQuaternion(f.panel.quaternion).distanceTo(UP)).toBeLessThan(1e-6);
    const position = launcher.position.clone(); f.hud.upsertTarget({ ...target, position: [2, -4, 2] }); f.update(300);
    expect(launcher.position).toEqual(position);
  });

  it.each(['idle', 'card', 'modal', 'menu'] as const)('keeps the open %s fixed through long looks and a step while reaching', (kind) => {
    const f = setup(kind); f.update(0); const position = f.panel.position.clone(), rotation = f.panel.quaternion.clone();
    f.head.position.x = 0.9; f.head.quaternion.setFromAxisAngle(UP, Math.PI / 2); f.update(100); f.update(1700); f.update(4000);
    expect(f.panel.position).toEqual(position); expect(f.panel.quaternion.toArray()).toEqual(rotation.toArray());
    f.hud.recenter?.(); f.update(4010);
    expect(f.panel.position.distanceTo(position)).toBeGreaterThan(0.3);
    expect(Math.abs(local(f.panel, f.head).x)).toBeLessThan(1e-6); expect(local(f.panel, f.head).z).toBeLessThan(-0.64);
  });

  it.each(['card', 'menu'] as const)('allows an explicit title drag of the %s and retains that placement after release', (kind) => {
    const f = setup(kind); f.update(0); f.update(300);
    const handle = f.node(kind === 'card' ? 'device-drag' : 'menu-drag');
    const origin = f.panel.position.clone(), point = handle.getWorldPosition(new Vector3());
    const hand = (at: Vector3, pressed = false, just = false, released = false): HandState => ({
      controller: true, joints: {}, pinchPoint: new Vector3(10, 10, 10), pinching: pressed, justPinched: just, justReleased: released,
      ray: { origin: f.head.position.clone(), dir: at.clone().sub(f.head.position).normalize() },
    });
    f.update(400, { right: hand(point) }); f.update(420, { right: hand(point, true, true) });
    const moved = point.clone().add(new Vector3(0.12, 0.04, 0));
    f.update(600, { right: hand(moved, true) }); f.update(700, { right: hand(moved, false, false, true) });
    expect(f.panel.position.x - origin.x).toBeCloseTo(0.12, 2);
    expect(f.panel.position.y - origin.y).toBeCloseTo(0.04, 2);
    const settled = f.panel.position.clone(); f.head.quaternion.setFromAxisAngle(UP, 0.6); f.update(5000);
    expect(f.panel.position).toEqual(settled);
  });

  it('keeps a direct title-edge drag from being stolen by nearby Ask Muse button assistance', () => {
    const f = setup('card'); f.update(0); f.update(300);
    let asks = 0; f.hud.on('assistantTalk', () => asks++);
    const handle = f.node('device-drag'), origin = f.panel.position.clone();
    const point = handle.localToWorld(new Vector3(0, 0.016, 0));
    const hand = (at: Vector3, pressed = false, just = false, released = false): HandState => ({
      controller: true, joints: {}, pinchPoint: new Vector3(10, 10, 10), pinching: pressed, justPinched: just, justReleased: released,
      ray: { origin: f.head.position.clone(), dir: at.clone().sub(f.head.position).normalize() },
    });
    f.update(400, { right: hand(point) }); f.update(420, { right: hand(point, true, true) });
    const moved = point.clone().add(new Vector3(0.12, 0.04, 0));
    f.update(600, { right: hand(moved, true) }); f.update(700, { right: hand(moved, false, false, true) });
    expect(asks).toBe(0);
    expect(f.panel.position.x - origin.x).toBeCloseTo(0.12, 2);
    expect(f.panel.position.y - origin.y).toBeCloseTo(0.04, 2);
  });

  it('does not jump the controls when a conversation opens, changes state, or is dismissed', () => {
    const f = setup('card'); f.update(300); const origin = f.panel.position.clone();
    f.head.quaternion.setFromAxisAngle(UP, 0.4); f.head.position.x += 0.2;
    f.hud.setAssistant?.({ targetId: target.id, state: 'thinking', transcript: 'Use my hand depth' }); f.update(600);
    expect(f.node('assistant-panel').position).toEqual(origin);
    f.hud.setAssistant?.({ targetId: target.id, state: 'error', text: 'No new mapping was applied.' }); f.update(800);
    f.hud.setAssistant?.(null); f.update(1000); expect(f.panel.position).toEqual(origin);
  });

  it.each(['left', 'right'] as const)('recalls with the left palm even when the non-dominant hand is %s, and keeps Exit AR reachable', (nonDominant) => {
    const f = setup('idle', nonDominant); f.update(0); f.head.quaternion.setFromAxisAngle(UP, Math.PI / 2);
    const palm = makeGestureHand('open_palm'); moveHand(palm, -0.3, 1.5, 0);
    palm.palmUp = true; palm.palmUpMs = 700;
    palm.pinchPoint.set(10, 10, 10); palm.ray.origin.set(10, 10, 10);
    f.update(50, { right: palm }, true);
    expect(f.node('main-menu').visible).toBe(false);
    f.update(100, { left: palm }, true); f.update(750, { left: palm }, true);
    const menu = f.node('main-menu'); expect(menu.visible).toBe(true); expect(Math.abs(local(menu, f.head).x)).toBeLessThan(1e-6);
    const anchored = menu.position.clone(); f.head.position.x += 0.1; f.head.quaternion.identity(); f.update(3000, { left: palm }, true);
    expect(menu.position).toEqual(anchored);
    f.hud.setDeck({ open: false }); f.update(3010, {}, true); f.update(3020, { left: palm }, true);
    expect(menu.visible).toBe(false); // Reacquired hands must complete a fresh open-palm dwell.
    setPosture(palm, 'fist'); f.update(3030, { left: palm }, true); setPosture(palm, 'open_palm'); f.update(3040, { left: palm }, true); f.update(3700, { left: palm }, true);
    expect(menu.visible).toBe(true); expect(menu.position).not.toEqual(anchored);
    menu.updateMatrixWorld(true);
    const exit = f.node('exit-ar').getWorldPosition(new Vector3()).sub(f.head.position);
    expect(exit.y).toBeGreaterThan(-0.25); expect(exit.length()).toBeLessThan(0.9);
  });

  it.each(['reply'] as const)('recalls an offscreen %s conversation without cancelling its request', (state) => {
    for (const targetId of [target.id, 'muse-general']) {
      const f = setup('card'); f.update(0);
      const dismissed: string[] = [];
      f.hud.on('assistantDismiss', (event) => dismissed.push(event.targetId));
      f.hud.setAssistant?.({ targetId, state, transcript: 'Keep this request.', text: 'The current request is retained.' });
      f.update(10);
      const assistant = f.node('assistant-panel'), previous = assistant.position.clone();
      f.head.quaternion.setFromAxisAngle(UP, Math.PI / 2); f.update(20);
      expect(assistant.position).toEqual(previous);
      const left = makeGestureHand('open_palm'); moveHand(left, -0.3, 1.5, 0);
      left.palmUp = true; left.pinchPoint.set(10, 10, 10); left.ray.origin.set(10, 10, 10);
      f.update(100, { left }, true); f.update(749, { left }, true);
      expect(f.node('main-menu').visible).toBe(false);
      f.update(750, { left }, true);
      expect(f.node('main-menu').visible).toBe(true);
      expect(Math.abs(local(f.node('main-menu'), f.head).x)).toBeLessThan(1e-6);
      expect(assistant.visible).toBe(false); expect(dismissed).toEqual([]);
      f.hud.setDeck({ open: false }); f.update(800, { left }, true);
      expect(f.node('main-menu').visible).toBe(false);
      expect(assistant.visible).toBe(true); expect(assistant.userData.state).toBe(state);
      expect(Math.abs(local(assistant, f.head).x)).toBeLessThan(1e-6);
      expect(assistant.position.distanceTo(previous)).toBeGreaterThan(0.3);
      expect(f.node('assistant-transcript')).toMatchObject({ text: 'You: Keep this request.' });
      expect(dismissed).toEqual([]);
    }
  });

  it.each(['idle'] as const)('dismisses the unused assistant when deliberate recall interrupts %s', (state) => {
    const f = setup('card'); f.update(0);
    const dismissed: string[] = [];
    f.hud.on('assistantDismiss', (event) => { dismissed.push(event.targetId); f.hud.setAssistant?.(null); });
    f.hud.setAssistant?.({ targetId: target.id, state });
    const left = makeGestureHand('open_palm'); moveHand(left, -0.3, 1.5, 0);
    left.palmUp = true; left.pinchPoint.set(10, 10, 10); left.ray.origin.set(10, 10, 10);
    f.update(100, { left }, true); f.update(749, { left }, true);
    expect(dismissed).toEqual([]);
    f.update(750, { left }, true);
    expect(f.node('main-menu').visible).toBe(true); expect(dismissed).toEqual([target.id]);
    f.hud.setDeck({ open: false }); f.update(800, { left }, true);
    expect(f.node('assistant-panel').visible).toBe(false);
    expect(f.node('device-card').visible).toBe(true);
  });

  it('keeps a pending confirmation isolated while recalling Menu over a retained conversation', () => {
    const f = setup('card'); f.update(0);
    f.hud.setAssistant?.({ targetId: target.id, state: 'thinking', transcript: 'Keep this request.' });
    f.hud.showConfirm({ id: 'arm', kind: 'arm', title: 'Enable controls' });
    const confirmations: string[] = [];
    f.hud.on('confirm', (event) => confirmations.push(event.id));
    const left = makeGestureHand('open_palm'); moveHand(left, -0.3, 1.5, 0);
    left.palmUp = true; left.pinchPoint.set(10, 10, 10); left.ray.origin.set(10, 10, 10);
    f.update(100, { left }, true); f.update(750, { left }, true);
    expect(f.node('main-menu').visible).toBe(true);
    expect(f.node('confirmation-panel').parent?.visible).toBe(false);
    expect(f.node('assistant-panel').visible).toBe(false); expect(confirmations).toEqual([]);
    f.hud.setDeck({ open: false }); f.update(800, { left }, true);
    expect(f.node('confirmation-panel').parent?.visible).toBe(true);
    expect(f.node('assistant-panel').visible).toBe(false); expect(confirmations).toEqual([]);
    f.hud.showConfirm(null);
    expect(f.node('assistant-panel').visible).toBe(true);
    expect(f.node('assistant-panel').userData.state).toBe('thinking');
  });

  it('does not recall Menu for the Perform fist or carry its dwell into a brief clutch release', () => {
    const f = setup('card'); f.update(0);
    f.hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Ready', canStop: true });
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', performAvailable: true, handControl: true, performingLive: true });
    const left = makeGestureHand('fist'); moveHand(left, -0.2, 1.4, -0.4);
    left.palmUp = true; left.palmUpMs = 1000;
    const right = makeGestureHand('open_palm'); moveHand(right, 0.2, 1.4, -0.4);
    f.update(100, { left, right }, true); f.update(1100, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(false);
    setPosture(left, 'open_palm');
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', performAvailable: true, handControl: true, performingLive: false });
    f.update(1200, { left, right }, true); f.update(1849, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(false);
    f.update(5000, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(false); // Gesture pauses cannot navigate away from Perform.
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', performAvailable: true, handControl: false });
    f.update(5100, { left, right }, true); expect(f.node('main-menu').visible).toBe(false);
    setPosture(left, 'fist'); f.update(5200, { left, right }, true); setPosture(left, 'open_palm');
    f.update(5300, { left, right }, true); f.update(5950, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(true);
    expect(f.node('deck:panic').visible).toBe(true);
  });

  it('leaves both palms available for Stop and does not count missing finger joints as an open palm', () => {
    const f = setup('card'); f.update(0);
    const left = makeGestureHand('open_palm'), right = makeGestureHand('open_palm');
    moveHand(left, -0.2, 1.4, -0.4); moveHand(right, 0.2, 1.4, -0.4);
    left.palmUp = right.palmUp = true;
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', handControl: true });
    f.update(100, { left, right }, true); f.update(1000, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(false);
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', handControl: false });
    right.palmUp = false; delete left.joints['pinky-finger-tip'];
    f.update(1100, { left, right }, true); f.update(2000, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(false);
  });

  it.each(['closed', 'lowered', 'missing'] as const)('allows another deliberate recall after the left hand is %s', (release) => {
    const f = setup(); f.update(0);
    const left = makeGestureHand('open_palm'); moveHand(left, -0.2, 1.4, -0.4); left.palmUp = true;
    f.update(100, { left }, true); f.update(750, { left }, true);
    expect(f.node('main-menu').visible).toBe(true); f.hud.setDeck({ open: false });
    if (release === 'closed') setPosture(left, 'fist');
    if (release === 'lowered') moveHand(left, -0.2, 0.9, -0.4);
    f.update(800, release === 'missing' ? {} : { left }, true);
    setPosture(left, 'open_palm'); moveHand(left, -0.2, 1.4, -0.4);
    f.update(900, { left }, true); f.update(1549, { left }, true);
    expect(f.node('main-menu').visible).toBe(false);
    f.update(1550, { left }, true); expect(f.node('main-menu').visible).toBe(true);
  });

  it('does not release the recall latch merely because the right palm turns toward the head', () => {
    const f = setup(); f.update(0);
    const left = makeGestureHand('open_palm'), right = makeGestureHand('open_palm');
    moveHand(left, -0.2, 1.4, -0.4); moveHand(right, 0.2, 1.4, -0.4); left.palmUp = true;
    f.update(100, { left, right }, true); f.update(750, { left, right }, true);
    f.hud.setDeck({ open: false }); right.palmUp = true; f.update(800, { left, right }, true);
    right.palmUp = false; f.update(900, { left, right }, true); f.update(1550, { left, right }, true);
    expect(f.node('main-menu').visible).toBe(false);
  });

  it('recalls from a controller button without attaching navigation to the moving grip', () => {
    const f = setup(); f.update(0);
    const controller: HandState = { controller: true, grip: { position: new Vector3(-0.2, 0.8, -0.2), quaternion: new Quaternion() },
      menuPressed: true, joints: {}, pinching: false, justPinched: false, justReleased: false, pinchPoint: new Vector3(10, 10, 10),
      ray: { origin: new Vector3(10, 10, 10), dir: new Vector3(0, 0, -1) } };
    f.update(100, { left: controller }, true); const menu = f.node('main-menu'), position = menu.position.clone(); expect(menu.visible).toBe(true);
    controller.menuPressed = false; controller.grip!.position.y -= 0.5; f.head.quaternion.setFromAxisAngle(UP, 1); f.update(4000, { left: controller }, true);
    expect(menu.position).toEqual(position); expect(f.node('hand-dock').userData.anchor).toBe('world');
  });

  it('uses one reachable conversation workspace and restores the control card after dismissal', () => {
    const f = setup('card'); f.update(300); f.hud.setAssistant?.({ targetId: target.id, state: 'listening' }); f.update(320);
    const assistant = f.node('assistant-panel'), card = f.node('device-card');
    expect(assistant.visible).toBe(true); expect(f.node('assistant-send').visible).toBe(true);
    expect(card.visible).toBe(false);
    expect(Math.abs(local(assistant, f.head).x)).toBeLessThan(1e-6);
    expect(assistant.position.distanceTo(f.head.position)).toBeLessThan(0.66);
    const pair = [card.position.clone(), assistant.position.clone()];
    f.head.position.x += 0.4; f.head.quaternion.setFromAxisAngle(UP, Math.PI / 2); f.update(5000);
    expect(card.position).toEqual(pair[0]); expect(assistant.position).toEqual(pair[1]);
    f.hud.recenter?.(); f.update(5010); expect(card.position).not.toEqual(pair[0]); expect(assistant.position).not.toEqual(pair[1]);
    f.hud.setAssistant?.(null); f.update(5020);
    expect(Math.abs(local(card, f.head).x)).toBeLessThan(1e-6); expect(assistant.visible).toBe(false); expect(card.visible).toBe(true);
  });
});
