import { Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TargetStore } from '../scan/targets';
import { QuestApp } from './app';
import type { ShellFrame } from './hud-contract';

function shell() {
  // Exercise the shell's real selection methods without constructing a browser, socket, or audio context.
  const app = Object.create(QuestApp.prototype) as QuestApp;
  const targets = new TargetStore();
  const { target } = targets.upsert(
    { detId: 'sam-device', label: 'Laptop', score: 0.9, box: [20, 20, 200, 100] },
    { position: new Vector3(0, 1.6, -1), facing: new Vector3(0, 0, 1), confirmed: false, method: 'size-prior', depth: 1, sizeM: [0.3, 0.2, 0.1] },
    'sam-frame',
  );
  const liveBox = { id: 'yolo_1', position: new Vector3(0.5, 1.6, -1), size: 0.3 };
  const live = {
    pick: vi.fn((id: string) => id === liveBox.id),
    unpick: vi.fn(),
    claimOf: vi.fn<() => string | undefined>(() => undefined),
    appendAimables: (out: typeof liveBox[]) => out.push(liveBox),
  };
  const hud = { setCandidate: vi.fn(), setLocked: vi.fn(), upsertTarget: vi.fn() };
  const scanner = { active: true, stop: vi.fn() };
  const ws = { send: vi.fn(() => 'sent') };
  Object.assign(app, {
    targets, live, hud, scanner, ws, lockedId: null,
    recorder: { input: vi.fn() }, page: { log: vi.fn() },
    input: { mouseAsHand: true, pointer: { inside: true } },
    candidate: { id: null, shown: null, since: 0 }, consumed: { left: false, right: false },
    aimTargets: new Map(), aimBuffer: [],
  });
  return { app, target, live, liveBox, hud, scanner, ws };
}

describe('live box selection in the Quest shell', () => {
  it('keeps scanning after a local pick and sends the SAM detection only on handover', () => {
    const { app, target, live, hud, scanner, ws } = shell();
    app.lock('yolo_1');
    expect(app.lockedId).toBe('yolo_1');
    expect(hud.setLocked).toHaveBeenLastCalledWith('yolo_1');
    expect(live.pick).toHaveBeenCalledWith('yolo_1');
    expect(scanner.stop).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();

    app.lock(target.id, 'live box');
    expect(app.lockedId).toBe(target.id);
    expect(scanner.stop).toHaveBeenCalledOnce();
    expect(live.unpick).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledExactlyOnceWith('target.select', { frameId: 'sam-frame', detId: 'sam-device' }, { to: 'server' });
  });

  it('resolves an already claimed box immediately and allows cancelling a pending pick', () => {
    const { app, target, live, hud, ws } = shell();
    app.lock('yolo_1');
    app.release();
    expect(app.lockedId).toBeNull();
    expect(hud.setLocked).toHaveBeenLastCalledWith(null);
    expect(ws.send).not.toHaveBeenCalled();
    live.claimOf.mockReturnValue(target.id);
    app.lock('yolo_1');
    expect(app.lockedId).toBe(target.id);
    expect(ws.send).toHaveBeenCalledOnce();
  });

  it('a desktop mouse pinch hits the live box without a SAM target or dwell delay', () => {
    const { app, target, liveBox, hud, ws } = shell();
    app.targets.remove(target.id);
    const origin = new Vector3(0, 1.6, 0);
    const ray = { origin, dir: liveBox.position.clone().sub(origin).normalize() };
    const f: ShellFrame = {
      time: 100, dt: 1 / 90,
      head: { position: origin, quaternion: new Quaternion(), ray },
      hands: { right: { joints: {}, ray, pinchPoint: new Vector3(), pinching: true, justPinched: true, justReleased: false, controller: true, palmUp: false, palmUpMs: 0 } },
    };
    const interact = Reflect.get(app, 'interact') as (frame: ShellFrame, time: number) => void;
    interact.call(app, f, 100);
    expect(app.lockedId).toBe(liveBox.id);
    expect(hud.setLocked).toHaveBeenLastCalledWith(liveBox.id);
    expect(ws.send).not.toHaveBeenCalled();
    interact.call(app, f, 120);
    expect(app.lockedId).toBeNull();
  });

  it('a pinch consumed by a HUD widget cannot select a box behind it', () => {
    const { app, liveBox, ws } = shell();
    Reflect.set(app, 'consumed', { left: false, right: true });
    const origin = new Vector3(0, 1.6, 0);
    const ray = { origin, dir: liveBox.position.clone().sub(origin).normalize() };
    const f: ShellFrame = {
      time: 100, dt: 1 / 90, head: { position: origin, quaternion: new Quaternion(), ray },
      hands: { right: { joints: {}, ray, pinchPoint: new Vector3(), pinching: true, justPinched: true, justReleased: false, controller: true, palmUp: false, palmUpMs: 0 } },
    };
    (Reflect.get(app, 'interact') as (frame: ShellFrame, time: number) => void).call(app, f, 100);
    expect(app.lockedId).toBeNull();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
