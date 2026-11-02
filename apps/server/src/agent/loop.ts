/**
 * The discovery loop for one target: IDENTIFY -> LINK -> RESEARCH (-> LEARN) -> DRIVE -> VERIFY -> FORGE -> ARM.
 * Models run only here ("AI at compile time"); every step is an agent.step with the model id, effort and
 * latency, every transition a target.status, and nothing is ever sent to a device before VERIFY.
 */
import type { Driver, DriverDraft } from '@ce/protocol';
import { newId } from '@ce/protocol';
import { resolveOp } from '../devices/encode';
import { allowedCcs, matchMidiProfile, type Profiles } from '../devices/profiles';
import { formatIssues, validateDriver } from '../devices/validate';
import type { Forge } from '../gen3d/forge';
import type { Hub } from '../hub';
import type { MuseChat } from '../muse/adapter';
import { decodeJpeg } from '../oracle/image';
import type { WebSearcher } from '../research/websearch';
import type { Sam } from '../scan/sam';
import { ArmService } from './arm';
import type { Dispatcher } from './dispatch';
import { drive, dryResolve, templateIrDraft, templateLocalDraft, templateMidiDraft } from './drive';
import { candidatesFor, online, pickSensor, type Roster, suggestedClients } from './executors';
import { cropForSkin, cropJpeg, identify, type SkinCropImage } from './identify';
import { learnCodes } from './learn';
import { type LinkCapability, neededCapability, tryLink } from './link';
import { research as doResearch } from './research';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';
import { type VerifyDeps, type VerifySummary, verifyDriver } from './verify';

export interface LoopDeps {
  hub: Pick<Hub, 'broadcast' | 'sendToDevice'>;
  targets: TargetStore;
  steps: StepLog;
  dispatcher: Dispatcher;
  roster: Roster;
  sam: Sam;
  spark: MuseChat;
  wonder?: MuseChat;
  web: WebSearcher;
  profiles: Profiles;
  forge: () => Forge | undefined;
  arm: ArmService;
  /** the "say" oracle: Muse Voice Transcribe hears a spoken line back */
  heard?: VerifyDeps['heard'];
  readVolume?: VerifyDeps['readVolume'];
  log?: (line: string) => void;
  /** how long LINK waits for a companion to appear */
  companionWaitMs?: number;
  /** IR lamps fade; the sim is instant */
  settleMs?: (t: Target, transport: Driver['transport']) => number;
  /** learn the remote when the brand's codes are not public (Koizumi, unknown) */
  learnIr?: boolean;
  /** CE_MAC_SILENT: a recorded clip stands in for the Mac's voice (see recordedSpeech.ts) */
  silentSpeech?: VerifyDeps['silentSpeech'];
}

/** One learn window per remote button: the user has to find the button after the prompt appears. */
const LEARN_WINDOW_MS = 10_000;
/** The second pass (after the library codes missed) gives a slower hand more time. */
const LEARN_WINDOW_RETRY_MS = 15_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    });
  });

export class LoopCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'LoopCancelled';
  }
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LoopCancelled();
}

/** Run the loop for a target that has a detection (from SCAN) or a card (a paired device the user pointed at). */
export async function runLoop(d: LoopDeps, t: Target, opts: { userText?: string; preferDeviceId?: string } = {}): Promise<void> {
  const log = d.log ?? (() => {});
  const abort = new AbortController();
  t.abort = abort;
  const signal = abort.signal;
  const base = { cardId: t.cardId, runId: t.runId };
  try {
    // ---------------------------------------------------------------- IDENTIFY
    if (!t.card) {
      if (!t.detection) throw new Error('nothing to identify: no detection and no card');
      d.targets.setState(t, 'identifying', `${t.detection.label} seen by ${t.detection.sensorDeviceId}`);
      const step = d.steps.begin('identify', `identifying the ${t.detection.label}`, { ...base, kind: 'opinion', model: d.spark.model });
      const img = decodeJpeg(t.detection.jpeg);
      const crop = cropJpeg(img, t.detection.box);
      const r = await identify(d.spark, t.detection, crop, t.detection.jpeg, { cardId: t.cardId, userText: opts.userText, signal });
      t.card = r.card;
      d.hub.broadcast('device.card', r.card);
      step.ok(`${r.card.name} (${r.card.maker} ${r.card.model}) confidence ${r.card.confidence.toFixed(2)}`, { model: r.model, effort: r.effort, latencyMs: r.latencyMs, source: r.source, recordedFrom: r.recordedFrom, evidence: (r.card.evidence[0] ?? '').slice(0, 64) });
      d.targets.setState(t, 'identified', `${r.card.name}: ${r.card.maker} ${r.card.model}`);
    }
    check(signal);
    const card = t.card;

    // ---------------------------------------------------------------- LINK
    const cap = neededCapability(card);
    if (!cap) {
      d.steps.note('link', `no control path for a ${card.category}`, { ...base, kind: 'proof', status: 'fail' });
      d.targets.setState(t, 'failed', `no known way to control a ${card.category}`);
      return;
    }
    d.targets.setState(t, 'linking', `needs ${cap}`);
    const profile = cap === 'midi' ? (await doResearch({ profiles: d.profiles, web: d.web }, card, cap, { allowWeb: false })).profile : undefined;
    const linkId = newId('ln');
    const waitUntil = Date.now() + (d.companionWaitMs ?? 10 * 60_000);
    let announced = false;
    let link = await tryLink({ roster: d.roster, dispatcher: d.dispatcher }, card, cap, { linkId, profile, preferDeviceId: opts.preferDeviceId ?? t.selectedBy, signal });
    while (!link.executor) {
      if (!announced) {
        announced = true;
        d.hub.broadcast('link.request', { linkId, cardId: t.cardId, needs: [cap], reason: `${card.name} is driven over ${cap}; no paired client online can do that`, suggestedClients: suggestedClients(cap), candidates: candidatesFor(d.roster, cap), status: online(d.roster, cap).length ? 'candidates' : 'needs-companion' });
        d.steps.note('link', `needs a companion: ${suggestedClients(cap).join(' or ')} (${cap})`, { ...base, kind: 'proof', status: 'fail' });
        d.targets.setState(t, 'needs-companion', `pair a ${suggestedClients(cap)[0]} (${cap})`);
      }
      if (Date.now() > waitUntil) {
        d.targets.setState(t, 'failed', `no ${cap} companion appeared`);
        return;
      }
      await sleep(1500, signal);
      link = await tryLink({ roster: d.roster, dispatcher: d.dispatcher }, card, cap, { linkId, profile, preferDeviceId: opts.preferDeviceId ?? t.selectedBy, signal });
    }
    t.link = link.result;
    d.hub.broadcast('link.result', link.result);
    for (const e of link.result.evidence) d.steps.note('link', e.detail.slice(0, 200), { ...base, kind: 'proof', status: e.ok ? 'ok' : 'fail', evidence: `${e.kind}${e.ok ? ' ✓' : ' ✗'}` });
    if (link.result.verdict === 'mismatch') {
      d.steps.note('link', 'wrong device: refused', { ...base, kind: 'proof', status: 'fail', evidence: link.result.reason });
      d.targets.setState(t, 'failed', link.result.reason ?? 'the connected device is not the one the camera saw');
      return;
    }
    const executor = link.executor;
    d.targets.setState(t, 'linked', `${executor.name} via ${link.result.channel ?? cap}${executor.port ? ` (${executor.port.name})` : ''} · ${link.result.verdict}`);
    check(signal);

    // ---------------------------------------------------------------- RESEARCH (+ LEARN) -> DRIVE -> VERIFY
    // Up to two passes. An IR driver written from the public code library may move nothing (honest misses: the
    // light obeys a remote nobody published), so the second pass learns the device's own remote, one press per
    // button, and rewrites the driver from the captured codes. A remote learned before the first VERIFY is not
    // learned twice unless it yielded nothing.
    let learned = t.research?.learned;
    const wantLearn = cap === 'ir' && d.learnIr !== false && (/koizumi|unknown/i.test(`${card.maker} ${card.model}`) || process.env.CE_IR_LEARN === '1');
    const receiver = cap === 'ir' ? pickSensor(d.roster, 'ir', { preferDeviceId: executor.deviceId }) : undefined;
    let driverId = '';
    let verified: VerifySummary | undefined;
    for (let pass = 1; pass <= 2 && !verified; pass++) {
      d.targets.setState(t, 'researching');
      if (cap === 'ir' && receiver && !learned?.length && (wantLearn || pass > 1)) {
        const step = d.steps.begin('link', `${pass > 1 ? 'the library codes did nothing: ' : ''}learning the remote with ${receiver.name}`, { ...base, kind: 'proof' });
        learned = await learnCodes({ dispatcher: d.dispatcher, steps: d.steps, log }, t, receiver.deviceId, { signal, durationMs: process.env.VITEST ? 300 : pass > 1 ? LEARN_WINDOW_RETRY_MS : LEARN_WINDOW_MS });
        if (learned.length) step.ok(`${learned.length} codes learned`, { evidence: learned.map((l) => l.button).join(' ') });
        else step.fail('no button press was captured in time', { evidence: 'nothing learned' });
      }
      if (pass > 1 && !learned?.length) {
        d.targets.setState(t, 'failed', 'the library codes did nothing and no remote button was captured; select the device again to retry');
        return;
      }
      const rstep = d.steps.begin('research', cap === 'midi' ? 'looking up the MIDI chart' : cap === 'ir' ? 'looking up IR codes' : 'local actions', { ...base, kind: 'proof' });
      // the cable knows the model when the camera does not: a USB port name that matches a stored chart's hint
      if (cap === 'midi' && executor.port && !matchMidiProfile(d.profiles, card)) {
        const byPort = [...d.profiles.midi.values()].find((p) => p.usb?.portNameHint && executor.port!.name.toLowerCase().includes(p.usb.portNameHint.toLowerCase()));
        if (byPort) {
          card.maker = byPort.manufacturer;
          card.model = byPort.device.replace(byPort.manufacturer, '').trim() || byPort.device;
          card.evidence = [...card.evidence, `USB port "${executor.port.name}" matches the ${byPort.device} chart`].slice(0, 12);
          d.hub.broadcast('device.card', card);
          d.steps.note('research', `USB says ${byPort.device}: using its chart`, { ...base, kind: 'proof', evidence: executor.port.name.slice(0, 64) });
        }
      }
      const research = await doResearch({ profiles: d.profiles, web: d.web }, card, cap, { learned, signal });
      t.research = research;
      rstep.ok(research.provenance.map((p) => `${p.source}: ${p.ref}`).join('; ').slice(0, 400), {
        kind: research.modelId ? 'opinion' : 'proof',
        model: research.modelId,
        evidence: research.profile ? `chart: ${research.profile.id}` : research.learned?.length ? `${research.learned.length} learned codes` : research.irLibrary ? `${research.irLibrary.candidates.length} library codes` : research.provenance[0]?.source,
      });
      check(signal);

      // ---------------------------------------------------------------- DRIVE
      d.targets.setState(t, 'driving');
      driverId = newId('drv');
      const ids = { driverId, executor: { deviceId: executor.deviceId, port: executor.port?.id }, executorKind: executor.kind };
      const vctx = { allowedCcs: research.allowedCcs, irLibrary: research.irLibrary, learned: research.learned, executorKind: executor.kind, emitsLight: cap === 'ir' || card.category === 'lighting' };
      const dstep = d.steps.begin('drive', 'writing the driver', { ...base, kind: 'opinion', model: d.spark.model });
      const result = await drive({ spark: d.spark, wonder: d.wonder, log }, card, research, cap, ids, vctx, {
        signal,
        onAttempt: (a) => d.steps.note('drive', a.ok ? `driver attempt ${a.attempt} valid` : a.error ? `driver attempt ${a.attempt} failed: ${a.error}` : `driver attempt ${a.attempt} rejected`, { ...base, kind: 'proof', status: a.ok ? 'ok' : 'fail', model: a.model, effort: a.effort, latencyMs: a.latencyMs, detail: a.issues || a.error }),
      });
      let driver: Driver;
      // provenance is the server's record (chart file, learned captures, web citations), whatever the model wrote
      const provenance = [...research.provenance, ...(result?.validation.driver.provenance ?? [])].filter((p, i, arr) => arr.findIndex((q) => q.source === p.source && q.ref === p.ref) === i).slice(0, 12);
      if (result?.validation.ok) {
        driver = { ...result.validation.driver, provenance, modelId: result.model, source: result.source };
        dstep.ok(`${driver.actions.length} actions, validated against the allowlist`, { model: result.model, effort: result.effort, latencyMs: result.latencyMs, source: result.source, recordedFrom: result.recordedFrom, evidence: `${driver.actions.length} actions · ${result.attempts} attempt(s)` });
      } else {
        // last resort: the curated template, honestly labelled
        const draft: DriverDraft = cap === 'midi' && research.profile ? templateMidiDraft(card, research.profile, research) : cap === 'ir' ? templateIrDraft(card, research) : templateLocalDraft(card, research, executor.kind);
        const v = validateDriver(draft, ids, vctx);
        if (!v.ok) {
          dstep.fail(`no valid driver: ${formatIssues(v.issues).slice(0, 300)}`);
          d.targets.setState(t, 'failed', 'could not write a valid driver');
          return;
        }
        driver = { ...v.driver, provenance, modelId: 'template', source: 'fixture' };
        dstep.ok('model draft rejected; curated template used (no Meta model wrote this driver)', { model: result?.model ?? 'template', latencyMs: result?.latencyMs, evidence: 'template driver' });
      }
      const unresolved = dryResolve(driver);
      if (unresolved.length) log(`[drive] unresolved actions: ${unresolved.join('; ')}`);
      t.driver = driver;
      t.driverIssues = result?.validation.issues;
      d.hub.broadcast('driver.spec', driver);
      d.hub.broadcast('driver.status', { driverId, cardId: t.cardId, phase: 'verifying', actions: driver.actions.map((a) => ({ actionId: a.actionId, label: a.label.slice(0, 40), verified: 'pending' as const })), modelId: driver.modelId });
      check(signal);

      // ---------------------------------------------------------------- VERIFY
      d.targets.setState(t, 'verifying', `${driver.actions.length} actions to prove`);
      const camera = pickSensor(d.roster, 'camera', { preferDeviceId: t.detection?.sensorDeviceId });
      // the device that drives it hears it best (the sim synth's own analyser, the Mac's USB audio for a real synth); a companion whose oracle is off would otherwise be preferred
      const mic = pickSensor(d.roster, 'mic', { preferDeviceId: executor.deviceId });
      const vstep = d.steps.begin('verify', `verifying on the real ${card.name}`, { ...base, kind: 'proof' });
      const summary = await verifyDriver(
        { dispatcher: d.dispatcher, sam: d.sam, heard: d.heard, readVolume: d.readVolume, silentSpeech: d.silentSpeech, log, settleMs: (tt, a) => d.settleMs?.(tt, a.encode.kind === 'ir' ? 'ir' : driver.transport) ?? (driver.transport === 'ir' ? 2000 : 350) },
        t,
        driver,
        {
          cameraDeviceId: camera?.deviceId,
          micDeviceId: mic?.deviceId,
          irCandidates: research.irLibrary?.candidates,
          signal,
          onStep: (title, detail) => d.steps.note('verify', title, { ...base, kind: 'proof', detail }),
          onEvidence: (e) => {
            t.evidence.push(e);
            d.hub.broadcast('verify.result', e);
            const sent = e.sent.op.kind === 'ir' ? `IR ${e.sent.op.bytes?.map((b) => b.toString(16).padStart(2, '0')).join(' ') ?? 'raw'}` : e.sent.op.kind === 'midi' ? `${e.sent.op.msg.toUpperCase()}${e.sent.op.number !== undefined ? ` ${e.sent.op.number}` : ''}${typeof e.sent.op.value === 'number' ? `=${e.sent.op.value}` : ''}` : `${e.sent.op.op}`;
            d.steps.note('verify', `${e.actionId}: sent ${sent} · expected ${e.expected.effect} · ${e.observed.note ?? e.observed.metric}`, { ...base, kind: 'proof', status: e.pass ? 'ok' : 'fail', evidence: `${e.pass ? 'seen ✓' : 'not seen ✗'} Δ${e.observed.delta}`, detail: JSON.stringify(e.observed) });
          },
        },
      );
      t.verification = summary.verification;
      t.driver = summary.driver;
      d.hub.broadcast('driver.spec', summary.driver);
      d.hub.broadcast('driver.status', { driverId, cardId: t.cardId, phase: summary.passed ? 'verified' : 'failed', actions: summary.driver.actions.map((a) => ({ actionId: a.actionId, label: a.label.slice(0, 40), verified: summary.verification[a.actionId] ?? 'untested' })), modelId: driver.modelId });
      if (!summary.passed) {
        const fromLibrary = cap === 'ir' && !summary.driver.provenance.some((p) => p.source === 'learned');
        if (pass === 1 && fromLibrary && receiver && d.learnIr !== false) {
          // the hero story's honest misses: nothing in the public library fits this light, so its own remote is learned next
          vstep.fail(`none of the ${summary.failed} library codes moved the ${card.name}: learning its own remote`, { evidence: 'no action verified · learning the remote' });
          learned = undefined;
          continue;
        }
        vstep.fail(`nothing the driver did was seen or heard (${summary.failed} miss${summary.failed === 1 ? '' : 'es'})`, { evidence: 'no action verified' });
        d.targets.setState(t, 'failed', 'no action could be verified on the device; controls stay disarmed');
        return;
      }
      vstep.ok(`${summary.passed} verified, ${summary.failed} missed${summary.irMatch ? ` · codes: ${summary.irMatch.brand} CH${summary.irMatch.channel}` : ''}`, { evidence: `${summary.passed} ✓ ${summary.failed} ✗` });
      d.targets.setState(t, 'verified', `${summary.passed} of ${summary.driver.actions.length} actions verified`);
      verified = summary;
    }
    if (!verified) return;
    const summary = verified;
    check(signal);
    // VERIFY may leave a light off or in its night-light mode, where dimmer steps do nothing: put it back on for the controls
    if (cap === 'ir') {
      const lit = (a: Driver['actions'][number]) => summary.verification[a.actionId] === 'pass' && a.expect?.sense === 'camera' && a.expect.effect === 'on' && !/night/i.test(`${a.actionId} ${a.label}`);
      const on = summary.driver.actions.find((a) => lit(a) && /full/i.test(`${a.actionId} ${a.label}`)) ?? summary.driver.actions.find(lit);
      if (on) {
        try {
          await d.dispatcher.exec(executor.deviceId, resolveOp(on), { port: executor.port?.id, cardId: t.cardId, driverId, actionId: on.actionId, lightCap: true, waitForSlot: true, signal, timeoutMs: 4000 });
          d.steps.note('verify', `left the ${card.name} on (${on.label}) for the controls`, { ...base, kind: 'proof' });
        } catch (e) {
          log(`[verify] could not relight the ${card.name}: ${(e as Error).message}`);
        }
      }
    }

    // ---------------------------------------------------------------- FORGE
    const forge = d.forge();
    if (!forge) {
      d.steps.note('forge', 'no forge available; controls not generated', { ...base, kind: 'proof', status: 'fail' });
      return;
    }
    d.targets.setState(t, 'forging', 'generating hacks and 3D controls');
    const fstep = d.steps.begin('forge', 'forging hacks and controls', { ...base, kind: 'opinion' });
    // the scan crop (SAM box padded 10 %, long edge <= 1024) lets Muse Image paint the panel skin; controls arm first, the skin lands as the next revision
    let crop: SkinCropImage | undefined;
    if (t.detection?.jpeg) {
      try {
        crop = cropForSkin(decodeJpeg(t.detection.jpeg), t.detection.box);
      } catch (e) {
        log(`[forge] no scan crop for the skin: ${(e as Error).message}`);
      }
    }
    const fr = await forge.generate({ device: { cardId: card.cardId, name: card.name.slice(0, 80), maker: card.maker.slice(0, 80), model: card.model.slice(0, 80), category: card.category, notes: card.notes?.slice(0, 600) }, driver: summary.driver, verification: summary.verification, ...(crop ? { crop } : {}), runId: t.runId, signal });
    if (!fr.ok || !fr.uiSpec) {
      fstep.fail(fr.error ?? 'forge failed', { model: fr.model, effort: fr.effort, latencyMs: fr.latencyMs, source: fr.source, recordedFrom: fr.recordedFrom });
      d.targets.setState(t, 'verified', `verified, but no controls could be generated: ${fr.error ?? 'forge failed'}`);
      return;
    }
    t.specId = fr.uiSpec.specId;
    fstep.ok(`${fr.uiSpec.hackset.hacks.length} hacks, ${fr.uiSpec.gen3d.controls.length} controls (rev ${fr.uiSpec.rev})`, { model: fr.model, effort: fr.effort, latencyMs: fr.latencyMs, source: fr.source, recordedFrom: fr.recordedFrom, evidence: fr.uiSpec.hackset.hacks.map((h) => h.name).join(' · ').slice(0, 64) });
    d.targets.setState(t, 'forged', `${fr.uiSpec.hackset.hacks.length} hacks ready`);
    check(signal);

    // ---------------------------------------------------------------- ARM
    const armed = await d.arm.request(t, summary.driver);
    if (armed.armed) d.hub.broadcast('driver.status', { driverId, cardId: t.cardId, phase: 'armed', actions: summary.driver.actions.map((a) => ({ actionId: a.actionId, verified: summary.verification[a.actionId] ?? 'untested' })), modelId: summary.driver.modelId });
  } catch (e) {
    if (e instanceof LoopCancelled || (e as Error).message === 'cancelled') {
      d.targets.setState(t, 'failed', 'cancelled');
      return;
    }
    log(`[loop] ${t.cardId} failed: ${(e as Error).stack ?? (e as Error).message}`);
    d.steps.note('other', `loop failed: ${(e as Error).message.slice(0, 160)}`, { ...base, kind: 'proof', status: 'fail' });
    d.targets.setState(t, 'failed', (e as Error).message.slice(0, 300));
  } finally {
    t.abort = undefined;
  }
}

export type { LinkCapability };
export { allowedCcs };
