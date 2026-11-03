import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import type { HandState, HudFrame } from '../contract';
import { createHud, THEME } from './index';
import { pairingUrlText } from './helper-pairing';

const urls = ['http://localhost:8787/pair', 'http://192.168.1.8:8787/pair', 'http://mac.local:8787/pair'];
function setup() {
  const scene = new Scene(), camera = new PerspectiveCamera();
  camera.position.set(0, 1.6, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene, camera, renderer: {} as WebGLRenderer });
  let time = 0;
  function frame(hand?: Partial<HandState>, elapsed = 20): HudFrame {
    time += elapsed;
    return { time, dt: elapsed / 1000, head: { position: camera.position, quaternion: camera.quaternion }, hands: hand ? { right: {
      joints: { 'index-finger-tip': { position: hand.pinchPoint!, quaternion: new Quaternion(), radius: 0.008 } },
      pinchPoint: new Vector3(), pinching: false, justPinched: false, justReleased: false,
      ray: { origin: camera.position, dir: new Vector3(0, 0, -1) }, ...hand,
    } } : {} };
  }
  function pinch(name: string) {
    hud.update(frame());
    const object = hud.root.getObjectByName(name)!;
    expect(object, name).toBeTruthy();
    const point = object.getWorldPosition(new Vector3());
    hud.update(frame({ pinchPoint: point, pinching: true, justPinched: true }));
    hud.update(frame({ pinchPoint: point, justReleased: true }));
  }
  hud.showHelperPairing?.({ urls }); hud.update(frame());
  return { hud, frame, pinch, camera };
}

describe('helper pairing card', () => {
  it('shows server URLs in local JetBrains Mono and scans beyond thirty seconds at a steady world anchor', () => {
    const { hud, frame, camera } = setup();
    const card = hud.root.getObjectByName('helper-pairing')!;
    expect(card.visible).toBe(true);
    expect(hud.root.getObjectByName('helper-pairing-title')).toMatchObject({ text: 'Pair a helper device' });
    expect(hud.root.getObjectByName('helper-pairing-url')).toMatchObject({ text: 'localhost:8787/pair', font: THEME.font.mono });
    expect(hud.root.getObjectByName('helper-pairing-alternative')).toMatchObject({ text: 'or 192.168.1.8:8787/pair' });
    expect(hud.root.getObjectByName('helper-pairing-status')).toMatchObject({ text: 'Looking for the QR code…' });
    const anchor = card.position.clone();
    camera.position.x += 0.1; camera.rotation.y = 0.15;
    hud.update(frame(undefined, 35_000));
    expect(card.visible).toBe(true);
    expect(card.position.distanceTo(anchor)).toBe(0);
    const pulse = hud.root.getObjectByName('helper-pairing-pulse') as Mesh;
    expect(pulse.material).toMatchObject({ transparent: true });
    hud.dispose();
  });

  it('uses the immersive keyboard without a locked device or cancelling the QR scan', () => {
    const { hud, frame, pinch } = setup();
    const events: unknown[] = [];
    hud.on('pairCode', (event) => events.push(event));
    hud.on('pairCancel', () => events.push('cancelled'));
    pinch('helper-type-code');
    expect(hud.root.getObjectByName('helper-pairing')!.visible).toBe(false);
    hud.setDeviceState?.(null); hud.showPairing(null);
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 0, status: 'Choose a tagged device' });
    hud.showConfirm(null);
    for (const key of 'K7Q4M2') pinch(`pair-key:${key}`);
    pinch('pair-code-submit');
    expect(events).toEqual([{ targetId: '__helper__', code: 'K7Q4M2' }]);
    expect(hud.root.getObjectByName('helper-pairing')!.visible).toBe(true);
    hud.showHelperPairing?.({ urls, pairedName: 'My laptop' }); hud.update(frame());
    expect(hud.root.getObjectByName('helper-pairing-title')).toMatchObject({ text: 'Paired with My laptop' });
    expect(hud.root.getObjectByName('helper-pairing-check')!.visible).toBe(true);
    expect(hud.root.getObjectByName('helper-type-code')!.visible).toBe(false);
    hud.showHelperPairing?.(null);
    expect(hud.root.getObjectByName('helper-pairing')!.visible).toBe(false);
    hud.dispose();
  });

  it('dismisses the keyboard on QR success and emits Skip for the session owner', () => {
    const { hud, pinch } = setup();
    pinch('helper-type-code');
    hud.showHelperPairing?.({ urls, pairedName: 'Laptop' });
    expect(hud.root.getObjectByName('pair-code-value')).toBeUndefined();
    expect(hud.root.getObjectByName('helper-pairing')!.visible).toBe(true);
    hud.showHelperPairing?.({ urls });
    let skipped = false;
    hud.on('helperSkip', () => { skipped = true; hud.showHelperPairing?.(null); });
    pinch('helper-skip');
    expect(skipped).toBe(true);
    expect(hud.root.getObjectByName('helper-pairing')!.visible).toBe(false);
    hud.dispose();
  });

  it('keeps the initial pairing card small enough for the scene draw budget', () => {
    const { hud } = setup();
    let draws = 0;
    hud.root.getObjectByName('helper-pairing')!.traverseVisible((object: Object3D) => { if ((object as Mesh).isMesh) draws++; });
    expect(draws * 2).toBeLessThanOrEqual(24);
    hud.dispose();
  });

  it('bundles the original mono font and license without an external runtime request', () => {
    const font = readFileSync(new URL('../../../public/fonts/JetBrainsMono-Regular.ttf', import.meta.url));
    expect(font.readUInt32BE(0)).toBe(0x00010000);
    expect(readFileSync(new URL('../../../public/fonts/OFL-JetBrainsMono.txt', import.meta.url), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(pairingUrlText('https://laptop.local:8443/pair/')).toBe('laptop.local:8443/pair');
  });

  it.skip('offers Pair on a laptop using the exact server hint', () => {
    const { hud, frame, pinch } = setup();
    hud.showHelperPairing?.(null);
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: '' });
    hud.upsertTarget({ id: 'laptop', label: 'Laptop', tagged: true, status: 'scanned', connection: 'offline', position: [0, 1.4, -1], confirmed: false });
    hud.setLocked('laptop');
    hud.setDeviceState?.({ targetId: 'laptop', connection: 'offline', action: 'open-companion', hint: 'Open localhost:9876/pair on this laptop' });
    hud.update(frame(undefined, 200));
    expect(hud.root.getObjectByName('device-status')).toMatchObject({ text: 'Open localhost:9876/pair on this laptop' });
    expect(hud.root.getObjectByName('control-pair')!.getObjectByName('sdf')).toMatchObject({ text: 'Pair' });
    let pairedTarget = '';
    hud.on('pair', ({ targetId }) => { pairedTarget = targetId; });
    pinch('control-pair');
    expect(pairedTarget).toBe('laptop');
    hud.dispose();
  });

  it.skip('starts the helper flow when typing a laptop code directly from its Control card', () => {
    const { hud, frame, pinch } = setup();
    hud.showHelperPairing?.(null);
    hud.setHome?.({ mode: 'control', filter: 'electronics', tagged: 1, status: '' });
    hud.upsertTarget({ id: 'laptop', label: 'Laptop', tagged: true, status: 'scanned', connection: 'offline', position: [0, 1.4, -1], confirmed: false });
    hud.setLocked('laptop');
    hud.setDeviceState?.({ targetId: 'laptop', connection: 'offline', action: 'open-companion', hint: 'Open localhost:9876/pair on this laptop' });
    hud.update(frame(undefined, 200));
    const events: unknown[] = [];
    hud.on('pair', ({ targetId }) => { events.push({ pair: targetId }); hud.showHelperPairing?.({ urls }); });
    hud.on('pairCancel', () => events.push('cancelled'));
    hud.on('pairCode', (event) => events.push(event));
    pinch('control-pair-code');
    for (const key of 'K7Q4M2') pinch(`pair-key:${key}`);
    pinch('pair-code-submit');
    expect(events).toEqual([{ pair: 'laptop' }, { targetId: '__helper__', code: 'K7Q4M2' }]);
    expect(hud.root.getObjectByName('helper-pairing')!.visible).toBe(true);
    hud.showHelperPairing?.({ urls, pairedName: 'My laptop' });
    expect(hud.root.getObjectByName('helper-pairing-title')).toMatchObject({ text: 'Paired with My laptop' });
    hud.dispose();
  });
});
