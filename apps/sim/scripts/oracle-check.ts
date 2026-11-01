/**
 * Runs the server's real camera oracle (apps/server/src/oracle/camera.ts) on sim camera frames for every lamp
 * transition the agent can cause, using the exact lamp outline from the render's id mask. Frames go through the
 * same development, sensor noise and JPEG round trip as live frames. No network, no key.
 *
 *   npx tsx apps/sim/scripts/oracle-check.ts            exit 0 = every transition reads the right way
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Effect, Polygon } from '@ce/protocol';
import { cameraMatches, observeCamera } from '../../server/src/oracle/camera';
import { decodeJpeg, encodeJpeg, maskAndRing } from '../../server/src/oracle/image';
import type { LampCmd } from '../src/ir/table';
import { applyVignette, compose, type CameraParams } from '../src/room/compose';
import { decodeCel } from '../src/room/hdr';
import { applyCmd, DEFAULT_STATE, type LampState, targetDisplay } from '../src/room/lamp';

const here = dirname(fileURLToPath(import.meta.url));
const ROOM = join(here, '../public/room');
const meta = JSON.parse(readFileSync(join(ROOM, 'meta.json'), 'utf8'));
const view = 'room';
const L = Object.fromEntries(['sky', 'lamp', 'night'].map((n) => [n, decodeCel(gunzipSync(readFileSync(join(ROOM, view, `${n}.cel.gz`))))]));
const layers = { width: L.sky!.width, height: L.sky!.height, sky: L.sky!.data, lamp: L.lamp!.data, night: L.night!.data };
applyVignette(layers);
const lampDev = (meta.views[view].devices as { id: string; polygon: [number, number][] }[]).find((d) => d.id === 'ceiling-light')!;
const polygon = lampDev.polygon as Polygon;

const argv = process.argv.slice(2);
const num = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};
const cam: CameraParams = { ...(meta.camera as CameraParams) };
for (const k of ['exposure', 'skyGain', 'lampGain', 'nightGain'] as const) cam[k] = num(`--${k}`) ?? cam[k];
const quiet = argv.includes('--quiet');
let seed = 1;
function frameLuma(img: { data: Uint8Array }) {
  let s = 0;
  for (let i = 0; i < img.data.length; i += 16) s += 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
  return s / (img.data.length / 16);
}
function shot(s: LampState) {
  const out = new Uint8ClampedArray(layers.width * layers.height * 4);
  compose(layers, targetDisplay(s), cam, out, { noise: 1, seed: seed++ });
  const jpg = encodeJpeg({ width: layers.width, height: layers.height, data: new Uint8Array(out.buffer) }, 88);
  return decodeJpeg(jpg);
}

const EXPECT: Record<LampCmd, Effect> = { fullOn: 'on', on: 'on', off: 'off', brighter: 'brighter', dimmer: 'dimmer', night: 'dimmer', warmer: 'warmer', cooler: 'cooler' };

const cases: { from: LampState; cmd: LampCmd; expect?: Effect }[] = [];
const on = (level: number, cctK = 4800): LampState => ({ ...DEFAULT_STATE, power: 'on', level, cctK });
cases.push({ from: DEFAULT_STATE, cmd: 'fullOn' });
cases.push({ from: on(10), cmd: 'off' });
cases.push({ from: on(10), cmd: 'night' });
cases.push({ from: { ...DEFAULT_STATE, power: 'night' }, cmd: 'fullOn' });
cases.push({ from: DEFAULT_STATE, cmd: 'night', expect: 'brighter' });
for (let lv = 1; lv < 10; lv++) cases.push({ from: on(lv), cmd: 'brighter' });
for (let lv = 10; lv > 1; lv--) cases.push({ from: on(lv), cmd: 'dimmer' });
for (const k of [6500, 4800, 3800, 3200]) cases.push({ from: on(10, k), cmd: 'warmer' });
for (const k of [2700, 3200, 3800, 4800]) cases.push({ from: on(10, k), cmd: 'cooler' });
for (const k of [4800, 3200]) cases.push({ from: on(4, k), cmd: 'warmer' });
// negative control: a code the lamp ignores must read as "none"
cases.push({ from: on(10), cmd: 'off', expect: 'none' });

let failures = 0;
const stepStats: { cmd: string; expected: string; fl: number; ringD: number; maskD: number }[] = [];
for (const c of cases) {
  const expected = c.expect ?? EXPECT[c.cmd];
  const after = expected === 'none' ? c.from : applyCmd(c.from, c.cmd);
  const A = shot(c.from);
  const B = shot(after);
  const obs = observeCamera(A, B, polygon, undefined, { exposureLocked: true });
  const ok = cameraMatches(obs, expected);
  if (!ok) failures++;
  const fl = (frameLuma(B) - frameLuma(A)) / frameLuma(A);
  const ra = maskAndRing(A, polygon);
  const rb = maskAndRing(B, polygon);
  const ringD = (rb.ring.luma - ra.ring.luma) / Math.max(1, ra.ring.luma);
  const maskD = (rb.mask.luma - ra.mask.luma) / Math.max(1, ra.mask.luma);
  stepStats.push({ cmd: c.cmd, expected, fl, ringD, maskD });
  if (quiet) continue;
  const name = `${c.from.power}${c.from.power === 'on' ? ` L${c.from.level} ${c.from.cctK}K` : ''} --${c.cmd}-->`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} expect ${expected.padEnd(8)} seen ${obs.effect}${obs.secondary ? '+' + obs.secondary : ''}  luma ratio ${(obs.delta * 100).toFixed(1)} %  abs ${(obs.absDelta * 100).toFixed(1)} %  R/B ${obs.rbBefore.toFixed(3)}→${obs.rbAfter.toFixed(3)} (${(obs.rbDelta * 100).toFixed(1)} %)  frame ${(fl * 100).toFixed(1)} %  ring ${(ringD * 100).toFixed(1)} %  mask ${(maskD * 100).toFixed(1)} %`);
}
console.log(`camera ${JSON.stringify(cam)}: ` + (failures ? `${failures}/${cases.length} transition(s) read wrong` : `all ${cases.length} transitions read the right way with the server's camera oracle`));
const steps = stepStats.filter((x) => x.cmd === 'brighter' || x.cmd === 'dimmer');
if (steps.length) {
  const min = (f: (x: (typeof steps)[0]) => number) => Math.min(...steps.map((x) => Math.abs(f(x)))) * 100;
  console.log(`brightness steps: smallest |frame luma| change ${min((x) => x.fl).toFixed(1)} %, |ring luma| ${min((x) => x.ringD).toFixed(1)} %, |mask luma| ${min((x) => x.maskD).toFixed(1)} %`);
}
process.exit(failures ? 1 : 0);
