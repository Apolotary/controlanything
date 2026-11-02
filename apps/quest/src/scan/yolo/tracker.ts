/**
 * A small multi-object tracker so live boxes do not flicker: greedy IoU matching of each frame's detections
 * to existing tracks (optionally against where each track is PREDICTED to be in the new frame, which the
 * caller derives from the track's world anchor and the new camera pose, so head motion does not break
 * matches), EMA smoothing of the box and score, class votes (a Cardputer that reads "laptop" one frame and
 * "keyboard" the next keeps one label), a short tentative phase and a short coast before a track is dropped.
 * Image-space only and pure: the 3D side lives in live.ts.
 */
import { iou } from './post';
import type { Box } from './prep';

export interface TrackerInput {
  box: Box;
  score: number;
  cls: number;
}

export interface Track {
  id: number;
  /** displayed class: the strongest vote */
  cls: number;
  /** smoothed box, pixels of the latest frame */
  box: Box;
  /** the last raw detection box */
  raw: Box;
  score: number;
  hits: number;
  /** consecutive frames without a match */
  misses: number;
  firstAt: number;
  lastSeenAt: number;
  /** shown to the user (enough hits, or one confident hit) */
  live: boolean;
  votes: Map<number, number>;
}

export interface TrackerOptions {
  /** min IoU to continue a track with the same class / with another class */
  iouSame: number;
  iouOther: number;
  /** box EMA weight of the new detection (1 = no smoothing) */
  alpha: number;
  /** hits before a track is shown, unless one hit scores ≥ instantScore */
  minHits: number;
  instantScore: number;
  /** a track is dropped after this long unseen AND at least minMisses unmatched frames */
  maxMissMs: number;
  minMisses: number;
  maxTracks: number;
}

export const TRACKER_DEFAULTS: TrackerOptions = {
  iouSame: 0.3,
  iouOther: 0.5,
  alpha: 0.55,
  minHits: 2,
  instantScore: 0.6,
  maxMissMs: 700,
  minMisses: 2,
  maxTracks: 12,
};

export interface TrackerUpdate {
  tracks: Track[];
  created: Track[];
  removed: Track[];
}

export class BoxTracker {
  readonly opts: TrackerOptions;
  private readonly tracks = new Map<number, Track>();
  private nextId = 1;

  constructor(opts: Partial<TrackerOptions> = {}) {
    this.opts = { ...TRACKER_DEFAULTS, ...opts };
  }

  list(): Track[] {
    return [...this.tracks.values()];
  }

  get(id: number): Track | undefined {
    return this.tracks.get(id);
  }

  clear(): Track[] {
    const all = this.list();
    this.tracks.clear();
    return all;
  }

  /**
   * One frame of detections. `predict` maps a track to its expected box in THIS frame (or null to use its
   * last box): pass it when the camera moved between frames.
   */
  update(dets: TrackerInput[], now: number, predict?: (t: Track) => Box | null, retainId?: number): TrackerUpdate {
    const o = this.opts;
    const tracks = this.list();
    const prior = new Map<number, Box>();
    for (const t of tracks) prior.set(t.id, predict?.(t) ?? t.box);
    // all candidate pairs above their threshold, best IoU first
    const pairs: { t: Track; d: number; v: number }[] = [];
    for (const t of tracks) {
      const pb = prior.get(t.id)!;
      dets.forEach((det, d) => {
        const v = iou(pb, det.box);
        if (v >= (det.cls === t.cls ? o.iouSame : o.iouOther)) pairs.push({ t, d, v: v + (det.cls === t.cls ? 0.05 : 0) });
      });
    }
    pairs.sort((a, b) => b.v - a.v);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.t.id) || usedD.has(p.d)) continue;
      usedT.add(p.t.id);
      usedD.add(p.d);
      this.continueTrack(p.t, dets[p.d]!, prior.get(p.t.id)!, now);
    }
    const removed: Track[] = [];
    for (const t of tracks) {
      if (usedT.has(t.id)) continue;
      t.misses++;
      // keep coasting where it is predicted to be, so a re-detection still matches
      t.box = prior.get(t.id)!;
      if (t.id === retainId) continue; // the selected device may await a slower SAM result
      if (t.misses >= o.minMisses && now - t.lastSeenAt > o.maxMissMs) {
        this.tracks.delete(t.id);
        removed.push(t);
      } else if (!t.live && t.misses >= 1) {
        // a tentative track that misses its second frame was noise
        this.tracks.delete(t.id);
        removed.push(t);
      }
    }
    const created: Track[] = [];
    dets.forEach((det, d) => {
      if (usedD.has(d) || this.tracks.size >= o.maxTracks) return;
      const t: Track = {
        id: this.nextId++,
        cls: det.cls,
        box: [...det.box],
        raw: [...det.box],
        score: det.score,
        hits: 1,
        misses: 0,
        firstAt: now,
        lastSeenAt: now,
        live: det.score >= o.instantScore || o.minHits <= 1,
        votes: new Map([[det.cls, det.score]]),
      };
      this.tracks.set(t.id, t);
      created.push(t);
    });
    return { tracks: this.list(), created, removed };
  }

  private continueTrack(t: Track, det: TrackerInput, prior: Box, now: number): void {
    const a = this.opts.alpha;
    t.box = [0, 1, 2, 3].map((i) => prior[i]! + (det.box[i]! - prior[i]!) * a) as Box;
    t.raw = [...det.box];
    t.score = t.score + (det.score - t.score) * 0.4;
    t.hits++;
    t.misses = 0;
    t.lastSeenAt = now;
    if (t.hits >= this.opts.minHits) t.live = true;
    for (const [c, v] of t.votes) t.votes.set(c, v * 0.8);
    t.votes.set(det.cls, (t.votes.get(det.cls) ?? 0) + det.score);
    let best = t.cls;
    let bestV = -1;
    for (const [c, v] of t.votes) {
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    // One ambiguous frame should not change the label above a stable device.
    if (best === t.cls || bestV > (t.votes.get(t.cls) ?? 0) * 1.35) t.cls = best;
  }
}
