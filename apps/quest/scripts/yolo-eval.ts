/**
 * Runs the bundled on-device detector (YOLOX-nano, Apache-2.0) on a JPEG in Node, with the same pre/post
 * processing the headset worker uses, and prints device boxes (and, with --raw, device candidates before NMS).
 *
 *   npx tsx apps/quest/scripts/yolo-eval.ts [photo.jpg] [--model path.onnx] [--raw] [--runs 10] [--rgbnorm]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import * as ort from 'onnxruntime-web';
import { allowedClasses, COCO_CLASSES, deviceClass } from '../src/scan/yolo/classes';
import { decodeYolox, postprocess } from '../src/scan/yolo/post';
import { letterbox, PAD_VALUE, rgbaToBgrChw, toSource } from '../src/scan/yolo/prep';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const photo = args.find((a) => !a.startsWith('--') && a !== opt('--model') && a !== opt('--runs')) ?? here('../public/test/scan-scene.jpg');
const modelPath = opt('--model') ?? here('../public/models/yolox_nano.onnx');
const runs = Number(opt('--runs') ?? 5);
const SIZE = 416;

const img = jpeg.decode(readFileSync(photo), { useTArray: true, formatAsRGBA: true });
const lb = letterbox(img.width, img.height, SIZE);
// bilinear resize into a 114-filled square, pasted top-left (what the worker's canvas drawImage does)
const rgba = new Uint8ClampedArray(SIZE * SIZE * 4).fill(PAD_VALUE);
for (let y = 0; y < lb.height; y++) {
  for (let x = 0; x < lb.width; x++) {
    const sx = Math.min(img.width - 1, (x + 0.5) / lb.scale - 0.5);
    const sy = Math.min(img.height - 1, (y + 0.5) / lb.scale - 0.5);
    const x0 = Math.max(0, Math.floor(sx));
    const y0 = Math.max(0, Math.floor(sy));
    const x1 = Math.min(img.width - 1, x0 + 1);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const fx = sx - x0;
    const fy = sy - y0;
    for (let c = 0; c < 3; c++) {
      const p = (xx: number, yy: number) => img.data[(yy * img.width + xx) * 4 + c]!;
      const v = p(x0, y0) * (1 - fx) * (1 - fy) + p(x1, y0) * fx * (1 - fy) + p(x0, y1) * (1 - fx) * fy + p(x1, y1) * fx * fy;
      rgba[(y * SIZE + x) * 4 + c] = v;
    }
  }
}
let input = rgbaToBgrChw(rgba, lb);
if (flag('--rgbnorm')) {
  // the pre-0.2.0 YOLOX convention (RGB, /255, ImageNet mean/std), to compare against
  const plane = SIZE * SIZE;
  const t = new Float32Array(plane * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) t[c * plane + i] = (input[(2 - c) * plane + i]! / 255 - mean[c]!) / std[c]!;
  input = t;
}

ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(readFileSync(modelPath), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
const feeds = { [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
let out: Float32Array | undefined;
const times: number[] = [];
for (let i = 0; i < Math.max(1, runs); i++) {
  const t0 = performance.now();
  const r = await session.run(feeds);
  times.push(performance.now() - t0);
  out = r[session.outputNames[0]!]!.data as Float32Array;
}
times.sort((a, b) => a - b);
console.log(`${modelPath.split('/').pop()} on ${photo.split('/').pop()} (${img.width}×${img.height} → ${lb.width}×${lb.height} in ${SIZE}²) · wasm 1 thread · median ${times[times.length >> 1]!.toFixed(1)} ms over ${times.length} runs`);

if (flag('--raw')) {
  const { devices } = decodeYolox(out!, { inputSize: SIZE, scoreThreshold: 0.25, allowed: allowedClasses('everything') });
  const top = devices.sort((a, b) => b.score - a.score).slice(0, 25);
  console.log('device candidates (raw, pre-NMS top 25):');
  for (const c of top) console.log(`  ${COCO_CLASSES[c.cls]!.padEnd(14)} ${(c.score * 100).toFixed(0).padStart(3)} %  ${toSource(c.box, lb).map((v) => Math.round(v)).join(',')}`);
}

const dets = postprocess(out!, { inputSize: SIZE, scoreThreshold: 0.3, allowed: allowedClasses('everything') });
console.log(`live layer (devices only, after NMS): ${dets.length}`);
for (const d of dets) console.log(`  ${deviceClass(d.cls)!.label.padEnd(12)} ${(d.score * 100).toFixed(0).padStart(3)} %  box ${toSource(d.box, lb).map((v) => Math.round(v)).join(',')}`);
