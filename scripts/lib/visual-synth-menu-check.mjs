import assert from 'node:assert/strict';

/** Real IWER XRHand input; no direct HUD drag, recenter, Menu or event calls.
 * Leaves Menu open. Returns measured pose/displacement evidence for the release ledger.
 */
export async function checkMenuHands({ quest, waitQuest, renderedFrames, screenshot }) {
  const saved = await quest.evaluate(async () => {
    const app = window.__ce, remote = app.emulator.device.remote;
    const saved = { mouse: app.input.mouseAsHand, mode: app.emulator.device.primaryInputMode };
    app.input.mouseAsHand = false;
    app.input.pointer.inside = app.input.pointer.down = app.input.pointer.latched = false;
    await remote.dispatch('set_input_mode', { mode: 'hand' });
    for (const device of ['hand-left', 'hand-right']) {
      await remote.dispatch('set_select_value', { device, value: 0 });
      await remote.dispatch('set_connected', { device, connected: false });
    }
    window.__menuHandEvidence = { trace: [] };
    return saved;
  });
  const elapsed = async ms => {
    const time = await quest.evaluate(() => window.__ce.lastFrame.time);
    await waitQuest(time => window.__ce.lastFrame.time >= time, time + ms);
  };
  const snapshot = async label => quest.evaluate(label => {
    const app = window.__ce, menu = app.hud.root.getObjectByName('main-menu');
    const hands = Object.fromEntries(['left', 'right'].map(side => {
      const hand = app.lastFrame.hands[side];
      return [side, hand ? { controller: !!hand.controller, jointCount: Object.keys(hand.joints).length,
        wrist: hand.joints.wrist?.position.toArray(), tip: hand.joints['index-finger-tip']?.position.toArray(),
        ray: { origin: hand.ray.origin.toArray(), dir: hand.ray.dir.toArray() }, pinching: hand.pinching,
        palmUp: hand.palmUp } : null];
    }));
    const row = { label, menu: menu.visible, position: menu.position.toArray(), recall: app.hud.root.userData.menuRecall, hands };
    window.__menuHandEvidence.trace.push(row); return row;
  }, label);
  const aim = async nodeName => {
    await quest.evaluate(async nodeName => {
      const app = window.__ce, remote = app.emulator.device.remote, node = app.hud.root.getObjectByName(nodeName);
      if (!node) throw new Error(`Missing menu input target: ${nodeName}`);
      for (let owner = node; owner; owner = owner.parent) if (!owner.visible) throw new Error(`Hidden menu input target: ${nodeName}`);
      const head = app.emulator.head(), target = node.getWorldPosition(head.position.clone());
      const position = head.position.clone().add(head.position.clone().set(.16, -.3, -.3).applyQuaternion(head.quaternion));
      const xyz = v => ({ x: v.x, y: v.y, z: v.z });
      await remote.dispatch('set_connected', { device: 'hand-left', connected: false });
      await remote.dispatch('set_connected', { device: 'hand-right', connected: true });
      await remote.dispatch('set_select_value', { device: 'hand-right', value: 0 });
      await remote.dispatch('set_hand_pose', { device: 'hand-right', poseId: 'default' });
      await remote.dispatch('set_transform', { device: 'hand-right', position: xyz(position) });
      await remote.dispatch('look_at', { device: 'hand-right', target: xyz(target) });
    }, nodeName);
    await waitQuest(() => window.__ce.lastFrame.hands.right?.joints['index-finger-tip'] && !window.__ce.lastFrame.hands.right.controller && !window.__ce.lastFrame.hands.right.pinching);
    await elapsed(220); // Let the production ray filter converge before pinch.
  };
  const select = async down => {
    await quest.evaluate(down => window.__ce.emulator.device.remote.dispatch('set_select_value', { device: 'hand-right', value: down ? 1 : 0, duration: .12 }), down);
    await waitQuest(down => !!window.__ce.lastFrame.hands.right?.pinching === down, down);
    await renderedFrames(3);
  };
  const click = async name => { await aim(name); await select(true); await select(false); };
  const recall = async () => {
    await quest.evaluate(async () => {
      const app = window.__ce, remote = app.emulator.device.remote, head = app.emulator.head();
      const wrist = head.position.clone().add(head.position.clone().set(-.2, 0, -.40).applyQuaternion(head.quaternion));
      wrist.y = head.position.y - .45; // Raised fingers, natural chest-height wrist; old gate rejected it.
      const palm = head.position.clone().sub(wrist).normalize(), fingers = head.position.clone().set(0, 1, 0);
      fingers.addScaledVector(palm, -fingers.dot(palm)).normalize();
      const xyz = v => ({ x: v.x, y: v.y, z: v.z });
      await remote.dispatch('set_connected', { device: 'hand-right', connected: false });
      await remote.dispatch('set_connected', { device: 'hand-left', connected: true });
      await remote.dispatch('set_select_value', { device: 'hand-left', value: 0 });
      await remote.dispatch('set_hand_pose', { device: 'hand-left', poseId: 'open' });
      await remote.dispatch('set_transform', { device: 'hand-left', anchor: 'wrist', position: xyz(wrist), orientation: { fingers: xyz(fingers), palm: xyz(palm) } });
    });
    await waitQuest(() => window.__ce.hud.root.userData.menuRecall?.progress > .05 || window.__ce.hud.root.getObjectByName('main-menu').visible);
    const pose = await snapshot('natural-left-hand-recall');
    assert(pose.hands.left?.jointCount >= 25 && !pose.hands.left.controller, 'Recall must use articulated XRHand');
    assert(pose.recall.wristHeight < -.4, 'Exercise natural raised fingers with wrist below old height gate');
    await waitQuest(() => window.__ce.hud.root.getObjectByName('main-menu').visible);
    await elapsed(100);
  };
  try {
    if (await quest.evaluate(() => window.__ce.hud.root.getObjectByName('main-menu').visible)) await click('menu-close');
    await recall();
    await quest.evaluate(() => {
      const app = window.__ce;
      app.emulator.lookAt(app.hud.root.getObjectByName('main-menu').getWorldPosition(app.desktopCam.position.clone()));
    });
    await renderedFrames(4);
    await aim('menu-drag');
    const before = await snapshot('far-ray-before');
    const tipDistance = await quest.evaluate(() => {
      const app = window.__ce, tip = app.lastFrame.hands.right.joints['index-finger-tip'].position;
      return tip.distanceTo(app.hud.root.getObjectByName('menu-drag').getWorldPosition(tip.clone()));
    });
    assert(tipDistance > .15, 'Menu drag must acquire by far ray, not fingertip touch');
    await select(true);
    await waitQuest(() => window.__ce.hud.root.getObjectByName('menu-drag').userData.pressed);
    await snapshot('far-ray-held');
    await quest.evaluate(async () => {
      const app = window.__ce, remote = app.emulator.device.remote, menu = app.hud.root.getObjectByName('main-menu');
      const transform = await remote.dispatch('get_transform', { device: 'hand-right' });
      const delta = app.desktopCam.position.clone().set(.12, .025, 0).applyQuaternion(menu.quaternion);
      const p = transform.position;
      await remote.dispatch('set_transform', { device: 'hand-right', position: { x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z } });
    });
    await elapsed(650); await select(false);
    const after = await snapshot('far-ray-placed');
    const displacement = Math.hypot(...after.position.map((value, i) => value - before.position[i]));
    assert(displacement > .07 && displacement < .2, `Hand-ray drag must move panel by intentional hand travel; got ${displacement}m`);
    if (screenshot) await screenshot('03a-hand-menu-drag');
    await quest.evaluate(() => {
      const app = window.__ce, head = app.emulator.head();
      app.emulator.lookAt(head.position.clone().add(head.position.clone().set(.7, 0, -.4).applyQuaternion(head.quaternion)));
    });
    await elapsed(300);
    const turned = await snapshot('head-turn-after-placement');
    assert(Math.hypot(...turned.position.map((value, i) => value - after.position[i])) < .002, 'Head turn must preserve placed anchor');
    // Close through actual open-finger plane crossing, with select still zero.
    await quest.evaluate(async () => {
      const app = window.__ce, remote = app.emulator.device.remote, button = app.hud.root.getObjectByName('menu-close');
      app.emulator.lookAt(button.getWorldPosition(app.desktopCam.position.clone()));
      const tip = button.localToWorld(app.desktopCam.position.clone().set(0, 0, .035));
      await remote.dispatch('set_hand_pose', { device: 'hand-right', poseId: 'open' });
      await remote.dispatch('set_transform', { device: 'hand-right', anchor: 'index-tip', position: { x: tip.x, y: tip.y, z: tip.z } });
    });
    await renderedFrames(5); await snapshot('near-poke-before');
    await quest.evaluate(async () => {
      const app = window.__ce, button = app.hud.root.getObjectByName('menu-close');
      const tip = button.localToWorld(app.desktopCam.position.clone().set(0, 0, -.025));
      await app.emulator.device.remote.dispatch('set_transform', { device: 'hand-right', anchor: 'index-tip', position: { x: tip.x, y: tip.y, z: tip.z } });
    });
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('main-menu').visible);
    await snapshot('near-poke-closed');
    await recall();
    if (screenshot) await screenshot('03b-natural-left-hand-recall');
    return await quest.evaluate(() => window.__menuHandEvidence);
  } finally {
    await quest.evaluate(async saved => {
      const app = window.__ce, remote = app.emulator.device.remote;
      for (const device of ['hand-left', 'hand-right']) {
        await remote.dispatch('set_select_value', { device, value: 0 });
        await remote.dispatch('set_connected', { device, connected: false });
      }
      await remote.dispatch('set_input_mode', { mode: saved.mode ?? 'controller' });
      app.input.mouseAsHand = saved.mouse;
    }, saved);
    await renderedFrames(3);
  }
}
