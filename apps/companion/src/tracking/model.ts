/** Local review of recorded WebXR telemetry. This does not infer poses from RGB video. */
import { crc32 } from '../../../quest/src/replay/zip';

export interface Vec3 { x: number; y: number; z: number }
export interface Quat extends Vec3 { w: number }
export interface Pose { position: Vec3; orientation: Quat }
export interface Joint extends Pose { radius: number }
export const JOINT_NAMES = [
  'wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  ...['index', 'middle', 'ring', 'pinky'].flatMap((finger) => [
    `${finger}-finger-metacarpal`, `${finger}-finger-phalanx-proximal`, `${finger}-finger-phalanx-intermediate`,
    `${finger}-finger-phalanx-distal`, `${finger}-finger-tip`,
  ]),
] as readonly string[];
export type JointName = string;
export const HAND_BONES: readonly (readonly [JointName, JointName])[] = [
  ...[JOINT_NAMES.slice(1, 5), JOINT_NAMES.slice(5, 10), JOINT_NAMES.slice(10, 15), JOINT_NAMES.slice(15, 20), JOINT_NAMES.slice(20, 25)]
    .flatMap((finger) => [['wrist', finger[0]] as const, ...finger.slice(1).map((name, i) => [finger[i], name] as const)]),
];
export interface Hand { source: 'hand' | 'controller' | 'untracked'; joints: Partial<Record<JointName, Joint>>; pinching: boolean }
export interface TrackingSample { t: number; head: Pose | null; hands: { left: Hand; right: Hand }; spaceId: number }
export interface Intrinsics { width: number; height: number; fx: number; fy: number; cx: number; cy: number }
export type TrackingSource = 'webxr' | 'emulator' | 'synthetic-demo' | 'unknown';
export interface TrackingVideo {
  file: string; mimeType: string; width: number; height: number; startOffsetMs: number;
  durationMs?: number; alignment: 'approximate' | 'unknown'; cameraExtrinsics?: 'uncalibrated';
}
export interface TrackingMeta {
  take: string; startedAt: number; app: string; device: { kind: string; name: string }; space: string;
  tracking?: { source: TrackingSource; sampleRateHz: number; jointConvention: string; units: string; axes: string };
  camera?: Intrinsics; video?: TrackingVideo; notes?: string;
}
export interface TrackingEvent { t: number; type: string; label: string; data?: Record<string, string | number | boolean> }
export interface TrackingTake {
  meta: TrackingMeta; samples: TrackingSample[]; durationMs: number; warnings: string[]; demo: boolean;
  video?: { bytes: Uint8Array; mimeType: string }; events: TrackingEvent[];
}
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_JSONL_BYTES = 48 * 1024 * 1024;
const MAX_DURATION_MS = 3_600_000;
const MAX_SAMPLES = 120_000;
const SAMPLE_HOLD_MS = 100;
const emptyHand = (): Hand => ({ source: 'untracked', joints: {}, pinching: false });
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, fallback = ''): string => typeof v === 'string' ? v.slice(0, 256) : fallback;
const validTime = (v: unknown): v is number => finite(v) && v >= 0 && v <= MAX_DURATION_MS;
function vector(v: unknown): Vec3 | null {
  const p = object(v);
  return p && finite(p.x) && finite(p.y) && finite(p.z) && Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) <= 10_000
    ? { x: p.x, y: p.y, z: p.z } : null;
}
function pose(v: unknown): Pose | null {
  const p = object(v), position = vector(p?.position), q = object(p?.orientation);
  if (!position || !q || !finite(q.x) || !finite(q.y) || !finite(q.z) || !finite(q.w)) return null;
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (norm < 0.5 || norm > 1.5) return null;
  return { position, orientation: { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm } };
}
function hand(v: unknown): Hand {
  const h = object(v);
  if (!h || (h.source !== 'hand' && h.source !== 'controller')) return emptyHand();
  const out: Hand = { source: h.source, joints: {}, pinching: h.pinching === true };
  // A controller pose cannot stand in for a tracked hand skeleton.
  if (h.source === 'controller') return out;
  const joints = object(h.joints);
  for (const name of JOINT_NAMES) {
    const raw = object(joints?.[name]), p = pose(raw);
    if (p && raw && finite(raw.radius) && raw.radius > 0 && raw.radius <= 0.2) out.joints[name] = { ...p, radius: raw.radius };
  }
  if (!Object.keys(out.joints).length) out.source = 'untracked';
  return out;
}
function intrinsics(v: unknown): Intrinsics | undefined {
  const k = object(v);
  if (!k || !['width', 'height', 'fx', 'fy', 'cx', 'cy'].every((key) => finite(k[key]))) return;
  if ((k.width as number) <= 0 || (k.height as number) <= 0 || (k.fx as number) <= 0 || (k.fy as number) <= 0) return;
  return { width: k.width as number, height: k.height as number, fx: k.fx as number, fy: k.fy as number, cx: k.cx as number, cy: k.cy as number };
}
function videoMetadata(v: unknown): TrackingVideo | undefined {
  const m = object(v);
  if (!m || typeof m.file !== 'string' || !safePath(m.file) || !/\.(webm|mp4)$/i.test(m.file)
    || !finite(m.startOffsetMs) || Math.abs(m.startOffsetMs) > MAX_DURATION_MS || !finite(m.width) || !finite(m.height) || m.width <= 0 || m.height <= 0) return;
  return { file: m.file, mimeType: m.file.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/webm',
    width: m.width, height: m.height, startOffsetMs: m.startOffsetMs,
    ...(validTime(m.durationMs) ? { durationMs: m.durationMs } : {}), alignment: m.alignment === 'approximate' ? 'approximate' : 'unknown', cameraExtrinsics: 'uncalibrated' };
}

/** Accept only known telemetry, not commands to execute. Legacy head-only takes remain readable. */
export function parseTrackingJsonl(source: string): TrackingTake {
  if (source.length > MAX_JSONL_BYTES) throw new Error('Telemetry is too large (48 MB maximum).');
  const rows = source.split(/\r?\n/);
  if (rows.length > 300_000) throw new Error('Telemetry contains too many rows.');
  let meta: TrackingMeta | undefined, duration = 0, declaredDuration = 0, invalid = 0, lostHead = 0, lastSpace = 0;
  const samples: TrackingSample[] = [], warnings: string[] = [], events: TrackingEvent[] = [];
  for (let line = 0; line < rows.length; line++) {
    if (!rows[line].trim()) continue;
    let r: Record<string, unknown> | null;
    try { r = object(JSON.parse(rows[line])); } catch { throw new Error(`Invalid JSON on telemetry line ${line + 1}.`); }
    if (!r) { invalid++; continue; }
    if (r.kind === 'meta') {
      if (meta) throw new Error('Telemetry has more than one metadata header.');
      if (r.v !== 1) throw new Error('Unsupported telemetry version. Expected a Quest v1 take.');
      const dev = object(r.device), tr = object(r.tracking);
      const trackSource: TrackingSource = ['webxr', 'emulator', 'synthetic-demo'].includes(String(tr?.source)) ? tr!.source as TrackingSource : 'unknown';
      if (tr && (tr.units !== 'meters' || tr.jointConvention !== 'webxr-hand-25' || tr.axes !== 'right-handed-y-up-negative-z-forward')) {
        throw new Error('Unsupported tracking coordinates. Expected WebXR 25 joints, meters, and right-handed Y-up / -Z forward.');
      }
      const space = text(r.space, 'unknown');
      if (space !== 'local-floor' && space !== 'local') throw new Error('Unsupported tracking reference space.');
      meta = { take: text(r.take, 'Imported take'), startedAt: finite(r.startedAt) ? r.startedAt : 0, app: text(r.app, 'unknown'),
        device: { kind: text(dev?.kind, 'unknown'), name: text(dev?.name, 'Unknown device') }, space,
        ...(tr ? { tracking: { source: trackSource, sampleRateHz: finite(tr.sampleRateHz) ? tr.sampleRateHz : 0,
          jointConvention: 'webxr-hand-25', units: 'meters', axes: 'right-handed-y-up-negative-z-forward' } } : {}),
        camera: intrinsics(r.camera), video: videoMetadata(r.video), notes: text(r.notes) };
      if (r.video && !meta.video) warnings.push('Video metadata is invalid; attach the original video and set its offset manually.');
      if (validTime(r.durationMs)) declaredDuration = r.durationMs;
      if (Array.isArray(r.recordingWarnings)) warnings.push(...r.recordingWarnings.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 512)));
      continue;
    }
    if (!validTime(r.t)) { invalid++; continue; }
    duration = Math.max(duration, r.t);
    if (r.kind === 'pose') {
      if (samples.length >= MAX_SAMPLES) throw new Error('Telemetry contains too many pose samples.');
      const h = object(r.hands), head = pose(r.head);
      if (r.head !== null && !head) lostHead++;
      const spaceId = Number.isSafeInteger(r.spaceId) && (r.spaceId as number) >= 0 ? r.spaceId as number : lastSpace;
      samples.push({ t: r.t, head, hands: { left: hand(h?.left), right: hand(h?.right) }, spaceId });
      lastSpace = spaceId;
    } else if (r.kind === 'input') {
      const input = object(r.input), type = text(input?.type);
      if (type === 'space' && Number.isSafeInteger(input?.spaceId) && (input?.spaceId as number) >= 0) lastSpace = input!.spaceId as number;
      else if (['xr', 'reference-space-reset', 'space-reset'].includes(type)) lastSpace++;
      if (type) {
        const data = safeEventData(input);
        events.push({ t: r.t, type, label: text(input?.label, type), ...(Object.keys(data).length ? { data } : {}) });
      }
    } else if (r.kind === 'event') {
      const type = text(r.type);
      if (type) events.push({ t: r.t, type, label: text(r.label, type), data: safeEventData(object(r.data)) });
    } else {
      const msg = object(r.msg), p = object(msg?.payload);
      if (msg?.type === 'exec.command' || msg?.type === 'exec.ack') events.push({ t: r.t, type: msg.type,
        label: msg.type === 'exec.command' ? 'Command requested' : p?.ok === true ? 'Transport acknowledged' : 'Transport failed', data: safeEventData(p) });
    }
  }
  if (!meta) throw new Error('Telemetry is missing its metadata header.');
  if (!samples.length) throw new Error('This take has no head or hand pose samples.');
  samples.sort((a, b) => a.t - b.t);
  events.sort((a, b) => a.t - b.t);
  // Keep the last observation when two samples share the same clock tick.
  const unique = samples.filter((s, i) => samples[i + 1]?.t !== s.t);
  if (invalid) warnings.push(`${invalid} unsupported or invalid telemetry rows were skipped.`);
  if (lostHead) warnings.push(`${lostHead} invalid head poses were marked untracked.`);
  if (!meta.tracking) warnings.push('Legacy head-only recording: hand tracking provenance was not recorded.');
  if (!unique.some((s) => Object.keys(s.hands.left.joints).length || Object.keys(s.hands.right.joints).length)) warnings.push('This recording has no tracked hand joints.');
  if (meta.video) warnings.push('Video and telemetry use approximate clock alignment; the passthrough camera-to-head transform is not calibrated.');
  return { meta, samples: unique, durationMs: Math.max(duration, declaredDuration), warnings, demo: meta.tracking?.source === 'synthetic-demo', events };
}

function safeEventData(input: Record<string, unknown> | null): Record<string, string | number | boolean> {
  const data: Record<string, string | number | boolean> = {};
  // No raw envelope, authentication, voice prompt, serial command, or MIDI bytes leave this reviewer.
  for (const key of ['execId', 'actionId', 'cardId', 'driverId', 'targetId', 'armId', 'hand', 'how', 'mode', 'value', 'on', 'approve', 'ok', 'dryRun', 'latencyMs']) {
    const v = input?.[key];
    if (typeof v === 'string') data[key] = v.slice(0, 128);
    else if (typeof v === 'boolean' || finite(v)) data[key] = v;
  }
  if (Number.isSafeInteger(input?.spaceId) && (input?.spaceId as number) >= 0) data.spaceId = input!.spaceId as number;
  if (['xr-start', 'xr-end', 'reference-reset', 'reference-change'].includes(String(input?.reason))) data.reason = input!.reason as string;
  return data;
}

const safePath = (name: string): boolean => !!name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').some((p) => p === '..' || p === '.' || p === '');
interface ZipPart { name: string; method: number; size: number; crc: number; data: Uint8Array }
/** Scan sizes and bounds before allocating or inflating. Ignore image entries, but still validate their bounds. */
function zipDirectory(bytes: Uint8Array): ZipPart[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (at: number, n: number) => { if (at < 0 || at + n > bytes.length) throw new Error('Truncated ZIP archive.'); };
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65_557); p--) {
    if (v.getUint32(p, true) === 0x06054b50 && p + 22 + v.getUint16(p + 20, true) === bytes.length) { end = p; break; }
  }
  if (end < 0) throw new Error('This is not a supported ZIP archive.');
  const count = v.getUint16(end + 10, true);
  if (count > 4096 || v.getUint16(end + 4, true) || v.getUint16(end + 6, true)) throw new Error('Split or oversized ZIP archives are not supported.');
  let at = v.getUint32(end + 16, true), total = 0;
  const parts: ZipPart[] = [], names = new Set<string>();
  for (let i = 0; i < count; i++) {
    check(at, 46);
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true), crc = v.getUint32(at + 16, true);
    const compressed = v.getUint32(at + 20, true), size = v.getUint32(at + 24, true), nameLen = v.getUint16(at + 28, true);
    const entryLen = 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true), local = v.getUint32(at + 42, true);
    check(at, entryLen); check(local, 30);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += entryLen;
    if (flags & 1) throw new Error('Encrypted ZIP files are not supported.');
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error('Invalid ZIP entry.');
    if (name.endsWith('/')) continue;
    if (!safePath(name) || names.has(name)) throw new Error('ZIP contains an invalid or duplicate file path.');
    names.add(name);
    total += size;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('Expanded recording exceeds the 128 MB limit.');
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    check(start, compressed);
    if (method === 0 && size !== compressed) throw new Error('Invalid ZIP file size.');
    if (/(^|\/)session\.jsonl$|\.(webm|mp4)$/i.test(name)) parts.push({ name, method, size, crc, data: bytes.subarray(start, start + compressed) });
  }
  return parts;
}
async function unpack(part: ZipPart, max: number): Promise<Uint8Array> {
  if (part.size > max) throw new Error(`Recording file ${part.name} is too large.`);
  let out: Uint8Array;
  if (part.method === 0) out = part.data.slice();
  else if (part.method === 8) {
    const stream = new Blob([part.data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.length;
        if (size > max || size > part.size) { await reader.cancel(); throw new Error('Expanded recording exceeds its declared size.'); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    out = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  } else throw new Error('Unsupported ZIP compression. Use STORE or DEFLATE.');
  if (out.length !== part.size || crc32(out) !== part.crc) throw new Error('Recording ZIP checksum failed.');
  return out;
}

export async function loadTrackingBytes(bytes: Uint8Array, filename: string): Promise<TrackingTake> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Recording is too large (128 MB maximum).');
  if (!/\.zip$/i.test(filename)) {
    if (!/\.(jsonl|ndjson)$/i.test(filename)) throw new Error('Choose a Quest take ZIP or telemetry JSONL file.');
    if (bytes.length > MAX_JSONL_BYTES) throw new Error('Telemetry is too large (48 MB maximum).');
    return parseTrackingJsonl(new TextDecoder().decode(bytes));
  }
  const entries = zipDirectory(bytes), sessions = entries.filter((e) => /(^|\/)session\.jsonl$/.test(e.name));
  if (sessions.length !== 1) throw new Error('Choose a ZIP with exactly one session.jsonl recording.');
  const session = sessions[0], take = parseTrackingJsonl(new TextDecoder().decode(await unpack(session, MAX_JSONL_BYTES)));
  const video = take.meta.video;
  if (video) {
    const prefix = session.name.slice(0, -'session.jsonl'.length), entry = entries.find((e) => e.name === prefix + video.file);
    if (entry) take.video = { bytes: await unpack(entry, MAX_ARCHIVE_BYTES), mimeType: video.mimeType };
    else take.warnings.push('The referenced video is missing from this ZIP; telemetry remains available.');
  }
  return take;
}
export async function loadTrackingFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<TrackingTake> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('Recording is too large (128 MB maximum).');
  return loadTrackingBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** Last actual sample, held for at most 100 ms. Never interpolate a missing joint or a space reset. */
export function sampleAt(take: TrackingTake, t: number, maxGapMs = SAMPLE_HOLD_MS): TrackingSample | null {
  if (!finite(t) || t < 0 || t > take.durationMs) return null;
  const samples = take.samples; let lo = 0, hi = samples.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].t <= t) lo = mid + 1; else hi = mid; }
  const sample = samples[lo - 1];
  if (!sample || t - sample.t > Math.max(0, Math.min(SAMPLE_HOLD_MS, maxGapMs))) return null;
  // Older recordings may mark an XR transition without recording an immediate null pose.
  lo = 0; hi = take.events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (take.events[mid].t <= t) lo = mid + 1; else hi = mid; }
  for (let i = lo - 1; i >= 0 && take.events[i].t >= sample.t; i--) {
    const event = take.events[i];
    if (isBoundary(event) && (event.t > sample.t || (event.type === 'space' && event.data?.spaceId !== undefined && event.data.spaceId !== sample.spaceId))) return null;
  }
  return sample;
}
const isBoundary = (event: TrackingEvent) => ['space', 'xr', 'reference-space-reset', 'space-reset'].includes(event.type);
export function trackingStats(take: TrackingTake): { samples: number; durationMs: number; headCoverage: number; leftCoverage: number; rightCoverage: number; rateHz: number; spaces: number } {
  let head = 0, left = 0, right = 0, intervals = 0, elapsed = 0;
  const spaces = new Set<number>(), boundaries = take.events.filter(isBoundary);
  let boundaryIndex = 0;
  for (let i = 0; i < take.samples.length; i++) {
    const s = take.samples[i], next = take.samples[i + 1]; spaces.add(s.spaceId);
    while (boundaries[boundaryIndex]?.t <= s.t) boundaryIndex++;
    const dt = Math.max(0, Math.min(SAMPLE_HOLD_MS, (next?.t ?? take.durationMs) - s.t, (boundaries[boundaryIndex]?.t ?? take.durationMs) - s.t));
    if (s.head) head += dt;
    if (s.hands.left.source === 'hand' && Object.keys(s.hands.left.joints).length) left += dt;
    if (s.hands.right.source === 'hand' && Object.keys(s.hands.right.joints).length) right += dt;
    if (next && next.spaceId === s.spaceId && next.t - s.t > 0 && next.t - s.t <= SAMPLE_HOLD_MS) { intervals++; elapsed += next.t - s.t; }
  }
  const duration = Math.max(1, take.durationMs);
  return { samples: take.samples.length, durationMs: take.durationMs, headCoverage: head / duration, leftCoverage: left / duration,
    rightCoverage: right / duration, rateHz: elapsed ? intervals * 1000 / elapsed : 0, spaces: spaces.size };
}

function rotate(p: Vec3, q: Quat): Vec3 {
  const tx = 2 * (q.y * p.z - q.z * p.y), ty = 2 * (q.z * p.x - q.x * p.z), tz = 2 * (q.x * p.y - q.y * p.x);
  return { x: p.x + q.w * tx + q.y * tz - q.z * ty, y: p.y + q.w * ty + q.z * tx - q.x * tz, z: p.z + q.w * tz + q.x * ty - q.y * tx };
}
/** WebXR world → viewer coordinates: inverse viewer rotation after translation, forward is -Z. */
export function worldToHead(point: Vec3, head: Pose): Vec3 {
  const q = head.orientation;
  return rotate({ x: point.x - head.position.x, y: point.y - head.position.y, z: point.z - head.position.z }, { x: -q.x, y: -q.y, z: -q.z, w: q.w });
}
/** Illustrative pinhole projection only; camera extrinsics must be calibrated for an RGB overlay. */
export function projectPoint(point: Vec3, head: Pose, camera: Intrinsics): { x: number; y: number; depth: number } | null {
  const p = worldToHead(point, head), depth = -p.z;
  if (depth < 0.01) return null;
  return { x: camera.cx + camera.fx * p.x / depth, y: camera.cy - camera.fy * p.y / depth, depth };
}

/** A clearly labelled visual fixture, never a captured demonstration or training accuracy claim. */
export function createDemoTake(): TrackingTake {
  const samples: TrackingSample[] = [], q: Quat = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i <= 240; i++) {
    const t = i * 1000 / 30, phase = t / 1000, yaw = Math.sin(phase * 0.5) * 0.18;
    const head: Pose = { position: { x: Math.sin(phase * 0.5) * 0.05, y: 1.62, z: 0 }, orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) } };
    const make = (side: -1 | 1): Hand => {
      if (side === -1 && t >= 3200 && t < 3700) return emptyHand();
      const h: Hand = { source: 'hand', joints: {}, pinching: side === 1 && Math.sin(phase * 1.7) > 0.5 };
      const wrist = { x: side * 0.18 + Math.sin(phase + side) * 0.055, y: 1.26 + Math.sin(phase * 1.7) * 0.07, z: -0.38 };
      h.joints.wrist = { position: wrist, orientation: q, radius: 0.012 };
      const fingers = [JOINT_NAMES.slice(1, 5), JOINT_NAMES.slice(5, 10), JOINT_NAMES.slice(10, 15), JOINT_NAMES.slice(15, 20), JOINT_NAMES.slice(20, 25)];
      fingers.forEach((names, finger) => names.forEach((name, joint) => {
        const across = [-0.055, -0.029, -0.007, 0.016, 0.037][finger] * side;
        const reach = [0.05, 0.09, 0.105, 0.095, 0.075][finger];
        const k = (joint + 1) / names.length, curl = h.pinching && finger <= 1 ? k * 0.045 : 0;
        h.joints[name] = { position: { x: wrist.x + across * (0.5 + k / 2), y: wrist.y + (finger === 0 ? 0.02 : 0.055) + k * reach - curl, z: wrist.z - 0.025 - k * 0.045 + curl }, orientation: q, radius: name.endsWith('tip') ? 0.007 : 0.009 };
      }));
      return h;
    };
    samples.push({ t, head, hands: { left: make(-1), right: make(1) }, spaceId: 1 });
  }
  return { meta: { take: 'Synthetic hand tracking demo', startedAt: 0, app: 'ControlAnything tracking demo', device: { kind: 'synthetic', name: 'Generated example' }, space: 'local-floor',
    tracking: { source: 'synthetic-demo', sampleRateHz: 30, jointConvention: 'webxr-hand-25', units: 'meters', axes: 'right-handed-y-up-negative-z-forward' } },
    samples, durationMs: 8000, warnings: ['Synthetic example only. No headset video or captured training data.', 'The left hand intentionally loses tracking for 0.5 seconds.'], demo: true,
    events: [{ t: 3200, type: 'tracking-gap', label: 'Left hand tracking unavailable (synthetic)' }] };
}

/** Export only validated telemetry and allowlisted interaction metadata; no device execution or credentials. */
export function exportTrackingJsonl(take: TrackingTake, options: { videoOffsetMs?: number } = {}): string {
  const offset = options.videoOffsetMs;
  const video = take.meta.video ? { ...take.meta.video, ...(finite(offset) ? { startOffsetMs: offset } : {}) } : undefined;
  const meta = { kind: 'meta', v: 1, ...take.meta, ...(video ? { video } : {}), durationMs: take.durationMs,
    recordingWarnings: take.warnings, dataset: { format: 'controlanything.tracking/1', poseSource: take.meta.tracking?.source ?? 'unknown',
      synthetic: take.demo, poseUnits: 'meters', timeUnits: 'milliseconds', quaternionOrder: 'xyzw', jointConvention: 'webxr-hand-25',
      quaternionNormalization: 'Finite quaternions are normalized to unit length on import.',
      trackingValidity: 'Missing joints and null head are untracked; samples are not interpolated.',
      videoAlignment: 'Approximate; camera-to-head extrinsics are uncalibrated.',
      actionEvidence: 'Recorded requests and transport acknowledgments do not prove a physical effect.',
      purpose: 'Demonstration review and dataset preparation; accuracy and training usefulness are not validated.' } };
  const rows = [...take.samples.map((s) => ({ kind: 'pose', ...s })), ...take.events.map((e) => ({ kind: 'event', ...e }))].sort((a, b) => a.t - b.t);
  const lines = [JSON.stringify(meta), ...rows.map((r) => JSON.stringify(r))];
  return lines.join('\n') + '\n';
}
