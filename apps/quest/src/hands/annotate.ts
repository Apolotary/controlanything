/**
 * Annotate on the webcam / phone: the Quest's SCAN layer without a headset. A camera frame goes to the server as
 * scan.frame (SAM 3.1 is the only detector, same server path and filter as the Quest's wrist filter), at most one
 * in flight and at least 1.3 s apart; scan.result outlines are kept in camera-image coordinates (0..1) and drawn by
 * the overlay. Tagging sends tag.add with that frame and detection, and the page stays in Annotate.
 * Tags remember their last box: on a webcam (a camera that does not move) that box is where the object is.
 */
import { newId, type ScanResultPayload, type TaggedDevice } from '@ce/protocol';

export type Filter = 'electronics' | 'objects' | 'everything';
export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'electronics', label: 'Electronics' }, { id: 'objects', label: 'Objects' }, { id: 'everything', label: 'All' },
];

export interface Detection {
  frameId: string; detId: string; label: string; score: number;
  /** camera-image box, 0..1 */
  x: number; y: number; w: number; h: number;
  /** camera-image outline, 0..1 */
  polygon?: [number, number][];
  cardId?: string; trackId?: string;
  at: number;
}

export interface Tag {
  cardId: string; label: string; name?: string;
  /** last known camera-image box (0..1) */
  box?: { x: number; y: number; w: number; h: number; polygon?: [number, number][] };
  connection?: TaggedDevice['connection']; hint?: string;
}

export interface FrameSource {
  /** a camera frame as a canvas (unmirrored), or null when none is ready */
  grab(): HTMLCanvasElement | null;
}

export class Annotator {
  filter: Filter = 'electronics';
  detections: Detection[] = [];
  readonly tags = new Map<string, Tag>();
  active = false;
  private inFlight?: { frameId: string; at: number };
  private lastSent = -Infinity;
  readonly stats = { sent: 0, results: 0, detections: 0, lastLatencyMs: 0, modelId: '', source: '' };
  private readonly encoder = document.createElement('canvas');

  constructor(private readonly send: (frame: { frameId: string; jpeg: string; width: number; height: number; capturedAt: number }, filter: Filter) => boolean) {}

  /** Once per animation frame. */
  tick(now: number, source: FrameSource): void {
    if (!this.active) return;
    if (this.inFlight && now - this.inFlight.at > 9000) this.inFlight = undefined; // a lost result never blocks scanning
    if (this.inFlight || now - this.lastSent < 1300) return;
    const canvas = source.grab();
    if (!canvas || !canvas.width) return;
    // at most 1280 px wide (the server's limit and the Quest's camera size)
    const scale = Math.min(1, 1280 / canvas.width);
    let out = canvas;
    if (scale < 1) {
      this.encoder.width = Math.round(canvas.width * scale); this.encoder.height = Math.round(canvas.height * scale);
      this.encoder.getContext('2d')!.drawImage(canvas, 0, 0, this.encoder.width, this.encoder.height);
      out = this.encoder;
    }
    const jpeg = out.toDataURL('image/jpeg', 0.8).split(',')[1];
    if (!jpeg) return;
    const frameId = newId('hf');
    if (!this.send({ frameId, jpeg, width: out.width, height: out.height, capturedAt: Date.now() }, this.filter)) return;
    this.inFlight = { frameId, at: now }; this.lastSent = now; this.stats.sent++;
  }

  onResult(p: ScanResultPayload): void {
    if (this.inFlight?.frameId === p.frameId) this.inFlight = undefined;
    this.stats.results++; this.stats.lastLatencyMs = p.latencyMs; this.stats.modelId = p.modelId; this.stats.source = p.source;
    const now = performance.now();
    this.detections = p.detections.map((d) => ({
      frameId: p.frameId, detId: d.detId, label: d.label, score: d.score,
      x: d.box[0] / p.width, y: d.box[1] / p.height, w: d.box[2] / p.width, h: d.box[3] / p.height,
      ...(d.polygon && d.polygon.length >= 3 ? { polygon: d.polygon.map(([x, y]) => [x / p.width, y / p.height] as [number, number]) } : {}),
      ...(d.cardId ? { cardId: d.cardId } : {}), ...(d.trackId ? { trackId: d.trackId } : {}), at: now,
    }));
    this.stats.detections = this.detections.length;
    // a tag follows its object: the server matches known targets (cardId); otherwise the same label nearby
    for (const tag of this.tags.values()) {
      const match = this.detections.find((d) => d.cardId === tag.cardId)
        ?? (tag.box ? this.detections.filter((d) => d.label === tag.label).sort((a, b) => dist(a, tag.box!) - dist(b, tag.box!))[0] : undefined);
      if (match && (!tag.box || dist(match, tag.box) < 0.25)) tag.box = { x: match.x, y: match.y, w: match.w, h: match.h, ...(match.polygon ? { polygon: match.polygon } : {}) };
    }
  }

  /** The detection already tagged as this card, if any. */
  tagFor(d: Detection): Tag | undefined {
    if (d.cardId && this.tags.has(d.cardId)) return this.tags.get(d.cardId);
    for (const t of this.tags.values()) if (t.box && t.label === d.label && dist(d, t.box) < 0.06) return t;
    return undefined;
  }

  /** A new local tag for a detection (sent as tag.add by the caller). */
  addTag(d: Detection): Tag {
    const cardId = newId('ht');
    const tag: Tag = { cardId, label: d.label, box: { x: d.x, y: d.y, w: d.w, h: d.h, ...(d.polygon ? { polygon: d.polygon } : {}) } };
    this.tags.set(cardId, tag);
    return tag;
  }

  /** The server's list is the truth: names, connection hints; tags removed elsewhere disappear here too. */
  syncTags(list: TaggedDevice[]): void {
    const seen = new Set<string>();
    for (const t of list) {
      seen.add(t.cardId);
      const local = this.tags.get(t.cardId);
      if (local) Object.assign(local, { label: t.label, ...(t.name ? { name: t.name } : {}), connection: t.connection, ...(t.hint ? { hint: t.hint } : {}) });
      else this.tags.set(t.cardId, { cardId: t.cardId, label: t.label, ...(t.name ? { name: t.name } : {}), connection: t.connection, ...(t.hint ? { hint: t.hint } : {}) });
    }
    for (const id of [...this.tags.keys()]) if (!seen.has(id) && !this.pending.has(id)) this.tags.delete(id);
    for (const id of seen) this.pending.delete(id);
  }
  /** tags sent but not yet in the server's list */
  readonly pending = new Set<string>();
}

const dist = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
