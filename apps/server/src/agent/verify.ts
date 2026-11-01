/**
 * VERIFY: run each driver action for real, once, and let a sensor decide (SPEC §3.3). Camera: a verify frame
 * before and after (SAM re-finds the target's outline on the before frame), mask-vs-ring luma and R/B ratio,
 * two consecutive confirmations. Audio: feature windows before/after. ack: the executor's acknowledgement.
 * IR from the library: when nothing reacts, the next candidate brand is tried (bounded); an honest miss is
 * expected and reported as evidence with pass=false. Every attempt is a verify.result broadcast.
 */
import type { Driver, DriverAction, Effect, Evidence, ExecOp, Polygon, SenseResultPayload, VerifyState } from '@ce/protocol';
import { newId } from '@ce/protocol';
import { resolveOp } from '../devices/encode';
import type { IrCandidate } from '../devices/profiles';
import { audioEvidence, audioMatches, observeAudio } from '../oracle/audio';
import { cameraEvidence, cameraMatches, observeCamera } from '../oracle/camera';
import { type DecodedImage, decodeJpeg } from '../oracle/image';
import { iou, polygonFor } from '../scan/polygon';
import { decodeMask, type Sam } from '../scan/sam';
import { Dispatcher, ExecError } from './dispatch';
import { clipDurationMs, type HeardResult, TRANSCRIPT_THRESHOLD } from './heard';
import type { Target } from './types';

export interface VerifyDeps {
  dispatcher: Dispatcher;
  sam: Sam;
  /** hears a spoken line back (the "say" oracle: Muse Voice Transcribe) */
  heard?: (line: string, wav: Uint8Array, signal?: AbortSignal) => Promise<HeardResult>;
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

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ExecError('cancelled', 'refused'));
    });
  });
}

/** Ask the camera for one verify frame. */
async function captureFrame(d: Dispatcher, sensorDeviceId: string, cardId: string, signal?: AbortSignal): Promise<{ img: DecodedImage; jpeg: string; width: number; height: number; exposureLocked: boolean }> {
  const [r] = await d.sense(sensorDeviceId, 'frame', { cardId, signal, timeoutMs: 6000 });
  if (!r?.frame) throw new ExecError(`no frame from ${sensorDeviceId}${r?.error ? ` (${r.error})` : ''}`, 'device');
  const src = r.frame.camera?.source;
  return { img: decodeJpeg(r.frame.jpeg), jpeg: r.frame.jpeg, width: r.frame.width, height: r.frame.height, exposureLocked: src === 'synthetic' || src === 'replay' };
}

/** Re-find the target's outline on a fresh frame with SAM (nearest to the stored box); fall back to the stored polygon. */
export async function refreshPolygon(sam: Sam, t: Target, jpeg: string, width: number, height: number, signal?: AbortSignal): Promise<{ polygon: Polygon; fresh: boolean; latencyMs: number; model: string }> {
  const det = t.detection;
  // no detection (a device the user pointed at without a scan): watch the middle of the frame
  if (!det) return { polygon: polygonFor(null, [Math.round(width * 0.25), Math.round(height * 0.25), Math.round(width * 0.5), Math.round(height * 0.5)]), fresh: false, latencyMs: 0, model: 'none' };
  const fallback = det.polygon ?? polygonFor(null, det.box);
  try {
    const r = await sam.segment(det.prompt, jpeg, { width, height, signal, label: `sam:verify:${det.prompt}` });
    let best: { score: number; polygon: Polygon } | undefined;
    for (const rec of r.records) {
      const box: [number, number, number, number] = [rec.x1, rec.y1, rec.x2 - rec.x1 + 1, rec.y2 - rec.y1 + 1];
      const overlap = iou(box, det.box);
      if (overlap < 0.2) continue;
      const raster = decodeMask(rec);
      const polygon = rec.polygon ?? polygonFor(raster ? { data: raster, width: rec.mask!.width, height: rec.mask!.height, x0: rec.x1, y0: rec.y1 } : null, box);
      if (!best || overlap > best.score) best = { score: overlap, polygon };
    }
    if (best) return { polygon: best.polygon, fresh: true, latencyMs: r.latencyMs, model: r.recordedFrom ?? r.model };
    return { polygon: fallback, fresh: false, latencyMs: r.latencyMs, model: r.recordedFrom ?? r.model };
  } catch (e) {
    return { polygon: fallback, fresh: false, latencyMs: 0, model: 'none' };
  }
}

async function audioWindow(d: Dispatcher, micDeviceId: string, cardId: string, offsetMs: number | undefined, signal?: AbortSignal): Promise<SenseResultPayload['audio']> {
  const [r] = await d.sense(micDeviceId, 'audio-features', { cardId, durationMs: 600, offsetMs, signal, timeoutMs: 6000 });
  if (!r?.audio) throw new ExecError(`no audio features from ${micDeviceId}${r?.error ? ` (${r.error})` : ''}`, 'device');
  return r.audio;
}

/** The op to send for one verification of an action: set actions go to their max (then min on the second pass), or to `value`. */
function opFor(a: DriverAction, pass: number, value?: number): ExecOp {
  if (a.kind === 'set' && a.encode.kind !== 'step') {
    if (value !== undefined) return resolveOp(a, value);
    if (a.range) return resolveOp(a, pass % 2 === 0 ? a.range.max : a.range.min);
  }
  return resolveOp(a);
}

/** The text a local "say" op speaks, if it is one. */
export function spokenLine(op: ExecOp): string | undefined {
  if (op.kind !== 'local' || op.op !== 'say') return undefined;
  if (typeof op.arg === 'string') return op.arg;
  if (op.arg && typeof op.arg === 'object' && 'text' in op.arg) return String((op.arg as Record<string, unknown>).text);
  return undefined;
}

/**
 * Verify one action once. Returns the evidence (pass or fail) or throws ExecError when the plumbing
 * (executor/sensor offline, timeouts) failed, which is not evidence about the device.
 */
export async function verifyOnce(deps: VerifyDeps, t: Target, driver: Driver, a: DriverAction, attempt: number, o: VerifyOptions, polygon?: Polygon): Promise<{ evidence: Evidence; polygon?: Polygon }> {
  const d = deps.dispatcher;
  const expected = effectFor(a);
  const sense = a.expect?.sense ?? 'none';
  const exec = driver.executor;
  const op = opFor(a, attempt, o.value);
  const base = { evidenceId: newId('ev'), cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, attempt, expected: { sense, effect: expected } } as const;
  const lightCap = driver.transport === 'ir';

  // the Mac speaks: record it through a microphone client and let Muse Voice Transcribe hear it back
  const line = spokenLine(op);
  if (line && sense === 'audio' && o.micDeviceId && deps.heard) {
    const ack = await d.exec(exec.deviceId, op, { port: exec.port, cardId: t.cardId, driverId: driver.driverId, actionId: a.actionId, waitForSlot: true, signal: o.signal, timeoutMs: 6000 });
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

  if (sense === 'camera') {
    if (!o.cameraDeviceId) throw new ExecError('no camera sensor online', 'offline');
    const before = await captureFrame(d, o.cameraDeviceId, t.cardId, o.signal);
    let poly = polygon;
    if (!poly) {
      const r = await refreshPolygon(deps.sam, t, before.jpeg, before.width, before.height, o.signal);
      poly = r.polygon;
      o.onStep?.(r.fresh ? `outline re-found by ${r.model}` : 'outline from the scan frame', `${poly.length} points`);
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
    const holdsNote = op.kind === 'midi' && op.msg !== 'note' && op.msg !== 'panic';
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
  const evidence: Evidence[] = [];
  const verification: Record<string, VerifyState> = {};
  for (const a of driver.actions) verification[a.actionId] = 'untested';
  let current = driver;
  let irMatch: IrCandidate | undefined;
  let polygon: Polygon | undefined;
  const push = (e: Evidence) => {
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
    if (!wanted.has(a.actionId) || verification[a.actionId] === 'pass' || verification[a.actionId] === 'fail') continue;
    if (a.encode.kind === 'step') {
      // a step composite is verified through its up/down triggers
      const up = verification[a.encode.upActionId];
      const down = verification[a.encode.downActionId];
      verification[a.actionId] = up === 'pass' || down === 'pass' ? 'pass' : up === 'fail' && down === 'fail' ? 'fail' : 'untested';
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
    try {
      for (let attempt = 1; attempt <= 2 && !passed; attempt++) {
        const { evidence: e, polygon: p } = await verifyOnce(deps, t, current, a, attempt, o, polygon);
        polygon = p ?? polygon;
        push(e);
        passed = e.pass;
        if (!passed && a.expect.sense === 'ack') break;
      }
      verification[a.actionId] = passed ? 'pass' : 'fail';
      if (passed && a.expect.sense === 'camera') lamp = a.expect.effect === 'off' ? 'off' : a.expect.effect === 'none' ? lamp : 'on';
    } catch (e) {
      if (!(e instanceof ExecError)) throw e;
      deps.log?.(`[verify] ${a.actionId}: ${e.message}`);
      o.onStep?.(`${a.label}: could not verify`, e.message);
      verification[a.actionId] = 'untested';
      if (e.code === 'offline' || e.code === 'refused') break;
    }
  }
  // steps whose triggers were verified later
  for (const a of current.actions) {
    if (a.encode.kind !== 'step') continue;
    const up = verification[a.encode.upActionId];
    const down = verification[a.encode.downActionId];
    verification[a.actionId] = up === 'pass' || down === 'pass' ? 'pass' : up === 'fail' && down === 'fail' ? 'fail' : 'untested';
  }
  const passed = Object.values(verification).filter((v) => v === 'pass').length;
  const failed = Object.values(verification).filter((v) => v === 'fail').length;
  const actions = current.actions.map((a) => ({ ...a, verified: verification[a.actionId] }));
  return { verification, evidence, passed, failed, irMatch, driver: { ...current, actions } };
}
