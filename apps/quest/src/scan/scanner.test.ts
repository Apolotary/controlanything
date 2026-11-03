import { Group, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Hud } from '../app/hud-contract';
import type { ScanResultPayload } from '../io/v1';
import type { WsClient } from '../io/ws';
import type { FrameCapture, FrameRecord } from './capture';
import type { DepthHit, DepthProvider } from './placement';
import { PoseRing } from './poses';
import { Scanner } from './scanner';
import { TargetStore } from './targets';

function setup(hit: DepthProvider['hit'] = async () => ({ point: new Vector3(0, 0, -2) })) {
  const pose = { position: new Vector3(), quaternion: new Quaternion() };
  const record: FrameRecord = {
    frameId: 'frame', purpose: 'scan', source: 'synthetic', capturedAt: Date.now(), tCapture: 0,
    width: 640, height: 480, intrinsics: { width: 640, height: 480, fx: 640, fy: 640, cx: 320, cy: 240 },
    head: pose, cam: pose, speedDeg: 0, handJoints: [], bytes: 0,
  };
  const records = new Map([[record.frameId, record]]);
  const send = vi.fn().mockReturnValue("sent");
  const upsertTarget = vi.fn();
  const hud = { root: new Group(), setScanning: vi.fn(), upsertTarget } as unknown as Hud;
  const targets = new TargetStore();
  const capture = vi.fn(async () => ({ record, payload: { frameId: record.frameId, jpeg: 'cropped', width: record.width, height: record.height } }));
  const scanner = new Scanner({
    capture: () => ({ get: (id: string) => records.get(id), capture } as unknown as FrameCapture), ws: { send } as unknown as WsClient,
    hud: () => hud, targets, poses: new PoseRing(), depth: () => [{ name: 'test', hit }], log: vi.fn(),
  });
  const result = (labels: string[], score = 0.9): ScanResultPayload => ({
    frameId: record.frameId, width: record.width, height: record.height, latencyMs: 10,
    modelId: 'sam-3.1', source: 'fixture', detections: labels.map((label, i) => ({
      detId: String(i), label, prompt: label, score, box: [300, 220, 40, 40],
    })),
  });
  return { scanner, targets, upsertTarget, result, record, records, send, capture };
}

describe('automatic annotation scanning', () => {
  it('accepts only the active device filter at confidence 0.5 or higher', async () => {
    const { scanner, targets, result } = setup();
    expect(scanner.category).toBe('everything');
    scanner.start();
    await scanner.onResult(result(['laptop'], 0.49));
    await scanner.onResult(result(['person holding a phone', 'chair', 'microwave', 'ceiling light', 'synthesizer']));
    expect(targets.list().map((target) => target.label)).toEqual(['microwave', 'ceiling light', 'synthesizer']);
    scanner.setCategory('lights');
    await scanner.onResult(result(['phone', 'lamp'], 0.5));
    expect(targets.list().map((target) => target.label)).toEqual(['microwave', 'ceiling light', 'synthesizer', 'lamp']);
    scanner.setCategory('electronics');
    await scanner.onResult(result(['electronic light', 'screen'], 0.5));
    expect(targets.list().map((target) => target.label)).toEqual(['microwave', 'ceiling light', 'synthesizer', 'lamp', 'screen']);
  });

  it('rejects objects beyond the configured range and caps each batch at five devices', async () => {
    const { scanner, targets, result } = setup();
    scanner.rangeM = 1.5;
    scanner.start();
    await scanner.onResult(result(['laptop']));
    expect(targets.list()).toHaveLength(0);
    scanner.rangeM = 3;
    await scanner.onResult(result(['laptop', 'screen', 'phone', 'keyboard', 'ceiling light', 'remote', 'mouse']));
    expect(targets.list()).toHaveLength(5);
  });

  it('suppresses generic duplicate boxes before depth placement while retaining a separate device', async () => {
    const hit = vi.fn(async () => ({ point: new Vector3(0, 0, -1) }));
    const { scanner, targets, result } = setup(hit);
    scanner.start();
    const payload = result([]);
    payload.detections = [
      { detId: 'generic', label: 'electronic device', prompt: 'electronic device', score: 0.99, box: [110, 110, 180, 130] },
      { detId: 'laptop', label: 'laptop', prompt: 'laptop', score: 0.7, box: [100, 100, 200, 160] },
      { detId: 'phone', label: 'phone', prompt: 'phone', score: 0.8, box: [350, 100, 40, 80] },
    ];
    await scanner.onResult(payload);
    expect(targets.list().map((target) => target.label).sort()).toEqual(['laptop', 'phone']);
    expect(hit).toHaveBeenCalledTimes(2);
    expect(scanner.stats.rejected).toBe(1);
  });

  it('does not let a low-confidence named box suppress an eligible unidentified candidate', async () => {
    const { scanner, targets, result } = setup();
    scanner.start();
    const payload = result([]);
    payload.detections = [
      { detId: 'generic', label: 'electronic device', prompt: 'electronic device', score: 0.8, box: [110, 110, 180, 130] },
      { detId: 'laptop', label: 'laptop', prompt: 'laptop', score: 0.4, box: [100, 100, 200, 160] },
    ];
    await scanner.onResult(payload);
    expect(targets.list().map((target) => target.label)).toEqual(['electronic device']);
  });

  it('ignores delayed segmentation after leaving Annotate, including while placement is pending', async () => {
    let resolveHit!: (hit: DepthHit | null) => void;
    const hit = new Promise<DepthHit | null>((resolve) => { resolveHit = resolve; });
    const { scanner, targets, upsertTarget, result } = setup(() => hit);
    await scanner.onResult(result(['laptop']));
    expect(upsertTarget).not.toHaveBeenCalled();
    scanner.start();
    const pending = scanner.onResult(result(['laptop']));
    scanner.stop();
    resolveHit({ point: new Vector3(0, 0, -2) });
    await pending;
    expect(targets.list()).toHaveLength(0);
    expect(upsertTarget).not.toHaveBeenCalled();
    scanner.start('pair');
    await scanner.onResult(result(['laptop']));
    expect(targets.list()).toHaveLength(0);
  });
});


it('rejects an older capture arriving after a newer one, including delayed placement', async () => {
  let finish!: (hit: DepthHit) => void;
  const deferred = new Promise<DepthHit>((resolve) => { finish = resolve; });
  let calls = 0;
  const { scanner, targets, result, records, record } = setup(() => ++calls === 1 ? deferred : Promise.resolve({ point: new Vector3(0.3, 0, -2) }));
  records.set('new', { ...record, frameId: 'new', tCapture: 100 });
  scanner.start();
  const old = scanner.onResult(result(['laptop']));
  await scanner.onResult({ ...result(['laptop']), frameId: 'new' });
  finish({ point: new Vector3(0, 0, -2) }); await old;
  expect(targets.list()).toHaveLength(1);
  expect(targets.list()[0]?.position.x).toBe(0.3);
  await scanner.onResult(result(['phone']));
  expect(targets.list()).toHaveLength(1);
});

it('registers fixture captures with the server before exposing their selection boxes', async () => {
  vi.useFakeTimers();
  try {
    const { record } = setup();
    const payload = { frameId: record.frameId, jpeg: 'fixture-jpeg', width: record.width, height: record.height, purpose: 'scan' };
    const send = vi.fn().mockReturnValue('sent'), upsertTarget = vi.fn();
    const scanner = new Scanner({
      capture: () => ({ capture: async () => ({ payload, record }), get: () => record } as unknown as FrameCapture),
      ws: { send } as unknown as WsClient,
      hud: () => ({ setScanning: vi.fn(), upsertTarget } as unknown as Hud), targets: new TargetStore(),
      poses: new PoseRing(), depth: () => [], log: vi.fn(),
      fixture: () => ({ fix: { source: 'fixture', modelId: 'sam-3.1', imageWidth: 640, imageHeight: 480, wallMs: 20,
        detections: [{ label: 'laptop', prompt: 'laptop', score: 1, box: [220, 180, 200, 120] }] },
        room: { imageWidth: 640, imageToWorld: (u: number, v: number) => new Vector3((u - 320) / 320, -(v - 240) / 320, -2) } as never }),
    });
    scanner.start(); scanner.tick(1000); await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledWith('scan.frame', { ...payload, fixtureDetections: [{ detId: 'fx0', label: 'laptop', prompt: 'laptop', score: 1, box: [220, 180, 200, 120] }] }, { to: 'server', droppable: true });
    expect(upsertTarget).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(upsertTarget).toHaveBeenCalledTimes(1);
    await scanner.onResult({ frameId: record.frameId, width: 640, height: 480, modelId: 'fixture', source: 'fixture', latencyMs: 0, detections: [{ detId: 'other', label: 'phone', prompt: 'phone', score: 1, box: [220, 180, 200, 120] }] });
    expect(upsertTarget).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});


describe('single selected-area scan', () => {
  it('waits for asynchronous depth placement even when another render frame ticks', async () => {
    let place!: (hit: DepthHit) => void;
    const f = setup(() => new Promise(resolve => { place = resolve; }));
    await f.scanner.scanRegion([0.2, 0.3, 0.8, 0.9], 100);
    const pending = f.scanner.onResult(f.result(['synthesizer']));
    f.scanner.tick(200); expect(f.scanner.active).toBe(true);
    place({ point: new Vector3(0, 0, -2) }); await pending;
    expect(f.targets.list()).toHaveLength(1); expect(f.scanner.active).toBe(false);
  });
  it('sends one cropped frame, never starts whole-view cadence and stops after its result', async () => {
    const f = setup();
    const region = [0.2, 0.3, 0.8, 0.9] as const;
    expect(await f.scanner.scanRegion(region, 100)).toBe(true);
    expect(f.capture).toHaveBeenCalledWith('scan', undefined, region);
    f.scanner.tick(2000); f.scanner.tick(4000);
    expect(f.capture).toHaveBeenCalledTimes(1);
    await f.scanner.onResult(f.result(['synthesizer']));
    expect(f.targets.list()).toHaveLength(1);
    expect(f.scanner.active).toBe(false);
    f.scanner.tick(5000); expect(f.capture).toHaveBeenCalledTimes(1);
  });
  it('does not stop a region capture while its async bitmap is still being prepared', async () => {
    const f = setup(); let release!: (value: Awaited<ReturnType<typeof f.capture>>) => void;
    f.capture.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.scanner.scanRegion([0.2, 0.3, 0.8, 0.9], 100);
    f.scanner.tick(200); expect(f.scanner.active).toBe(true);
    release({record:f.record, payload:{frameId:f.record.frameId,jpeg:'crop',width:f.record.width,height:f.record.height}});
    expect(await pending).toBe(true);
  });
});
