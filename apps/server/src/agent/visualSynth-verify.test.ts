import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver, ExecOp, ScanFramePayload } from '@ce/protocol';
import { visualSynthDraft } from '../devices/visualSynth';
import { encodeJpeg } from '../oracle/image';
import type { Sam } from '../scan/sam';
import type { Dispatcher } from './dispatch';
import { TargetStore } from './targets';
import { verifyOnce } from './verify';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(working: boolean) {
  let level = 110;
  const sent: ExecOp[] = [];
  const sensorKinds: string[] = [];
  const label = 'ControlAnything Visual Synth';
  const frame = (): ScanFramePayload => {
    const data = new Uint8Array(64 * 48 * 4);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
      const offset = (y * 64 + x) * 4;
      const value = x >= 20 && x < 44 && y >= 10 && y < 30 ? level : 35;
      data.set([value, value, value, 255], offset);
    }
    return { purpose: 'verify', frameId: 'frame', jpeg: Buffer.from(encodeJpeg({ width: 64, height: 48, data })).toString('base64'), width: 64, height: 48,
      capturedAt: Date.now(), camera: { source: 'synthetic' },
      fixtureDetections: [{ detId: 'screen', label, prompt: 'synthesizer', score: 1, box: [20, 10, 24, 20] }] };
  };
  const dispatcher = {
    async exec(_deviceId: string, op: ExecOp) {
      sent.push(op);
      if (working && op.kind === 'midi') {
        if (op.msg === 'cc' && typeof op.value === 'number') level = 50 + op.value;
        if (op.msg === 'pc') level = [50, 110, 190][op.number!];
      }
      return { execId: 'exec', ok: true, sentAt: Date.now() };
    },
    async sense(_deviceId: string, kind: string) {
      sensorKinds.push(kind);
      return [{ senseId: 'sense', kind: 'frame', frame: frame(), at: Date.now(), ok: true }];
    },
  } as unknown as Dispatcher;
  const target = new TargetStore({ broadcast: () => 0 }).create({ cardId: 'screen',
    detection: { frameId: 'old', detId: 'screen', label, prompt: 'synthesizer', sensorDeviceId: 'quest', score: 1,
      // The camera has moved since annotation: fresh projected boxes must win.
      box: [1, 1, 2, 2], width: 64, height: 48, jpeg: frame().jpeg, capturedAt: 0 } });
  const driver: Driver = { ...visualSynthDraft('screen', []), driverId: 'driver', executor: { deviceId: 'sim', port: 'ce-visual-synth' } };
  const segment = vi.fn(() => { throw new Error('synthetic fixture should use its projected box'); });
  const sam = { mode: 'fixture', segment } as unknown as Sam;
  return { dispatcher, target, driver, sam, sent, sensorKinds, segment };
}

describe('visual instrument camera verification', () => {
  it.each([0, 1, 2, 3])('measures action %i in two camera frames with a distinct baseline', async (index) => {
    const h = harness(true);
    const pending = verifyOnce({ dispatcher: h.dispatcher, sam: h.sam, settleMs: () => 0 }, h.target, h.driver, h.driver.actions[index], 1, { cameraDeviceId: 'quest' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.evidence.pass).toBe(true);
    expect(result.evidence.observed).toMatchObject({ sense: 'camera', sensorDeviceId: 'quest' });
    expect(result.evidence.note).toContain('confirmed 2x');
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).not.toEqual(h.sent[1]);
    expect(h.sensorKinds).toEqual(['frame', 'frame', 'frame', 'frame']);
    expect(h.segment).not.toHaveBeenCalled();
  });

  it('never prepares a baseline when the camera is unavailable', async () => {
    const h = harness(true);
    vi.spyOn(h.dispatcher, 'sense').mockRejectedValue(new Error('camera offline'));
    await expect(verifyOnce({ dispatcher: h.dispatcher, sam: h.sam }, h.target, h.driver, h.driver.actions[0], 1, { cameraDeviceId: 'quest' })).rejects.toThrow('camera offline');
    expect(h.sent).toEqual([]);
  });

  it('fails an acknowledged command when the screen pixels did not change', async () => {
    const h = harness(false);
    const pending = verifyOnce({ dispatcher: h.dispatcher, sam: h.sam, settleMs: () => 0 }, h.target, h.driver, h.driver.actions[0], 1, { cameraDeviceId: 'quest' });
    await vi.runAllTimersAsync();
    expect((await pending).evidence).toMatchObject({ pass: false, observed: { sense: 'camera', delta: 0 } });
  });
});
