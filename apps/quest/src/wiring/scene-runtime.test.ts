import { describe, expect, it } from 'vitest';
import { fakeWorkerFactory } from './fake-worker.test-support';
import { SCENE_LAYOUT, SCENE_LIMITS, SceneRuntime, type SceneSignals } from './scene-runtime';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => queueMicrotask(r)); };
const hand = (x: number) => ({ x, y: 0, z: 0.1, tip: { x, y: 0.05, z: 0 }, thumb: { x, y: 0, z: 0 }, tips: Array(15).fill(x), vx: 0, vy: 0, vz: 0, speed: 0, nx: 0, ny: 0, nz: -1, pinch: 0, pinchTap: false, fist: false, open: true, palmOut: false });
const signals = (t: number, right: ReturnType<typeof hand> | null): SceneSignals => ({ t, dt: 1 / 72, head: { x: 0, y: 0.3, z: 0.55 }, device: null, right, left: null, values: { cc21: 64 } });

function setup(code: string) {
  const stops: [string, string][] = [];
  const log = { posted: [] as unknown[] };
  const rt = new SceneRuntime({ onStop: (reason, kind) => stops.push([reason, kind]), createWorker: fakeWorkerFactory(log) });
  expect(rt.start({ wiringId: 'w1', cardId: 'c1', title: 'Test', code })).toBeNull();
  return { rt, stops, log };
}

describe('scene sandbox', () => {
  it('returns a display list that follows the hand, with trails, halos and labels', async () => {
    const { rt } = setup(`
      draw.point(0, 0, 0, 0.01, '#ff0000', 1);
      if (s.right) { draw.sphere(s.right.x, s.right.y, s.right.z, 0.02, 0x00ff00, 0.5); draw.trail('r', s.right.tip.x, s.right.tip.y, s.right.tip.z, 0x40d8ff, 0.012); }
      draw.line(0, 0, 0, 0.1, 0.1, 0.1, draw.hsl(0.5, 1, 0.5), 0.5);
      draw.text(0, 0.1, 0, 'Ripples ' + s.values.cc21, 0xffffff, 0.02);`);
    await flush();
    for (let i = 0; i < 4; i++) { rt.tick(signals(i / 72, hand(0.1 * i))); await flush(); }
    const v = rt.view;
    expect(v.active).toBe(true);
    expect(v.counts.spheres).toBe(1);
    // 1 point + trail points + 1 sphere halo
    expect(v.counts.points).toBeGreaterThanOrEqual(4);
    expect(v.counts.lines).toBeGreaterThanOrEqual(2);
    expect(v.texts[0]!.text).toBe('Ripples 64');
    const sp = SCENE_LAYOUT.sp.off;
    expect(v.data![sp]).toBeCloseTo(0.3); // sphere follows the latest right hand x
    expect(v.data![SCENE_LAYOUT.pt.off + 4]).toBe(1); // '#ff0000' -> red channel 1
    rt.stop('done', 'user');
    expect(v.active).toBe(false);
    expect(v.data).toBeNull();
  });

  it('caps what one frame may draw', async () => {
    const { rt } = setup('for (var i = 0; i < 9000; i++) draw.point(i * 0.0001, 0, 0, 0.01, 0xffffff, 1); for (var j = 0; j < 500; j++) draw.box(0, 0, 0, 0.1, 0.1, 0.1, 0xffffff, 1, 0);');
    await flush();
    rt.tick(signals(0, null)); await flush();
    expect(rt.view.counts.points).toBe(SCENE_LIMITS.points);
    expect(rt.view.counts.boxes).toBe(SCENE_LIMITS.boxes);
    expect(rt.stats.dropped).toBeGreaterThan(5000);
  });

  it('stops after three throws and refuses forbidden code', async () => {
    const { rt, stops } = setup('draw.point(s.right.x, 0, 0, 0.01, 0xffffff, 1);');
    await flush();
    for (let i = 0; i < 3; i++) { rt.tick(signals(i, null)); await flush(); }
    expect(rt.running).toBe(false);
    expect(stops.at(-1)![1]).toBe('error');
    const refused: string[] = [];
    const rt2 = new SceneRuntime({ onStop: (r) => refused.push(r), createWorker: fakeWorkerFactory() });
    expect(rt2.start({ wiringId: 'w2', cardId: 'c1', title: 'x', code: 'fetch("https://x"); draw.point(0,0,0,0.01,0,1);' })).toMatch(/refused/);
  });
});
