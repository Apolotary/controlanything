import { type ScanFramePayload, type ScanResultPayload } from '@ce/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FixtureSam } from '../scan/sam';
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
  let enabled = true;
  const scan = new ScanService({ sam, hub, dispatcher, targets: new TargetStore(hub), steps: new StepLog(hub),
    pairing: { listPending: () => [], approve: vi.fn() }, enabled: () => enabled });
  return { scan, sam, hub, pause: () => { enabled = false; } };
}

describe('tagging fast detector frames', () => {
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
