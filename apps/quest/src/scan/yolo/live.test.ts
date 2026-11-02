import { Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Hud, HudTarget } from '../../app/hud-contract';
import type { CameraSource, GrabbedFrame } from '../camera';
import { PoseRing } from '../poses';
import type { Target } from '../targets';
import { LiveDetector, MIN_INTERVAL } from './live';
import type { WorkerIn, WorkerOut } from './protocol';

const frame = { cam: { position: new Vector3(), quaternion: new Quaternion() }, k: { width: 416, height: 312, fx: 416, fy: 416, cx: 208, cy: 156 }, handJoints: [] };
const detection = { cls: 63, score: 0.9, box: [108, 106, 200, 100] as [number, number, number, number] };

class FakeWorker {
  onmessage?: (event: MessageEvent<WorkerOut>) => void;
  onerror?: (event: ErrorEvent) => void;
  postMessage = vi.fn<(message: WorkerIn, transfer?: Transferable[]) => void>();
  terminate = vi.fn();
  emit(message: WorkerOut): void { this.onmessage?.({ data: message } as MessageEvent<WorkerOut>); }
  ready(): void { this.emit({ type: 'ready', ep: 'wasm', threads: 1, isolated: false, loadMs: 1, fetchMs: 1, warmMs: 1 }); }
}

function setup() {
  const targets: Target[] = [];
  const views = new Map<string, HudTarget>();
  const workers: FakeWorker[] = [];
  const bitmap = { width: 416, height: 312, close: vi.fn() } as unknown as ImageBitmap;
  const grab = vi.fn<() => Promise<GrabbedFrame | null>>().mockResolvedValue({ bitmap, width: 416, height: 312, tCapture: 0, headPose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } });
  const onPickClaimed = vi.fn();
  const live = new LiveDetector({
    camera: () => ({ grab, eye: 'mono' } as unknown as CameraSource), poses: new PoseRing(),
    hud: () => ({ upsertTarget: (t: HudTarget) => views.set(t.id, t), removeTarget: (id: string) => views.delete(id) } as unknown as Hud),
    samTargets: () => targets, depth: () => [], handJoints: () => [], log: vi.fn(), modelUrl: '/models/yolox_nano.onnx', onPickClaimed,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  const sam = (id = 'sam_device', size = 1): Target => {
    const view = [...views.values()][0]!;
    return { id, position: new Vector3(...view.position), sizeM: view.sizeM!.map((v) => v * size) } as Target;
  };
  return { live, targets, views, workers, bitmap, grab, onPickClaimed, sam };
}

describe('live selection and SAM handover', () => {
  it('keeps a pinched box through tracker aging and hands it to a late SAM result once', () => {
    const { live, targets, views, sam, onPickClaimed } = setup();
    live.running = true;
    live.apply([detection], frame, 0);
    const id = live.aimables()[0]!.id;
    expect(live.pick(id)).toBe(true);
    const target = sam();
    live.apply([], frame, 1000);
    live.apply([], frame, 5000);
    expect(live.pickedId).toBe(id);
    expect(views.get(id)?.status).toBe('locked');
    expect(live.aimables()).toHaveLength(1);
    targets.push(target);
    expect(live.onSamTargets()).toBe(target.id);
    expect(onPickClaimed).toHaveBeenCalledExactlyOnceWith(target.id);
    expect(live.aimables()).toEqual([]);
    expect(live.pickedId).toBeUndefined();
    live.onSamTargets();
    expect(onPickClaimed).toHaveBeenCalledTimes(1);
  });

  it('does not let a small subobject claim the selected larger device', () => {
    const { live, targets, sam, onPickClaimed } = setup();
    live.apply([detection], frame, 0);
    live.pick(live.aimables()[0]!.id);
    targets.push(sam('small_remote', 0.1));
    expect(live.onSamTargets()).toBeUndefined();
    expect(onPickClaimed).not.toHaveBeenCalled();
  });

  it('keeps a selected device in world space when the user looks away', () => {
    const { live } = setup();
    live.apply([detection], frame, 0);
    const aim = live.aimables()[0]!;
    const position = aim.position.clone();
    live.pick(aim.id);
    live.apply([], { ...frame, cam: { position: new Vector3(), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI) } }, 1000);
    expect(aim.position).toEqual(position);
  });

  it('clears selection on category change and scan stop, reusing aim objects across frames', () => {
    const { live, views } = setup();
    live.apply([detection], frame, 0);
    const out: ReturnType<LiveDetector['aimables']> = [];
    live.appendAimables(out);
    const aim = out[0]!;
    out.length = 0;
    live.appendAimables(out);
    expect(out[0]).toBe(aim);
    live.pick(aim.id);
    live.setCategory('electronics');
    expect(live.pickedId).toBeUndefined();
    expect(views.get(aim.id)?.status).toBe('scanned');
    live.pick(aim.id);
    live.stop();
    expect(live.pickedId).toBeUndefined();
    expect(views.size).toBe(0);
  });

  it('drops people and non-device results again at the main-thread boundary', () => {
    const { live } = setup();
    live.apply([{ ...detection, cls: 0 }, { ...detection, cls: 56 }], frame, 0);
    expect(live.aimables()).toEqual([]);
  });
});

describe('live worker scheduling and lifecycle', () => {
  it('allows one frame in flight and never sends above 15 Hz', async () => {
    const { live, workers, grab } = setup();
    live.start(); workers[0]!.ready();
    live.stats.intervalMs = MIN_INTERVAL;
    live.tick(100, 11);
    await Promise.resolve();
    live.tick(150, 11);
    expect(grab).toHaveBeenCalledTimes(1);
    const sent = workers[0]!.postMessage.mock.calls.at(-1)![0];
    expect(sent.type).toBe('frame');
    if (sent.type !== 'frame') throw new Error('expected frame');
    workers[0]!.emit({ type: 'result', id: sent.id, dets: [], width: 416, height: 312, prepMs: 0, inferMs: 1, postMs: 0 });
    live.tick(166, 11);
    expect(grab).toHaveBeenCalledTimes(1);
    live.tick(167, 11);
    await Promise.resolve();
    expect(grab).toHaveBeenCalledTimes(2);
    live.dispose();
  });

  it('closes a captured bitmap when the scan stops during capture', async () => {
    const { live, workers, grab, bitmap } = setup();
    let finish!: (value: GrabbedFrame) => void;
    grab.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    live.start(); workers[0]!.ready(); live.tick(100, 11);
    live.stop();
    finish({ bitmap, width: 416, height: 312, tCapture: 0 });
    await Promise.resolve();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it('terminates a failed worker and reloads cleanly on the next scan', async () => {
    const { live, workers } = setup();
    live.start();
    const loading = live.load();
    workers[0]!.emit({ type: 'error', fatal: true, message: 'GPU unavailable' });
    await expect(loading).rejects.toThrow('GPU unavailable');
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(live.running).toBe(false);
    live.start(); workers[1]!.ready();
    await expect(live.load()).resolves.toBeUndefined();
    expect(live.stats.state).toBe('ready');
    live.dispose();
  });

  it('rejects pending initialization on dispose and permits a fresh load', async () => {
    const { live, workers } = setup();
    const loading = live.load();
    live.dispose();
    await expect(loading).rejects.toThrow('disposed');
    const fresh = live.load();
    workers[1]!.ready();
    await expect(fresh).resolves.toBeUndefined();
    live.dispose();
  });

  it('discards results captured before scan restart', async () => {
    const { live, workers, views } = setup();
    live.start(); workers[0]!.ready(); live.tick(100, 11);
    await Promise.resolve();
    const sent = workers[0]!.postMessage.mock.calls.at(-1)![0];
    if (sent.type !== 'frame') throw new Error('expected frame');
    live.stop(); live.start();
    workers[0]!.emit({ type: 'result', id: sent.id, dets: [detection], width: 416, height: 312, prepMs: 0, inferMs: 1, postMs: 0 });
    expect(views.size).toBe(0);
    live.dispose();
  });
});
