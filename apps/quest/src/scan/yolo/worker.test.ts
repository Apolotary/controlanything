import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerIn, WorkerOut } from './protocol';

const ort = vi.hoisted(() => ({
  env: { wasm: { numThreads: 0, proxy: true }, logLevel: '' },
  create: vi.fn(),
  outputDispose: vi.fn(),
}));
vi.mock('onnxruntime-web/webgpu', () => ({
  env: ort.env,
  InferenceSession: { create: ort.create },
  Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} },
}));

let scope: {
  onmessage?: (e: MessageEvent<WorkerIn>) => void;
  postMessage: ReturnType<typeof vi.fn>;
  crossOriginIsolated: boolean;
  name?: string;
  navigator: { hardwareConcurrency: number; gpu?: { requestAdapter: ReturnType<typeof vi.fn> } };
};
const send = (message: WorkerIn) => scope.onmessage?.({ data: message } as MessageEvent<WorkerIn>);
const messages = () => scope.postMessage.mock.calls.map(([m]) => m as WorkerOut);
const waitForReady = () => vi.waitFor(() => expect(messages().some((m) => m.type === 'ready')).toBe(true));
function session(run = vi.fn().mockImplementation(async () => ({ output: { location: 'cpu', data: new Float32Array(85), dispose: ort.outputDispose } }))) {
  return { inputNames: ['input'], outputNames: ['output'], run, release: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  scope = { postMessage: vi.fn(), crossOriginIsolated: false, navigator: { hardwareConcurrency: 8 } };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() {
      return { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(416 * 416 * 4) }) };
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('YOLOX worker providers and bitmap ownership', () => {
  it('preserves the runtime message handler when its pthread loads this bundle', async () => {
    scope.name = 'em-pthread';
    const runtimeHandler = vi.fn();
    scope.onmessage = runtimeHandler;
    await import('./yolo.worker');
    expect(scope.onmessage).toBe(runtimeHandler);
  });

  it('uses single-threaded WASM when WebGPU and isolation are unavailable', async () => {
    ort.create.mockResolvedValue(session());
    await import('./yolo.worker');
    send({ type: 'init', modelUrl: '/model.onnx', inputSize: 416, ep: 'auto' });
    await waitForReady();
    expect(ort.create).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ executionProviders: ['wasm'] }));
    expect(messages()).toContainEqual(expect.objectContaining({ type: 'ready', ep: 'wasm', threads: 1 }));
    expect(ort.outputDispose).toHaveBeenCalledTimes(2);
  });

  it('uses WebGPU when an adapter and warmup are available', async () => {
    scope.navigator.gpu = { requestAdapter: vi.fn().mockResolvedValue({}) };
    scope.crossOriginIsolated = true;
    ort.create.mockResolvedValue(session());
    await import('./yolo.worker');
    send({ type: 'init', modelUrl: '/model.onnx', inputSize: 416, ep: 'auto' });
    await waitForReady();
    expect(messages()).toContainEqual(expect.objectContaining({ type: 'ready', ep: 'webgpu', threads: 4 }));
  });

  it('releases a GPU session and retries WASM if shader warmup fails', async () => {
    const gpu = session(vi.fn().mockRejectedValue(new Error('shader compilation failed')));
    ort.create.mockResolvedValueOnce(gpu).mockResolvedValueOnce(session());
    await import('./yolo.worker');
    send({ type: 'init', modelUrl: '/model.onnx', inputSize: 416, ep: 'webgpu' });
    await waitForReady();
    expect(gpu.release).toHaveBeenCalledTimes(1);
    expect(messages()).toContainEqual(expect.objectContaining({ type: 'ready', ep: 'wasm', fallback: expect.stringContaining('shader compilation failed') }));
  });

  it('closes transferred bitmaps on success and emits device-only results', async () => {
    const out = new Float32Array(85);
    out.set([1, 1, 1, 1, 0.9]); out[5] = 0.95; out[5 + 63] = 0.8;
    ort.create.mockResolvedValue(session(vi.fn().mockResolvedValue({ output: { location: 'cpu', data: out, dispose: ort.outputDispose } })));
    await import('./yolo.worker');
    send({ type: 'init', modelUrl: '/model.onnx', inputSize: 416, ep: 'wasm' });
    await waitForReady();
    const bitmap = { width: 416, height: 312, close: vi.fn() };
    send({ type: 'frame', id: 1, bitmap: bitmap as unknown as ImageBitmap, allowed: [0, 63], scoreThreshold: 0.3 });
    await vi.waitFor(() => expect(messages()).toContainEqual(expect.objectContaining({ type: 'result', id: 1, dets: [] })));
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(ort.outputDispose).toHaveBeenCalledTimes(3);
  });

  it('closes transferred bitmaps when inference fails', async () => {
    const wasm = session();
    ort.create.mockResolvedValue(wasm);
    await import('./yolo.worker');
    send({ type: 'init', modelUrl: '/model.onnx', inputSize: 416, ep: 'wasm' });
    await waitForReady();
    wasm.run.mockRejectedValueOnce(new Error('inference failed'));
    const bitmap = { width: 416, height: 312, close: vi.fn() };
    send({ type: 'frame', id: 2, bitmap: bitmap as unknown as ImageBitmap, allowed: [63], scoreThreshold: 0.3 });
    await vi.waitFor(() => expect(messages()).toContainEqual(expect.objectContaining({ type: 'error', id: 2, message: 'inference failed' })));
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
