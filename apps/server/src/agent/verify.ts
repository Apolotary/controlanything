/**
 * VERIFY: run each driver action for real, once, and let a sensor decide (SPEC §3.3). Camera: a verify frame
 * before and after (SAM re-finds the target's outline on the before frame), mask-vs-ring luma and R/B ratio,
 * two consecutive confirmations. Audio: feature windows before/after. ack: the executor's acknowledgement.
 * IR from the library: when nothing reacts, the next candidate brand is tried (bounded); an honest miss is
 * expected and reported as evidence with pass=false. Every attempt is a verify.result broadcast.
 */
import type { Driver, DriverAction, Effect, Evidence, ExecAckPayload, ExecOp, Polygon, ScanFramePayload, SenseResultPayload, VerifyState } from '@ce/protocol';
import { newId } from '@ce/protocol';
import { cancellableDelay as sleep, throwIfCancelled } from '../muse/cancellation';
import { MUSICAL_SCALE } from '@ce/vsynth/musical-manifest';
import { isMusicalSynthPort, MUSICAL_SYNTH_MANIFEST } from '../devices/musicalSynth';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';
import { isVisualSynthPort, TOUCH_VERIFY_CENTER, TOUCH_VERIFY_HOVER, touchRoleOfCc } from '../devices/visualSynth';
import { resolveOp } from '../devices/encode';
import type { IrCandidate } from '../devices/profiles';
import { audioEvidence, audioMatches, observeAudio } from '../oracle/audio';
import { cameraEvidence, cameraMatches, observeCamera } from '../oracle/camera';
import { type DecodedImage, decodeJpeg } from '../oracle/image';
import { iou, polygonFor } from '../scan/polygon';
import { decodeMask, type Sam } from '../scan/sam';
import { Dispatcher, ExecError } from './dispatch';
import { clipDurationMs, type HeardResult, TRANSCRIPT_THRESHOLD } from './heard';
import type { RecordedSpeech } from './recordedSpeech';
import type { Target } from './types';

export interface VerifyDeps {
  dispatcher: Dispatcher;
  sam: Sam;
  /** hears a spoken line back (the "say" oracle: Muse Voice Transcribe) */
  heard?: (line: string, wav: Uint8Array, signal?: AbortSignal) => Promise<HeardResult>;
  /** the Mac's current output volume, so a volume probe can put it back afterwards */
  readVolume?: () => Promise<number | undefined>;
  /** Restore a snapshotted Mac volume even after its discovery run was cancelled. */
  restoreVolume?: (volume: number, signal: AbortSignal) => Promise<void>;
  /**
   * CE_MAC_SILENT=1: the Mac does not speak, so a recorded clip of a line stands in for its voice and is what the
   * transcription oracle hears; the evidence names the recording instead of a microphone (recordedSpeech.ts).
   */
  silentSpeech?: (line: string) => RecordedSpeech | undefined;
  log?: (line: string) => void;
  /** wait after an action before the "after" measurement (IR lamps fade ~3 s; the sim is instant) */
  settleMs?: (t: Target, a: DriverAction) => number;
  now?: () => number;
}

export interface VerifyOptions {
  cameraDeviceId?: string;
  micDeviceId?: string;
  /** library candidates to cycle through for an IR driver that got no reaction (in order) */
  irCandidates?: IrCandidate[];
  maxIrCandidates?: number;
  /** actions to verify (default: every action with an expectation other than none) */
  actionIds?: string[];
  signal?: AbortSignal;
  onEvidence?: (e: Evidence) => void;
  onStep?: (title: string, detail?: string) => void;
  /** how many consecutive passes make a pass (default 2) */
  confirmations?: number;
  /** "set" actions: the value to send (default: the range's max on odd attempts, min on even) */
  value?: number;
  /** A requested runtime combo keeps its chosen volume; discovery probes restore it. */
  retainVolume?: boolean;
  /** visual synth: epoch ms after which the camera is skipped and the renderer self-report decides */
  cameraDeadline?: number;
  /** visual synth: set after the first camera miss (too far, off-centre); later actions skip the camera, saying why */
  cameraSkip?: string;
  /** A newer setup/request may retire an aborted verification's independent cleanup. */
  cleanupAllowed?: () => boolean;
}

export interface VerifySummary {
  verification: Record<string, VerifyState>;
  evidence: Evidence[];
  passed: number;
  failed: number;
  /** IR: the candidate brand/channel that worked, if the library path was used */
  irMatch?: IrCandidate;
  driver: Driver;
}

function effectFor(a: DriverAction): Effect {
  return a.expect?.effect ?? 'any';
}

/** Ask the camera for one verify frame. */
async function captureFrame(d: Dispatcher, sensorDeviceId: string, cardId: string, signal?: AbortSignal, timeoutMs = 6000): Promise<{ img: DecodedImage; jpeg: string; width: number; height: number; exposureLocked: boolean; fixtures?: ScanFramePayload['fixtureDetections']; pose?: { position: { x: number; y: number; z: number } } }> {
  const [r] = await d.sense(sensorDeviceId, 'frame', { cardId, signal, timeoutMs });
  if (!r?.frame) throw new ExecError(`no frame from ${sensorDeviceId}${r?.error ? ` (${r.error})` : ''}`, 'device');
  const src = r.frame.camera?.source;
  // absolute luma is only comparable at a fixed exposure: synthetic/replay frames, or a headset that locked it
  return { fixtures: src === 'synthetic' ? r.frame.fixtureDetections : undefined, pose: r.frame.camera?.cameraPose ?? r.frame.pose, img: decodeJpeg(r.frame.jpeg), jpeg: r.frame.jpeg, width: r.frame.width, height: r.frame.height, exposureLocked: src === 'synthetic' || src === 'replay' || r.frame.camera?.exposure === 'locked' };
}

/** Re-find the selected target in a fresh frame before sending a camera-verified command. */
export async function refreshPolygon(sam: Sam, t: Target, jpeg: string, width: number, height: number, signal?: AbortSignal, pose?: { position: { x: number; y: number; z: number } }): Promise<{ polygon: Polygon; fresh: boolean; latencyMs: number; model: string }> {
  throwIfCancelled(signal);
  const det = t.detection;
  // Paired devices selected without a detection use the centre of the camera view.
  if (!det) return { polygon: polygonFor(null, [Math.round(width * 0.25), Math.round(height * 0.25), Math.round(width * 0.5), Math.round(height * 0.5)]), fresh: false, latencyMs: 0, model: 'none' };
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await sam.segment(det.prompt, jpeg, { width, height, pose, signal, label: `sam:verify:${det.prompt}` });
      throwIfCancelled(signal);
      break;
    } catch (e) {
      throwIfCancelled(signal);
      if (attempt === 1) throw new ExecError(`camera check failed twice: ${(e as Error).message}`, 'device');
    }
  }
  let best: { score: number; polygon: Polygon } | undefined;
  for (const rec of r!.records) {
    const box: [number, number, number, number] = [rec.x1, rec.y1, rec.x2 - rec.x1 + 1, rec.y2 - rec.y1 + 1];
    const overlap = iou(box, det.box);
    if (overlap < 0.2) continue;
    const raster = decodeMask(rec);
    const polygon = rec.polygon ?? polygonFor(raster ? { data: raster, width: rec.mask!.width, height: rec.mask!.height, x0: rec.x1, y0: rec.y1 } : null, box);
    if (!best || overlap > best.score) best = { score: overlap, polygon };
  }
  if (!best) throw new ExecError('the camera cannot see the selected device; keep it in view and retry', 'device');
  return { polygon: best.polygon, fresh: true, latencyMs: r!.latencyMs, model: r!.recordedFrom ?? r!.model };
}

async function audioWindow(d: Dispatcher, micDeviceId: string, cardId: string, offsetMs: number | undefined, signal?: AbortSignal): Promise<SenseResultPayload['audio']> {
  const [r] = await d.sense(micDeviceId, 'audio-features', { cardId, durationMs: 600, offsetMs, signal, timeoutMs: 6000 });
  if (!r?.audio) throw new ExecError(`no audio features from ${micDeviceId}${r?.error ? ` (${r.error})` : ''}`, 'device');
  return r.audio;
}

/**
 * The op to send for one verification of an action: set actions go to their max (then min on the second pass), or to `value`.
 * The visual synth's fingertip inputs are verified gently: X and Y at the middle of the canvas, pressure as a soft hover
 * (1..20), never a touch-down splash.
 */
function opFor(a: DriverAction, pass: number, value?: number, visual = false): ExecOp {
  if (a.kind === 'set' && a.encode.kind !== 'step') {
    if (value !== undefined) return resolveOp(a, value);
    const role = visual && a.encode.kind === 'midi' && a.encode.msg === 'cc' ? touchRoleOfCc(a.encode.number) : undefined;
    if (role) return resolveOp(a, role === 'pressure' ? TOUCH_VERIFY_HOVER : TOUCH_VERIFY_CENTER);
    if (a.range) return resolveOp(a, pass % 2 === 0 ? a.range.max : a.range.min);
  }
  return resolveOp(a);
}

/** A repeatable baseline away from the commanded value (a program change goes to another pattern). Touch pressure's baseline is never a touch-down. */
function visualBaseline(op: ExecOp): ExecOp | undefined {
  if (op.kind !== 'midi') return undefined;
  if (op.msg === 'pc' && op.number !== undefined) return { ...op, number: (op.number + 1) % 3 };
  if (op.msg === 'cc' && typeof op.value === 'number') {
    const role = touchRoleOfCc(op.number);
    if (role === 'pressure') return { ...op, value: op.value > 0 ? 0 : TOUCH_VERIFY_HOVER };
    if (role) return { ...op, value: op.value < 64 ? 100 : 28 };
    return { ...op, value: op.value < 64 ? 127 : 0 };
  }
  return undefined;
}

/** The text a local "say" op speaks, if it is one. */
export function spokenLine(op: ExecOp): string | undefined {
  if (op.kind !== 'local' || op.op !== 'say') return undefined;
  if (typeof op.arg === 'string') return op.arg;
  if (op.arg && typeof op.arg === 'object' && 'text' in op.arg) return String((op.arg as Record<string, unknown>).text);
  return undefined;
}

/** The whole visual-synth verification is bounded; past this the camera is skipped and the renderer report decides. */
export const VISUAL_VERIFY_BUDGET_MS = 10_000;
/** One camera frame for the visual synth may take this long before the renderer report decides instead. */
const VISUAL_FRAME_TIMEOUT_MS = 2500;
/** The visual synth's CC → parameter table, read from its manifest (touchX / touchY / touchPressure on CC22-24 included); symmetry is stepped 1..8. */
const VISUAL_CC_PARAM: Record<number, string> = Object.fromEntries(VISUAL_SYNTH_MANIFEST.controls.map((c) => [c.cc, c.parameter]));

/**
 * The visual synth's renderer self-report (exec.ack.applied) as evidence: the commanded value must be the
 * renderer's state after the command. An ok ack without a report still counts, labelled as an acknowledgement only.
 */
export function rendererEvidence(op: ExecOp, ack: ExecAckPayload, camera?: string): { pass: boolean; observed: Evidence['observed']; note: string } {
  const applied = ack.applied;
  const why = camera ? `camera: ${camera}; ` : '';
  let expected: { param: string; value: number } | undefined;
  if (op.kind === 'midi' && op.msg === 'cc' && op.number !== undefined && typeof op.value === 'number' && VISUAL_CC_PARAM[op.number]) {
    const param = VISUAL_CC_PARAM[op.number];
    expected = { param, value: param === 'symmetry' ? 1 + Math.round((op.value / 127) * 7) : op.value / 127 };
  } else if (op.kind === 'midi' && op.msg === 'pc' && op.number !== undefined) expected = { param: 'pattern', value: op.number };
  const got = expected && applied?.params ? applied.params[expected.param] : undefined;
  const base = { sense: 'ack' as const, metric: 'ack' as const, threshold: 1 / 127 };
  if (!ack.ok) return { pass: false, observed: { ...base, before: 0, after: 0, delta: 0, note: 'the Mac refused the command' }, note: 'executor refused' };
  if (!applied || !expected || got === undefined) {
    return { pass: true, observed: { ...base, before: 0, after: 1, delta: 1, note: `${why}Mac acknowledged (no renderer report)`.slice(0, 200) }, note: `Mac acknowledged · ${why}no renderer report`.slice(0, 300) };
  }
  const delta = Math.abs(got - expected.value);
  const pass = delta <= 1 / 127 + 1e-6 && applied.visible !== false;
  const by = applied.source === 'renderer' ? 'verified by renderer' : 'Mac acknowledged (port state, renderer not drawing)';
  const shown = `${expected.param} ${expected.param === 'pattern' || expected.param === 'symmetry' ? got : got.toFixed(2)}`;
  return {
    pass,
    observed: { ...base, before: expected.value, after: got, delta, note: `${why}${by}: ${shown}${applied.visible === false ? ' (renderer hidden)' : ''}${applied.frame !== undefined ? ` · frame ${applied.frame}` : ''}`.slice(0, 200) },
    note: (pass ? `${by}: ${shown}` : `renderer reported ${shown}, expected ${expected.value.toFixed(2)}${applied.visible === false ? ' (renderer hidden)' : ''}`).slice(0, 300),
  };
}

/**
 * Verify one action once. Returns the evidence (pass or fail) or throws ExecError when the plumbing
 * (executor/sensor offline, timeouts) failed, which is not evidence about the device.
 */
export async function verifyOnce(deps: VerifyDeps, t: Target, driver: Driver, a: DriverAction, attempt: number, o: VerifyOptions, polygon?: Polygon): Promise<{ evidence: Evidence; polygon?: Polygon }> {
  throwIfCancelled(o.signal);
  if (a.encode.kind === 'ir' && a.expect?.sense !== 'camera') throw new ExecError('IR actions require camera evidence of the device response', 'refused');
  const volumeProbe = a.encode.kind === 'local' && a.encode.op === 'volume' && !o.retainVolume;
  if (volumeProbe && (!deps.readVolume || (deps.restoreVolume && driver.executor.deviceId !== 'mac-local'))) throw new ExecError('cannot snapshot volume on this executor before verification', 'refused');
  const previousVolume = volumeProbe ? await deps.readVolume!() : undefined;
  throwIfCancelled(o.signal);
  if (volumeProbe && previousVolume === undefined) throw new ExecError('cannot snapshot volume before verification', 'refused');
  try {
    return await observeOnce(deps, t, driver, a, attempt, o, polygon);
  } finally {
    if (previousVolume !== undefined) {
      const cleanup = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { cleanup.abort(); reject(new Error('volume restoration timed out')); }, 4000);
        });
        const restore = deps.restoreVolume
          ? deps.restoreVolume(previousVolume, cleanup.signal)
          : deps.dispatcher.exec(driver.executor.deviceId, { kind: 'local', op: 'volume', arg: previousVolume }, { port: driver.executor.port, cardId: t.cardId, driverId: driver.driverId, actionId: `${a.actionId}:restore`, waitForSlot: true, signal: cleanup.signal, timeoutMs: 4000 });
        await Promise.race([restore, expired]);
      } catch (error) {
        deps.log?.(`[verify] could not restore the volume to ${previousVolume}: ${(error as Error).message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

async function observeOnce(deps: VerifyDeps, t: Target, driver: Driver, a: DriverAction, attempt: number, o: VerifyOptions, polygon?: Polygon): Promise<{ evidence: Evidence; polygon?: Polygon }> {
  const d = deps.dispatcher;
  const expected = effectFor(a);
  const sense = a.expect?.sense ?? 'none';
  const exec = driver.executor;
  const op = opFor(a, attempt, o.value, isVisualSynthPort(exec.port));
  const base = { evidenceId: newId('ev'), cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, attempt, expected: { sense, effect: expected } } as const;
  const lightCap = driver.transport === 'ir';

  if (isMusicalSynthPort(exec.port)) return observeMusical(deps, t, driver, a, o, base);

  // the Mac speaks: record it through a microphone client and let Muse Voice Transcribe hear it back
  const line = spokenLine(op);
  if (line && sense === 'audio' && deps.heard && (o.micDeviceId || deps.silentSpeech)) {
    const ack = await d.exec(exec.deviceId, op, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, waitForSlot: true, signal: o.signal, timeoutMs: 6000 });
    const canned = deps.silentSpeech?.(line);
    if (canned) {
      // nothing may be audible on this machine: the recorded clip is what the model hears, and the evidence says so
      const heard = await deps.heard(canned.line, canned.wav, o.signal);
      const evidence: Evidence = {
        ...base,
        execId: ack.execId,
        sent: { op, at: ack.sentAt },
        observed: { sense: 'audio', metric: 'transcript', before: 0, after: heard.similarity, delta: heard.similarity, threshold: TRANSCRIPT_THRESHOLD, sensorDeviceId: exec.deviceId, note: `${heard.recordedFrom ?? heard.model}${heard.source === 'fixture' ? ' (FIXTURE replay)' : ''} heard "${heard.transcript.slice(0, 60)}" · recorded clip ${canned.file}, not this Mac (CE_MAC_SILENT)`.slice(0, 200) },
        pass: heard.pass,
        note: (heard.pass ? `recorded clip heard back by ${heard.recordedFrom ?? heard.model}: "${heard.transcript.slice(0, 60)}" · ${canned.label}` : `expected "${canned.line.slice(0, 40)}", heard "${heard.transcript.slice(0, 40) || 'nothing'}" · ${canned.label}`).slice(0, 200),
      };
      return { evidence };
    }
    if (!o.micDeviceId) {
      return { evidence: { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { sense: 'ack', metric: 'ack', before: 0, after: 1, delta: 1, threshold: 1, sensorDeviceId: exec.deviceId, note: 'spoken; no microphone client online' }, pass: false, note: 'said, but no microphone could hear it' } };
    }
    let clipResult: SenseResultPayload | undefined;
    try {
      [clipResult] = await d.sense(o.micDeviceId, 'audio-clip', { cardId: t.cardId, durationMs: clipDurationMs(line), signal: o.signal, timeoutMs: clipDurationMs(line) + 6000 });
    } catch (e) {
      deps.log?.(`[verify] no audio clip for "${line.slice(0, 30)}": ${(e as Error).message}`);
    }
    if (clipResult?.clip?.wav) {
      const heard = await deps.heard(line, new Uint8Array(Buffer.from(clipResult.clip.wav, 'base64')), o.signal);
      const evidence: Evidence = {
        ...base,
        execId: ack.execId,
        sent: { op, at: ack.sentAt },
        observed: { sense: 'audio', metric: 'transcript', before: 0, after: heard.similarity, delta: heard.similarity, threshold: TRANSCRIPT_THRESHOLD, sensorDeviceId: o.micDeviceId, note: `${heard.recordedFrom ?? heard.model}${heard.source === 'fixture' ? ' (FIXTURE replay)' : ''} heard "${heard.transcript.slice(0, 120)}"` },
        pass: heard.pass,
        note: heard.pass ? `heard back by ${heard.recordedFrom ?? heard.model}: "${heard.transcript.slice(0, 80)}"` : `expected "${line.slice(0, 40)}", heard "${heard.transcript.slice(0, 40) || 'nothing'}"`,
      };
      return { evidence };
    }
    // no recording possible: fall through to the level check with the words already spoken
    const after = await audioWindow(d, o.micDeviceId, t.cardId, -800, o.signal).catch(() => undefined);
    const before = await audioWindow(d, o.micDeviceId, t.cardId, -3000, o.signal).catch(() => undefined);
    if (before && after) {
      const obs = observeAudio(before, after);
      const pass = audioMatches(obs, 'louder');
      return { evidence: { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { ...audioEvidence(obs, 'louder'), sensorDeviceId: o.micDeviceId }, pass, note: pass ? 'something was said (level only; no clip to transcribe)' : 'nothing heard' } };
    }
    return { evidence: { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { sense: 'ack', metric: 'ack', before: 0, after: 1, delta: 1, threshold: 1, sensorDeviceId: exec.deviceId, note: 'spoken; no microphone clip available' }, pass: false, note: 'said, but no microphone could hear it' } };
  }

  if (sense === 'camera' && isVisualSynthPort(exec.port) && op.kind === 'midi') return observeVisual(deps, t, driver, a, o, op, base, polygon);
  if (sense === 'camera') {
    if (!o.cameraDeviceId) throw new ExecError('no camera sensor online', 'offline');
    let before = await captureFrame(d, o.cameraDeviceId, t.cardId, o.signal);
    let poly = polygon;
    if (deps.sam.mode === 'fixture' && before.fixtures && t.detection) {
      const matches = before.fixtures.filter((det) => det.label === t.detection!.label);
      const selected = matches.length === 1 ? matches[0] : undefined;
      if (!selected) throw new ExecError('the synthetic camera cannot see the selected device', 'device');
      const [x, y, w, h] = selected.box;
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > before.width || y + h > before.height) throw new ExecError('invalid synthetic target bounds', 'device');
      poly = selected.polygon ?? polygonFor(null, selected.box);
    }
    if (!poly) {
      const r = await refreshPolygon(deps.sam, t, before.jpeg, before.width, before.height, o.signal, before.pose);
      poly = r.polygon;
      o.onStep?.(r.fresh ? `outline re-found by ${r.model}` : t.detection ? 'outline from the scan frame' : 'User-aimed center of the camera; no detected outline', `${poly.length} points`);
    }
    // A repeatable baseline prevents a pattern already selected from producing a false miss.
    // Only this repo's silent virtual instrument supports these preparation commands.
    if (isVisualSynthPort(exec.port) && op.kind === 'midi') {
      // Continuous animation is not evidence that a command worked. Freeze this repo's virtual
      // instrument before taking its baseline; the loop restores defaults after verification.
      await d.exec(exec.deviceId, { kind: 'midi', msg: 'cc', channel: 1, number: 1, value: 0 },
        { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: `${a.actionId}:freeze-animation`, waitForSlot: true, signal: o.signal });
      const baseline = visualBaseline(op);
      if (baseline) {
        await d.exec(exec.deviceId, baseline, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: `${a.actionId}:baseline`, waitForSlot: true, signal: o.signal });
        await sleep(350, o.signal);
        before = await captureFrame(d, o.cameraDeviceId, t.cardId, o.signal);
      }
    }
    const ack = await d.exec(exec.deviceId, op, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, lightCap, waitForSlot: true, signal: o.signal, timeoutMs: 4000 });
    const settle = deps.settleMs?.(t, a) ?? 1200;
    await sleep(settle, o.signal);
    // two consecutive confirmations: the change must be there in two frames taken apart
    const confirmations = Math.max(1, o.confirmations ?? 2);
    const cam = { exposureLocked: before.exposureLocked };
    let obs = observeCamera(before.img, (await captureFrame(d, o.cameraDeviceId, t.cardId, o.signal)).img, poly, undefined, cam);
    let pass = cameraMatches(obs, expected);
    let agreed = 1;
    for (let k = 1; k < confirmations && pass; k++) {
      await sleep(Math.max(150, Math.min(settle, 600)), o.signal);
      const again = observeCamera(before.img, (await captureFrame(d, o.cameraDeviceId, t.cardId, o.signal)).img, poly, undefined, cam);
      if (cameraMatches(again, expected)) {
        agreed++;
        obs = again;
      } else pass = false;
    }
    const evidence: Evidence = { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { ...cameraEvidence(obs, expected), sensorDeviceId: o.cameraDeviceId }, pass };
    evidence.note = pass ? `camera saw ${obs.effect}${obs.secondary ? ` + ${obs.secondary}` : ''}, confirmed ${agreed}x` : agreed > 0 && confirmations > 1 && obs.effect !== 'none' ? `expected ${expected}, saw ${obs.effect} once but not again` : `expected ${expected}, camera saw ${obs.effect === 'none' ? 'no change' : obs.effect}`;
    return { evidence, polygon: poly };
  }

  if (sense === 'audio') {
    if (!o.micDeviceId) throw new ExecError('no microphone sensor online', 'offline');
    // a CC sweep is only audible while something sounds: hold a note through the before/after windows
    // A reviewed CC-only chart does not authorize a generated note. The wearer supplies the sound.
    const holdsNote = op.kind === 'midi' && op.msg !== 'note' && op.msg !== 'panic' && !t.research?.profile?.reviewedChart;
    if (holdsNote) {
      const noteAction = driver.actions.find((x) => x.encode.kind === 'midi' && x.encode.msg === 'note');
      const noteOp: ExecOp = noteAction && noteAction.encode.kind === 'midi' ? { ...noteAction.encode, durationMs: 3000 } : { kind: 'midi', msg: 'note', channel: (op as { channel: number }).channel, number: 60, velocity: 100, durationMs: 3000 };
      try {
        await d.exec(exec.deviceId, noteOp, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: `${a.actionId}:hold`, waitForSlot: true, signal: o.signal, timeoutMs: 4000 });
      } catch (e) {
        deps.log?.(`[verify] could not hold a note for ${a.actionId}: ${(e as Error).message}`);
      }
      await sleep(400, o.signal);
    }
    const before = await audioWindow(d, o.micDeviceId, t.cardId, holdsNote ? undefined : -600, o.signal);
    const ack = await d.exec(exec.deviceId, op, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, waitForSlot: true, signal: o.signal, timeoutMs: 4000 });
    await sleep(deps.settleMs?.(t, a) ?? 350, o.signal);
    const after = await audioWindow(d, o.micDeviceId, t.cardId, undefined, o.signal);
    const obs = observeAudio(before!, after!);
    const pass = audioMatches(obs, expected);
    const evidence: Evidence = { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { ...audioEvidence(obs, expected), sensorDeviceId: o.micDeviceId }, pass };
    evidence.note = pass ? `heard ${obs.effect}${obs.secondary ? ` + ${obs.secondary}` : ''}` : `expected ${expected}, heard ${obs.effect === 'none' ? (obs.silent ? 'silence' : 'no change') : obs.effect}`;
    return { evidence };
  }

  // ack (or none): the executor's acknowledgement is the evidence
  try {
    const ack = await d.exec(exec.deviceId, op, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, lightCap, waitForSlot: true, signal: o.signal, timeoutMs: 4000 });
    if (isVisualSynthPort(exec.port) && op.kind === 'midi') {
      // Touch X / Y draw nothing while the finger is lifted: the renderer's report of the applied parameter is the evidence.
      const r = rendererEvidence(op, ack);
      return { evidence: { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { ...r.observed, sensorDeviceId: exec.deviceId }, pass: r.pass, note: r.note } };
    }
    const evidence: Evidence = { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, observed: { sense: 'ack', metric: 'ack', before: 0, after: 1, delta: 1, threshold: 1, sensorDeviceId: exec.deviceId, note: ack.detail?.slice(0, 200) }, pass: true, note: 'executor acknowledged' };
    return { evidence };
  } catch (e) {
    if (e instanceof ExecError && e.code === 'device' && e.ack) {
      const evidence: Evidence = { ...base, execId: e.ack.execId, sent: { op, at: e.ack.sentAt }, observed: { sense: 'ack', metric: 'ack', before: 0, after: 0, delta: 0, threshold: 1, sensorDeviceId: exec.deviceId, note: `${e.ack.error ?? ''} ${e.ack.detail ?? ''}`.trim().slice(0, 200) }, pass: false, note: 'executor refused' };
      return { evidence };
    }
    throw e;
  }
}

/**
 * The silent visual synth: one camera check (no second confirmation), bounded in time; when the camera sees no
 * change (too far, off-centre, card in the way) or cannot answer in time, the renderer's own report decides and the
 * evidence says which one did. Verification can never zero the demo while the Mac acknowledges the commands.
 */
/** Known software instrument only. A real analyser tone and exact applied state are both required.
 * The ready port proves the browser audio graph is available after a normal user gesture; this path cannot bypass autoplay.
 * Every probe releases its gate and restores settings, including cancellation.
 */
async function observeMusical(deps: VerifyDeps, t: Target, driver: Driver, a: DriverAction, o: VerifyOptions,
  base: Pick<Evidence, 'evidenceId' | 'cardId' | 'driverId' | 'actionId' | 'attempt' | 'expected'>): Promise<{ evidence: Evidence }> {
  const e = a.encode;
  if (a.expect?.sense !== 'audio' || a.expect.effect !== 'any' || e.kind !== 'midi' || e.channel !== 1 || !['cc', 'pc'].includes(e.msg)) throw new ExecError('The software instrument requires its manifest and actual analyser evidence', 'refused');
  const c = e.msg === 'cc' ? MUSICAL_SYNTH_MANIFEST.controls.find(c => c.cc === e.number) : undefined;
  const param = c?.parameter ?? (e.msg === 'pc' ? 'preset' : undefined);
  if (!param) throw new ExecError('Software instrument action is outside its manifest', 'refused');
  // Moderate probe values avoid extreme resonance/long envelopes. Gate must actually start a note.
  const chosen = c ? c.cc === 17 ? 127 : Math.round(Math.max(a.range?.min ?? c.min, Math.min(a.range?.max ?? c.max, c.default + (c.default < (c.max - c.min) / 2 ? 8 : -8)))) : undefined;
  const op = resolveOp(a, chosen);
  const exec = driver.executor;
  const send = (command: ExecOp, suffix: string, signal = o.signal) => {
    if (suffix.startsWith('restore-') && o.cleanupAllowed && !o.cleanupAllowed()) return Promise.reject(new ExecError('Verification cleanup was superseded', 'refused'));
    return deps.dispatcher.exec(exec.deviceId, command,
      { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: `${a.actionId}:${suffix}`, waitForSlot: true, signal, timeoutMs: 4000,
        ...(suffix.startsWith('restore-') && o.cleanupAllowed ? { stillCurrent: o.cleanupAllowed } : {}) });
  };
  const cc = (number: number, value: number): ExecOp => ({ kind: 'midi', msg: 'cc', channel: 1, number, value });
  let initial: ExecAckPayload['applied'];
  let ack: ExecAckPayload | undefined;
  try {
    initial = (await send(cc(17, 0), 'probe-release')).applied;
    if (initial?.source !== 'musical-synth' || !initial.audio?.unlocked || initial.visible !== true) throw new ExecError('Click the Mac page once to enable browser audio and keep ControlAnything Synth visible', 'offline');
    ack = await send(op, 'probe-action');
    let measured = ack;
    // Presets release notes, and filter/envelope settings need a sounding note for graph evidence.
    if (!(e.msg === 'cc' && e.number === 17)) measured = await send(cc(17, 127), 'probe-gate');
    // Pitch and gate must produce the requested scale note, not merely some waveform.
    // A short bounded settle also lets a previous release/delay tail clear the analyser window.
    const expectedIndex = e.msg === 'cc' && e.number === 16 ? chosen! : initial.params?.noteIndex;
    const expectedNote = Number.isInteger(expectedIndex) ? MUSICAL_SCALE[expectedIndex as number] : undefined;
    const expectedHz = expectedNote === undefined ? undefined : 440 * 2 ** ((expectedNote - 69) / 12);
    const pitchRelevant = e.msg === 'cc' && (e.number === 16 || e.number === 17);
    const pitchMatches = (receipt: ExecAckPayload['applied']) => expectedHz !== undefined && receipt?.audio?.frequency !== undefined && Math.abs(receipt.audio.frequency / expectedHz - 1) <= .025;
    for (let poll = 0; pitchRelevant && !pitchMatches(measured.applied) && poll < 3; poll++) {
      await sleep(70, o.signal);
      measured = await send(cc(17, 127), 'probe-settle');
    }
    const applied = measured.applied;
    const got = applied?.params?.[param];
    const expected = e.msg === 'pc' ? e.number! : chosen!;
    const audio = applied?.audio;
    const fresh = !!applied && applied.source === 'musical-synth' && applied.visible === true && audio?.unlocked === true
      && typeof applied.frame === 'number' && typeof initial.frame === 'number' && applied.frame > initial.frame
      && typeof applied.at === 'number' && applied.at >= ack.sentAt - 1000;
    const tone = !!audio && Number.isFinite(audio.rms) && audio.rms > 1e-5 && Number.isFinite(audio.frequency) && audio.frequency > 20;
    const pass = fresh && tone && got === expected && (!pitchRelevant || pitchMatches(applied));
    const note = pass
      ? `Software audio graph: ${param}=${got}; analyser RMS ${audio!.rms.toFixed(4)}, ${audio!.frequency.toFixed(1)} Hz${audio!.muted ? ' (master muted)' : ''}. Not physical microphone evidence.`
      : `Software graph check failed: ${param}=${got ?? 'missing'} (expected ${expected}); ${!fresh ? 'no fresh unlocked analyser receipt' : !tone ? 'analyser measured no tone' : got !== expected ? 'applied parameter mismatch' : `measured pitch ${audio?.frequency.toFixed(1)} Hz, expected ${expectedHz?.toFixed(1)} Hz`}.`;
    return { evidence: { ...base, execId: ack.execId, sent: { op, at: ack.sentAt }, pass, note: note.slice(0, 300),
      observed: { sense: 'audio', metric: 'rms', before: initial.audio?.rms ?? 0, after: audio?.rms ?? 0, delta: (audio?.rms ?? 0) - (initial.audio?.rms ?? 0),
        threshold: 1e-5, sensorDeviceId: exec.deviceId, note: note.slice(0, 200) } } };
  } finally {
    if (initial?.source === 'musical-synth' && initial.params) {
      // Bounded independent cleanup survives cancellation. Gate zero first, then restore the exact prior catalog values.
      const cleanup = AbortSignal.timeout(3500);
      try {
        await send(cc(17, 0), 'restore-release', cleanup);
        if (e.msg === 'pc' && typeof initial.params.preset === 'number') await send({ kind: 'midi', msg: 'pc', channel: 1, number: initial.params.preset }, 'restore-preset', cleanup);
        for (const control of MUSICAL_SYNTH_MANIFEST.controls) {
          if (control.cc === 17 || (e.msg !== 'pc' && control.cc !== e.number)) continue;
          const value = initial.params[control.parameter];
          if (typeof value === 'number') await send(cc(control.cc, value), 'restore-parameter', cleanup);
        }
      } catch (err) { deps.log?.(`[verify] could not release/restore software synth: ${(err as Error).message}`); }
    }
  }
}

async function observeVisual(deps: VerifyDeps, t: Target, driver: Driver, a: DriverAction, o: VerifyOptions, op: Extract<ExecOp, { kind: 'midi' }>,
  base: Pick<Evidence, 'evidenceId' | 'cardId' | 'driverId' | 'actionId' | 'attempt' | 'expected'>, polygon?: Polygon): Promise<{ evidence: Evidence; polygon?: Polygon }> {
  const d = deps.dispatcher;
  const exec = driver.executor;
  const expected = base.expected.effect;
  const run = (o2: ExecOp, actionId: string) => d.exec(exec.deviceId, o2, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId, waitForSlot: true, signal: o.signal, timeoutMs: 4000 });
  const timeLeft = () => (o.cameraDeadline ?? Infinity) - Date.now();
  const useCamera = !!o.cameraDeviceId && !o.cameraSkip && timeLeft() > 1500;
  let before: Awaited<ReturnType<typeof captureFrame>> | undefined;
  let poly = polygon;
  let cameraNote: string | undefined = o.cameraDeviceId ? (useCamera ? undefined : o.cameraSkip ?? 'skipped (time budget)') : 'no headset camera';
  // Continuous animation is not evidence: freeze, then a baseline away from the commanded value.
  await run({ kind: 'midi', msg: 'cc', channel: 1, number: 1, value: 0 }, `${a.actionId}:freeze-animation`);
  const baseline = visualBaseline(op);
  if (baseline) await run(baseline, `${a.actionId}:baseline`);
  if (useCamera) {
    try {
      await sleep(250, o.signal);
      before = await captureFrame(d, o.cameraDeviceId!, t.cardId, o.signal, Math.min(VISUAL_FRAME_TIMEOUT_MS, timeLeft()));
      if (!poly) {
        const r = await refreshPolygon(deps.sam, t, before.jpeg, before.width, before.height, o.signal, before.pose);
        poly = r.polygon;
        o.onStep?.(r.fresh ? `outline re-found by ${r.model}` : t.detection ? 'outline from the scan frame' : 'User-aimed center of the camera; no detected outline', `${poly.length} points`);
      }
    } catch (e) {
      throwIfCancelled(o.signal);
      before = undefined;
      cameraNote = `no frame (${(e as Error).message.slice(0, 60)})`;
    }
  }
  let ack: ExecAckPayload | undefined;
  for (let tries = 0; !ack; tries++) {
    try {
      ack = await run(op, a.actionId);
    } catch (e) {
      if (!(e instanceof ExecError && e.code === 'device' && e.ack)) throw e;
      // A renderer that blinked away (focus, notification) answers no_port; give it one short chance to return.
      if (e.ack.error === 'no_port' && tries === 0) { await sleep(1500, o.signal); continue; }
      ack = e.ack;
    }
  }
  let camera: { pass: boolean; observed: Evidence['observed']; note: string } | undefined;
  if (before && poly && ack.ok) {
    try {
      await sleep(deps.settleMs?.(t, a) ?? 350, o.signal);
      const after = await captureFrame(d, o.cameraDeviceId!, t.cardId, o.signal, Math.min(VISUAL_FRAME_TIMEOUT_MS, Math.max(500, timeLeft())));
      const obs = observeCamera(before.img, after.img, poly, undefined, { exposureLocked: before.exposureLocked });
      const pass = cameraMatches(obs, expected);
      camera = { pass, observed: { ...cameraEvidence(obs, expected), sensorDeviceId: o.cameraDeviceId }, note: pass ? `camera saw ${obs.effect}${obs.secondary ? ` + ${obs.secondary}` : ''}` : `saw ${obs.effect === 'none' ? 'no change' : obs.effect}` };
      if (!pass) {
        cameraNote = `${camera.note} (Δ${obs.delta.toFixed(3)})`;
        // One miss means the screen is too far or off-centre for this camera: the renderer decides the rest, quickly.
        o.cameraSkip = 'skipped after the first camera miss';
      }
    } catch (e) {
      throwIfCancelled(o.signal);
      cameraNote = `no frame (${(e as Error).message.slice(0, 60)})`;
    }
  }
  const sent = { op, at: ack.sentAt };
  if (camera?.pass) return { evidence: { ...base, execId: ack.execId, sent, observed: camera.observed, pass: true, note: `${camera.note} · verified by camera` }, polygon: poly };
  const r = rendererEvidence(op, ack, cameraNote);
  return { evidence: { ...base, execId: ack.execId, sent, observed: { ...r.observed, sensorDeviceId: exec.deviceId }, pass: r.pass, note: r.note }, polygon: poly };
}

/** Swap the IR encodes of a driver to another library candidate set (same keys), keeping ids and labels. */
export function retargetIr(driver: Driver, candidates: IrCandidate[], brand: string, channel: number): Driver | undefined {
  const table = candidates.filter((c) => c.brand === brand && c.channel === channel);
  if (!table.length) return undefined;
  const actions = driver.actions.map((a) => {
    if (a.encode.kind !== 'ir') return a;
    const key = a.encode.ref?.split('/').pop() ?? a.actionId;
    const c = table.find((x) => x.key === key) ?? table.find((x) => x.key === a.actionId);
    return c ? { ...a, encode: { ...c.op }, verified: 'pending' as const } : a;
  });
  return { ...driver, actions };
}

/**
 * Verify every action of a driver. The first camera action of an IR library driver drives the candidate
 * search: when the first brand gets no reaction, the next brand's table replaces the encodes and the probe
 * runs again, up to maxIrCandidates brands. Returns the (possibly retargeted) driver and the evidence.
 */
export async function verifyDriver(deps: VerifyDeps, t: Target, driver: Driver, o: VerifyOptions): Promise<VerifySummary> {
  if (isVisualSynthPort(driver.executor.port) && o.cameraDeadline === undefined) o = { ...o, cameraDeadline: Date.now() + VISUAL_VERIFY_BUDGET_MS };
  const evidence: Evidence[] = [];
  const verification: Record<string, VerifyState> = {};
  for (const a of driver.actions) verification[a.actionId] = 'untested';
  let current = driver;
  let irMatch: IrCandidate | undefined;
  let polygon: Polygon | undefined;
  const push = (e: Evidence) => {
    throwIfCancelled(o.signal);
    evidence.push(e);
    o.onEvidence?.(e);
  };

  // IR library search: probe the most visible key ("off" or the first camera action) per candidate brand
  if (driver.transport === 'ir' && o.irCandidates?.length && !driver.provenance.some((p) => p.source === 'learned')) {
    const probe = current.actions.find((a) => a.actionId === 'off' && a.expect?.sense === 'camera') ?? current.actions.find((a) => a.expect?.sense === 'camera');
    if (probe) {
      const brands: { brand: string; channel: number }[] = [];
      for (const c of o.irCandidates) if (!brands.some((b) => b.brand === c.brand && b.channel === c.channel)) brands.push({ brand: c.brand, channel: c.channel });
      const max = o.maxIrCandidates ?? 6;
      let attempt = 0;
      for (const b of brands.slice(0, max)) {
        const retargeted = retargetIr(current, o.irCandidates, b.brand, b.channel);
        if (!retargeted) continue;
        const pa = retargeted.actions.find((a) => a.actionId === probe.actionId)!;
        attempt++;
        o.onStep?.(`trying ${b.brand} CH${b.channel} ${pa.label}`, pa.encode.kind === 'ir' ? `bytes ${pa.encode.bytes?.map((x) => x.toString(16).padStart(2, '0')).join(' ')}` : undefined);
        const { evidence: e, polygon: p } = await verifyOnce(deps, t, retargeted, pa, attempt, o, polygon);
        polygon = p ?? polygon;
        push(e);
        if (e.pass) {
          current = retargeted;
          irMatch = o.irCandidates.find((c) => c.brand === b.brand && c.channel === b.channel);
          verification[pa.actionId] = 'pass';
          // undo the probe (lights back on) when an inverse exists, so the rest can be measured from a lit state
          const inv = pa.inverseActionId ? retargeted.actions.find((x) => x.actionId === pa.inverseActionId) : undefined;
          if (inv) {
            const { evidence: e2 } = await verifyOnce(deps, t, retargeted, inv, 1, o, polygon);
            push(e2);
            verification[inv.actionId] = e2.pass ? 'pass' : 'fail';
          }
          break;
        }
      }
      if (!irMatch) {
        for (const a of current.actions) if (a.expect?.sense === 'camera') verification[a.actionId] = 'fail';
        return { verification, evidence, passed: 0, failed: evidence.length, driver: current };
      }
    }
  }

  const wanted = new Set(o.actionIds ?? current.actions.map((a) => a.actionId));
  // what the camera has told us about the lamp so far: brightness and colour probes need it lit
  let lamp: 'on' | 'off' | 'unknown' = 'unknown';
  const needsLight = (a: DriverAction) => a.expect?.sense === 'camera' && ['brighter', 'dimmer', 'warmer', 'cooler'].includes(a.expect.effect);
  const relight = async (): Promise<boolean> => {
    const candidates = current.actions.filter((a) => a.expect?.sense === 'camera' && (a.expect.effect === 'on' || a.expect.effect === 'brighter') && verification[a.actionId] !== 'fail');
    for (const a of candidates) {
      try {
        const { evidence: e, polygon: p } = await verifyOnce(deps, t, current, a, 1, o, polygon);
        polygon = p ?? polygon;
        push(e);
        if (e.pass) {
          verification[a.actionId] = 'pass';
          lamp = 'on';
          return true;
        }
        if (verification[a.actionId] === 'untested') verification[a.actionId] = 'fail';
      } catch {
        return false;
      }
    }
    return false;
  };
  // most visible first: off, then on (which also undoes off, leaving the lamp at full), then dimmer (so that
  // brighter has room to show), then brighter, then the rest; audio: notes before sweeps
  const rank = (a: DriverAction) => {
    const e = a.expect?.effect;
    if (/night/i.test(`${a.actionId} ${a.label}`)) return 6; // night mode last: colour keys do nothing in it
    if (e === 'off') return 0;
    if (e === 'on') return 1;
    if (e === 'dimmer') return 2;
    if (e === 'brighter') return 3;
    if (e === 'warmer' || e === 'cooler') return 4;
    if (a.encode.kind === 'midi' && a.encode.msg === 'note') return 2;
    return 5;
  };
  const ordered = [...current.actions].sort((x, y) => rank(x) - rank(y));
  for (const a of ordered) {
    throwIfCancelled(o.signal);
    if (!wanted.has(a.actionId) || verification[a.actionId] === 'pass' || verification[a.actionId] === 'fail') continue;
    if (a.encode.kind === 'step') {
      // a step composite is verified through its up/down triggers
      const up = verification[a.encode.upActionId];
      const down = verification[a.encode.downActionId];
      verification[a.actionId] = up === 'pass' && down === 'pass' ? 'pass' : up === 'fail' || down === 'fail' ? 'fail' : 'untested';
      continue;
    }
    if (!a.expect || a.expect.sense === 'none') {
      verification[a.actionId] = 'untested';
      continue;
    }
    // a lamp that was switched off cannot show a brighter/dimmer/warmer/cooler step: light it again first
    if (lamp === 'off' && needsLight(a)) {
      o.onStep?.('the light is off: switching it on before the next probe');
      if (!(await relight())) {
        o.onStep?.(`${a.label}: not tested (the light is off and nothing switched it on)`);
        verification[a.actionId] = 'untested';
        continue;
      }
    }
    // one real attempt (with its built-in double confirmation); a miss gets one retry
    let passed = false;
    // the visual synth gets one check per action: its renderer report already decides a camera miss
    const attempts = isVisualSynthPort(current.executor.port) || isMusicalSynthPort(current.executor.port) ? 1 : 2;
    try {
      for (let attempt = 1; attempt <= attempts && !passed; attempt++) {
        const { evidence: e, polygon: p } = await verifyOnce(deps, t, current, a, attempt, o, polygon);
        polygon = p ?? polygon;
        push(e);
        passed = e.pass;
        if (!passed && a.expect.sense === 'ack') break;
      }
      verification[a.actionId] = passed ? 'pass' : 'fail';
      if (passed && a.expect.sense === 'camera') lamp = a.expect.effect === 'off' ? 'off' : a.expect.effect === 'none' ? lamp : 'on';
    } catch (e) {
      throwIfCancelled(o.signal);
      if (!(e instanceof ExecError)) throw e;
      deps.log?.(`[verify] ${a.actionId}: ${e.message}`);
      o.onStep?.(`${a.label}: could not verify`, e.message);
      verification[a.actionId] = 'untested';
      if (e.code === 'offline' || e.code === 'refused' || (a.expect.sense === 'camera' && !polygon)) break;
    }
  }
  // steps whose triggers were verified later
  for (const a of current.actions) {
    if (a.encode.kind !== 'step') continue;
    const up = verification[a.encode.upActionId];
    const down = verification[a.encode.downActionId];
    verification[a.actionId] = up === 'pass' && down === 'pass' ? 'pass' : up === 'fail' || down === 'fail' ? 'fail' : 'untested';
  }
  const passed = Object.values(verification).filter((v) => v === 'pass').length;
  const failed = Object.values(verification).filter((v) => v === 'fail').length;
  const actions = current.actions.map((a) => ({ ...a, verified: verification[a.actionId] }));
  return { verification, evidence, passed, failed, irMatch, driver: { ...current, actions } };
}
