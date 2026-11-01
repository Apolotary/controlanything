/**
 * Protocol v1 as the headset uses it. The wire shapes come from @ce/protocol (owned by brain); this module adds
 * the headset-side helpers: intrinsics WITH the image size, a detection normaliser that accepts the obvious
 * variants (a newer server must not break an older headset build), and the evidence sentence for the HUD.
 */
import type { PayloadOf } from '@ce/protocol';
import { z } from 'zod';

export type ScanFramePayload = PayloadOf<'scan.frame'>;
export type ScanResultPayload = PayloadOf<'scan.result'>;
export type TargetSelectPayload = PayloadOf<'target.select'>;
export type TargetStatusPayload = PayloadOf<'target.status'>;
export type SenseRequestPayload = PayloadOf<'sense.request'>;
export type SenseResultPayload = PayloadOf<'sense.result'>;
export type VerifyResultPayload = PayloadOf<'verify.result'>;
export type VoiceAudioPayload = PayloadOf<'voice.audio'>;
export type VoiceTextPayload = PayloadOf<'voice.text'>;
export type UiSpecPayload = PayloadOf<'ui.spec'>;
export type LinkRequestPayload = PayloadOf<'link.request'>;
export type LinkResultPayload = PayloadOf<'link.result'>;
export type ArmRequestPayload = PayloadOf<'arm.request'>;
export type DriverStatusPayload = PayloadOf<'driver.status'>;

export type FramePurpose = ScanFramePayload['purpose'];
export type CameraSourceKind = NonNullable<NonNullable<ScanFramePayload['camera']>['source']>;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface Pose {
  position: Vec3;
  orientation: Quat;
}

/** Pinhole intrinsics in pixels, for an image of `width` × `height`. */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

// --- detections ------------------------------------------------------------------------------

const num = z.number();
const DetectionReader = z.looseObject({
  detId: z.union([z.string(), z.number()]).transform(String),
  label: z.string().default('device'),
  prompt: z.string().optional(),
  score: num.default(0.5),
  box: z.union([z.array(num).min(4).max(4), z.object({ x: num, y: num, w: num, h: num })]),
  polygon: z.array(z.union([z.array(num).min(2).max(2), z.object({ x: num, y: num })])).optional(),
  cardId: z.string().optional(),
  deviceId: z.string().optional(),
  trackId: z.string().optional(),
});

/** One detection in pixels of the frame that was sent. */
export interface Det {
  detId: string;
  label: string;
  prompt?: string;
  score: number;
  /** [x, y, w, h] px, origin top-left */
  box: [number, number, number, number];
  /** px */
  polygon?: [number, number][];
  cardId?: string;
  deviceId?: string;
  trackId?: string;
}

/**
 * Normalise detections to pixels of the frame we sent. Boxes whose four numbers all lie in [0, 1] are taken as
 * normalised (protocol v1 sends pixels; older/other producers may not). Invalid entries are dropped.
 */
export function normalizeDetections(raw: readonly unknown[], frameW: number, frameH: number): Det[] {
  const out: Det[] = [];
  for (const r of raw) {
    const p = DetectionReader.safeParse(r);
    if (!p.success) continue;
    const d = p.data;
    let [x, y, w, h] = Array.isArray(d.box) ? d.box : [d.box.x, d.box.y, d.box.w, d.box.h];
    const normalised = [x, y, w, h].every((v) => v >= 0 && v <= 1) && frameW > 4 && frameH > 4;
    if (normalised) {
      x *= frameW;
      w *= frameW;
      y *= frameH;
      h *= frameH;
    }
    if (!(w > 0 && h > 0) || ![x, y, w, h].every(Number.isFinite)) continue;
    let polygon: [number, number][] | undefined;
    if (d.polygon?.length) {
      polygon = d.polygon.map((pt) => (Array.isArray(pt) ? [pt[0], pt[1]] : [pt.x, pt.y]) as [number, number]);
      if (normalised && polygon.every(([px, py]) => px >= 0 && px <= 1 && py >= 0 && py <= 1)) {
        polygon = polygon.map(([px, py]) => [px * frameW, py * frameH]);
      }
      if (polygon.length < 3) polygon = undefined;
    }
    const det: Det = { detId: d.detId, label: d.label, score: d.score, box: [x, y, w, h] };
    if (d.prompt) det.prompt = d.prompt;
    if (polygon) det.polygon = polygon;
    if (d.cardId) det.cardId = d.cardId;
    if (d.deviceId) det.deviceId = d.deviceId;
    if (d.trackId) det.trackId = d.trackId;
    out.push(det);
  }
  return out;
}

// --- evidence --------------------------------------------------------------------------------

const EFFECT_WORDS: Record<string, string> = {
  brighter: 'got brighter',
  dimmer: 'got darker',
  warmer: 'got warmer',
  cooler: 'got cooler',
  on: 'turned on',
  off: 'turned off',
  louder: 'got louder',
  quieter: 'got quieter',
  'tone-up': 'got brighter in tone',
  'tone-down': 'got darker in tone',
  any: 'reacted',
};

/** The HUD's oracle strip as a sentence (research/15 §3.7): "sent IR NEC 0x10 → seen 38 % brighter ✓". */
export function evidenceSentence(e: VerifyResultPayload): { sent: string; expect: string; seen: string; verdict: 'ok' | 'fail' } {
  const op = e.sent.op as { kind?: string; msg?: string; number?: number; value?: unknown; protocol?: string; command?: unknown; op?: string };
  let sent = e.actionId;
  if (op?.kind === 'midi') sent = `${String(op.msg ?? 'midi').toUpperCase()}${op.number !== undefined ? ` ${op.number}` : ''}${op.value !== undefined ? ` = ${String(op.value)}` : ''}`;
  else if (op?.kind === 'ir') sent = `IR ${op.protocol ?? ''}${op.command !== undefined ? ` ${String(op.command)}` : ''}`.trim();
  else if (op?.kind === 'local') sent = String(op.op ?? 'local');
  const effect = (e.expected as { effect?: string })?.effect ?? 'any';
  const expect = EFFECT_WORDS[effect] ?? effect;
  const sense = e.observed.sense === 'audio' ? 'heard' : e.observed.sense === 'ack' ? 'wired' : 'seen';
  const pct = e.observed.metric === 'luma-mask-vs-ring' ? ` ${Math.round(Math.abs(e.observed.delta) * 100)} %` : '';
  const seen = e.pass ? `${sense}${pct} ✓` : 'no reaction ✗';
  return { sent, expect, seen, verdict: e.pass ? 'ok' : 'fail' };
}
