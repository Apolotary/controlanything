import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { EXAMPLES, type Gen3dSpec } from '@ce/gen3d';
import type { Hud, HudFrame, HudTarget } from '../contract';
import { createHud } from './index';
import { Emitter } from '../../app/emitter';
import { VoiceAssistant } from '../../voice/assistant';
import type { PushToTalk, PttEvents } from '../../voice/ptt';
import type { PayloadOf } from '@ce/protocol';
import type { SdfText } from './text';
import { THEME } from './theme';

const instances: Hud[] = [];
function setup() {
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.5, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer }); instances.push(hud);
  const target: HudTarget = { id: 'mac', label: 'MacBook', tagged: true, connection: 'ready', status: 'verified', confirmed: true, position: [0, 0.7, -1] };
  hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: 'Choose a device' }); hud.upsertTarget(target); hud.setLocked(target.id);
  let time = 0;
  const update = (pinch?: { point: Vector3; pressed?: boolean; released?: boolean }, elapsed = 20) => {
    const frame: HudFrame = { time: time += elapsed, dt: elapsed / 1000, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion }, hands: pinch ? { right: {
      controller: true, joints: {}, pinching: !!pinch.pressed, justPinched: !!pinch.pressed, justReleased: !!pinch.released, pinchPoint: new Vector3(10, 10, 10),
      ray: { origin: camera.position.clone(), dir: pinch.point.clone().sub(camera.position).normalize() },
    } } : {} }; hud.update(frame);
  };
  const node = (name: string) => hud.root.getObjectByName(name);
  const click = (name: string) => { update(undefined, 300); const point = node(name)!.getWorldPosition(new Vector3()); update({ point }); update({ point, pressed: true }); update({ point, released: true }); };
  update(undefined, 300);
  return { hud, camera, target, node, click, update };
}
function mappingWorkspace() {
  const f = setup(), spec = EXAMPLES['op1-knobs']!;
  f.hud.renderSpec({ ...spec, controls: spec.controls.map((c) => ({ ...c, armed: true })) }, { targetId: 'mac' });
  f.hud.setArmed(spec.specId, true);
  const ptt = Object.assign(new Emitter<PttEvents>(), { listening: false, cancel() {}, release() {}, async press() {} });
  let sent: PayloadOf<'voice.text'> | undefined, currentMap = 'Map r2 · Height to Warp';
  const syncMap = () => f.hud.setDeviceState?.({ targetId: 'mac', connection: 'ready', silentVisual: true,
    performAvailable: true, mappingSummary: currentMap, mappingOutcome: assistant.mappingOutcome('mac') });
  const assistant = new VoiceAssistant({ ptt: ptt as unknown as PushToTalk, selected: () => ({ cardId: 'mac', targetId: 'mac' }),
    identity: () => 'quest', microphoneError: () => undefined, setup: () => false,
    send: (type, payload) => { if (type === 'voice.text') sent = payload as PayloadOf<'voice.text'>; return true; },
    render: (view) => { f.hud.setAssistant?.(view); syncMap(); },
  });
  f.hud.on('assistantDismiss', () => assistant.cancel());
  return { ...f, assistant, publishMap: (summary: string) => { currentMap = summary; syncMap(); },
    reply: (assistantReply: NonNullable<PayloadOf<'voice.text'>['assistant']>, intent: PayloadOf<'voice.text'>['intent'] = 'gesture') => assistant.receive({ ...sent!, recipientId: 'quest', intent, assistant: assistantReply }) };
}
afterEach(() => { instances.splice(0).forEach((hud) => hud.dispose()); vi.useRealTimers(); });

describe('headset navigation and truthful controls', () => {
  it('retains the failed latest request beside the working saved mapping after dismissing Muse', () => {
    const f = mappingWorkspace(), assistant = f.assistant;
    assistant.sendText('Make a ripple controlled by hand depth');
    f.reply({ state: 'reply', text: 'Hand depth is unsupported. No new mapping was applied.' });
    f.click('assistant-dismiss');
    expect(f.node('assistant-panel')?.visible).toBe(false);
    expect(f.node('device-status')).toMatchObject({ text: 'Map r2 · Height to Warp\nLatest request not applied' });
    expect(f.node('hand-control')?.visible).toBe(true);
    expect(f.node('hand-control')?.userData.disabled).not.toBe(true);
    assistant.sendText('What does Warp do?');
    f.reply({ state: 'reply', text: 'Warp changes the current visual.' }, 'question');
    f.click('assistant-dismiss');
    expect(f.node('device-status')).toMatchObject({ text: 'Map r2 · Height to Warp\nLatest request not applied' });
    let performs = 0; f.hud.on('handControl', () => performs++); f.click('hand-control'); expect(performs).toBe(1);
    assistant.cancel();
  });

  it.each(['failed', 'cancelled'] as const)('shows the published map without claiming it is unchanged when confirmation is %s', (outcome) => {
    vi.useFakeTimers(); const f = mappingWorkspace();
    f.assistant.sendText('Map wrist roll to Warp');
    f.reply({ state: 'proposal', text: 'Apply the new mapping.', proposalId: 'new-map', proposalKind: 'gesture', mapping: ['Wrist roll to Warp'] });
    f.assistant.confirm('mac', 'new-map', true);
    // The authoritative spec can arrive before its conversation acknowledgement is lost.
    f.publishMap('Map r3 · Wrist roll to Warp');
    if (outcome === 'failed') { vi.advanceTimersByTime(f.assistant.responseTimeoutMs + 1); f.click('assistant-dismiss'); }
    else f.assistant.cancel();
    expect(f.assistant.mappingOutcome('mac')).toBe(outcome);
    const text = outcome === 'failed' ? 'Latest result unconfirmed' : 'Request cancelled; saved map shown';
    expect(f.node('device-status')).toMatchObject({ text: `Map r3 · Wrist roll to Warp\n${text}` });
    expect(f.node('hand-control')?.visible).toBe(true); expect(f.node('hand-control')?.userData.disabled).not.toBe(true);
    f.reply({ state: 'applied', text: 'Late response.' });
    expect(f.assistant.mappingOutcome('mac')).toBe(outcome);
    f.assistant.cancel();
  });

  it('fits the two mapping-status lines above the actual first control label and value', () => {
    const f = setup(), spec = EXAMPLES['ceiling-dimmer']!;
    f.hud.renderSpec({ ...spec, controls: spec.controls.map((c) => ({ ...c, armed: true })) }, { targetId: 'mac' });
    f.hud.setArmed(spec.specId, true); f.update(undefined, 300);
    const status = f.node('device-status') as SdfText;
    // Use an oversized measured font block to exercise the same fit callback
    // used by browser SDF text, including a long saved-map/action name.
    status.textRenderInfo = { blockBounds: [0, -0.06, 0.5, 0] };
    f.hud.setDeviceState?.({ targetId: 'mac', connection: 'ready', performAvailable: true,
      mappingSummary: 'Map r22 · Pinch opening to Screen brightness', mappingOutcome: 'unchanged' });
    f.update(undefined, 300); f.hud.root.updateMatrixWorld(true);
    expect(status.text.split('\n')).toHaveLength(2); expect(status.whiteSpace).toBe('nowrap');
    expect(status.text).toContain('Latest request not applied');
    const bottom = status.getWorldPosition(new Vector3()).y - 0.06 * status.scale.y;
    for (const name of ['control-label', 'control-value']) {
      const label = f.node(name) as SdfText;
      const top = label.getWorldPosition(new Vector3()).y + label.fontSize * THEME.font.lineHeight / 2;
      expect(bottom).toBeGreaterThan(top + 0.005);
    }
    expect(status.scale.x * 0.5).toBeLessThanOrEqual(THEME.control.width);
  });

  it('offers an identifiable app menu, two filters and a direct virtual-synth action', () => {
    const f = setup(); let demo = 0;
    f.hud.on('visualSynth', () => demo++);
    f.hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: 1, status: 'Find devices' }); f.click('menu-toggle');
    expect(f.node('app-menu-title')).toMatchObject({ text: 'ControlAnything' });
    expect(f.node('visual-synth')?.visible).toBe(true); expect(f.node('muse-canvas')?.visible).toBe(false);
    f.click('menu-tools'); expect(f.node('visual-synth')?.visible).toBe(false);
    expect(f.node('filter:everything')?.visible).toBe(true); expect(f.node('filter:electronics')?.visible).toBe(true);
    expect(f.node('filter:lights')).toBeUndefined(); expect(f.node('menu-recovery-hint')).toBeTruthy();
    f.click('menu-tools-back'); f.click('visual-synth'); expect(demo).toBe(1); expect(f.node('main-menu')?.visible).toBe(false);
  });

  it('opens general Muse and deliberate area identification directly from the main menu', () => {
    const f = setup(); let asks = 0, scans = 0, opens = 0;
    f.hud.on('askMuseGeneral', () => asks++); f.hud.on('identifyArea', () => scans++); f.hud.on('menuOpened', () => opens++);
    f.click('menu-toggle'); expect(f.node('hand-dock')?.visible).toBe(false);
    f.click('ask-muse-general'); expect(asks).toBe(1); expect(f.node('main-menu')?.visible).toBe(false);
    f.click('menu-toggle'); f.click('menu-tools'); f.click('identify-area'); expect(scans).toBe(1); expect(opens).toBe(2);
  });

  it('keeps the Details geometry and hitbox inside the device card after hover feedback', () => {
    const f = setup();
    const spec = EXAMPLES['op1-knobs']!;
    f.hud.renderSpec({ ...spec, controls: spec.controls.map((c) => ({ ...c, armed: true })) }, { targetId: 'mac' });
    f.hud.setArmed(spec.specId, true); f.hud.setDeviceState?.({ targetId: 'mac', connection: 'ready', performAvailable: true });
    f.update(); const details = f.node('details-toggle')!;
    f.update({ point: details.getWorldPosition(new Vector3()) }); f.update();
    const plate = details.getObjectByName('button-plate')!;
    expect(details.position.x + plate.scale.x * details.scale.x / 2).toBeLessThanOrEqual(0.20);
    expect(details.scale.x).toBe(1);
  });

  it('keeps finding and tagging available under the nonblocking first-tag coach', () => {
    const f = setup();
    f.hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: 1, status: 'Find devices' });
    f.hud.upsertTarget({ ...f.target, id: 'next-synth', label: 'Synthesizer', tagged: false, position: [0.2, 1.5, -1] });
    f.hud.setOnboarding?.({ step: 'use', title: 'Your device is tagged', message: 'Open Menu and choose Use devices.' });
    f.update();
    expect(f.node('onboarding-guide')?.visible).toBe(true);
    expect(f.node('device-annotations')?.visible).toBe(true);
    expect(f.hud.isTargetVisible?.('next-synth')).toBe(true);
    const aim = { position: new Vector3(), size: 0 };
    expect(f.hud.getTargetAim?.('next-synth', aim)).toBe(true);
    f.click('menu-toggle');
    expect(f.node('onboarding-guide')?.visible).toBe(false);
    expect(f.node('device-annotations')?.visible).toBe(false);
    expect(f.hud.isTargetVisible?.('next-synth')).toBe(false);
  });

  it('targets the foreground workspace rather than an offscreen physical device', () => {
    const f = setup();
    f.hud.upsertTarget({ ...f.target, position: [3, 1.5, 0] });
    f.hud.setDeviceState?.({ targetId: 'mac', connection: 'setup', busy: true }); f.update();
    expect(f.node('device-edge-pill')?.visible).toBe(false);
    f.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); f.update();
    f.hud.setDeck({ open: true }); f.update();
    expect(f.node('device-edge-pill')?.visible).toBe(true);
    expect(f.node('device-edge-pill')?.userData.targetSurface).toBe('main-menu');
    f.hud.setDeck({ open: false }); f.hud.showConfirm({ id: 'test', title: 'Enable controls', kind: 'arm' }); f.update();
    expect(f.node('device-edge-pill')?.visible).toBe(true);
    expect(f.node('device-edge-pill')?.userData.targetSurface).toBe('confirmation-panel');
  });

  it('keeps game creation off an active synthesizer while preserving object information', () => {
    const f = setup(); f.hud.upsertTarget({ ...f.target, label: 'ControlAnything Visual Synth' });
    expect(f.node('canvas-create')?.visible).toBe(false); expect(f.node('object-inspect')?.visible).toBe(true);
    f.hud.upsertTarget({ ...f.target, label: 'Art book', connection: 'unknown' });
    f.hud.setDeviceState?.({ targetId: 'mac', connection: 'unknown' }); f.update();
    expect(f.node('canvas-create')?.visible).toBe(true);
  });

  it('never exposes unknown or unverified playback from a verified speech action or ready hack item', () => {
    const f = setup(); const events: string[] = [];
    f.hud.on('control', () => events.push('control')); f.hud.on('hack', () => events.push('hack'));
    const spec: Gen3dSpec = { ...EXAMPLES['ceiling-dimmer']!, specId: 'mac-controls', controls: [
      { id: 'play', label: 'Start playback', kind: 'trigger', armed: false, binding: { action: 'play' } },
      { id: 'pause', label: 'Pause audio', kind: 'trigger', binding: { action: 'pause' } },
      { id: 'say', label: 'Speech', kind: 'trigger', armed: true, binding: { action: 'say' } },
    ] };
    f.hud.renderSpec(spec, { targetId: 'mac' }); f.hud.setArmed(spec.specId, true); f.update();
    expect(f.node('control:play')).toBeUndefined(); expect(f.node('control:pause')).toBeUndefined(); expect(f.node('control:say')).toBeTruthy();
    expect(f.node('verdict-chip')?.visible).toBe(false); expect(f.node('device-status')).toMatchObject({ text: 'Only verified controls shown' });
    // When no verified control buttons remain, the old fallback must not expose untested hack entries.
    f.hud.setArmed(spec.specId, false, undefined, ['say']);
    f.hud.showHackMenu('mac', { title: 'Mac actions', items: [
      { id: 'play', label: 'Start playback', kind: 'action', status: 'ready' },
      { id: 'pause', label: 'Pause audio', kind: 'action', status: 'uploading' },
    ] });
    f.update(); expect(f.node('action:play')).toBeUndefined(); expect(f.node('action:pause')).toBeUndefined();
    expect(f.node('device-status')).toMatchObject({ text: 'No verified controls available' }); expect(events).toEqual([]);
  });

  it('shows camera aiming guidance only during the selected visual demo setup and keeps it out of dialogs', () => {
    const f = setup();
    f.hud.setDeviceState?.({ targetId: 'mac', connection: 'setup', screenGuide: true }); f.update();
    expect(f.node('visual-synth-screen-guide')?.visible).toBe(true);
    expect(f.node('visual-synth-screen-instruction')).toMatchObject({ text: 'Center the Mac visuals\nThen choose Set up control.' });
    const card = f.node('device-card')!; expect(card.position.x).toBeCloseTo(0);
    f.hud.setDeviceState?.({ targetId: 'mac', connection: 'setup', screenGuide: true, busy: true }); f.update();
    expect(f.node('visual-synth-screen-instruction')).toMatchObject({ text: 'Keep the Mac visuals centered\nwhile we check the controls.' });
    f.hud.setDeck({ open: true }); expect(f.node('visual-synth-screen-guide')?.visible).toBe(false);
    f.hud.setDeck({ open: false }); f.hud.showConfirm({ id: 'arm', title: 'Enable controls', kind: 'arm' }); f.update();
    expect(f.node('visual-synth-screen-guide')?.visible).toBe(false);
    f.hud.showConfirm(null); f.hud.setDeviceState?.({ targetId: 'mac', connection: 'ready', screenGuide: true }); f.update();
    expect(f.node('visual-synth-screen-guide')?.visible).toBe(false); expect(card.position.x).toBeCloseTo(0);
  });

  it('keeps an unavailable synth workflow visible, suppresses stale cards, and offers retry or Change device', () => {
    const f = setup(); let retries = 0, changes = 0;
    f.hud.on('visualSynth', () => retries++); f.hud.on('changeDevice', () => changes++);
    f.hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', visualSynthSelection: { phase: 'unavailable', message: 'Open the companion in Chrome and choose Open visuals.' } });
    f.update(undefined, 10_000);
    expect(f.node('visual-synth-selection')?.visible).toBe(true); expect(f.node('device-card')?.visible).toBe(false);
    expect(f.node('visual-synth-selection-message')).toMatchObject({ text: expect.stringContaining('Open visuals') });
    f.click('visual-synth-retry'); expect(retries).toBe(1);
    f.click('menu-toggle'); expect(f.node('visual-synth-selection')?.visible).toBe(false);
    f.click('menu-tools'); f.click('change-device'); expect(changes).toBe(1);
  });

  it.each(['pending', 'unavailable'] as const)('keeps Mac pairing above a %s visual selection without overlapping panels or retry input', phase => {
    const f = setup(); let retries = 0;
    f.hud.on('visualSynth', () => retries++);
    f.hud.on('helperPair', () => f.hud.showHelperPairing?.({ urls: ['http://localhost:8787/pair'] }));
    f.hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '', visualSynthSelection: { phase, message: 'Waiting for Mac visuals' } });
    f.update(); expect(f.node('visual-synth-selection')?.visible).toBe(true);
    f.click('menu-toggle'); f.click('menu-tools'); f.click('helper-pair');
    expect(f.node('helper-pairing')?.visible).toBe(true);
    expect(f.node('visual-synth-selection')?.visible).toBe(false);
    f.click('visual-synth-retry'); expect(retries).toBe(0);
    f.hud.showHelperPairing?.(null); f.update();
    expect(f.node('visual-synth-selection')?.visible).toBe(true);
    expect(f.node('device-card')?.visible).toBe(false);
  });

  it('prevents an overlapping MacBook chip from stealing Ask Muse or its Apply button', () => {
    const f = setup(); const events: string[] = [];
    f.hud.on('selectTarget', ({ targetId }) => events.push(targetId));
    f.hud.on('assistantTalk', () => { events.push('ask'); f.hud.setAssistant?.({ targetId: 'mac', state: 'proposal', proposalId: 'map', mapping: ['Right height: Warp'] }); });
    f.hud.on('assistantConfirm', () => events.push('apply'));
    const ask = f.node('assistant-talk')!.getWorldPosition(new Vector3());
    f.hud.upsertTarget({ ...f.target, id: 'other-laptop', position: [ask.x, ask.y - 0.12, ask.z + 0.1] }); f.update();
    expect(f.node('target-label:other-laptop')?.visible).toBe(false);
    f.click('assistant-talk'); expect(events).toEqual(['ask']);
    expect(f.node('device-card')?.visible).toBe(false);
    f.click('assistant-apply'); expect(events).toEqual(['ask', 'apply']);
  });

  it('offers object information without a connection and keeps readiness wording complete', () => {
    const f = setup(); let inspect = 0;
    f.hud.setDeviceState?.({ targetId: 'mac', connection: 'offline' });
    f.hud.on('inspectObject', () => inspect++); f.click('object-inspect'); expect(inspect).toBe(1);
    const title = 'ControlAnything Visual Synth is Ready';
    f.hud.showConfirm({ id: 'arm', kind: 'arm', title }); f.update();
    expect(f.node('confirmation-title')).toMatchObject({ text: title, userData: expect.objectContaining({ fitWidth: expect.any(Number), fitHeight: expect.any(Number) }) });
  });

  it('accepts a relaxed distant pinch where the visible button aim assistance lands', () => {
    const f = setup(); let asks = 0; f.hud.on('assistantTalk', () => asks++);
    const point = f.node('assistant-talk')!.getWorldPosition(new Vector3()).add(new Vector3(0.12, 0, 0));
    f.camera.position.z += 2; f.update({ point }); f.update({ point, pressed: true }); f.update({ point, released: true });
    expect(asks).toBe(1);
  });
});
