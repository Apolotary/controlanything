import { afterEach, describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import type { HandState, Hud, HudFrame } from '../contract';
import { createHud } from './index';
import { makeGestureHand, moveHand, setPosture } from '../../gestures/fixtures.test-support';

const instances: Hud[] = [];
function fixture(open = true) {
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  const hud = createHud({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: {} as WebGLRenderer }); instances.push(hud);
  hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: 'Ready' });
  hud.upsertTarget({ id: 'synth', label: 'Visual synth', tagged: true, confirmed: true, connection: 'ready', status: 'verified', position: [0, 1, -1] }); hud.setLocked('synth');
  let time = 0;
  const step = (hands: HudFrame['hands'] = {}, elapsed = 16) => hud.update({ time: time += elapsed, dt: elapsed / 1000, head, hands });
  const node = (name: string) => hud.root.getObjectByName(name)!;
  hud.setDeck({ open }); step(); step();
  return { hud, head, step, node };
}
afterEach(() => instances.splice(0).forEach(hud => hud.dispose()));
function pinch(hand: HandState, down: boolean, just = false): void { hand.pinching = down; hand.justPinched = down && just; hand.justReleased = !down && just; }

describe('natural hand menu movement and recovery', () => {
  it('keeps a far-ray hand drag on its ray even when the fingertip shares the panel depth', () => {
    const f = fixture(), panel = f.node('main-menu'), handle = f.node('menu-drag');
    const before = panel.position.clone(), point = handle.getWorldPosition(new Vector3());
    const hand = makeGestureHand('pinch'); moveHand(hand, -.12, 1.22, -.59);
    hand.ray.origin.set(-.12, 1.28, -.30); hand.ray.dir.copy(point).sub(hand.ray.origin).normalize();
    // Real fingers are located below the handle, unlike controller fixtures.
    const tip = hand.joints['index-finger-tip']!.position;
    expect(Math.abs(tip.z - point.z)).toBeLessThan(.075); expect(Math.abs(tip.y - point.y)).toBeGreaterThan(.5);
    f.step({ right: hand }); pinch(hand, true, true); f.step({ right: hand });
    pinch(hand, true); f.step({ right: hand }, 80);
    expect(panel.position.distanceTo(before)).toBeLessThan(1e-5); // Old depth-only near classification jumped here.
    expect(handle.userData.pressed).toBe(true);
    const delta = new Vector3(.12, .045, 0);
    moveHand(hand, hand.joints.wrist!.position.x + delta.x, hand.joints.wrist!.position.y + delta.y, hand.joints.wrist!.position.z);
    hand.ray.dir.copy(point).add(delta).sub(hand.ray.origin).normalize(); f.step({ right: hand }, 100);
    expect(panel.position.x - before.x).toBeCloseTo(delta.x, 3); expect(panel.position.y - before.y).toBeCloseTo(delta.y, 3);
    pinch(hand, false, true); f.step({ right: hand }); const placed = panel.position.clone();
    f.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), .7); f.step({}, 2000);
    expect(panel.position).toEqual(placed);
  });

  it('moves with an actual near fingertip pinch, while a poke alone does not grab the Move bar', () => {
    const f = fixture(), panel = f.node('main-menu'), point = f.node('menu-drag').getWorldPosition(new Vector3());
    const hand = makeGestureHand('pinch'), index = hand.joints['index-finger-tip']!.position.clone();
    const at = point.clone().add(new Vector3(0, 0, .02)); moveHand(hand, at.x - index.x, at.y - index.y, at.z - index.z);
    hand.ray.origin.set(10, 10, 10); hand.ray.dir.set(0, 0, -1);
    const before = panel.position.clone(); f.step({ right: hand });
    moveHand(hand, hand.joints.wrist!.position.x, hand.joints.wrist!.position.y, hand.joints.wrist!.position.z - .04); f.step({ right: hand });
    expect(panel.position).toEqual(before);
    moveHand(hand, hand.joints.wrist!.position.x, hand.joints.wrist!.position.y, hand.joints.wrist!.position.z + .04); f.step({ right: hand });
    pinch(hand, true, true); f.step({ right: hand }); pinch(hand, true);
    moveHand(hand, hand.joints.wrist!.position.x + .10, hand.joints.wrist!.position.y + .03, hand.joints.wrist!.position.z); f.step({ right: hand }, 100);
    expect(panel.position.x - before.x).toBeCloseTo(.10, 3); expect(panel.position.y - before.y).toBeCloseTo(.03, 3);
    pinch(hand, false, true); f.step({ right: hand });
  });

  it('allows near finger pokes on the visible primary demo button without grabbing its neighbor', () => {
    const f = fixture(), button = f.node('visual-synth'), point = button.getWorldPosition(new Vector3());
    let demos = 0; f.hud.on('visualSynth', () => demos++);
    const hand = makeGestureHand('point'), index = hand.joints['index-finger-tip']!.position.clone();
    moveHand(hand, point.x - index.x, point.y - index.y, point.z + .03 - index.z);
    hand.ray.origin.set(10, 10, 10); hand.ray.dir.set(0, 0, -1);
    const before = f.node('main-menu').position.clone(); f.step({ right: hand });
    moveHand(hand, hand.joints.wrist!.position.x, hand.joints.wrist!.position.y, hand.joints.wrist!.position.z - .05); f.step({ right: hand });
    expect(demos).toBe(1); expect(f.node('main-menu').position).toEqual(before);
  });

  it('visibly dwells for a naturally raised open hand with low wrist and a nonqualifying wrist normal', () => {
    const f = fixture(false), left = makeGestureHand('open_palm'), right = makeGestureHand('open_palm');
    const rotation = new Quaternion().setFromEuler(new Euler(Math.PI / 2, Math.PI, 0, 'YXZ'));
    for (const joint of Object.values(left.joints)) if (joint) { joint.position.applyQuaternion(rotation); joint.quaternion.copy(rotation); }
    moveHand(left, -.2, 1.12, -.42); left.palmUp = false; right.palmUp = true;
    expect(left.joints.wrist!.position.y).toBeLessThan(f.head.position.y - .4);
    const palmNormal = new Vector3(0, -1, 0).applyQuaternion(rotation);
    expect(palmNormal.dot(f.head.position.clone().sub(left.joints.wrist!.position).normalize())).toBeLessThan(.65);
    for (let i = 0; i < 20; i++) f.step({ left, right });
    expect(f.hud.root.userData.menuRecall.reason).toBe('holding');
    expect(f.hud.root.userData.menuRecall.progress).toBeGreaterThan(.4);
    expect(f.node('workspace-stage')).toMatchObject({ text: expect.stringContaining('%') });
    for (let i = 0; i < 24; i++) f.step({ left, right });
    expect(f.node('main-menu').visible).toBe(true);
    f.hud.setDeck({ open: false }); for (let i = 0; i < 50; i++) f.step({ left, right });
    expect(f.node('main-menu').visible).toBe(false);
    moveHand(left, -.2, .6, -.42); f.step({ left, right }); moveHand(left, -.2, 1.12, -.42);
    for (let i = 0; i < 44; i++) f.step({ left, right }); expect(f.node('main-menu').visible).toBe(true);
  });

  it.each(['listening', 'thinking', 'setup', 'proposal'] as const)('keeps %s visible during natural hand movement and preserves explicit Menu escape', state => {
    const f = fixture(false), left = makeGestureHand('open_palm'); moveHand(left, -.2, 1.4, -.4);
    const dismissed: string[] = [];
    f.hud.on('assistantDismiss', ({ targetId }) => dismissed.push(targetId));
    f.hud.setAssistant?.({ targetId: 'synth', state, transcript: 'Make water ripples', proposalId: 'review' });
    const panel = f.node('assistant-panel'), before = panel.position.clone();
    f.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1.4);
    for (let i = 0; i < 50; i++) f.step({ left });
    expect(f.node('main-menu').visible).toBe(false); expect(panel.visible).toBe(true);
    expect(panel.position).toEqual(before); expect(dismissed).toEqual([]);
    expect(f.hud.root.userData.menuRecall.reason).toBe('assistant-active');
    expect(f.node('workspace-recovery-label')).toMatchObject({ text: expect.stringMatching(/^Muse · look /) });
    // Escape is still a deliberate ray pinch; the passive gesture did not invoke it.
    const right = makeGestureHand('pinch'); moveHand(right, .15, 1.25, -.3);
    const point = f.node('menu-toggle').getWorldPosition(new Vector3());
    right.ray.origin.set(.15, 1.25, -.3); right.ray.dir.copy(point).sub(right.ray.origin).normalize();
    f.step({ left, right }); pinch(right, true, true); f.step({ left, right });
    expect(f.node('main-menu').visible).toBe(true);
    expect(dismissed).toEqual(state === 'listening' ? ['synth'] : []);
    pinch(right, false, true); f.step({ left, right });
    f.hud.setDeck({ open: false });
    f.hud.setAssistant?.({ targetId: 'synth', state: 'reply', text: 'Result ready' });
    for (let i = 0; i < 50; i++) f.step({ left });
    expect(f.node('main-menu').visible).toBe(false); // Completion cannot replay the held hand.
  });

  it('requires lowering or closing the left hand after Perform ends, so two-palms Stop cannot open Menu', () => {
    const f = fixture(false), left = makeGestureHand('open_palm'); moveHand(left, -.2, 1.4, -.4);
    f.hud.setDeviceState?.({ targetId: 'synth', connection: 'ready', handControl: true });
    for (let i = 0; i < 50; i++) f.step({ left }); expect(f.node('main-menu').visible).toBe(false);
    f.hud.setDeviceState?.({ targetId: 'synth', connection: 'ready', handControl: false });
    for (let i = 0; i < 50; i++) f.step({ left }); expect(f.node('main-menu').visible).toBe(false);
    setPosture(left, 'fist'); f.step({ left }); setPosture(left, 'open_palm');
    for (let i = 0; i < 44; i++) f.step({ left }); expect(f.node('main-menu').visible).toBe(true);
  });
});
