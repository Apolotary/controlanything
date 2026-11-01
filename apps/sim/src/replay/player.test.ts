import { describe, expect, it, vi } from 'vitest';
import { parseSession, TakePlayer } from './player';

const take = [
  JSON.stringify({ kind: 'meta', v: 1, take: 'hero-lamp', startedAt: 1000, app: 'quest@0.1.0', camera: { width: 1280, height: 960, fx: 868, fy: 868, cx: 640, cy: 480 } }),
  JSON.stringify({ t: 0, dir: 'out', msg: { v: 1, type: 'hello', id: 'a', ts: 0, from: '', payload: { deviceToken: 'x' } } }),
  JSON.stringify({ t: 10, kind: 'pose', head: { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }),
  JSON.stringify({ t: 20, dir: 'out', msg: { v: 1, type: 'scan.frame', id: 'b', ts: 0, from: '', to: 'server', payload: { frameId: 'f1', jpegFile: 'frames/f1.jpg', width: 1280, height: 960, capturedAt: 0, purpose: 'scan' } } }),
  JSON.stringify({ t: 30, dir: 'in', msg: { v: 1, type: 'scan.result', id: 'c', ts: 0, from: 'server', payload: { frameId: 'f1', detections: [] } } }),
  JSON.stringify({ t: 40, dir: 'out', msg: { v: 1, type: 'sense.result', id: 'd', ts: 0, from: '', to: 'server', payload: { senseId: 'old', kind: 'frame', frame: { frameId: 'f2', jpegFile: 'frames/f2.jpg', width: 1280, height: 960, capturedAt: 0, purpose: 'verify', senseId: 'old' }, at: 0 } } }),
  'not json',
].join('\n');

describe('take replay', () => {
  it('parses the agreed session.jsonl format', () => {
    const t = parseSession(take);
    expect(t.name).toBe('hero-lamp');
    expect(t.meta?.app).toBe('quest@0.1.0');
    expect(t.lines.filter((l) => l.dir === 'out')).toHaveLength(3);
    expect(t.lines.find((l) => l.kind === 'pose')).toBeDefined();
  });

  it('re-sends headset messages with their frames and answers sense requests from the recording', async () => {
    vi.useFakeTimers();
    const t = parseSession(take);
    t.frames.set('frames/f1.jpg', 'AAAA');
    t.frames.set('frames/f2.jpg', 'BBBB');
    const sent: Record<string, unknown>[] = [];
    const log: string[] = [];
    const p = new TakePlayer(t, { send: (m) => (sent.push(m), true), log: (s) => log.push(s) });
    expect(p.summary()).toContain('3 sent / 1 received');
    p.play(1);
    await vi.advanceTimersByTimeAsync(50);
    // hello is never replayed (the sim has its own identity); sense.result waits for a live request
    expect(sent.map((m) => m.type)).toEqual(['scan.frame']);
    expect((sent[0]!.payload as { jpeg?: string; jpegFile?: string }).jpeg).toBe('AAAA');
    expect((sent[0]!.payload as { jpegFile?: string }).jpegFile).toBeUndefined();
    expect(sent[0]!.to).toBe('server');
    const answered = await p.answer({ senseId: 'live-1', sensorDeviceId: 'sim', kind: 'frame' });
    expect(answered).toBe(true);
    const res = sent.at(-1)!;
    expect(res.type).toBe('sense.result');
    const payload = res.payload as { senseId: string; frame: { jpeg: string; senseId: string } };
    expect(payload.senseId).toBe('live-1');
    expect(payload.frame.senseId).toBe('live-1');
    expect(payload.frame.jpeg).toBe('BBBB');
    expect(await p.answer({ senseId: 'live-2', sensorDeviceId: 'sim', kind: 'frame' })).toBe(false);
    p.stop();
    vi.useRealTimers();
  });
});
