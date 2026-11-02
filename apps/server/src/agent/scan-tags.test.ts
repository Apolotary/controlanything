import { type ScanFramePayload, type ScanResultPayload } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FixtureSam, type Sam } from '../scan/sam';
import { CallLog } from '../muse/callLog';
import { Dispatcher } from './dispatch';
import { ScanService } from './scan';
import { StepLog } from './steps';
import { TargetStore } from './targets';

const frame: ScanFramePayload = { frameId: 'frame', jpeg: 'AAAA', width: 320, height: 240, capturedAt: 1, purpose: 'scan' };
const sender = { deviceId: 'quest', canApprove: true };

function scanner() {
  const hub = { broadcast: vi.fn(() => 0) };
  const sam = new FixtureSam({ callLog: new CallLog(() => {}) });
  const dispatcher = new Dispatcher({ hub: { sendToDevice: () => 0 } });
  const targets = new TargetStore(hub);
  let enabled = true;
  const scan = new ScanService({ sam, hub, dispatcher, targets, steps: new StepLog(hub),
    pairing: { listPending: () => [], approve: vi.fn() }, enabled: () => enabled });
  return { scan, sam, hub, targets, pause: () => { enabled = false; } };
}

describe('tagging fast detector frames', () => {
  it('registers exact synthetic fixture selections only for an owner on a fixture server', async () => {
    const s = scanner();
    const segment = vi.spyOn(s.sam, 'segmentAll');
    const fixtureDetections = [
      { detId: 'fx0', label: 'synthesizer', prompt: 'synthesizer', score: 1, box: [20, 30, 40, 50] },
      { detId: 'excluded', label: 'person', prompt: 'person', score: 1, box: [20, 30, 40, 50] },
    ];
    const synthetic = { ...frame, camera: { source: 'synthetic' as const }, fixtureDetections };
    await s.scan.onFrame(synthetic, sender);
    expect(segment).not.toHaveBeenCalled();
    expect(s.scan.detection(frame.frameId, 'fx0')).toMatchObject({ label: 'synthesizer', box: [20, 30, 40, 50], jpeg: frame.jpeg });
    expect(s.scan.detection(frame.frameId, 'excluded')).toBeUndefined();
    await s.scan.onFrame({ ...synthetic, frameId: 'peripheral', capturedAt: 2 }, { ...sender, canApprove: false });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(s.scan.detection('peripheral', 'fx0')).toBeUndefined();
    vi.spyOn(s.sam as Sam, 'mode', 'get').mockReturnValue('live');
    await s.scan.onFrame({ ...synthetic, frameId: 'live', capturedAt: 3 }, sender);
    expect(segment).toHaveBeenCalledTimes(2);
    expect(s.scan.detection('live', 'fx0')).toBeUndefined();
  });

  it.each(['class', 'time', 'pose', 'continuous'] as const)('only reuses known cards with class, track, time and pose continuity: %s', async (change) => {
    const s = scanner();
    const run = (prompt: string) => [{ prompt, records: [{ id: 1, w: 320, h: 240, x1: 1, y1: 1, x2: 100, y2: 100, confidence: 0.9 }], model: 'fixture', source: 'fixture' as const, latencyMs: 0, text: '' }];
    const segment = vi.spyOn(s.sam, 'segmentAll').mockResolvedValue(run('ceiling light'));
    const pose = { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    const first = await s.scan.onFrame({ ...frame, pose }, sender);
    const target = s.targets.create({ cardId: 'lamp', armed: true, detection: s.scan.detection(frame.frameId, first!.detections[0].detId) });
    segment.mockResolvedValue(run(change === 'class' ? 'synthesizer' : 'ceiling light'));
    const next = await s.scan.onFrame({ ...frame, frameId: 'next', capturedAt: change === 'time' ? 5000 : 1001,
      pose: change === 'pose' ? { ...pose, orientation: { x: 0, y: 1, z: 0, w: 0 } } : pose }, sender);
    expect(next!.detections[0].cardId).toBe(change === 'continuous' ? target.cardId : undefined);
    expect(next!.detections[0].trackId === first!.detections[0].trackId).toBe(change === 'continuous');
  });

  it('retains the exact frame while SAM is pending and drops late discovery after switching modes', async () => {
    const s = scanner();
    let finish!: (runs: Awaited<ReturnType<FixtureSam['segmentAll']>>) => void;
    vi.spyOn(s.sam, 'segmentAll').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const work = s.scan.onFrame(frame, sender);
    expect(s.scan.tagDetection('frame', 'local-box', 'synthesizer')).toMatchObject({ jpeg: 'AAAA', label: 'synthesizer', frameId: 'frame' });
    s.pause();
    finish([]);
    expect(await work).toBeUndefined();
    expect(s.hub.broadcast).not.toHaveBeenCalled();
  });

  it('uses a unique requested label instead of the first box when an id is omitted', async () => {
    const s = scanner();
    await s.scan.onFrame(frame, sender);
    const stored = s.scan.frame('frame')!;
    const detections: ScanResultPayload['detections'] = [
      { detId: 'light', label: 'ceiling light', prompt: 'ceiling light', score: 0.9, box: [1, 1, 10, 10] },
      { detId: 'synth', label: 'synthesizer', prompt: 'synthesizer', score: 0.9, box: [50, 60, 80, 40] },
    ];
    stored.detections = detections;
    expect(s.scan.tagDetection('frame', undefined, 'synthesizer')?.box).toEqual([50, 60, 80, 40]);
    stored.detections.push({ ...detections[1], detId: 'another-synth', box: [150, 60, 80, 40] });
    expect(s.scan.tagDetection('frame', undefined, 'synthesizer')?.box).toEqual([0, 0, 320, 240]);
    expect(s.scan.tagDetection('frame', 'another-synth', 'synthesizer')?.box).toEqual([150, 60, 80, 40]);
    expect(s.scan.tagDetection('frame', undefined, 'person')).toBeUndefined();
  });
});
