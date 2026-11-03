import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '@ce/gen3d';
import { PerspectiveCamera, Quaternion, Scene, Vector3, type Object3D, type WebGLRenderer } from 'three';
import type { HandState, Hud, HudFrame } from '../contract';
import { createHud } from './index';

const instances: Hud[] = [];
function fixture() {
  const head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  const hud = createHud({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: {} as WebGLRenderer }); instances.push(hud);
  hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 2, status: 'Choose a device' });
  for (const [id, label] of [['synth', 'Visual synth'], ['mac', 'MacBook']]) hud.upsertTarget({ id: id!, label: label!, tagged: true, confirmed: true, connection: 'ready', status: 'verified', position: [0, 0.7, -1] });
  hud.setLocked('synth');
  let time = 0;
  const frame = (hands: HudFrame['hands'] = {}) => hud.update({ time: time += 100, dt: 0.1, pointer: 'mouse', head, hands });
  const node = (name: string) => hud.root.getObjectByName(name)!;
  const hand = (at: Vector3, pressed = false, just = false): HandState => ({ controller: true, joints: {}, pinchPoint: new Vector3(10, 10, 10), pinching: pressed, justPinched: just, justReleased: !pressed,
    ray: { origin: head.position.clone(), dir: at.clone().sub(head.position).normalize() } });
  const click = (object: Object3D) => { frame(); const point = object.getWorldPosition(new Vector3()); frame({ right: hand(point) }); frame({ right: hand(point, true, true) }); frame({ right: hand(point) }); };
  frame(); frame(); frame();
  return { hud, head, frame, node, hand, click };
}
afterEach(() => instances.splice(0).forEach((hud) => hud.dispose()));

describe('one persistent task workspace', () => {
  it.skip('keeps device, conversation, confirmation and project content at one anchor through a head turn', () => {
    const f = fixture(), anchor = f.node('device-card').position.clone();
    f.head.position.x = 0.4; f.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.8);
    f.hud.setAssistant?.({ targetId: 'synth', state: 'thinking', transcript: 'Control this synth' }); f.frame();
    expect(f.node('assistant-panel').position).toEqual(anchor);
    expect(f.hud.presentationSnapshot?.()).toEqual({ surface: 'assistant', stage: 'building' });
    f.hud.showConfirm({ id: 'arm', title: 'Enable controls', kind: 'arm' }); f.frame();
    expect(f.node('confirmation-panel').position).toEqual(anchor);
    expect(f.hud.presentationSnapshot?.().stage).toBe('review');
    f.hud.showConfirm(null); f.hud.setAssistant?.(null);
    f.hud.setProjects?.({ title: 'Chord Garden', status: 'Ready', projectCount: 1, actionCount: 4, ready: true, running: false, engaged: false }); f.frame();
    expect(f.node('project-panel').position).toEqual(anchor);
    expect(f.hud.presentationSnapshot?.()).toEqual({ surface: 'project', stage: 'ready' });
    f.hud.setProjects?.(null); f.hud.setLocked('mac'); f.frame();
    expect(f.node('device-card').position).toEqual(anchor);
  });

  it.skip('moves the entire workspace when its menu title is dragged, then retains it on close', () => {
    const f = fixture(), before = f.node('device-card').position.clone();
    f.hud.setDeck({ open: true }); f.frame();
    const point = f.node('menu-drag').getWorldPosition(new Vector3());
    f.frame({ right: f.hand(point) }); f.frame({ right: f.hand(point, true, true) });
    const moved = point.clone().add(new Vector3(0.15, 0.04, 0));
    f.frame({ right: f.hand(moved, true) }); f.frame({ right: f.hand(moved) });
    f.hud.setDeck({ open: false }); f.frame();
    const after = f.node('device-card').position.clone();
    expect(after.x - before.x).toBeCloseTo(0.15, 2); expect(after.y - before.y).toBeCloseTo(0.04, 2);
    f.hud.setAssistant?.({ targetId: 'synth', state: 'reply', text: 'Ready to review' }); f.frame();
    expect(f.node('assistant-panel').position).toEqual(after);
  });

  it.skip('keeps normal performance motion away from navigation and leaves an explicit Stop', () => {
    const f = fixture(), original = EXAMPLES['ceiling-dimmer']!;
    f.hud.renderSpec({ ...original, controls: original.controls.map((control) => ({ ...control, armed: true })) }, { targetId: 'synth' });
    f.hud.setArmed(original.specId, true);
    f.hud.setDeviceState?.({ targetId: 'synth', connection: 'ready', performAvailable: true, handControl: true }); f.frame();
    expect(f.node('hand-dock').visible).toBe(false);
    expect(f.node('assistant-talk').visible).toBe(false);
    expect(f.node('object-inspect').visible).toBe(false);
    expect(f.node('hand-control').visible).toBe(true);
    expect(f.hud.presentationSnapshot?.().stage).toBe('perform');
    const stops: boolean[] = []; f.hud.on('handControl', ({ enabled }) => stops.push(enabled));
    f.click(f.node('hand-control')); expect(stops).toEqual([false]);
  });

  it.skip('does not transfer a held press from a dismissed panel to the task behind it', () => {
    const f = fixture(); let requested = 0;
    f.hud.on('assistantTalk', () => requested++);
    f.hud.setAssistant?.({ targetId: 'synth', state: 'reply', text: 'Result' }); f.frame();
    const dismiss = f.node('assistant-dismiss').getWorldPosition(new Vector3());
    f.frame({ right: f.hand(dismiss) }); f.frame({ right: f.hand(dismiss, true, true) });
    f.hud.setAssistant?.(null); f.frame();
    const ask = f.node('assistant-talk').getWorldPosition(new Vector3());
    f.frame({ right: f.hand(ask, true) }); f.frame({ right: f.hand(ask, true) });
    expect(requested).toBe(0);
    f.frame({ right: f.hand(ask) }); f.frame({ right: f.hand(ask, true, true) }); expect(requested).toBe(1);
  });

  it('cancels confirmation when release is outside the resolved button', () => {
    const f = fixture(), approvals: boolean[] = [];
    f.hud.on('confirm', ({ approve }) => approvals.push(approve));
    f.hud.showConfirm({ id: 'confirm', title: 'Review change' }); f.frame();
    const point = f.node('confirm-yes').getWorldPosition(new Vector3());
    f.frame({ right: f.hand(point) }); f.frame({ right: f.hand(point, true, true) });
    f.frame({ right: f.hand(point.clone().add(new Vector3(0.4, 0, 0))) });
    expect(approvals).toEqual([]);
    f.click(f.node('confirm-yes')); expect(approvals).toEqual([true]);
  });

  it.skip('consumes workspace background and makes collinear object bodies unavailable for selection', () => {
    const f = fixture(), selected: string[] = [], consumed: string[] = [];
    f.hud.on('selectTarget', ({ targetId }) => selected.push(targetId));
    f.hud.on('consumed', ({ widget }) => consumed.push(widget));
    const aim = { position: new Vector3(), size: 0 };
    for (const id of ['synth', 'mac']) expect(f.hud.getTargetAim?.(id, aim)).toBe(false);
    const point = f.node('device-card').localToWorld(new Vector3(0.18, -0.02, 0));
    f.frame({ right: f.hand(point) }); f.frame({ right: f.hand(point, true, true) }); f.frame({ right: f.hand(point) });
    expect(consumed).toContain('handle'); expect(selected).toEqual([]);
    f.hud.setAssistant?.({ targetId: 'synth', state: 'proposal', proposalId: 'map', text: 'Review this mapping' }); f.frame();
    for (const id of ['synth', 'mac']) expect(f.hud.getTargetAim?.(id, aim)).toBe(false);
    f.click(f.node('target-label:mac')); expect(selected).toEqual([]);
    expect(f.hud.presentationSnapshot?.()).toEqual({ surface: 'assistant', stage: 'review' });
  });

  it.skip('points to an offscreen confirmation without moving or approving it, and the cue consumes no input', () => {
    const f = fixture(), approvals: boolean[] = [], consumed: string[] = [];
    f.hud.showConfirm({ id: 'enable', title: 'Enable controls', kind: 'arm' }); f.frame();
    const modal = f.node('confirmation-panel'), anchor = modal.position.clone();
    f.hud.on('confirm', ({ approve }) => approvals.push(approve));
    f.hud.on('consumed', ({ widget }) => consumed.push(widget));
    f.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); f.frame();
    const cue = f.node('device-edge-pill');
    expect(cue.visible).toBe(true); expect(cue.userData.targetSurface).toBe('confirmation-panel');
    expect(f.node('workspace-recovery-label')).toMatchObject({ text: 'Raise open left hand · hold' });
    const cueInView = cue.position.clone().sub(f.head.position).applyQuaternion(f.head.quaternion.clone().invert());
    expect(Math.max(Math.abs(cueInView.x) / 0.32, Math.abs(cueInView.y) / 0.23)).toBeCloseTo(1);
    f.click(cue); expect(consumed).toEqual([]); expect(approvals).toEqual([]);
    expect(modal.position).toEqual(anchor);
    f.head.quaternion.identity(); f.frame(); expect(cue.visible).toBe(false);
    expect(modal.position).toEqual(anchor);
  });

  it('recovers the foreground conversation, project and Menu with one cue and no palm instruction during hands', () => {
    const f = fixture();
    f.head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    f.hud.setAssistant?.({ targetId: 'synth', state: 'reply', text: 'Response' }); f.frame();
    const cue = f.node('device-edge-pill'); expect(cue.userData.targetSurface).toBe('assistant-panel');
    f.hud.setProjects?.({ title: 'Project', status: 'Ready', projectCount: 1, actionCount: 1, ready: true, running: true, engaged: false }); f.frame();
    expect(cue.userData.targetSurface).toBe('project-panel');
    expect(f.node('workspace-recovery-label')).toMatchObject({ text: 'Controls · look right' });
    f.hud.setProjects?.(null); f.hud.setDeck({ open: true }); f.frame();
    expect(cue.userData.targetSurface).toBe('main-menu');
    let count = 0; f.hud.root.traverseVisible(object => { if (object.name === 'device-edge-pill') count++; });
    expect(count).toBe(1);
  });
});
