/**
 * A recorded session ("take"), the format agreed with the sim lane:
 *
 *   <take>/session.jsonl      line 1: {kind:'meta', v:1, take, startedAt, app, device:{kind,name}, camera, space}
 *                             then:   {t, dir:'out'|'in', msg: <the exact protocol envelope>}
 *                                     {t, kind:'pose', head, hands, spaceId}                 (up to 30 Hz)
 *                                     {t, kind:'input', input:{type, ...}}
 *   <take>/frames/<frameId>.jpg   JPEGs moved out of scan.frame (and sense.result.frame): payload.jpeg → payload.jpegFile
 *
 * `t` is milliseconds since the take started. Players skip lines they do not understand.
 */
import type { Envelope } from '../io/ws';
import { fromBase64, toBase64 } from '../scan/base64';
import { unzip } from './zip';

export interface TakeMeta {
  kind: 'meta';
  v: 1;
  take: string;
  startedAt: number;
  app: string;
  device: { kind: string; name: string };
  camera: { width: number; height: number; fx: number; fy: number; cx: number; cy: number };
  space: 'local-floor';
  notes?: string;
  /** Optional additions to v1: older takes remain readable. */
  tracking?: {
    source: 'webxr' | 'emulator';
    sampleRateHz: 30;
    jointConvention: 'webxr-hand-25';
    units: 'meters';
    axes: 'right-handed-y-up-negative-z-forward';
  };
  video?: RecordedVideo;
  durationMs?: number;
  recordingWarnings?: string[];
}

export interface RecordedVideo {
  file: 'video.webm' | 'video.mp4';
  mimeType: string;
  width: number;
  height: number;
  /** Time of MediaRecorder.start relative to the take. This is NOT exposure synchronization. */
  startOffsetMs: number;
  durationMs: number;
  clock: 'performance';
  alignment: 'approximate';
  cameraExtrinsics: 'uncalibrated';
}
export interface RecordedPose {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}
export interface RecordedJoint extends RecordedPose { radius: number }
export interface RecordedHand {
  source: 'hand' | 'controller' | 'untracked';
  joints: Partial<Record<string, RecordedJoint>>;
  pinching: boolean;
}


export interface MsgLine {
  t: number;
  dir: 'out' | 'in';
  msg: Envelope;
}
export interface PoseLine {
  t: number;
  kind: 'pose';
  head: RecordedPose | null;
  hands?: { left: RecordedHand; right: RecordedHand };
  /** New XR session or reference-space reset increments this; never interpolate across it. */
  spaceId?: number;
}
export interface InputLine {
  t: number;
  kind: 'input';
  input: { type: string; [k: string]: unknown };
}
export type TakeLine = MsgLine | PoseLine | InputLine;

export interface Take {
  meta: TakeMeta;
  lines: TakeLine[];
  /** frames/<frameId>.jpg → JPEG bytes (or a URL to fetch lazily) */
  frames: Map<string, Uint8Array | string>;
  /** Optional synchronized camera recording, bytes from a ZIP or URL beside session.jsonl. */
  video?: Uint8Array | string;
}

export const isMsg = (l: TakeLine): l is MsgLine => 'dir' in l;
export const isPose = (l: TakeLine): l is PoseLine => (l as PoseLine).kind === 'pose';
export const isInput = (l: TakeLine): l is InputLine => (l as InputLine).kind === 'input';

/** Move a frame's base64 JPEG out of a payload. Returns the cleaned payload (a copy) and the extracted bytes. */
export function extractJpeg(env: Envelope): { msg: Envelope; files: [string, string][] } {
  const files: [string, string][] = [];
  const p = env.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return { msg: env, files };
  const strip = (frame: Record<string, unknown>): Record<string, unknown> => {
    if (typeof frame.jpeg !== 'string' || typeof frame.frameId !== 'string') return frame;
    const file = `frames/${frame.frameId}.jpg`;
    files.push([file, frame.jpeg]);
    const { jpeg: _drop, ...rest } = frame;
    return { ...rest, jpegFile: file };
  };
  if (env.type === 'scan.frame') return { msg: { ...env, payload: strip(p) }, files };
  if (env.type === 'sense.result' && p.frame && typeof p.frame === 'object') {
    return { msg: { ...env, payload: { ...p, frame: strip(p.frame as Record<string, unknown>) } }, files };
  }
  return { msg: env, files };
}

/** Put a frame's JPEG back (for re-sending a recorded message). */
export async function restoreJpeg(env: Envelope, take: Take, base?: string): Promise<Envelope> {
  const put = async (frame: Record<string, unknown>) => {
    const file = frame.jpegFile;
    if (typeof file !== 'string') return frame;
    const bytes = await frameBytes(take, file, base);
    const { jpegFile: _f, ...rest } = frame;
    return { ...rest, jpeg: bytes ? toBase64(bytes) : '' };
  };
  const p = env.payload as Record<string, unknown>;
  if (env.type === 'scan.frame') return { ...env, payload: await put(p) };
  if (env.type === 'sense.result' && p?.frame) return { ...env, payload: { ...p, frame: await put(p.frame as Record<string, unknown>) } };
  return env;
}

export async function frameBytes(take: Take, file: string, base?: string): Promise<Uint8Array | null> {
  const f = take.frames.get(file);
  if (f instanceof Uint8Array) return f;
  const url = typeof f === 'string' ? f : base ? new URL(file, base).toString() : null;
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  take.frames.set(file, bytes);
  return bytes;
}

export function parseJsonl(text: string): { meta: TakeMeta; lines: TakeLine[] } {
  const rows = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const meta = rows.find((r) => r.kind === 'meta') as TakeMeta | undefined;
  if (!meta) throw new Error('session.jsonl has no meta line');
  const lines = rows.filter((r) => r.kind !== 'meta' && typeof r.t === 'number') as unknown as TakeLine[];
  lines.sort((a, b) => a.t - b.t);
  return { meta, lines };
}

/** Load a take from a .zip URL/bytes or a session.jsonl URL (frames fetched lazily next to it). */
export async function loadTake(src: string | Uint8Array): Promise<Take> {
  if (typeof src !== 'string' || /\.zip(\?|$)/i.test(src)) {
    const bytes = typeof src === 'string' ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : src;
    const entries = await unzip(bytes);
    const jsonl = entries.find((e) => e.name.endsWith('session.jsonl'));
    if (!jsonl) throw new Error('zip has no session.jsonl');
    const prefix = jsonl.name.slice(0, -'session.jsonl'.length);
    const { meta, lines } = parseJsonl(new TextDecoder().decode(jsonl.data));
    const frames = new Map<string, Uint8Array | string>();
    for (const e of entries) if (e.name.startsWith(`${prefix}frames/`)) frames.set(e.name.slice(prefix.length), e.data);
    const video = meta.video ? entries.find((e) => e.name === `${prefix}${meta.video!.file}`)?.data : undefined;
    return { meta, lines, frames, ...(video ? { video } : {}) };
  }
  const res = await fetch(src);
  if (!res.ok) throw new Error(`take ${src}: HTTP ${res.status}`);
  const { meta, lines } = parseJsonl(await res.text());
  const base = new URL(src, location.href).toString();
  const frames = new Map<string, Uint8Array | string>();
  for (const l of lines) {
    if (!isMsg(l)) continue;
    const p = l.msg.payload as Record<string, unknown>;
    const file = (p?.jpegFile ?? (p?.frame as Record<string, unknown> | undefined)?.jpegFile) as string | undefined;
    if (file) frames.set(file, new URL(file, base).toString());
  }
  return { meta, lines, frames, ...(meta.video ? { video: new URL(meta.video.file, base).toString() } : {}) };
}

export function decodeFrame(b64: string): Uint8Array {
  return fromBase64(b64);
}
