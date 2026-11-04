/// <reference lib="webworker" />
/** Runs HandVision off the main thread. Frames arrive as transferred RGBA buffers and go back for reuse. */
import { HandVision, type Face } from './vision';

type In =
  | { type: 'frame'; w: number; h: number; buffer: ArrayBuffer; mask: boolean; seq: number }
  | { type: 'calibrate'; box: { x0: number; y0: number; x1: number; y1: number } }
  | { type: 'reset-model' }
  | { type: 'reset-background' }
  | { type: 'face'; search: boolean; face?: Face | null };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let vision: HandVision | undefined;
let faceSearch = true;

scope.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === 'frame') {
    if (!vision || vision.w !== m.w || vision.h !== m.h) {
      const model = vision?.model, calibrated = vision?.calibrated;
      vision = new HandVision(m.w, m.h);
      if (model) { vision.model = model; vision.calibrated = !!calibrated; }
      vision.faceSearch = faceSearch;
    }
    const rgba = new Uint8ClampedArray(m.buffer);
    const result = vision.process(rgba, m.mask);
    const calibration = vision.calibrating ? vision.calibrateFrame(rgba) : null;
    const flow = result.flow.slice();
    const mask = result.mask ? result.mask.slice() : undefined;
    const transfer: Transferable[] = [m.buffer, flow.buffer];
    if (mask) transfer.push(mask.buffer);
    scope.postMessage({ type: 'result', seq: m.seq, result: { ...result, flow, mask }, calibration, buffer: m.buffer }, transfer);
  } else if (m.type === 'calibrate') {
    vision?.startCalibration(m.box, 12);
  } else if (m.type === 'reset-background') {
    vision?.resetBackground(); vision?.resetFace();
  } else if (m.type === 'reset-model') {
    vision?.resetModel(); vision?.resetFace();
  } else if (m.type === 'face') {
    faceSearch = m.search;
    if (vision) { vision.faceSearch = m.search; if (m.face !== undefined) vision.setFace(m.face); }
  }
};
