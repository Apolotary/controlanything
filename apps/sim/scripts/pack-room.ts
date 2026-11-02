/**
 * Packs the Blender render (apps/sim/scene/room.py) into the web assets the sim loads:
 *   public/room/<view>/{sky,lamp,night}.cel.gz   linear light layers (CEL1: planar RGBE, 7-bit mantissas, gzipped)
 *   public/room/meta.json                         poses, intrinsics, device boxes/outlines per view, camera gains
 *
 * Usage: npx tsx apps/sim/scripts/pack-room.ts --src <blender out dir> [--out apps/sim/public/room]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { decodeCel, decodeHdr, encodeCel } from '../src/room/hdr';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const SRC = resolve(opt('--src', join(here, '../scene/out')));
const OUT = resolve(opt('--out', join(here, '../public/room')));

const DEVICE_INFO: Record<string, { kind: string; label: string }> = {
  'ceiling-light': { kind: 'lighting', label: 'ceiling light' },
  synth: { kind: 'synthesizer', label: 'synthesizer' },
  remote: { kind: 'remote-control', label: 'IR remote' },
  laptop: { kind: 'synthesizer', label: 'ControlAnything Visual Synth' },
  'air-conditioner': { kind: 'appliance', label: 'air conditioner' },
};

type Pt = [number, number];

function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drop hull points until <= max, removing the one that changes the area least each time. */
function simplify(poly: Pt[], max: number): Pt[] {
  const p = [...poly];
  const area = (a: Pt, b: Pt, c: Pt) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  while (p.length > max) {
    let best = 0;
    let bestA = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = area(p[(i - 1 + p.length) % p.length]!, p[i]!, p[(i + 1) % p.length]!);
      if (a < bestA) {
        bestA = a;
        best = i;
      }
    }
    p.splice(best, 1);
  }
  return p.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

const luminance = (d: Float32Array, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]!;
}

/** Inverse of the compositor's filmic curve (bisection). */
function toneInv(y: number): number {
  const tone = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tone(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
const srgbToLinear = (s: number) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);

const scene = JSON.parse(readFileSync(join(SRC, 'scene.json'), 'utf8'));
const maskIds: Record<string, number[]> = scene.maskIds;
const width: number = scene.width;
const height: number = scene.height;
const views: Record<string, unknown> = {};
let camera = { exposure: 1, skyGain: 1, lampGain: 1, nightGain: 1 };

for (const [view, vmeta] of Object.entries(scene.views as Record<string, Record<string, unknown>>)) {
  mkdirSync(join(OUT, view), { recursive: true });
  const layers: Record<string, Float32Array> = {};
  for (const layer of ['sky', 'lamp', 'night']) {
    const bytes = readFileSync(join(SRC, view, `${layer}.hdr`));
    layers[layer] = decodeHdr(bytes).data;
  }
  // id mask -> per-device pixel sets
  const png = PNG.sync.read(readFileSync(join(SRC, view, 'mask.png')));
  const owner = new Int8Array(width * height).fill(-1);
  const ids = Object.keys(maskIds);
  const pts: Pt[][] = ids.map(() => []);
  const boxes = ids.map(() => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1, n: 0 }));
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      const r = png.data[o]! > 127 ? 1 : 0;
      const g = png.data[o + 1]! > 127 ? 1 : 0;
      const b = png.data[o + 2]! > 127 ? 1 : 0;
      let k = ids.findIndex((id) => maskIds[id]![0] === r && maskIds[id]![1] === g && maskIds[id]![2] === b);
      // the synth's screen is drawn white inside the synth
      if (k < 0 && r && g && b) k = ids.indexOf('synth');
      if (k < 0) continue;
      owner[y * width + x] = k;
      const bx = boxes[k]!;
      bx.n++;
      bx.x0 = Math.min(bx.x0, x);
      bx.y0 = Math.min(bx.y0, y);
      bx.x1 = Math.max(bx.x1, x);
      bx.y1 = Math.max(bx.y1, y);
      // boundary pixels only, for the hull
      const edge = x === 0 || y === 0 || x === png.width - 1 || y === png.height - 1;
      if (edge || x % 2 === 0) pts[k]!.push([x, y]);
    }
  }
  const devices = ids
    .map((id, k) => ({ id, k, bx: boxes[k]! }))
    .filter(({ bx }) => bx.n >= 60)
    .map(({ id, k, bx }) => ({
      id,
      kind: DEVICE_INFO[id]?.kind ?? 'other',
      label: DEVICE_INFO[id]?.label ?? id,
      box: [bx.x0 / width, bx.y0 / height, (bx.x1 - bx.x0 + 1) / width, (bx.y1 - bx.y0 + 1) / height].map((v) => Math.round(v * 10000) / 10000),
      boxPx: [bx.x0, bx.y0, bx.x1 - bx.x0 + 1, bx.y1 - bx.y0 + 1],
      pixels: bx.n,
      polygon: simplify(hull(pts[k]!), 32),
    }));
  views[view] = { ...vmeta, devices };
  {
    const lamp = devices.find((d) => d.id === 'ceiling-light');
    const night = layers.night!;
    // the night LED only matters on and around the shade; elsewhere it is invisible next to the dusk ambient
    const crop = lamp ? { x0: lamp.boxPx[0]! - lamp.boxPx[2]! * 0.6, y0: lamp.boxPx[1]! - lamp.boxPx[3]! * 1.2, x1: lamp.boxPx[0]! + lamp.boxPx[2]! * 1.6, y1: lamp.boxPx[1]! + lamp.boxPx[3]! * 2.4 } : undefined;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (crop && x >= crop.x0 && x <= crop.x1 && y >= crop.y0 && y <= crop.y1) continue;
        const i = (y * width + x) * 3;
        night[i] = night[i + 1] = night[i + 2] = 0;
      }
    }
    for (const layer of ['sky', 'lamp', 'night']) {
      const img = { width, height, data: layers[layer]! };
      const cel = encodeCel(img, 7);
      const gz = gzipSync(cel, { level: 9 });
      writeFileSync(join(OUT, view, `${layer}.cel.gz`), gz);
      // precision report: worst relative error on reasonably bright pixels
      const back = decodeCel(cel).data;
      let worst = 0;
      for (let i = 0; i < back.length; i += 7) {
        const a = img.data[i]!;
        if (a > 1e-4) worst = Math.max(worst, Math.abs(back[i]! - a) / a);
      }
      console.log(`${view}/${layer}: ${(gz.length / 1e6).toFixed(2)} MB (worst rel. error ${(worst * 100).toFixed(2)} % on the main channel samples)`);
    }
  }

  if (view === 'room') {
    // calibrate the camera on the main view: walls at full brightness ~ mid-grey, dusk ambient dim but readable,
    // night LED a warm glow on the shade
    const lampK = ids.indexOf('ceiling-light');
    const bgLamp: number[] = [];
    const bgSky: number[] = [];
    const nightIn: number[] = [];
    for (let p = 0, i = 0; p < width * height; p++, i += 3) {
      if (owner[p] === -1) {
        if (p % 7 === 0) {
          bgLamp.push(luminance(layers.lamp!, i));
          bgSky.push(luminance(layers.sky!, i));
        }
      } else if (owner[p] === lampK) nightIn.push(luminance(layers.night!, i));
    }
    const target = (srgb: number) => toneInv(srgbToLinear(srgb));
    camera = {
      exposure: 1,
      lampGain: target(0.53) / percentile(bgLamp, 0.6),
      skyGain: target(0.21) / percentile(bgSky, 0.6),
      nightGain: target(0.75) / Math.max(1e-6, percentile(nightIn, 0.985)),
    };
    for (const k of Object.keys(camera) as (keyof typeof camera)[]) camera[k] = Number(camera[k].toPrecision(4));
    console.log('camera calibration', camera);
  }
}

const meta = {
  v: 1,
  generator: scene.generator,
  blender: scene.blender,
  samples: scene.samples,
  width,
  height,
  space: scene.space,
  note: 'Linear light layers rendered with Cycles from apps/sim/scene/room.py; frames are developed in the browser (apps/sim/src/room/compose.ts).',
  camera,
  views,
  devices: scene.devices,
  room: scene.room,
};
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`wrote ${join(OUT, 'meta.json')}`);
