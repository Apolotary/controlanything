/** Messages between the live detector (main thread) and its worker. */
import type { Box } from './prep';

export type YoloEp = 'webgpu' | 'wasm';

export type WorkerIn =
  | { type: 'init'; modelUrl: string; inputSize: number; ep: YoloEp | 'auto' }
  | { type: 'frame'; id: number; bitmap: ImageBitmap; allowed: number[]; scoreThreshold: number };

export interface WorkerDet {
  /** pixels of the bitmap that was sent */
  box: Box;
  score: number;
  cls: number;
}

export type WorkerOut =
  | { type: 'ready'; ep: YoloEp; threads: number; isolated: boolean; loadMs: number; fetchMs: number; warmMs: number; fallback?: string }
  | { type: 'result'; id: number; dets: WorkerDet[]; width: number; height: number; prepMs: number; inferMs: number; postMs: number }
  | { type: 'error'; id?: number; message: string; fatal?: boolean };
