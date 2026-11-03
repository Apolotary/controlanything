import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import type { SetupProgressView } from '@ce/protocol';
import type { HandState, Hud, HudFrame } from '../contract';
import { createHud } from './index';
import { artifactExcerpt } from './setup-progress';

const instances: Hud[] = [];
const progress = (patch: Partial<SetupProgressView> = {}): SetupProgressView => ({
  cardId: 'server-card-id', runId: 'run-1', title: 'Writing device commands', detail: 'Muse is producing a driver from the supported actions.',
  stages: [
    { id: 'connect', label: 'Connect', status: 'done' }, { id: 'learn', label: 'Learn device', status: 'done' },
    { id: 'driver', label: 'Write commands', status: 'active' }, { id: 'check', label: 'Check effects', status: 'pending' },
    { id: 'interface', label: 'Build controls', status: 'pending' }, { id: 'enable', label: 'Enable', status: 'pending' },
  ], artifact: { label: 'Driver output', code: '{ "action": "warp", "cc": 71, "range": [0, 127] }' },
  facts: ['4 supported actions', 'MIDI through the connected helper'], source: 'Fixture', working: true, ...patch,
});

function setup() {
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.6, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer }); instances.push(hud);
  let time = 0;
  const step = (hand?: Partial<HandState>, elapsed = 20) => {
    const frame: HudFrame = { time: time += elapsed, dt: elapsed / 1000, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion },
      hands: hand ? { right: { controller: true, joints: {}, pinchPoint: new Vector3(10, 10, 10), ray: { origin: camera.position, dir: new Vector3(0, 0, -1) }, pinching: false, justPinched: false, justReleased: false, ...hand } } : {} };
    hud.update(frame);
  };
  const node = (name: string) => hud.root.getObjectByName(name)!;
  const text = (name: string) => (node(name) as Object3D & { text: string }).text;
  const click = (name: string) => {
    step(undefined, 300);
    const ray = { origin: camera.position.clone(), dir: node(name).getWorldPosition(new Vector3()).sub(camera.position).normalize() };
    step({ ray }); step({ ray, pinching: true, justPinched: true }); step({ ray, justReleased: true });
  };
  hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: 'Ready' });
  hud.upsertTarget({ id: 'target-1', label: 'Visual synth', tagged: true, connection: 'setup', status: 'scanned', position: [0, 1.4, -1], confirmed: true });
  hud.setLocked('target-1'); hud.setDeviceState?.({ targetId: 'target-1', connection: 'setup', busy: true }); step(undefined, 300);
  return { hud, camera, node, text, click, step };
}
afterEach(() => instances.splice(0).forEach((hud) => hud.dispose()));

describe('selected-card setup progress', () => {
  it.skip('shows real stages, artifact and source while preserving pooled nodes, the card anchor and Cancel', () => {
    const f = setup(), cancel = vi.fn(); f.hud.on('cancel', cancel); f.hud.setSetupProgress?.(progress());
    const panel = f.node('setup-progress'), card = f.node('device-card'), stage = f.node('setup-stage-driver');
    const position = card.position.clone(), rotation = card.quaternion.clone(), children = [...panel.children];
    expect(panel.parent).toBe(card); expect(panel.visible).toBe(true); expect(f.node('device-status').visible).toBe(false);
    expect(stage.userData.status).toBe('active'); expect(f.text('setup-artifact-code')).toContain('"cc": 71');
    expect(f.text('setup-progress-source')).toBe('Fixture');
    f.camera.position.x += 0.2; f.hud.setSetupProgress?.(progress({ title: 'Checking the response', detail: 'Sending a bounded command and observing its effect.',
      stages: progress().stages.map((s) => ({ ...s, status: s.id === 'driver' ? 'done' : s.id === 'check' ? 'active' : s.status })) })); f.step();
    expect(panel.children).toEqual(children); expect(f.node('setup-stage-driver')).toBe(stage);
    expect(card.position).toEqual(position); expect(card.quaternion.toArray()).toEqual(rotation.toArray());
    expect(f.node('setup-stage-check').userData.status).toBe('active');
    f.click('setup-progress-cancel'); expect(cancel).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-1' });
  });

  it.skip('keeps automatic setup progress in the foreground, suspends it for Enable, then restores ready controls', () => {
    const f = setup(), cancel = vi.fn(); f.hud.on('cancel', cancel);
    f.hud.setSetupProgress?.(progress()); f.hud.setAssistant?.({ targetId: 'target-1', state: 'setup', text: 'Follow the setup steps.' }); f.step();
    const card = f.node('device-card'), assistant = f.node('assistant-panel'), position = card.position.clone();
    expect(card.visible).toBe(true); expect(assistant.visible).toBe(false);
    const background = f.node('setup-progress-background');
    expect(background.position.y + 0.50 / 2).toBeCloseTo(0.16);
    expect(f.node('setup-progress-cancel').position.y - 0.024).toBeGreaterThan(background.position.y - 0.50 / 2);
    f.hud.showConfirm({ id: 'enable', kind: 'arm', title: 'Enable controls' }); f.step();
    expect(f.node('setup-progress').visible).toBe(false); expect(assistant.visible).toBe(false);
    f.click('setup-progress-cancel'); expect(cancel).not.toHaveBeenCalled();
    f.hud.showConfirm(null); f.step(); expect(f.node('setup-progress').visible).toBe(true); expect(card.position).toEqual(position);
    const spec = { ...EXAMPLES['ceiling-dimmer']!, controls: EXAMPLES['ceiling-dimmer']!.controls.map((c) => ({ ...c, armed: true })) };
    f.hud.renderSpec(spec, { targetId: 'target-1' }); f.hud.setArmed(spec.specId, true);
    f.hud.setDeviceState?.({ targetId: 'target-1', connection: 'ready' }); f.hud.setSetupProgress?.(progress({ working: false })); f.step();
    f.hud.setAssistant?.(null); f.step();
    expect(f.node('setup-progress').visible).toBe(false); expect(f.node('device-status').visible).toBe(true);
    expect(f.node('main-control:brightness')).toBeDefined(); expect(card.position).toEqual(position);
  });

  it.skip('shows an explicitly started microphone conversation and Send even while setup is running', () => {
    const f = setup(); f.hud.setSetupProgress?.(progress());
    f.hud.on('assistantTalk', () => f.hud.setAssistant?.({ targetId: 'target-1', state: 'listening', text: 'Listening' }));
    f.click('assistant-talk'); f.step();
    expect(f.node('assistant-panel').visible).toBe(true); expect(f.node('assistant-send').visible).toBe(true);
    expect(f.node('device-card').visible).toBe(false); expect(f.node('setup-progress').visible).toBe(false);
  });

  it.skip('retains failure evidence and an explicit retry, then clears it on selection or mode changes', () => {
    const f = setup(), retry = vi.fn(); f.hud.on('setup', retry);
    f.hud.setDeviceState?.({ targetId: 'target-1', connection: 'setup', busy: false });
    f.hud.setSetupProgress?.(progress({ working: false, title: 'Could not verify the response', stages: progress().stages.map((s) => ({ ...s, status: s.id === 'check' ? 'failed' : s.status })) }));
    expect(f.node('setup-stage-check').userData.status).toBe('failed'); f.click('setup-progress-retry'); expect(retry).toHaveBeenCalledOnce();
    f.hud.setHome?.({ mode: 'annotate', filter: 'electronics', tagged: 1, status: '' }); f.hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: '' });
    expect(f.node('setup-progress').visible).toBe(false);
    f.hud.setSetupProgress?.(progress()); f.hud.setLocked(null); f.hud.setLocked('target-1');
    expect(f.node('setup-progress').visible).toBe(false); expect(f.text('setup-artifact-code')).toBe('');
  });

  it.skip('keeps Cancel between completed stages while the overall setup attempt is still busy', () => {
    const f = setup(), cancel = vi.fn(), retry = vi.fn(); f.hud.on('cancel', cancel); f.hud.on('setup', retry);
    f.hud.setSetupProgress?.(progress({ working: false, title: 'Device linked' }));
    f.click('setup-progress-cancel'); expect(cancel).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    f.hud.setDeviceState?.({ targetId: 'target-1', connection: 'ready', busy: true }); f.step();
    expect(f.node('setup-progress').visible).toBe(true); expect(f.node('setup-progress-cancel')).toBeDefined();
    f.hud.setDeviceState?.({ targetId: 'target-1', connection: 'setup', busy: false }); f.step();
    expect(f.node('setup-progress-retry')).toBeDefined(); f.click('setup-progress-retry'); expect(retry).toHaveBeenCalledOnce();
  });

  it.skip.each(['open-companion', 'pair-device'] as const)('keeps the required %s pairing action available during setup', (action) => {
    const f = setup(), pair = vi.fn(); f.hud.on('pair', pair); f.hud.setSetupProgress?.(progress());
    f.hud.setDeviceState?.({ targetId: 'target-1', connection: 'offline', action, busy: true }); f.step();
    expect(f.node('setup-progress').visible).toBe(false); expect(f.node('control-pair')).toBeDefined();
    f.click('control-pair'); expect(pair).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-1' });
  });

  it('bounds code excerpts and marks truncation without inventing additional output', () => {
    const excerpt = artifactExcerpt('{"actual":"' + 'x'.repeat(300) + '"}');
    expect(excerpt.split('\n')).toHaveLength(3); expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.split('\n').every((line) => line.length <= 40)).toBe(true);
    expect(artifactExcerpt('')).toBe('');
  });
});
