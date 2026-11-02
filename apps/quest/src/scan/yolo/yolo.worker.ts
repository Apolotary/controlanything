/**
 * The on-device detector worker: YOLOX-nano (Apache-2.0, bundled under public/models/) on onnxruntime-web,
 * WebGPU when the browser exposes it, else WASM SIMD (multi-threaded only when the page is cross-origin
 * isolated). One frame at a time: ImageBitmap (transferred, already downscaled) → 416² letterbox on a
 * 114-grey canvas → BGR NCHW → session.run → decode + NMS + device filtering → device boxes in the
 * bitmap's pixels. Class 0 is discarded before a box is decoded.
 * (Typed against the DOM lib; the worker scope is narrowed by hand, as in encode.worker.ts.)
 */
import * as ort from 'onnxruntime-web/webgpu';
import { postprocess } from './post';
import { letterbox, PAD_VALUE, rgbaToBgrChw, toSource } from './prep';
import type { WorkerIn, WorkerOut, YoloEp } from './protocol';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
  crossOriginIsolated?: boolean;
  name?: string;
  navigator: Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } };
};

let session: ort.InferenceSession | undefined;
let ep: YoloEp = 'wasm';
let size = 416;
let canvas: OffscreenCanvas | undefined;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let tensorData: Float32Array | undefined;
let inputTensor: ort.Tensor | undefined;
let busy = false;

const post = (m: WorkerOut, transfer?: Transferable[]) => scope.postMessage(m, transfer);

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = scope.navigator.gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function init(m: Extract<WorkerIn, { type: 'init' }>): Promise<void> {
  const t0 = performance.now();
  size = m.inputSize;
  const isolated = Boolean(scope.crossOriginIsolated);
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(4, (scope.navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  const res = await fetch(m.modelUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`model ${m.modelUrl}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const fetchMs = performance.now() - t0;
  const order: YoloEp[] = m.ep === 'wasm' ? ['wasm'] : m.ep === 'webgpu' ? ['webgpu', 'wasm'] : (await hasWebGpu()) ? ['webgpu', 'wasm'] : ['wasm'];
  const errors: string[] = [];
  canvas = new OffscreenCanvas(size, size);
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context in the worker');
  tensorData = new Float32Array(3 * size * size).fill(PAD_VALUE);
  inputTensor = new ort.Tensor('float32', tensorData, [1, 3, size, size]);
  let warmMs = 0;
  for (const candidate of order) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [candidate], graphOptimizationLevel: 'all' });
      // A provider may create its session successfully but fail to compile a kernel on its first run.
      const tw = performance.now();
      await run();
      await run();
      warmMs = (performance.now() - tw) / 2;
      ep = candidate;
      break;
    } catch (e) {
      errors.push(`${candidate}: ${(e as Error).message}`);
      await session?.release().catch(() => undefined);
      session = undefined;
    }
  }
  if (!session) throw new Error(`no execution provider worked (${errors.join('; ')})`);
  post({ type: 'ready', ep, threads: ort.env.wasm.numThreads as number, isolated, loadMs: Math.round(performance.now() - t0), fetchMs: Math.round(fetchMs), warmMs: Math.round(warmMs), fallback: errors.length ? errors.join('; ') : undefined });
}

async function run(): Promise<Float32Array> {
  const s = session!;
  const out = await s.run({ [s.inputNames[0]!]: inputTensor! });
  try {
    const t = out[s.outputNames[0]!]!;
    // WebGPU may return a GPU tensor; release its buffer after downloading its data.
    return (t.location && t.location !== 'cpu' ? await t.getData() : t.data) as Float32Array;
  } finally {
    for (const t of Object.values(out)) t.dispose();
  }
}

async function detect(m: Extract<WorkerIn, { type: 'frame' }>): Promise<void> {
  const t0 = performance.now();
  const bmp = m.bitmap;
  try {
    if (!session || !ctx || !tensorData) throw new Error('detector not ready');
    const lb = letterbox(bmp.width, bmp.height, size);
    ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bmp, 0, 0, lb.width, lb.height);
    const px = ctx.getImageData(0, 0, size, size).data;
    rgbaToBgrChw(px, lb, tensorData);
    const t1 = performance.now();
    const out = await run();
    const t2 = performance.now();
    const cands = postprocess(out, { inputSize: size, scoreThreshold: m.scoreThreshold, allowed: new Set(m.allowed), iouThreshold: 0.45, maxOut: 12 });
    const dets = cands.map((c) => ({ box: toSource(c.box, lb), score: c.score, cls: c.cls })).filter((d) => d.box[2] > 1 && d.box[3] > 1);
    const t3 = performance.now();
    post({ type: 'result', id: m.id, dets, width: bmp.width, height: bmp.height, prepMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2 });
  } catch (e) {
    post({ type: 'error', id: m.id, message: (e as Error).message });
  } finally {
    bmp.close();
  }
}

// ORT's bundled pthread workers load this module again. Preserve their Emscripten handler.
if (!scope.name?.startsWith('em-pthread')) scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    init(m).catch((err) => post({ type: 'error', message: `init failed: ${(err as Error).message}`, fatal: true }));
  } else if (m.type === 'frame') {
    if (busy) {
      m.bitmap.close();
      post({ type: 'error', id: m.id, message: 'detector busy' });
      return;
    }
    busy = true;
    void detect(m).finally(() => { busy = false; });
  }
};
