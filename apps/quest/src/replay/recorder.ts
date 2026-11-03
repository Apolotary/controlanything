/** Bounded, opt-in take capture: protocol events, camera frames, video and WebXR telemetry. */
import type { Envelope } from '../io/ws';
import { fromBase64 } from '../scan/base64';
import { extractJpeg, type InputLine, type RecordedHand, type RecordedPose, type RecordedVideo, type TakeLine, type TakeMeta } from './take';
import { type ZipEntry, zipStore } from './zip';

export const TAKE_DURATION_LIMIT_MS = 90_000;
const FRAME_BYTE_LIMIT = 8 * 1024 * 1024;
const JSON_BYTE_LIMIT = 24 * 1024 * 1024;
const JOINT_NAMES = new Set(['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip', ...['index', 'middle', 'ring', 'pinky'].flatMap((finger) => ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((part) => `${finger}-finger-${part}`))]);
type V3 = { x: number; y: number; z: number };
type Q4 = V3 & { w: number };
export interface PoseInput { position: V3; quaternion: Q4 }
export interface HandInput {
  controller?: boolean;
  joints: Partial<Record<string, PoseInput & { radius: number }>>;
  pinching: boolean;
}
const rounded = (n: number) => Math.round(n * 10000) / 10000;
const vec = (p: V3): V3 => ({ x: rounded(p.x), y: rounded(p.y), z: rounded(p.z) });
function poseCopy(pose: PoseInput | null): RecordedPose | null {
  if (!pose) return null;
  const p = pose.position; const q = pose.quaternion;
  if (![p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite) || Math.hypot(q.x, q.y, q.z, q.w) < 0.0001) return null;
  return { position: vec(p), orientation: { ...vec(q), w: rounded(q.w) } };
}
function handCopy(hand?: HandInput): RecordedHand {
  const result: RecordedHand = { source: 'untracked', joints: {}, pinching: false };
  if (!hand) return result;
  if (hand.controller) return { ...result, source: 'controller' };
  for (const [name, joint] of Object.entries(hand.joints)) {
    if (!JOINT_NAMES.has(name) || !joint) continue;
    const pose = poseCopy(joint);
    if (pose && Number.isFinite(joint.radius) && joint.radius > 0 && joint.radius <= 0.1) result.joints[name] = { ...pose, radius: rounded(joint.radius) };
  }
  if (Object.keys(result.joints).length) { result.source = 'hand'; result.pinching = hand.pinching; }
  return result;
}

export class Recorder {
  recording = false;
  /** App finalizes its video after a memory/time bound is reached. */
  onLimit?: (reason: string) => void;
  private meta?: TakeMeta;
  private lines: TakeLine[] = [];
  private frames = new Map<string, string>();
  private video?: Uint8Array;
  private t0 = 0;
  private nextPoseAt = 0;
  private spaceId = 0;
  private jsonBytes = 0;
  private durationTimer?: ReturnType<typeof setTimeout>;
  /** bytes of JPEG kept so far (base64 length × 3/4) */
  frameBytes = 0;

  start(meta: Omit<TakeMeta, 'kind' | 'v' | 'startedAt' | 'take'> & { take?: string }): string {
    if (this.recording) throw new Error('Stop the current take before starting another.');
    const now = new Date();
    const take = meta.take ?? `take-${now.toISOString().replace(/[:.]/g, '-').slice(0, 23)}`;
    this.meta = { kind: 'meta', v: 1, startedAt: now.getTime(), ...meta, take };
    this.lines = []; this.frames.clear(); this.video = undefined;
    this.frameBytes = 0; this.jsonBytes = 0; this.spaceId = 0;
    this.t0 = performance.now(); this.nextPoseAt = 0;
    this.recording = true;
    this.durationTimer = setTimeout(() => this.limit('Take reached the 90 second recording limit.'), TAKE_DURATION_LIMIT_MS);
    return take;
  }

  stop(): void {
    if (this.recording && this.meta) this.meta.durationMs = this.now();
    this.recording = false;
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = undefined;
  }

  get take(): string | undefined { return this.meta?.take; }
  get elapsedMs(): number { return this.recording ? this.now() : this.meta?.durationMs ?? 0; }
  get count(): { lines: number; frames: number } { return { lines: this.lines.length, frames: this.frames.size }; }
  get videoBytes(): number { return this.video?.byteLength ?? 0; }

  warning(reason: string): void {
    if (!this.meta) return;
    const warnings = this.meta.recordingWarnings ??= [];
    if (!warnings.includes(reason)) warnings.push(reason);
  }

  attachVideo(metadata: RecordedVideo, bytes: Uint8Array): void {
    if (this.recording) throw new Error('Stop telemetry before attaching finalized video.');
    if (!this.meta || !bytes.length) return;
    this.meta.video = metadata; this.video = bytes;
  }

  message(dir: 'in' | 'out', env: Envelope): void {
    if (!this.recording) return;
    const { msg, files } = extractJpeg(env);
    let addedBytes = 0;
    for (const [file, b64] of files) addedBytes += Math.round((b64.length * 3) / 4) - Math.round(((this.frames.get(file)?.length ?? 0) * 3) / 4);
    if (this.frameBytes + addedBytes > FRAME_BYTE_LIMIT) { this.limit('Take reached the 8 MB camera-frame limit.'); return; }
    if (!this.append({ t: this.now(), dir, msg })) return;
    for (const [file, b64] of files) this.frames.set(file, b64);
    this.frameBytes += addedBytes;
  }

  /** Call with fresh XR data; null is an explicit tracking loss, never the last known pose. */
  pose(head: PoseInput | null, hands: { left?: HandInput; right?: HandInput } = {}, force = false): void {
    if (!this.recording) return;
    const t = this.now();
    if (!force && t < this.nextPoseAt) return;
    this.nextPoseAt = Math.max(this.nextPoseAt + 1000 / 30, t);
    this.append({ t, kind: 'pose', head: poseCopy(head), hands: { left: handCopy(hands.left), right: handCopy(hands.right) }, spaceId: this.spaceId });
  }

  /** Coordinates from separate spaces cannot form one trajectory. */
  spaceBoundary(reason: 'xr-start' | 'xr-end' | 'reference-reset' | 'reference-change'): void {
    if (!this.recording) return;
    this.spaceId++;
    this.nextPoseAt = 0;
    this.input('space', { spaceId: this.spaceId, reason });
    this.pose(null, {}, true);
  }

  input(type: string, data: Record<string, unknown> = {}): void {
    if (!this.recording) return;
    const line: InputLine = { t: this.now(), kind: 'input', input: { type, ...data } };
    this.append(line);
  }

  jsonl(): string {
    if (!this.meta) return '';
    return [this.meta, ...this.lines].map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  toZip(): Uint8Array {
    if (!this.meta) throw new Error('nothing recorded');
    if (this.recording) throw new Error('Stop recording before saving the take.');
    const take = this.meta.take;
    const entries: ZipEntry[] = [{ name: `${take}/session.jsonl`, data: new TextEncoder().encode(this.jsonl()) }];
    for (const [file, b64] of this.frames) entries.push({ name: `${take}/${file}`, data: fromBase64(b64) });
    if (this.meta.video && this.video) entries.push({ name: `${take}/${this.meta.video.file}`, data: this.video });
    return zipStore(entries);
  }

  download(zip?: Uint8Array): string | null {
    if (!this.meta) return null;
    const blob = new Blob([(zip ?? this.toZip()) as unknown as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${this.meta.take}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return a.download;
  }

  private append(line: TakeLine): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(line)).byteLength + 1;
    if (this.jsonBytes + bytes > JSON_BYTE_LIMIT) { this.limit('Take reached the 24 MB tracking/event limit.'); return false; }
    this.lines.push(line); this.jsonBytes += bytes; return true;
  }
  private limit(reason: string): void {
    if (!this.recording) return;
    this.warning(reason); this.stop(); this.onLimit?.(reason);
  }
  private now(): number { return Math.max(0, Math.round(performance.now() - this.t0)); }
}
