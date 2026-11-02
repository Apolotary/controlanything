import { Group, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxField } from '../../hud/v2/boxes';
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

afterEach(() => vi.unstubAllGlobals());

function setup(field?: BoxField) {
  const targets: Target[] = [];
  const root = new Group();
  if (field) root.add(field);
  const views = new Map<string, HudTarget>();
  const workers: FakeWorker[] = [];
  const bitmap = { width: 416, height: 312, close: vi.fn() } as unknown as ImageBitmap;
  const grab = vi.fn<() => Promise<GrabbedFrame | null>>().mockResolvedValue({ bitmap, width: 416, height: 312, tCapture: 0, headPose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } });
  const onPickClaimed = vi.fn();
  const live = new LiveDetector({
    camera: () => ({ grab, eye: 'mono' } as unknown as CameraSource), poses: new PoseRing(),
    hud: () => ({ root, upsertTarget: (t: HudTarget) => {
      views.set(t.id, t);
      field?.set(t.id, new Vector3(...t.position), t.sizeM?.[0] ?? 0.3, t.sizeM?.[1] ?? 0.2, '#ffffff');
    }, removeTarget: (id: string) => { views.delete(id); field?.remove(id); } } as unknown as Hud),
    samTargets: () => targets, depth: () => [], handJoints: () => [], log: vi.fn(), modelUrl: '/models/yolox_nano.onnx', onPickClaimed,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  const sam = (id = 'sam_device', size = 1): Target => {
    const view = [...views.values()][0]!;
    return { id, label: 'Ceiling light', score: 0.9, status: 'scanned', facing: new Vector3(0, 0, 1), position: new Vector3(...view.position), sizeM: view.sizeM!.map((v) => v * size) } as Target;
  };
  return { live, targets, views, workers, bitmap, grab, onPickClaimed, sam };
}

describe('live selection and SAM handover', () => {
  it('confirms after 150 ms, fades on render time, and expires with no further worker result', () => {
    const field = new BoxField();
    const { live, views } = setup(field);
    live.running = true;
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 100);
    expect(views.size).toBe(0);
    live.apply([detection], frame, 150);
    const id = live.aimables()[0]!.id;
    live.tick(450, 11);
    expect(field.boxes.get(id)?.opacity).toBeCloseTo(0.5);
    live.tick(550, 11);
    expect(views.size).toBe(0);
    expect(live.aimables()).toEqual([]);
    field.dispose();
  });

  it('rejects an edge-overlapping hand immediately instead of coasting its old box', () => {
    const { live, views } = setup();
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    expect(views.size).toBe(1);
    const hand = new Vector3((108 - 208) / 416, -(106 - 156) / 416, -1);
    live.apply([detection], { ...frame, handJoints: [hand] }, 200);
    expect(views.size).toBe(0);
    expect(live.aimables()).toEqual([]);
  });

  it('reclaims a full outline slot for the SAM label and shape without a duplicate', () => {
    const field = new BoxField(1);
    const { live, targets, views, sam } = setup(field);
    field.setLimit(1);
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const oldId = live.aimables()[0]!.id;
    const target = sam();
    targets.push(target);
    expect(field.set(target.id, target.position, 0.3, 0.2, '#ffffff')).toBeUndefined();
    live.onSamTargets();
    expect(field.boxes.size).toBe(1);
    expect(field.has(oldId)).toBe(false);
    expect(views.get(target.id)?.label).toBe('Ceiling light');
    live.apply([detection], frame, 250);
    expect(field.boxes.size).toBe(1);
    expect(live.aimables()).toEqual([]);
    field.dispose();
  });

  it('makes room for SAM-only classes when the scan limit is full', () => {
    const field = new BoxField(1);
    const { live, targets, views, sam } = setup(field);
    field.setLimit(1);
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const target = sam();
    target.position.x += 2;
    targets.push(target);
    live.onSamTargets();
    expect(field.boxes.size).toBe(1);
    expect(field.has(target.id)).toBe(true);
    expect([...views.values()].map((v) => v.label)).toEqual(['Ceiling light']);
    field.dispose();
  });

  it('retains a confirmed identity across deliberate slow cadence without leaving a stale outline', () => {
    const { live, views } = setup();
    live.stats.intervalMs = 600;
    live.running = true;
    live.apply([detection], frame, 0);
    live.tick(500, 11);
    live.apply([detection], frame, 600);
    const id = live.aimables()[0]!.id;
    live.tick(1000, 11);
    expect(views.size).toBe(0);
    live.apply([detection], frame, 1200);
    expect(live.aimables()[0]?.id).toBe(id);
    live.dispose();
  });

  it('keeps a pinched box through tracker aging and hands it to a late SAM result once', () => {
    const { live, targets, views, sam, onPickClaimed } = setup();
    live.running = true;
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const id = live.aimables()[0]!.id;
    const hover = live.hoverTarget(id)!;
    expect(hover.position).toBe(live.aimables()[0]!.position);
    expect(hover.sizeM).toEqual(views.get(id)?.sizeM);
    expect(hover.facing.length()).toBeCloseTo(1);
    expect(live.hoverTarget('unknown')).toBeUndefined();
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
    expect(live.hoverTarget(id)).toBeUndefined();
    expect(live.pickedId).toBeUndefined();
    live.onSamTargets();
    expect(onPickClaimed).toHaveBeenCalledTimes(1);
  });

  it('does not let a small subobject claim the selected larger device', () => {
    const { live, targets, sam, onPickClaimed } = setup();
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    live.pick(live.aimables()[0]!.id);
    targets.push(sam('small_remote', 0.1));
    expect(live.onSamTargets()).toBeUndefined();
    expect(onPickClaimed).not.toHaveBeenCalled();
  });

  it('keeps a selected device in world space when the user looks away', () => {
    const { live } = setup();
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const aim = live.aimables()[0]!;
    const position = aim.position.clone();
    live.pick(aim.id);
    live.apply([], { ...frame, cam: { position: new Vector3(), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI) } }, 1000);
    expect(aim.position).toEqual(position);
  });

  it('clears selection on category change and scan stop, reusing aim objects across frames', () => {
    const { live, views } = setup();
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const out: ReturnType<LiveDetector['aimables']> = [];
    live.appendAimables(out);
    const aim = out[0]!;
    out.length = 0;
    live.appendAimables(out);
    expect(out[0]).toBe(aim);
    live.pick(aim.id);
    live.setCategory('everything');
    expect(live.pickedId).toBeUndefined();
    expect(views.get(aim.id)?.status).toBe('scanned');
    live.pick(aim.id);
    live.stop();
    expect(live.pickedId).toBeUndefined();
    expect(views.size).toBe(0);
    expect(live.hoverTarget(aim.id)).toBeUndefined();
  });

  it('drops people and non-device results again at the main-thread boundary', () => {
    const { live } = setup();
    live.apply([{ ...detection, cls: 0 }, { ...detection, cls: 56 }], frame, 0);
    expect(live.aimables()).toEqual([]);
  });

  it('filters low scores and objects farther than three metres before allocating live tracks', () => {
    const { live, views } = setup();
    const distant = { ...detection, box: [198, 146, 20, 20] as [number, number, number, number] };
    for (const now of [0, 150]) live.apply([{ ...detection, score: 0.49 }, distant], frame, now);
    expect(views.size).toBe(0);
    expect(live.tracker.list()).toHaveLength(0);
    live.rangeM = 8;
    for (const now of [300, 450]) live.apply([distant], frame, now);
    expect(views.size).toBe(1);
  });

  it('refreshes an unchanged visible box before the shell observation expires', () => {
    const { live, views } = setup();
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const id = live.aimables()[0]!.id;
    const initial = views.get(id);
    live.apply([detection], frame, 250);
    expect(views.get(id)).toBe(initial);
    live.apply([detection], frame, 350);
    expect(views.get(id)).not.toBe(initial);
    expect(live.aimables()[0]?.id).toBe(id);
  });

  it('snapshots a live object for immediate tagging and follows its claimed outline smoothly', () => {
    const { live, targets, sam } = setup();
    live.apply([detection], frame, 0);
    live.apply([detection], frame, 150);
    const id = live.aimables()[0]!.id;
    const snapshot = live.targetSnapshot(id)!;
    expect(snapshot).toMatchObject({ id, label: 'Laptop', source: 'yolo', score: 0.9 });
    const target = sam();
    target.cardId = 'tagged-laptop';
    const start = target.position.clone();
    targets.push(target);
    live.onSamTargets();
    expect(live.targetSnapshot(id)).toBeUndefined();
    live.apply([{ ...detection, box: [128, 106, 200, 100] }], frame, 300);
    expect(target.position.x).toBeGreaterThan(start.x);
    expect(target.position.x - start.x).toBeLessThan(0.03);
    expect(target.lastSeenAt).toBeGreaterThan(0);
  });
});

describe('live worker scheduling and lifecycle', () => {
  it('publishes live percentiles, backoff, skipped opportunities and backend recovery on __ce', async () => {
    const app = { existing: true, yoloStats: undefined as unknown };
    vi.stubGlobal('window', { __ce: app });
    const { live, workers } = setup();
    live.start(); workers[0]!.ready();
    live.tick(100, 11);
    await Promise.resolve();
    live.tick(200, 11);
    const sent = workers[0]!.postMessage.mock.calls.at(-1)![0];
    if (sent.type !== 'frame') throw new Error('expected frame');
    workers[0]!.emit({ type: 'result', id: sent.id, dets: [], width: 416, height: 312, prepMs: 0, inferMs: 100, postMs: 0 });
    expect(live.stats.intervalMs).toBeGreaterThanOrEqual(135);
    expect(app.yoloStats).toEqual({ backend: 'wasm', inferMs: { p50: 100, p95: 100 }, hz: 1, boxes: 0, dropped: 1 });
    workers[0]!.emit({ type: 'backend', ep: 'wasm', threads: 1, fallback: 'GPU lost' });
    expect(app.existing).toBe(true);
    expect(live.stats.threads).toBe(1);
    live.stop();
    live.tick(performance.now() + 1001, 11);
    expect(live.telemetry.value.hz).toBe(0);
    live.dispose();
  });

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
