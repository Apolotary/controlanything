import { describe, expect, it } from 'vitest';
import { Group, Quaternion, Vector3 } from 'three';
import type { HandState, HudFrame } from '../contract';
import { DockHold, FingerTouchDetector, HandDockAnchor, type FingerMenuFinger } from './hand-dock';
import { WristPalette, type PaletteItem } from './wrist-palette';

it('puts layer and object filters first while keeping virtual demos on More with persistent Stop and held Exit', () => {
  const palette = new WristPalette({} as never);
  let annotate = true, actions = 0;
  const add = (key: string, order: number, extra: Partial<PaletteItem> = {}) => palette.register({ key, label: key, order, onSelect() { actions++; }, ...extra });
  add('ask-muse', -40, { section: 'primary', visible: () => !annotate });
  add('layer', -100, { section: 'primary', segments: [{ key: 'annotate', label: 'Annotate', width: .094 }, { key: 'control', label: 'Control', width: .094 }] });
  add('track', -90, { section: 'primary', visible: () => annotate, segments: [{ key: 'electronics', label: 'Electronics', width: .086 }, { key: 'objects', label: 'Objects', width: .064 }, { key: 'everything', label: 'All', width: .04 }] });
  add('visual-synth', 0); add('musical-synth', 1); add('buddy', 10);
  add('tangible:pick', 60, { visible: () => !annotate });
  add('deck:panic', 80); add('tutorial', 85); add('exit-ar', 90, { hold: true });
  const rebuild = () => { palette.contentGroup.clear(); palette.rebuild(); };
  rebuild();
  const main = ['layer:annotate', 'layer:control', 'track:electronics', 'track:objects', 'track:everything', 'palette-more', 'deck:panic', 'exit-ar'];
  expect(palette.buttons.map(button => button.name)).toEqual(main);
  expect(palette.userData.height).toBeLessThan(.25);
  expect(palette.item('palette-more')?.keepOpen).toBe(true);
  expect(palette.item('exit-ar')?.hold).toBe(true);
  expect(palette.getObjectByName('track:electronics')!.userData.width).toBeGreaterThan(.10);
  const stop = palette.getObjectByName('deck:panic')!, exit = palette.getObjectByName('exit-ar')!;
  expect(stop.position.y).toBe(exit.position.y);
  expect(stop.position.x + stop.userData.width / 2).toBeLessThan(exit.position.x - exit.userData.width / 2);

  palette.item('palette-more')!.onSelect(); expect(palette.needsRebuild()).toBe(true); rebuild();
  expect(palette.userData.page).toBe('more');
  expect(palette.buttons.map(button => button.name)).toEqual(['palette-back', 'visual-synth', 'musical-synth', 'buddy', 'tutorial', 'deck:panic', 'exit-ar']);
  expect(palette.userData.height).toBeLessThan(.31);
  expect(palette.item('palette-back')?.keepOpen).toBe(true);
  expect(actions).toBe(0); // Browsing never selects a feature or starts a command.
  annotate = false; expect(palette.needsRebuild()).toBe(true); rebuild();
  expect(palette.buttons.some(button => button.name === 'tangible:pick')).toBe(true);
  expect(palette.buttons.some(button => button.name.startsWith('track:'))).toBe(false);
  expect(palette.userData.height).toBeLessThan(.31);

  palette.item('palette-back')!.onSelect(); rebuild();
  expect(palette.buttons.map(button => button.name)).toEqual(['layer:annotate', 'layer:control', 'ask-muse', 'palette-more', 'deck:panic', 'exit-ar']);
  palette.item('palette-more')!.onSelect(); rebuild();
  palette.update({ time: 0, dt: .016, head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() },
    hands: { left: hand(-.2, false) } });
  expect(palette.userData.page).toBe('primary');
  expect(actions).toBe(0);
});

it('keeps excess explicit purpose actions reachable instead of dropping them', () => {
  const palette = new WristPalette({} as never);
  for (let i = 0; i < 5; i++) palette.register({ key: `purpose-${i}`, label: `Purpose ${i}`, section: 'primary', order: i, onSelect() {} });
  palette.rebuild(); expect(palette.buttons.map(button => button.name)).toEqual(['purpose-0', 'purpose-1', 'palette-more']);
  palette.item('palette-more')!.onSelect(); palette.contentGroup.clear(); palette.rebuild();
  expect(palette.buttons.map(button => button.name)).toEqual(['palette-back', 'purpose-2', 'purpose-3', 'purpose-4']);
});

function hand(x = -0.2, palmUp = true, palmUpMs = 450): HandState {
  return {
    joints: {
      wrist: { position: new Vector3(x, 1.3, -0.4), quaternion: new Quaternion(), radius: 0.01 },
      'middle-finger-phalanx-proximal': { position: new Vector3(x, 1.3, -0.48), quaternion: new Quaternion(), radius: 0.008 },
      'thumb-tip': { position: new Vector3(x - 0.08, 1.3, -0.46), quaternion: new Quaternion(), radius: 0.008 },
      'middle-finger-tip': { position: new Vector3(x, 1.3, -0.56), quaternion: new Quaternion(), radius: 0.008 },
      'ring-finger-tip': { position: new Vector3(x + 0.04, 1.3, -0.54), quaternion: new Quaternion(), radius: 0.008 },
      'pinky-finger-tip': { position: new Vector3(x + 0.08, 1.3, -0.51), quaternion: new Quaternion(), radius: 0.008 },
    },
    palmUp, palmUpMs, controller: false,
    pinching: false, justPinched: false, justReleased: false, pinchPoint: new Vector3(),
    ray: { origin: new Vector3(), dir: new Vector3(0, 0, -1) },
  };
}

function setup(nonDominant: 'left' | 'right' = 'left') {
  const anchor = new HandDockAnchor(nonDominant), dock = new Group(), wrist = new Group();
  const frame: HudFrame = {
    time: 0, dt: 0.016,
    head: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() },
    hands: {},
  };
  const update = (time: number) => { frame.time = time; anchor.update(frame, dock, wrist, 0.192); };
  return { anchor, dock, wrist, frame, update };
}

function controller(position = new Vector3(-0.18, 1.4, -0.4)): HandState {
  return { ...hand(), joints: {}, controller: true, grip: { position, quaternion: new Quaternion() } };
}

describe('HandDockAnchor', () => {
  const moveHeight = (menuHand: HandState, delta: number) => {
    for (const joint of Object.values(menuHand.joints)) if (joint) joint.position.y += delta;
  };

  it('re-arms after a dismissed palm is lowered, requiring a fresh raised dwell without turning the palm away', () => {
    const f = setup(); f.frame.hands.left = hand(-.2, true, 10_000);
    f.update(0); f.update(450); expect(f.anchor.open).toBe(true);
    f.anchor.dismiss(450); f.update(500); expect(f.anchor.open).toBe(false);
    moveHeight(f.frame.hands.left, -.6); f.update(550);
    moveHeight(f.frame.hands.left, .6); f.update(600); f.update(1049);
    expect(f.anchor.open).toBe(false);
    f.update(1050); expect(f.anchor.open).toBe(true);
  });

  it('does not reuse palm-facing time gathered while lowered or blocked as a raised opening dwell', () => {
    const f = setup(); f.frame.hands.left = hand(-.2, true, 10_000);
    moveHeight(f.frame.hands.left, -.6); f.update(0); f.update(1000);
    moveHeight(f.frame.hands.left, .6); f.update(1016); expect(f.anchor.open).toBe(false);
    f.update(1400); f.anchor.blockOpen = true; f.update(1401);
    f.anchor.blockOpen = false; f.update(1500); f.update(1949);
    expect(f.anchor.open).toBe(false);
    f.update(1950); expect(f.anchor.open).toBe(true);
  });

  it('ignores a relaxed palm-up hand below chest height and a hand still moving into place', () => {
    const f = setup(); f.frame.hands.left = hand(-.2, true, 10_000);
    moveHeight(f.frame.hands.left, -.1); // 40 cm below the eyes: waist/desk level
    f.update(0); f.update(2000); expect(f.anchor.open).toBe(false);
    moveHeight(f.frame.hands.left, .1); f.update(2016);
    for (let t = 2032; t <= 2800; t += 16) { moveHeight(f.frame.hands.left, .004); f.update(t); } // still rising, 25 cm/s
    expect(f.anchor.open).toBe(false);
    f.update(3250); expect(f.anchor.open).toBe(true);
  });

  it('opens on a raised palm with a pinch held 250 ms, never while blocked, and only once per pinch', () => {
    const f = setup(); const menuHand = f.frame.hands.left = hand(-.2, true, 10_000);
    menuHand.pinching = menuHand.justPinched = true; f.anchor.blockOpen = true; f.update(0);
    menuHand.justPinched = false; f.anchor.blockOpen = false; f.update(400); expect(f.anchor.open).toBe(false);
    menuHand.pinching = false; f.update(420);
    menuHand.pinching = menuHand.justPinched = true; f.update(440); menuHand.justPinched = false;
    f.update(689); expect(f.anchor.open).toBe(false);
    f.update(690); expect(f.anchor.open).toBe(true);
    f.anchor.dismiss(700); f.update(1200); expect(f.anchor.open).toBe(false);
  });

  it('freezes an open menu at its raised position and closes it after lowering even while the palm still faces the eyes', () => {
    const f = setup(); f.frame.hands.left = hand(-.2, true, 10_000);
    f.update(0); f.update(450); f.update(630); const position = f.dock.position.clone();
    moveHeight(f.frame.hands.left, -.6); f.update(700); f.update(999);
    expect(f.anchor.open).toBe(true); expect(f.dock.position.distanceTo(position)).toBe(0);
    f.update(1000); expect(f.anchor.open).toBe(false);
    f.update(1180); expect(f.anchor.opacity).toBe(0);
  });

  it.each(['left', 'right'] as const)('attaches to the %s non-dominant hand after its palm dwell', (side) => {
    const { anchor, dock, wrist, frame, update } = setup(side);
    const menuHand = hand(side === 'left' ? -0.2 : 0.2, true, 449);
    frame.hands = { left: hand(-0.2), right: hand(0.2), [side]: menuHand };
    update(0);
    update(449);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(wrist.visible).toBe(true);
    expect(anchor.wristOpacity).toBe(0.6);
    menuHand.palmUpMs = 450;
    update(450);
    expect(anchor.open).toBe(true);
    expect(anchor.justOpened).toBe(true);
    expect(anchor.opacity).toBe(0);
    const knuckle = menuHand.joints['middle-finger-phalanx-proximal']!.position;
    expect(dock.position.distanceTo(knuckle)).toBeCloseTo(0.06);
    expect(Math.sign(dock.position.x)).toBe(side === 'left' ? -1 : 1);
    const facing = new Vector3(0, 0, 1).applyQuaternion(dock.quaternion);
    expect(facing.dot(frame.head.position.clone().sub(dock.position).normalize())).toBeCloseTo(1);
    update(630);
    expect(anchor.opacity).toBe(1);
    expect(anchor.justOpened).toBe(false);
    expect(wrist.visible).toBe(true);
    expect(anchor.wristOpacity).toBe(0.6);
    expect(wrist.quaternion.angleTo(dock.quaternion)).toBeLessThan(1e-8);
  });

  it('waits 300 ms after the palm turns away, then fades out over 180 ms', () => {
    const { anchor, wrist, frame, update } = setup();
    frame.hands.left = hand();
    update(0); update(450); update(630);
    frame.hands.left.palmUp = false;
    update(650); update(949);
    expect(anchor.open).toBe(true);
    update(950);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(1);
    update(1040);
    expect(anchor.opacity).toBeGreaterThan(0);
    expect(anchor.opacity).toBeLessThan(1);
    expect(wrist.visible).toBe(true);
    update(1130);
    expect(anchor.opacity).toBe(0);
    expect(anchor.wristOpacity).toBe(0.6);
  });

  it('holds an open menu near the other hand at a menu fingertip, then releases it', () => {
    const { anchor, dock, frame, update } = setup();
    frame.hands.left = hand();
    update(0); update(450); update(630);
    const other = hand(0.2);
    const menuTip = frame.hands.left.joints['pinky-finger-tip']!.position;
    const tip = { position: menuTip.clone().add(new Vector3(0.04, 0, 0.04)), quaternion: new Quaternion(), radius: 0.008 };
    other.joints['index-finger-tip'] = tip;
    frame.hands.right = other;
    frame.hands.left.palmUp = false;
    update(650); update(1450);
    expect(anchor.open).toBe(true);
    tip.position.copy(menuTip).add(new Vector3(0.25, 0, 0));
    update(1550); update(1850); update(2030);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    tip.position.copy(dock.position);
    update(2250);
    expect(anchor.open).toBe(false);
  });

  it('does not keep itself open with the menu hand fingertip', () => {
    const { anchor, dock, frame, update } = setup();
    frame.hands.left = hand();
    update(0); update(450); update(630);
    frame.hands.left.palmUp = false;
    frame.hands.left.joints['index-finger-tip'] = { position: dock.position.clone(), quaternion: new Quaternion(), radius: 0.008 };
    update(650); update(950);
    expect(anchor.open).toBe(false);
  });

  it('smooths hand motion with an 80 ms time constant while keeping the anchor upright', () => {
    const { dock, frame, update } = setup();
    const menuHand = hand(); frame.hands.left = menuHand;
    update(0);
    const before = dock.position.clone();
    menuHand.joints.wrist!.position.x += 0.2;
    menuHand.joints['middle-finger-phalanx-proximal']!.position.x += 0.2;
    menuHand.joints.wrist!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.6);
    frame.dt = 0.08;
    update(80);
    const knuckle = menuHand.joints['middle-finger-phalanx-proximal']!.position;
    const destination = knuckle.clone().addScaledVector(frame.head.position.clone().sub(knuckle).normalize(), 0.06);
    expect(dock.position.distanceTo(before.clone().lerp(destination, 1 - Math.exp(-1)))).toBeLessThan(1e-8);
    expect(new Vector3(1, 0, 0).applyQuaternion(dock.quaternion).y).toBeCloseTo(0, 2);
  });

  it('hides immediately when only the dominant hand remains and requires a new palm dwell on return', () => {
    const { anchor, wrist, frame, update } = setup();
    frame.hands.left = hand(); frame.hands.right = hand(0.2);
    update(0); update(450); update(630);
    delete frame.hands.left;
    update(650);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    expect(wrist.visible).toBe(false);
    frame.hands.left = hand(-0.2, true, 0);
    update(750);
    expect(anchor.open).toBe(false);
  });

  it('never reveals a world fallback for missing controller poses, and hands take priority immediately', () => {
    const { anchor, dock, wrist, frame, update } = setup();
    dock.position.set(1, 2, 3);
    frame.hands.left = { ...hand(), controller: true };
    update(0);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    expect(wrist.visible).toBe(false);
    expect(dock.position.toArray()).toEqual([1, 2, 3]);
    frame.hands.left = { ...hand(), joints: {} };
    update(20);
    expect(anchor.tracked).toBe(true);
    frame.hands.left = hand(-0.2, false, 0);
    update(40);
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
    expect(wrist.visible).toBe(true);
  });

  it('opens above the left controller after a raised dwell and follows the grip smoothly', () => {
    const { anchor, dock, frame, update } = setup('right');
    frame.hands.left = controller();
    update(0); update(299);
    expect(anchor.source).toBe('controller');
    expect(anchor.tracked).toBe(true);
    expect(anchor.open).toBe(false);
    update(300); update(480);
    expect(anchor.open).toBe(true);
    expect(anchor.opacity).toBe(1);
    const grip = frame.hands.left.grip!;
    expect(dock.position.y).toBeGreaterThan(grip.position.y + 0.1);
    const facing = new Vector3(0, 0, 1).applyQuaternion(dock.quaternion);
    expect(facing.dot(frame.head.position.clone().sub(dock.position).normalize())).toBeCloseTo(1);
    const before = dock.position.clone();
    grip.position.x += 0.1;
    frame.dt = 0.08;
    update(560);
    const target = grip.position.clone().add(new Vector3(0, 0.11, 0));
    target.addScaledVector(frame.head.position.clone().sub(target).normalize(), 0.04);
    expect(dock.position.distanceTo(before.clone().lerp(target, 1 - Math.exp(-1)))).toBeLessThan(1e-8);
  });

  it('keeps the raised dock stable near its threshold, then closes after lowering', () => {
    const { anchor, frame, update } = setup();
    frame.hands.left = controller(new Vector3(0, 1.3, -0.5));
    update(0); update(300); update(480);
    frame.hands.left.grip!.position.y = 1.19;
    update(600); update(1000);
    expect(anchor.open).toBe(true);
    frame.hands.left.grip!.position.y = 1.0;
    update(1100); update(1400); update(1580);
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
  });

  it('opens from the left menu button while lowered, with no right-controller substitute', () => {
    const { anchor, frame, update } = setup();
    frame.hands.left = controller(new Vector3(-0.2, 0.9, -0.4));
    update(0);
    frame.hands.left.menuPressed = true;
    update(20);
    expect(anchor.open).toBe(true);
    frame.hands.left.menuPressed = false;
    update(300); update(1000);
    expect(anchor.opacity).toBe(1);
    frame.hands.left.menuPressed = true;
    update(1100);
    frame.hands.left.menuPressed = false;
    update(1400); update(1580);
    expect(anchor.open).toBe(false);
    delete frame.hands.left;
    frame.hands.right = controller();
    update(1800);
    expect(anchor.source).toBeNull();
    expect(anchor.opacity).toBe(0);
  });

  it('gives real hands priority over controllers without carrying over menu visibility', () => {
    const { anchor, frame, update } = setup();
    frame.hands.left = controller();
    frame.hands.left.menuPressed = true;
    update(0); update(180);
    frame.hands.left = hand(-0.2, false, 0);
    update(200);
    expect(anchor.source).toBe('hand');
    expect(anchor.open).toBe(false);
    expect(anchor.opacity).toBe(0);
  });

  it('uses the fallback while the desktop mouse drives input, even with emulated hands present', () => {
    const { anchor, wrist, frame, update } = setup();
    frame.hands = { left: hand(-0.2, false, 0), right: hand(0.2, false, 0) };
    frame.pointer = 'mouse';
    update(100);
    expect(anchor.tracked).toBe(false);
    expect(anchor.open).toBe(true);
    expect(wrist.visible).toBe(false);
    delete frame.pointer;
    update(200);
    expect(anchor.tracked).toBe(true);
  });
});

describe('FingerTouchDetector', () => {
  function setupTouch() {
    const detector = new FingerTouchDetector(), menuHand = hand();
    const thumb = menuHand.joints['thumb-tip']!.position;
    const rest = thumb.clone();
    const touch = (finger: FingerMenuFinger, distance = 0.01) => {
      thumb.copy(menuHand.joints[`${finger}-finger-tip`]!.position).add(new Vector3(0, distance, 0));
    };
    const release = () => { thumb.copy(rest); };
    const update = (time: number, open = true) => detector.update(menuHand, open, time);
    return { detector, menuHand, thumb, touch, release, update };
  }

  it.each(['middle', 'ring', 'pinky'] as const)('debounces a %s touch and emits exactly one activation per contact', (finger) => {
    const { touch, update } = setupTouch();
    expect(update(0).ready).toBe(true);
    touch(finger);
    expect(update(10).touching).toBe(false);
    expect(update(39).justTouched).toBe(false);
    const pressed = update(40);
    expect(pressed.finger).toBe(finger);
    expect(pressed.touching).toBe(true);
    expect(pressed.justTouched).toBe(true);
    expect(update(100).justTouched).toBe(false);
    expect(update(1000).touching).toBe(true);
  });

  it('uses a wider release distance so contact jitter cannot repeat an action', () => {
    const { touch, update } = setupTouch();
    update(0); touch('middle'); update(10);
    expect(update(40).justTouched).toBe(true);
    touch('middle', 0.019);
    expect(update(50).touching).toBe(true);
    touch('middle', 0.014);
    expect(update(60).justTouched).toBe(false);
    touch('middle', 0.023);
    expect(update(70).touching).toBe(false);
    touch('middle', 0.014); update(80);
    expect(update(110).justTouched).toBe(true);
  });

  it('requires a continuous close touch and highlights only within four centimetres', () => {
    const { touch, update } = setupTouch();
    update(0);
    touch('ring', 0.041);
    expect(update(10).near.ring).toBe(false);
    touch('ring', 0.039);
    expect(update(20).near.ring).toBe(true);
    touch('ring', 0.016);
    expect(update(60).touching).toBe(false);
    touch('ring', 0.014); update(70);
    touch('ring', 0.016); update(90);
    touch('ring', 0.014); update(100);
    expect(update(129).justTouched).toBe(false);
    expect(update(130).justTouched).toBe(true);
  });

  it('ignores thumb and index contact entirely', () => {
    const { menuHand, thumb, update } = setupTouch();
    menuHand.joints['index-finger-tip'] = { position: thumb.clone(), quaternion: new Quaternion(), radius: 0.008 };
    menuHand.pinching = menuHand.justPinched = true;
    update(0);
    expect(update(100).touching).toBe(false);
    expect(update(1000).finger).toBeNull();
  });

  it('requires a 300 ms palm dwell and a fresh release after a touch during opening', () => {
    const { menuHand, touch, release, update } = setupTouch();
    menuHand.palmUpMs = 299;
    expect(update(0).ready).toBe(false);
    touch('middle'); update(20);
    menuHand.palmUpMs = 300;
    expect(update(300).touching).toBe(false);
    expect(update(400).justTouched).toBe(false);
    release(); update(420);
    touch('middle'); update(440);
    expect(update(470).justTouched).toBe(true);
  });

  it('cancels an active pinky hold during fast wrist movement and requires release', () => {
    const { menuHand, touch, release, update } = setupTouch();
    update(0); touch('pinky'); update(10);
    expect(update(40).justTouched).toBe(true);
    menuHand.joints.wrist!.position.x += 0.02;
    const moved = update(56);
    expect(moved.touching).toBe(false);
    expect(moved.finger).toBeNull();
    expect(moved.ready).toBe(false);
    expect(update(90).justTouched).toBe(false);
    expect(update(900).touching).toBe(false);
    release(); update(920);
    touch('pinky'); update(940);
    expect(update(970).justTouched).toBe(true);
  });

  it('allows wrist movement below the speed limit', () => {
    const { menuHand, touch, update } = setupTouch();
    update(0); touch('middle'); update(10);
    menuHand.joints.wrist!.position.x += 0.01;
    expect(update(40).justTouched).toBe(true);
  });

  it.each(['closed', 'palm down', 'tracking lost', 'clock reset'] as const)('cancels after %s without activating a still-held touch on return', (reason) => {
    const { detector, menuHand, touch, release, update } = setupTouch();
    update(100); touch('middle'); update(110);
    expect(update(140).justTouched).toBe(true);
    if (reason === 'closed') update(160, false);
    else if (reason === 'palm down') { menuHand.palmUp = false; update(160); menuHand.palmUp = true; }
    else if (reason === 'tracking lost') detector.update(undefined, true, 160);
    else update(90);
    expect(update(200).touching).toBe(false);
    expect(update(400).justTouched).toBe(false);
    release(); update(420);
    touch('middle'); update(440);
    expect(update(470).justTouched).toBe(true);
  });

  it('allows a tracked finger when another is missing and disarms the missing finger until release', () => {
    const { menuHand, touch, release, update } = setupTouch();
    const ring = menuHand.joints['ring-finger-tip']!;
    delete menuHand.joints['ring-finger-tip'];
    update(0); touch('middle'); update(10);
    expect(update(40).justTouched).toBe(true);
    release(); update(60);
    menuHand.joints['ring-finger-tip'] = ring;
    touch('ring'); update(80);
    expect(update(200).justTouched).toBe(false);
    release(); update(220);
    touch('ring'); update(240);
    expect(update(270).justTouched).toBe(true);
    delete menuHand.joints['ring-finger-tip'];
    expect(update(280).touching).toBe(false);
  });

  it('never accepts controller poses as finger input', () => {
    const { menuHand, touch, update } = setupTouch();
    menuHand.controller = true;
    update(0); touch('middle'); update(10);
    expect(update(100).touching).toBe(false);
  });
});

describe('DockHold', () => {
  it('fills for 600 ms and commits exactly once while still held', () => {
    const hold = new DockHold();
    hold.begin(100);
    expect(hold.update(400)).toBe(false);
    expect(hold.progress).toBe(0.5);
    expect(hold.update(699)).toBe(false);
    expect(hold.update(700)).toBe(true);
    expect(hold.progress).toBe(1);
    expect(hold.update(1000)).toBe(false);
  });

  it('cancels an early release and requires a full fresh hold', () => {
    const hold = new DockHold();
    hold.begin(0); hold.update(500); hold.cancel();
    expect(hold.progress).toBe(0);
    expect(hold.update(700)).toBe(false);
    hold.begin(1000);
    expect(hold.update(1599)).toBe(false);
    expect(hold.update(1600)).toBe(true);
  });

  it('does not restart an active hold and cancels when session time moves backward', () => {
    const hold = new DockHold();
    hold.begin(1000); hold.begin(1200);
    expect(hold.update(1600)).toBe(true);
    expect(hold.update(900)).toBe(false);
    expect(hold.progress).toBe(0);
    expect(hold.update(2000)).toBe(false);
    hold.begin(2000);
    expect(hold.update(2600)).toBe(true);
  });
});
