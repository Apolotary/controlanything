/**
 * Desktop mode with IWER (Immersive Web Emulation Runtime): an emulated Meta Quest 3 (immersive-ar,
 * hand tracking, hit-test API) so the real XR code path runs in Chrome on the Mac. Mono view for clean
 * screenshots; mouse-look (right-drag or Alt-drag), WASD/QE to move, left click = pinch along the mouse ray.
 * `?devui=1` adds IWER's own DevUI instead. `window.__ce.emulator.device.remote` exposes IWER's remote API.
 */
import type { XRDevice } from 'iwer';
import { Euler, Quaternion, Vector3 } from 'three';

export interface Emulator {
  device: XRDevice;
  devui: boolean;
  /** current emulated head pose (also used for the 2D preview before a session starts) */
  head(): { position: Vector3; quaternion: Quaternion };
  setHead(position: Vector3, quaternion: Quaternion): void;
  lookAt(target: Vector3): void;
  dispose(): void;
}

export async function installEmulator(opts: { devui?: boolean; canvas: HTMLCanvasElement }): Promise<Emulator> {
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3, { stereoEnabled: false });
  device.installRuntime({ forceInstall: true });
  device.primaryInputMode = 'hand';
  let devui = false;
  if (opts.devui) {
    try {
      const mod = (await import('@iwer/devui')) as unknown as { DevUI: new (d: XRDevice) => unknown };
      device.installDevUI(mod.DevUI as never);
      devui = true;
    } catch (e) {
      console.warn('[emulator] DevUI failed to load', e);
    }
  }
  const euler = new Euler(0, 0, 0, 'YXZ');
  euler.setFromQuaternion(new Quaternion(device.quaternion.x, device.quaternion.y, device.quaternion.z, device.quaternion.w));
  const keys = new Set<string>();
  let dragging = false;
  let last = { x: 0, y: 0 };

  const apply = () => {
    const q = new Quaternion().setFromEuler(euler);
    device.quaternion.set(q.x, q.y, q.z, q.w);
    device.notifyStateChange?.();
  };
  const head = () => ({
    position: new Vector3(device.position.x, device.position.y, device.position.z),
    quaternion: new Quaternion(device.quaternion.x, device.quaternion.y, device.quaternion.z, device.quaternion.w),
  });

  const typing = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (typing(e) || e.metaKey || e.ctrlKey) return;
    keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onDown = (e: PointerEvent) => {
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging || devui) return;
    euler.y -= (e.clientX - last.x) * 0.004;
    euler.x = Math.max(-1.4, Math.min(1.4, euler.x - (e.clientY - last.y) * 0.004));
    last = { x: e.clientX, y: e.clientY };
    apply();
  };
  const onUp = () => {
    dragging = false;
  };
  const noMenu = (e: Event) => e.preventDefault();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  opts.canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  opts.canvas.addEventListener('contextmenu', noMenu);

  let lastT = performance.now();
  let raf = 0;
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (!devui && keys.size) {
      const speed = keys.has('ShiftLeft') ? 1.5 : 0.6;
      const fwd = new Vector3(0, 0, -1).applyEuler(new Euler(0, euler.y, 0));
      const right = new Vector3(1, 0, 0).applyEuler(new Euler(0, euler.y, 0));
      const move = new Vector3();
      if (keys.has('KeyW')) move.add(fwd);
      if (keys.has('KeyS') && keys.has('AltLeft')) move.sub(fwd); // plain S toggles scan in the app
      if (keys.has('KeyA')) move.sub(right);
      if (keys.has('KeyD')) move.add(right);
      if (keys.has('KeyQ')) move.y -= 1;
      if (keys.has('KeyE')) move.y += 1;
      if (move.lengthSq()) {
        move.normalize().multiplyScalar(speed * dt);
        device.position.set(device.position.x + move.x, device.position.y + move.y, device.position.z + move.z);
      }
      const turn = 1.2 * dt;
      if (keys.has('ArrowLeft')) euler.y += turn;
      if (keys.has('ArrowRight')) euler.y -= turn;
      if (keys.has('ArrowUp')) euler.x = Math.min(1.4, euler.x + turn);
      if (keys.has('ArrowDown')) euler.x = Math.max(-1.4, euler.x - turn);
      apply();
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  return {
    device,
    devui,
    head,
    setHead(position, quaternion) {
      device.position.set(position.x, position.y, position.z);
      device.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      euler.setFromQuaternion(quaternion);
      device.notifyStateChange?.();
    },
    lookAt(target) {
      const p = head().position;
      const d = target.clone().sub(p).normalize();
      euler.set(Math.asin(Math.max(-1, Math.min(1, d.y))), Math.atan2(-d.x, -d.z), 0);
      apply();
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      opts.canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      opts.canvas.removeEventListener('contextmenu', noMenu);
    },
  };
}
