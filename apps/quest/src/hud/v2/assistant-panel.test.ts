import { describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import { EXAMPLES } from '@ce/gen3d';
import type { ObjectInformation } from '@ce/protocol';
import type { AssistantView, HandState, HudFrame, HudTarget } from '../contract';
import { assistantLines, informationPages, readingPages } from './assistant-panel';
import { createHud } from './index';

const target: HudTarget = { id: 'synth', tagged: true, connection: 'setup', label: 'Synthesizer', status: 'scanned',
  position: [0, 1.4, -1], facing: [0, 0, 1], confirmed: true, sizeM: [0.3, 0.2, 0.05] };

function fixture(connection: 'setup' | 'offline' | 'ready' = 'setup') {
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.4, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
  let time = 0;
  const frame = (hand?: Partial<HandState>, elapsed = 20): HudFrame => ({ time: time += elapsed, dt: elapsed / 1000,
    head: { position: camera.position, quaternion: camera.quaternion }, hands: hand ? { right: {
      joints: {}, controller: true, pinchPoint: new Vector3(10, 10, 10),
      ray: { origin: camera.position.clone(), dir: new Vector3(0, 0, -1) },
      pinching: false, justPinched: false, justReleased: false, ...hand,
    } } : {}, pointer: 'mouse' });
  const node = (name: string) => hud.root.getObjectByName(name)!;
  const text = (name: string) => (node(name) as Object3D & { text: string }).text;
  const ray = (object: Object3D) => ({ origin: camera.position.clone(), dir: object.getWorldPosition(new Vector3()).sub(camera.position).normalize() });
  const pinch = (object: Object3D, held = 20) => {
    hud.update(frame(undefined, 200));
    const aim = ray(object);
    hud.update(frame({ ray: aim }));
    hud.update(frame({ ray: aim, pinching: true, justPinched: true }));
    hud.update(frame({ ray: aim, pinching: true }, held));
    hud.update(frame({ ray: aim, justReleased: true }));
  };
  hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: 'Choose a device' });
  hud.upsertTarget({ ...target, connection }); hud.setLocked(target.id);
  hud.setDeviceState?.({ targetId: target.id, connection });
  hud.update(frame(undefined, 200));
  const view = (state: AssistantView['state'], extra: Partial<AssistantView> = {}) => hud.setAssistant?.({ targetId: target.id, state, ...extra });
  return { hud, camera, frame, node, text, ray, pinch, view };
}

describe('Ask Muse on a selected device', () => {
  it('lets the wearer read every word of a long request and reply without losing the current request', () => {
    const f = fixture(), dismissed = vi.fn(); f.hud.on('assistantDismiss', dismissed);
    const request = Array.from({ length: 90 }, (_, i) => `request${i}`).join(' ');
    const reply = Array.from({ length: 110 }, (_, i) => `reply${i}`).join(' ');
    f.view('reply', { transcript: request, text: reply });
    f.pinch(f.node('assistant-read'));
    const pages = [...readingPages(request), ...readingPages(reply)];
    for (let index = 0; index < pages.length; index++) {
      expect(f.text('object-info-detail')).toBe(pages[index]);
      expect(f.text('object-info-detail')).not.toContain('…');
      expect(f.text('object-info-detail').length).toBeLessThanOrEqual(280);
      if (index < pages.length - 1) f.pinch(f.node('object-info-sources'));
    }
    expect(f.node('object-info-sources').userData.disabled).toBe(true);
    f.pinch(f.node('object-info-back')); expect(f.text('object-info-detail')).toBe(pages.at(-2));
    f.pinch(f.node('object-info-close'));
    expect(dismissed).not.toHaveBeenCalled(); expect(f.node('assistant-panel').visible).toBe(true);
    expect(f.node('assistant-dismiss').visible).toBe(true); expect(f.node('assistant-read').visible).toBe(true);
    f.hud.dispose();
  });

  it('opens a general conversation without a selected device and sends using its own context', () => {
    const f = fixture(), talk = vi.fn(), dismissed = vi.fn();
    f.hud.on('assistantTalk', talk); f.hud.on('assistantDismiss', dismissed);
    f.hud.setLocked(null); f.hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: 0, status: '' });
    f.hud.setAssistant?.({ targetId: 'muse-general', state: 'listening' }); f.hud.update(f.frame());
    expect(f.node('assistant-panel').visible).toBe(true); expect(f.text('assistant-title')).toBe('Ask Muse');
    expect(f.node('device-annotations').visible).toBe(false);
    f.pinch(f.node('assistant-send')); expect(talk).toHaveBeenCalledExactlyOnceWith({ targetId: 'muse-general' });
    f.pinch(f.node('assistant-dismiss')); expect(dismissed).toHaveBeenCalledExactlyOnceWith({ targetId: 'muse-general' });
    f.hud.dispose();
  });

  it('distinguishes selecting a connected instrument from applying a mapping', () => {
    const f = fixture(), confirm = vi.fn(); f.hud.on('assistantConfirm', confirm);
    f.view('proposal', { proposalId: 'peripheral-choice', proposalKind: 'peripheral', text: 'Use the connected OP-1 Field. This does not enable physical control.' });
    expect(f.node('assistant-apply').children[1]).toMatchObject({ text: 'Choose instrument' });
    expect(f.text('assistant-status')).toContain('Choose connected instrument');
    f.pinch(f.node('assistant-apply')); expect(confirm).toHaveBeenCalledExactlyOnceWith({ targetId: target.id, proposalId: 'peripheral-choice', accept: true });
    f.hud.dispose();
  });

  it('foregrounds the known summary and combines missing facts into one note without empty rows', () => {
    const f = fixture('offline');
    const info: ObjectInformation = { title: 'The Art of Cyberpunk', identityStatus: 'uncertain', identityNote: 'The cover matches; edition is unconfirmed.',
      description: { value: 'An illustrated art book.', sourceIds: ['1'] }, dimensions: { value: null, sourceIds: [] }, weight: { value: null, sourceIds: [] }, price: null,
      sources: [{ id: '1', title: 'Publisher catalogue', url: 'https://example.com/book' }], researchedAt: 1793664000000, cached: false, source: 'fixture' };
    f.view('reply', { text: 'Long fallback prose '.repeat(20), objectInfo: info }); f.hud.update(f.frame());
    expect(f.text('assistant-title')).toBe('The Art of Cyberpunk');
    expect(f.text('assistant-status')).toContain('Identity uncertain');
    expect(f.node('assistant-response').visible).toBe(false);
    expect(f.text('object-info-description')).toContain('[1]');
    expect(f.text('object-info-description')).toBe('Summary [1]: An illustrated art book.');
    for (const name of ['dimensions', 'weight', 'price']) {
      expect(f.node(`object-info-${name}`).visible).toBe(false);
      expect(f.text(`object-info-${name}`)).toBe('');
    }
    expect(f.text('object-info-unavailable').replace(/\s+/g, ' ')).toBe('Not available: dimensions, weight, price. Check exact model or edition.');
    const visible = f.node('object-info-facts').children.filter((node) => node.visible);
    expect(visible).toHaveLength(3);
    expect(f.node('object-info-description').position.y).toBeGreaterThan(f.node('object-info-unavailable').position.y);
    expect(f.node('object-info-unavailable').position.y).toBeGreaterThan(f.node('object-info-provenance').position.y);
    for (const node of visible) {
      expect((node as Object3D & { maxWidth: number }).maxWidth).toBe(0.38);
      expect(f.text(node.name).length).toBeLessThanOrEqual(280);
      expect(f.text(node.name).split('\n').every((line) => line.length <= 44)).toBe(true);
      expect(node.position.y - node.userData.fitHeight).toBeGreaterThan(-0.15);
      expect(f.text(node.name)).not.toContain('Unknown');
    }
    expect(f.node('assistant-apply').visible).toBe(false);
    f.pinch(f.node('object-info-sources'));
    expect(f.text('object-info-detail').replace(/\s+/g, ' ')).toContain('edition is unconfirmed');
    f.pinch(f.node('object-info-back')); expect(f.node('object-info-facts').visible).toBe(true);
    const pages = informationPages(info);
    for (const page of pages) { f.pinch(f.node('object-info-sources')); expect(f.text('object-info-detail')).toBe(page.text); }
    expect(f.text('object-info-detail')).toBe('https://example.com/book');
    f.pinch(f.node('object-info-sources')); expect(f.node('object-info-facts').visible).toBe(true);
    f.view('error', { text: 'Research unavailable', objectInfo: undefined });
    expect(f.node('object-info-facts').visible).toBe(false); expect(f.node('assistant-response').visible).toBe(true);
    f.hud.dispose();
  });

  it('keeps all sourced facts and price context readable through actual information pages', () => {
    const f = fixture('offline'), actions = vi.fn();
    for (const event of ['setup', 'assistantConfirm', 'canvasCreate'] as const) f.hud.on(event, actions);
    const info: ObjectInformation = { title: 'Portable instrument', identityStatus: 'matched', identityNote: 'Sources match the supplied model. Physical identity is unverified.',
      description: { value: 'This instrument has a detailed sourced description. '.repeat(8), sourceIds: ['1'] },
      dimensions: { value: '28.8 x 10.2 x 2.9 cm', sourceIds: ['1'] }, weight: { value: '643 g', sourceIds: ['1'] },
      price: { amount: '1999', currency: 'USD', retailer: 'Example shop', condition: 'new', asOf: '2026-11-03', sourceIds: ['2'] },
      sources: [{ id: '1', title: 'Manufacturer specifications', url: 'https://example.com/model/specifications', excerpt: 'Dimensions and weight are listed for the exact supplied model.' },
        { id: '2', title: 'Retailer listing', url: 'https://example.com/shop/model' }], researchedAt: 1793664000000, source: 'fixture', cached: false };
    f.view('reply', { objectInfo: info }); f.hud.update(f.frame());
    expect(f.text('assistant-title')).toBe(info.title);
    expect(f.node('object-info-unavailable').visible).toBe(false);
    expect(f.text('object-info-dimensions')).toBe('Dimensions [1]: 28.8 x 10.2 x 2.9 cm');
    expect(f.text('object-info-weight')).toBe('Weight [1]: 643 g');
    expect(f.text('object-info-price').replace(/\s+/g, ' ')).toContain('Price [2]: USD 1999 Example shop');
    const visible = f.node('object-info-facts').children.filter((node) => node.visible);
    expect(visible).toHaveLength(5);
    for (const node of visible) {
      expect((node as Object3D & { maxWidth: number }).maxWidth).toBe(0.38);
      expect(f.text(node.name).split('\n').length).toBeLessThanOrEqual(2);
      expect(node.position.y - node.userData.fitHeight).toBeGreaterThan(-0.15);
    }
    const retained: { label: string; text: string }[] = [];
    for (let i = 0; i < informationPages(info).length; i++) {
      f.pinch(f.node('object-info-sources'));
      retained.push({ label: f.text('assistant-status'), text: f.text('object-info-detail') });
      expect(f.text('object-info-detail')).not.toContain('…');
      expect(f.text('object-info-detail').length).toBeLessThanOrEqual(280);
      expect(f.text('object-info-detail').split('\n').every((line) => line.length <= 38)).toBe(true);
      expect(f.text('object-info-detail').split('\n').length).toBeLessThanOrEqual(7);
      expect(f.node('assistant-apply').visible).toBe(false);
    }
    const normalized = (value: string) => value.replace(/\s+/g, '');
    const complete = (label: string) => normalized(retained.filter((page) => page.label.includes(`· ${label}`)).map((page) => page.text).join(''));
    expect(complete('Description')).toBe(normalized(info.description.value!));
    expect(complete('Dimensions')).toBe(normalized(info.dimensions.value!));
    expect(complete('Weight')).toBe(normalized(info.weight.value!));
    expect(complete('Price')).toBe(normalized('USD 1999 Example shop Condition: new As of 2026-11-03'));
    expect(complete('URL')).toBe(normalized(info.sources.map((source) => source.url).join('')));
    expect(actions).not.toHaveBeenCalled();
    f.pinch(f.node('object-info-sources')); expect(f.node('object-info-facts').visible).toBe(true);
    f.hud.dispose();
  });

  it('offers one useful empty research state without repeated Unknown fields', () => {
    const f = fixture('offline');
    const info: ObjectInformation = { title: 'Unidentified object', identityStatus: 'uncertain', identityNote: 'Exact model is unknown.',
      description: { value: null, sourceIds: [] }, dimensions: { value: null, sourceIds: [] }, weight: { value: null, sourceIds: [] }, price: null,
      sources: [], researchedAt: 1, source: 'fixture', cached: false };
    f.view('reply', { objectInfo: info });
    expect(f.text('object-info-description')).toBe('No sourced details yet.');
    expect(f.text('object-info-unavailable')).toContain('Check exact model or edition.');
    expect(informationPages(info).filter((page) => page.label === 'Not available')).toHaveLength(1);
    expect(informationPages(info).some((page) => page.text === 'Unknown')).toBe(false);
    f.hud.dispose();
  });

  it('retains full long descriptions, evidence excerpts and source URLs within the actual text limit', () => {
    const description = 'Detailed description. '.repeat(22), excerpt = 'Relevant publisher excerpt. '.repeat(32), url = `https://example.com/${'long-source-path-'.repeat(50)}`;
    const info: ObjectInformation = { title: 'Book', identityStatus: 'matched', identityNote: 'Source matches the supplied identity, not an independent physical identification.',
      description: { value: description, sourceIds: ['1'] }, dimensions: { value: null, sourceIds: [] }, weight: { value: null, sourceIds: [] }, price: null,
      sources: [{ id: '1', title: 'Publisher', url, excerpt }], researchedAt: 1, source: 'fixture', cached: false };
    const pages = informationPages(info), normalize = (value: string) => value.replace(/\s+/g, '');
    for (const [prefix, expected] of [['Description', description], ['Excerpt', excerpt], ['URL', url]]) {
      const selected = pages.filter((page) => page.label.startsWith(prefix!));
      expect(normalize(selected.map((page) => page.text).join(''))).toBe(normalize(expected!));
      expect(selected.every((page) => page.text.length <= 280 && page.text.split('\n').length <= 7)).toBe(true);
    }
    expect(pages[0]?.text).toContain('not an independent');
  });

  it('requires all identity-review pages before offering Confirm identity', () => {
    const f = fixture(), confirm = vi.fn(); f.hud.on('assistantConfirm', confirm);
    const text = 'Confirm the Field model yourself. Old controls will be cleared. '.repeat(10);
    f.view('proposal', { proposalId: 'identity-one', proposalKind: 'identity', text, mapping: ['OP-1 Field connected over USB MIDI; physical control unverified.'] });
    expect(f.text('assistant-status')).toContain('Review identity'); expect(f.node('assistant-apply').visible).toBe(false);
    const pages = readingPages(`${text}\n\nOP-1 Field connected over USB MIDI; physical control unverified.`);
    for (let i = 0; i < pages.length; i++) {
      expect(f.text('assistant-response')).toBe(pages[i]);
      if (i < pages.length - 1) f.pinch(f.node('object-info-sources'));
    }
    expect(f.node('assistant-apply').visible).toBe(true);
    expect(f.node('assistant-apply').children[1]).toMatchObject({ text: 'Confirm identity' });
    f.pinch(f.node('assistant-apply')); expect(confirm).toHaveBeenCalledExactlyOnceWith({ targetId: target.id, proposalId: 'identity-one', accept: true });
    f.hud.dispose();
  });
  it.skip.each(['setup', 'offline', 'ready'] as const)('is available for a selected %s device and stays out of annotation/onboarding', (connection) => {
    const f = fixture(connection);
    expect(f.node('assistant-talk').visible).toBe(true);
    expect(f.node('assistant-panel').visible).toBe(false);
    f.view('reply', { text: 'Ask me about this device.' });
    expect(f.node('assistant-panel').visible).toBe(true);
    f.hud.setLocked(null);
    expect(f.node('device-card').visible).toBe(false);
    expect(f.node('assistant-panel').visible).toBe(false);
    f.view('reply', { text: 'A stale reply' });
    f.hud.setLocked(target.id);
    expect(f.node('assistant-panel').visible).toBe(false);
    f.hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: 1, status: 'Find devices' });
    f.view('listening');
    expect(f.node('assistant-panel').visible).toBe(false);
    expect(f.node('assistant-talk').visible).toBe(false);
    f.hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: 'Use devices' });
    f.hud.setOnboarding?.({ step: 'use', title: 'Your device is tagged', message: 'Open Menu.' });
    f.view('reply');
    expect(f.node('assistant-talk').visible).toBe(false);
    expect(f.node('assistant-panel').visible).toBe(false);
    f.hud.dispose();
  });

  it.skip('records and sends with two separate clicks, never requiring the hand to remain held', () => {
    const f = fixture(); const talk = vi.fn();
    f.hud.on('assistantTalk', (event) => { talk(event); f.view(talk.mock.calls.length === 1 ? 'listening' : 'thinking'); });
    f.pinch(f.node('assistant-talk'), 2500);
    expect(talk).toHaveBeenCalledExactlyOnceWith({ targetId: target.id });
    expect(f.text('assistant-status')).toBe('Listening · pinch Send when finished');
    const label = f.node('assistant-talk').children.find((child) => 'text' in child) as Object3D & { text: string };
    expect(label.text).toBe('Send');
    f.hud.update(f.frame(undefined, 3000));
    expect(f.node('assistant-panel').visible).toBe(true);
    expect(talk).toHaveBeenCalledOnce();
    f.pinch(f.node('assistant-send'));
    expect(talk).toHaveBeenCalledTimes(2);
    expect(f.text('assistant-status')).toBe('Working · no new controls applied');
    f.pinch(f.node('assistant-talk'));
    expect(talk).toHaveBeenCalledTimes(2);
    f.view('reply', { transcript: 'What can this device do?', text: 'It supports MIDI controls.' });
    expect(f.text('assistant-transcript')).toContain('What can this device do?');
    expect(f.text('assistant-response')).toBe('It supports MIDI controls.');
    expect(f.node('assistant-talk').userData.disabled).toBe(false);
    f.hud.dispose();
  });

  it.each([true, false])('requires an explicit proposal choice (accept=%s)', (accept) => {
    const f = fixture('ready'), confirm = vi.fn();
    f.hud.on('assistantConfirm', confirm);
    f.view('proposal', { proposalId: 'map-1', transcript: 'Use height for brightness', text: 'Use your hand height to change brightness.', mapping: ['Right hand height: brightness', 'Left fist: engage controls'] });
    expect(f.node('assistant-dismiss').children[1]).toMatchObject({ text: 'Dismiss' });
    f.hud.update(f.frame(undefined, 200));
    expect(confirm).not.toHaveBeenCalled();
    expect(f.text('assistant-mapping')).toContain('Right hand height: brightness');
    f.pinch(f.node(accept ? 'assistant-apply' : 'assistant-dismiss'), 1000);
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ targetId: target.id, proposalId: 'map-1', accept });
    f.view(accept ? 'applied' : 'reply', { text: accept ? 'Mapping applied.' : 'Mapping dismissed.' });
    expect(f.node('assistant-apply').visible).toBe(false);
    expect(f.node('assistant-dismiss').visible).toBe(true);
    f.view('proposal', { proposalId: 'too-long', mapping: ['Right hand → brightness '.repeat(20)] });
    expect(f.text('assistant-mapping')).toContain('too long to review');
    expect(f.node('assistant-apply').visible).toBe(false);
    f.hud.dispose();
  });

  it('blocks proposal interaction behind the menu and Enable controls dialog', () => {
    const f = fixture('ready'), confirm = vi.fn(); f.hud.on('assistantConfirm', confirm);
    f.view('proposal', { proposalId: 'map-1', mapping: ['Right hand height: brightness'] });
    f.hud.setDeck({ open: true });
    expect(f.node('assistant-panel').visible).toBe(false);
    f.pinch(f.node('assistant-apply'));
    expect(confirm).not.toHaveBeenCalled();
    f.hud.setDeck({ open: false });
    expect(f.node('assistant-panel').visible).toBe(true);
    f.hud.showConfirm({ id: 'arm', kind: 'arm', title: 'Enable controls' });
    expect(f.node('assistant-panel').visible).toBe(false);
    f.pinch(f.node('assistant-apply'));
    expect(confirm).not.toHaveBeenCalled();
    f.hud.showConfirm(null);
    f.pinch(f.node('assistant-apply'));
    expect(confirm).toHaveBeenCalledOnce();
    f.hud.dispose();
  });

  it('restores the centered conversation after setup without making the covered controls interactive', () => {
    const f = fixture('setup'), confirm = vi.fn(), control = vi.fn();
    f.hud.on('assistantConfirm', confirm); f.hud.on('control', control);
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'setup', screenGuide: true });
    f.view('setup', { text: 'Set up the visual synth, then enable controls.' });
    f.hud.update(f.frame(undefined, 300));
    const card = f.node('device-card'), assistant = f.node('assistant-panel');
    const assistantPosition = assistant.position.clone(), assistantRotation = assistant.quaternion.clone();
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'setup', screenGuide: true, busy: true });
    f.hud.showConfirm({ id: 'arm', kind: 'arm', title: 'Enable controls' });
    expect(assistant.visible).toBe(false);
    // Looking toward Muse during the check must not make the device card move into the reply panel.
    f.camera.position.x += 0.05; f.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -0.3);
    const example = EXAMPLES['op1-knobs']!;
    const spec = { ...example, specId: 'visual-controls', controls: [
      { ...example.controls[0]!, armed: true },
      ...['Flow', 'Rings', 'Prism'].map((label, i) => ({ id: `pattern${i}`, label, kind: 'trigger' as const, armed: true, binding: { action: `pattern${i}` } })),
    ] };
    f.hud.renderSpec(spec, { targetId: target.id }); f.hud.setArmed(spec.specId, true);
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', screenGuide: false, performAvailable: true });
    f.hud.update(f.frame(undefined, 500));
    f.hud.showConfirm(null);
    f.view('proposal', { proposalId: 'after-setup', mapping: ['Hand height to Warp (0-127)'] });
    f.hud.update(f.frame(undefined, 300));
    expect(card.visible).toBe(false);
    expect(assistant.position).toEqual(assistantPosition); expect(assistant.quaternion.toArray()).toEqual(assistantRotation.toArray());
    expect(f.node('control:pattern2')).toBeTruthy();
    expect(assistant.visible).toBe(true);
    f.pinch(f.node('assistant-apply'));
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ targetId: target.id, proposalId: 'after-setup', accept: true });
    expect(control).not.toHaveBeenCalled();
    f.hud.dispose();
  });

  it('anchors the conversation once and clears it when another device is selected', () => {
    const f = fixture(); f.view('listening');
    const position = f.node('assistant-panel').position.clone(), rotation = f.node('assistant-panel').quaternion.clone();
    f.camera.position.x += 1; f.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    for (let i = 0; i < 6; i++) f.hud.update(f.frame(undefined, 1000));
    f.view('reply', { text: 'I can help.' });
    expect(f.node('assistant-panel').position).toEqual(position);
    expect(f.node('assistant-panel').quaternion.toArray()).toEqual(rotation.toArray());
    f.hud.upsertTarget({ ...target, id: 'other' }); f.hud.setLocked('other');
    expect(f.node('assistant-panel').visible).toBe(false);
    f.view('proposal', { proposalId: 'stale' });
    expect(f.node('assistant-panel').visible).toBe(false);
    f.hud.dispose();
  });

  it.skip('preserves Perform and Details controls alongside Ask Muse', () => {
    const f = fixture('ready');
    const spec = EXAMPLES['op1-knobs']!;
    f.hud.renderSpec({ ...spec, controls: spec.controls.map((control) => ({ ...control, armed: true })) }, { targetId: target.id });
    f.hud.setArmed(EXAMPLES['op1-knobs']!.specId, true);
    f.hud.setDeviceState?.({ targetId: target.id, connection: 'ready', performAvailable: true });
    expect(f.node('hand-control')).toBeTruthy(); expect(f.node('details-toggle')).toBeTruthy();
    f.pinch(f.node('details-toggle'));
    expect(f.node('details-panel').visible).toBe(true);
    expect(f.node('assistant-talk').visible).toBe(true);
    f.view('reply', { text: 'These are the controls.' });
    expect(f.node('details-panel').visible).toBe(true);
    f.hud.dispose();
  });

  it('bounds text and refuses an incomplete mapping review', () => {
    const f = fixture();
    f.view('proposal', { proposalId: 'too-long', transcript: 'word '.repeat(100), text: 'response '.repeat(100), mapping: Array.from({ length: 8 }, (_, i) => `Mapping ${i}`) });
    expect(f.text('assistant-transcript').split('\n').length).toBeLessThanOrEqual(2);
    expect(f.text('assistant-response').split('\n').length).toBeLessThanOrEqual(3);
    expect(f.text('assistant-response')).toContain('…');
    expect(f.text('assistant-mapping')).toContain('too long to review');
    expect(f.node('assistant-apply').visible).toBe(false);
    expect(f.node('assistant-dismiss').visible).toBe(true);
    expect(assistantLines('x'.repeat(100), 40, 2).split('\n').every((line) => line.length <= 40)).toBe(true);
    expect(assistantLines('Height → brightness', 40, 2)).toBe('Height to brightness');
    f.hud.dispose();
  });

  it.each(['listening', 'thinking', 'reply', 'setup', 'applied', 'error'] as const)('can dismiss %s without changing the selected device', (state) => {
    const f = fixture(), dismiss = vi.fn();
    f.hud.on('assistantDismiss', (event) => { dismiss(event); f.hud.setAssistant?.(null); });
    f.view(state, { text: 'Connect the companion device, then keep it open while you select the synthesizer and set up its controls. Check that the cable supports data and that MIDI input is enabled.' });
    expect(f.node('assistant-dismiss').children[1]).toMatchObject({ text: state === 'applied' ? 'Use controls' : 'Dismiss' });
    expect(f.text('assistant-response').split('\n').length).toBeGreaterThan(3);
    expect(f.text('assistant-response').split('\n').length).toBeLessThanOrEqual(6);
    f.pinch(f.node('assistant-dismiss'));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ targetId: target.id });
    expect(f.node('assistant-panel').visible).toBe(false);
    expect(f.node('device-card').visible).toBe(true);
    f.hud.dispose();
  });

  it.each(['menu', 'confirmation', 'pairing', 'approvals'] as const)('cancels a hidden recording when %s opens', (surface) => {
    const f = fixture(), dismiss = vi.fn();
    f.hud.on('assistantDismiss', (event) => { dismiss(event); f.hud.setAssistant?.(null); });
    f.view('listening');
    if (surface === 'menu') f.hud.setDeck({ open: true });
    if (surface === 'confirmation') f.hud.showConfirm({ id: 'arm', title: 'Enable controls', kind: 'arm' });
    if (surface === 'pairing') f.hud.showHelperPairing?.({ urls: ['http://localhost:8787/pair'] });
    if (surface === 'approvals') f.hud.showApprovals([{ pairingId: 'new', name: 'Helper', kind: 'mac', display: '123456' }]);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ targetId: target.id });
    expect(f.node('assistant-panel').visible).toBe(false);
    f.hud.dispose();
  });

  it('cancels microphone opening through Menu but keeps an in-flight reply suspended', () => {
    const f = fixture(), dismiss = vi.fn();
    f.hud.on('assistantDismiss', (event) => { dismiss(event); f.hud.setAssistant?.(null); });
    f.view('idle', { text: 'Opening microphone…' }); f.hud.setDeck({ open: true });
    expect(dismiss).toHaveBeenCalledOnce();
    f.hud.setDeck({ open: false });
    f.view('thinking'); f.hud.setDeck({ open: true });
    expect(dismiss).toHaveBeenCalledOnce();
    f.hud.setDeck({ open: false });
    expect(f.node('assistant-panel').visible).toBe(true);
    f.hud.dispose();
  });

  it('suppresses all competing chips until the selected workspace is explicitly released', () => {
    const f = fixture();
    f.hud.upsertTarget({ ...target, id: 'other', position: [0.5, 1.4, -1] });
    f.hud.update(f.frame());
    const chip = f.node(`target-label:${target.id}`), other = f.node('target-label:other');
    const position = chip.position.clone();
    f.view('reply', { text: 'I can help with this device.' });
    expect(chip.visible).toBe(false); expect(other.visible).toBe(false);
    expect(f.hud.isTargetVisible?.(target.id)).toBe(true);
    expect(f.hud.getTargetAim?.(target.id, { position: new Vector3(), size: 0 })).toBe(false);
    expect(chip.position).toEqual(position);
    f.hud.setDeck({ open: true }); expect(chip.visible).toBe(false);
    f.hud.setDeck({ open: false }); expect(chip.visible).toBe(false);
    f.hud.showConfirm({ id: 'arm', kind: 'arm', title: 'Enable controls' }); expect(chip.visible).toBe(false);
    f.hud.showConfirm(null); f.hud.update(f.frame()); expect(chip.visible).toBe(false);
    f.hud.setAssistant?.(null); expect(chip.visible).toBe(false);
    f.hud.setLocked(null); expect(chip.visible).toBe(true); expect(other.visible).toBe(true);
    expect(chip.position).toEqual(position);
    f.hud.dispose();
  });

  it('keeps a noninteractive recovery cue for an offscreen conversation and its restored workspace', () => {
    const f = fixture('ready');
    f.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    f.hud.update(f.frame());
    const edge = f.node('device-edge-pill');
    expect(edge.visible).toBe(true);
    f.view('proposal', { proposalId: 'mapping', mapping: ['Hand height: brightness'] });
    expect(f.node('assistant-panel').visible).toBe(true);
    expect(edge.visible).toBe(true); expect(edge.userData.targetSurface).toBe('assistant-panel');
    f.hud.update(f.frame()); expect(edge.visible).toBe(true);
    f.hud.setAssistant?.(null);
    expect(edge.visible).toBe(true);
    expect(f.node('device-card').visible).toBe(true);
    f.hud.dispose();
  });
});
