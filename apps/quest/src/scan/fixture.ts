/**
 * Local scan fixture for the desktop emulator: real SAM 3.1 boxes recorded on the test photo
 * (public/test/scan-scene.sam.json, a live 8-prompt run), re-projected into whatever the synthetic camera
 * sees now. Lets the client pipeline (placement → tags → lock → select) run with no server-side detector.
 * Enabled with ?scan=fixture; results are labelled source "fixture".
 */
import type { Det } from '../io/v1';
import type { FrameRecord } from './capture';
import { worldToPixel } from './projection';
import type { VirtualRoom } from './synthetic';

export interface SamFixture {
  source: string;
  modelId: string;
  imageWidth: number;
  imageHeight: number;
  wallMs: number;
  detections: { prompt: string; label: string; box: [number, number, number, number]; score: number }[];
}

export async function loadSamFixture(url: string): Promise<SamFixture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${url}: HTTP ${res.status}`);
  return (await res.json()) as SamFixture;
}

/**
 * The sim room's exact device boxes (from its render's id mask) as a fixture. NOT model output: labelled
 * "sim-layout" so nothing on screen pretends a Meta model produced it. For client-side tests only.
 */
export function fixtureFromSimLayout(layout: { width: number; height: number; devices: { id: string; kind: string; label: string; box: [number, number, number, number] }[] }): SamFixture {
  return {
    source: 'sim room layout (exact boxes from the render id mask)',
    modelId: 'sim-layout',
    imageWidth: layout.width,
    imageHeight: layout.height,
    wallMs: 600,
    detections: layout.devices.map((d) => ({
      prompt: d.kind,
      label: d.label || d.kind,
      score: 1,
      box: [d.box[0] * layout.width, d.box[1] * layout.height, d.box[2] * layout.width, d.box[3] * layout.height],
    })),
  };
}

/** Detections of the fixture that are visible in this frame, in this frame's pixels. */
export function projectFixture(fix: SamFixture, room: VirtualRoom, rec: FrameRecord): Det[] {
  const s = room.imageWidth / fix.imageWidth;
  const out: Det[] = [];
  fix.detections.forEach((d, i) => {
    const [x, y, w, h] = d.box;
    const corners = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ].map(([u, v]) => worldToPixel(room.imageToWorld(u * s, v * s), rec.intrinsics, rec.cam));
    if (corners.some((c) => !c)) return;
    const us = corners.map((c) => c!.u);
    const vs = corners.map((c) => c!.v);
    const x0 = Math.min(...us);
    const x1 = Math.max(...us);
    const y0 = Math.min(...vs);
    const y1 = Math.max(...vs);
    const cx0 = Math.max(0, x0);
    const cy0 = Math.max(0, y0);
    const cx1 = Math.min(rec.width, x1);
    const cy1 = Math.min(rec.height, y1);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    const visible = ((cx1 - cx0) * (cy1 - cy0)) / ((x1 - x0) * (y1 - y0));
    if (visible < 0.4) return;
    out.push({ detId: `fx${i}`, label: d.label, prompt: d.prompt, score: d.score, box: [cx0, cy0, cx1 - cx0, cy1 - cy0] });
  });
  return out;
}
