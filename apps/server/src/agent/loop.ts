/**
 * The discovery loop for one target: IDENTIFY -> LINK -> RESEARCH (-> LEARN) -> DRIVE -> VERIFY -> FORGE -> ARM.
 * Models run only here ("AI at compile time"); every step is an agent.step with the model id, effort and
 * latency, every transition a target.status, and nothing is ever sent to a device before VERIFY.
 */
import type { AgentGuidance, AgentPhase, Driver, DriverDraft } from '@ce/protocol';
import { newId } from '@ce/protocol';
import { resolveOp } from '../devices/encode';
import { isVisualSynthPort } from '../devices/visualSynth';
import { allowedCcs, type Profiles } from '../devices/profiles';
import type { MidiChartStore } from '../devices/midi-charts';
import { formatIssues, validateDriver } from '../devices/validate';
import type { Forge } from '../gen3d/forge';
import type { Hub } from '../hub';
import type { MuseChat } from '../muse/adapter';
import { cancellableDelay as sleep } from '../muse/cancellation';
import { FlowRun, PhaseTimeout } from './flow';
import { CANCELLED_GUIDANCE, failureGuidance, learnGuidance, linkGuidance, stateGuidance, stepGuidance, type TimedPhase } from './guidance';
import { decodeJpeg } from '../oracle/image';
import type { WebSearcher } from '../research/websearch';
import type { Sam } from '../scan/sam';
import { ArmService } from './arm';
import type { Dispatcher } from './dispatch';
import { drive, dryResolve, templateIrDraft, templateLocalDraft, templateMidiDraft } from './drive';
import { candidatesFor, online, pickSensor, type Roster, suggestedClients } from './executors';
import { cropForSkin, cropJpeg, identify, type IdentifyResult, type SkinCropImage } from './identify';
import { learnCodes } from './learn';
import { type LinkCapability, neededCapability, tryLink } from './link';
import { research as doResearch } from './research';
import type { StepLog } from './steps';
import type { TargetStore } from './targets';
import type { Target } from './types';
import { type VerifyDeps, type VerifySummary, verifyDriver } from './verify';
import { virtualScreenExecutor } from './visual-synth';

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
  midiCharts?: MidiChartStore;
  forge: () => Forge | undefined;
  arm: ArmService;
  /** the "say" oracle: Muse Voice Transcribe hears a spoken line back */
  heard?: VerifyDeps['heard'];
  readVolume?: VerifyDeps['readVolume'];
  restoreVolume?: VerifyDeps['restoreVolume'];
  log?: (line: string) => void;
  /** how long LINK waits for a companion to appear */
  companionWaitMs?: number;
  phaseTimeoutMs?: Partial<Record<TimedPhase, number>>;
  /** IR lamps fade; the sim is instant */
  settleMs?: (t: Target, transport: Driver['transport']) => number;
  /** learn the remote when the brand's codes are not public (Koizumi, unknown) */
  learnIr?: boolean;
  /** CE_MAC_SILENT: a recorded clip stands in for the Mac's voice (see recordedSpeech.ts) */
  silentSpeech?: VerifyDeps['silentSpeech'];
}

/** The visual synth's live driver call gets this long before the curated template stands in. */
const VISUAL_DRIVE_BUDGET_MS = Number(process.env.CE_DRIVE_TIMEOUT_MS) > 0 ? Number(process.env.CE_DRIVE_TIMEOUT_MS) : 20_000;
/** CE_DEMO=1: the one-shot demo. The silent visual synth arms itself after verification (no Enable modal). */
export const demoMode = (): boolean => process.env.CE_DEMO === '1';

/** One learn window per remote button: the user has to find the button after the prompt appears. */
const LEARN_WINDOW_MS = 10_000;
/** The second pass (after the library codes missed) gives a slower hand more time. */
const LEARN_WINDOW_RETRY_MS = 15_000;

/** Run the loop for a target that has a detection (from SCAN) or a card (a paired device the user pointed at). */
export async function runLoop(d: LoopDeps, t: Target, opts: { userText?: string; preferDeviceId?: string; identifyOnly?: boolean; identified?: Omit<IdentifyResult, 'card'>; refreshResearch?: boolean } = {}): Promise<void> {
  const log = d.log ?? (() => {});
  t.abort?.abort();
  const abort = new AbortController();
  t.abort = abort;
  const signal = abort.signal;
  const base = { cardId: t.cardId, runId: t.runId };
  let visualRestore: { deviceId: string; port?: string; driverId: string } | undefined;
  const flow = new FlowRun(abort, { ...d.phaseTimeoutMs, ...(d.companionWaitMs !== undefined ? { link: d.companionWaitMs } : {}) });
  const retryNotice = () => {
    const guidance: AgentGuidance = { sentence: 'That did not work; trying once more…', hint: 'You can cancel or choose another device', action: 'cancel' };
    d.targets.setState(t, t.state, 'retrying the model call once', guidance);
    d.steps.note(flow.phase === 'learn' ? 'research' : flow.phase, 'retrying the model call once', { ...base, ...guidance });
  };
  const fail = (detail: string, guidance = failureGuidance(flow.phase)) => {
    d.steps.failRun(base.runId, guidance);
    d.targets.setState(t, 'failed', detail, guidance);
  };
  try {
    // ---------------------------------------------------------------- IDENTIFY
    if (!t.card) {
      if (!t.detection) throw new Error('nothing to identify: no detection and no card');
      flow.enter('identify');
      d.targets.setState(t, 'identifying', `${t.detection.label} seen by ${t.detection.sensorDeviceId}`);
      const step = d.steps.begin('identify', `identifying the ${t.detection.label}`, { ...base, kind: 'opinion', model: d.spark.model });
      const img = decodeJpeg(t.detection.jpeg);
      const crop = cropJpeg(img, t.detection.box);
      const detection = t.detection;
      const r = await flow.retry(() => identify(d.spark, detection, crop, detection.jpeg, { cardId: t.cardId, userText: opts.userText, signal }), retryNotice);
      t.card = r.card;
      d.hub.broadcast('device.card', r.card);
      step.ok(`${r.card.name} (${r.card.maker} ${r.card.model}) confidence ${r.card.confidence.toFixed(2)}`, { model: r.model, effort: r.effort, latencyMs: r.latencyMs, source: r.source, recordedFrom: r.recordedFrom, evidence: (r.card.evidence[0] ?? '').slice(0, 64) });
      d.targets.setState(t, 'identified', `${r.card.name}: ${r.card.maker} ${r.card.model}`);
    } else if (opts.identified) {
      // Named quietly when it was tagged: the work log still shows which model identified it, once setup starts.
      const c = t.card;
      d.steps.begin('identify', `identified when tagged`, { ...base, kind: 'opinion', model: opts.identified.model })
        .ok(`${c.name} (${c.maker} ${c.model}) confidence ${c.confidence.toFixed(2)}`, { ...opts.identified, evidence: (c.evidence[0] ?? '').slice(0, 64) });
    }
    flow.check();
    if (opts.identifyOnly) return;
    const card = t.card;

    // ---------------------------------------------------------------- LINK
    flow.enter('link');
    const cap = neededCapability(card);
    if (!cap) {
      d.steps.note('link', `no control path for a ${card.category}`, { ...base, kind: 'proof', status: 'fail' });
      fail(`no known way to control a ${card.category}`, { sentence: 'I do not know how to control this device yet', hint: 'Cancel and choose another device', action: 'cancel' });
      return;
    }
    d.targets.setState(t, 'linking', `needs ${cap}`);
    const profile = cap === 'midi' ? (await flow.wait(doResearch({ profiles: d.profiles, web: d.web, midiCharts: d.midiCharts }, card, cap, { allowWeb: false }))).profile : undefined;
    const linkId = newId('ln');
    let announced = false;
    let link = await flow.wait(tryLink({ roster: d.roster, dispatcher: d.dispatcher }, card, cap, { linkId, profile, preferDeviceId: opts.preferDeviceId ?? t.selectedBy, signal, probeIdentity: false }));
    while (!link.executor) {
      if (!announced) {
        announced = true;
        const companionOnline = d.roster.devices().some((device) => device.online && (device.role === 'companion' || device.capabilities.includes('midi')));
        const guidance = linkGuidance(cap, companionOnline);
        d.hub.broadcast('link.request', { linkId, cardId: t.cardId, needs: [cap], reason: `${card.name} is driven over ${cap}; no paired client online can do that`, suggestedClients: suggestedClients(cap), candidates: candidatesFor(d.roster, cap), status: online(d.roster, cap).length ? 'candidates' : 'needs-companion' });
        d.steps.note('link', `needs a companion: ${suggestedClients(cap).join(' or ')} (${cap})`, { ...base, kind: 'proof', status: 'fail', ...guidance });
        d.targets.setState(t, 'needs-companion', `pair a ${suggestedClients(cap)[0]} (${cap})`, guidance);
      }
      await flow.wait(sleep(1500, signal));
      link = await flow.wait(tryLink({ roster: d.roster, dispatcher: d.dispatcher }, card, cap, { linkId, profile, preferDeviceId: opts.preferDeviceId ?? t.selectedBy, signal, probeIdentity: false }));
    }
    t.link = link.result;
    d.hub.broadcast('link.result', link.result);
    for (const e of link.result.evidence) d.steps.note('link', e.detail.slice(0, 200), { ...base, kind: 'proof', status: e.ok ? 'ok' : 'fail', evidence: `${e.kind}${e.ok ? ' ✓' : ' ✗'}` });
    if (link.result.verdict === 'mismatch') {
      d.steps.note('link', 'wrong device: refused', { ...base, kind: 'proof', status: 'fail', evidence: link.result.reason });
      fail(link.result.reason ?? 'the connected device is not the one the camera saw', { sentence: 'A different device is connected', hint: 'Connect the device you selected, then retry or cancel', action: 'retry' });
      return;
    }
    const executor = link.executor;
    d.targets.setState(t, 'linked', `${executor.name} via ${link.result.channel ?? cap}${executor.port ? ` (${executor.port.name})` : ''} · ${link.result.verdict}`);
    flow.check();

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
      if (cap === 'ir' && receiver && !learned?.length && (wantLearn || pass > 1)) {
        flow.enter('learn');
        const guidance = learnGuidance(receiver.kind === 'remo' ? 'Remo' : receiver.name);
        d.targets.setState(t, 'researching', 'learning the remote', guidance);
        const step = d.steps.begin('research', `${pass > 1 ? 'the library codes did nothing: ' : ''}learning the remote with ${receiver.name}`, { ...base, kind: 'proof', ...guidance });
        learned = await flow.wait(learnCodes({ dispatcher: d.dispatcher, steps: d.steps, log }, t, receiver.deviceId, { signal, durationMs: process.env.VITEST ? 300 : pass > 1 ? LEARN_WINDOW_RETRY_MS : LEARN_WINDOW_MS }));
        if (learned.length) step.ok(`${learned.length} codes learned`, { evidence: learned.map((l) => l.button).join(' ') });
        else {
          step.fail('no button press was captured in time', { evidence: 'nothing learned', ...failureGuidance('learn') });
          fail('no remote button was captured', failureGuidance('learn'));
          return;
        }
      }
      if (pass > 1 && !learned?.length) {
        fail('the library codes did nothing and no remote button was captured', failureGuidance('learn'));
        return;
      }
      flow.enter('research');
      d.targets.setState(t, 'researching');
      const rstep = d.steps.begin('research', cap === 'midi' ? 'looking up the MIDI chart' : cap === 'ir' ? 'looking up IR codes' : 'local actions', { ...base, kind: 'proof' });
      // USB port labels can be shared by different models (for example OP-1 and OP-1 Field).
      // Keep the identified model; a port-name hint alone cannot promote it to another model's chart.
      const research = await flow.retry(() => doResearch({ profiles: d.profiles, web: d.web, midiCharts: d.midiCharts }, card, cap, { learned, signal, refresh: opts.refreshResearch }), retryNotice);
      t.research = research;
      rstep.ok(research.provenance.map((p) => `${p.source}: ${p.ref}`).join('; ').slice(0, 400), {
        kind: research.modelId ? 'opinion' : 'proof',
        model: research.modelId,
        evidence: research.profile ? `chart: ${research.profile.id}` : research.learned?.length ? `${research.learned.length} learned codes` : research.irLibrary ? `${research.irLibrary.candidates.length} library codes` : research.provenance[0]?.source,
      });
      flow.check();
      if (cap === 'midi' && !research.allowedCcs?.size) {
        const guidance = { sentence: 'This device needs a reviewed MIDI chart', hint: 'On the Mac, open Details → MIDI chart, confirm its exact model and cited controls, then retry setup', action: 'retry' as const };
        d.steps.note('research', 'Web research is not a MIDI permission chart; no device commands were generated', { ...base, kind: 'proof', status: 'fail', ...guidance });
        fail('Missing MIDI chart: no reviewed CC permissions for this device', guidance);
        return;
      }

      // ---------------------------------------------------------------- DRIVE
      flow.enter('drive');
      d.targets.setState(t, 'driving');
      driverId = newId('drv');
      const ids = { driverId, executor: { deviceId: executor.deviceId, port: executor.port?.id }, executorKind: executor.kind };
      const reviewed = research.profile?.reviewedChart;
      const vctx = { expectedTransport: cap, allowedCcs: research.allowedCcs,
        ...(reviewed ? { allowedChannels: new Set([reviewed.channel]), ccRanges: new Map(research.profile!.parameters.filter((p) => p.cc !== null && p.range).map((p) => [p.cc!, { min: p.range![0], max: p.range![1] }])), midiCcOnly: true } : {}),
        irLibrary: research.irLibrary, learned: research.learned, executorKind: executor.kind, emitsLight: cap === 'ir' || card.category === 'lighting' };
      const dstep = d.steps.begin('drive', 'writing the driver', { ...base, kind: 'opinion', model: d.spark.model });
      // The visual synth's live driver call is bounded: a slow Muse answer falls back to the curated template below.
      const visualDrive = !!virtualScreenExecutor(card);
      const driveBudget = new AbortController();
      const driveTimer = visualDrive ? setTimeout(() => driveBudget.abort(), VISUAL_DRIVE_BUDGET_MS) : undefined;
      let result: Awaited<ReturnType<typeof drive>>;
      try {
        result = await flow.wait(drive({ spark: d.spark, wonder: d.wonder, log }, card, research, cap, ids, vctx, {
          signal: AbortSignal.any([signal, driveBudget.signal]),
          onAttempt: (a) => !signal.aborted && d.steps.note('drive', a.ok ? `driver attempt ${a.attempt} valid` : a.error ? `driver attempt ${a.attempt} failed: ${a.error}` : `driver attempt ${a.attempt} rejected`, { ...base, kind: 'proof', status: a.ok ? 'ok' : 'fail', model: a.model, effort: a.effort, latencyMs: a.latencyMs, detail: a.issues || a.error, ...(a.error ? { sentence: a.attempt === 1 ? 'That did not work; trying once more…' : 'The model could not prepare the commands', hint: 'You can retry or choose another device', action: 'retry' as const } : {}) }),
          maxAttempts: visualDrive ? 1 : 2,
        }));
      } catch (e) {
        if (signal.aborted || !driveBudget.signal.aborted) throw e;
        d.steps.note('drive', `no driver from ${d.spark.model} within ${VISUAL_DRIVE_BUDGET_MS / 1000} s; using the curated template`, { ...base, kind: 'proof', status: 'fail', model: d.spark.model });
        result = undefined;
      } finally {
        clearTimeout(driveTimer);
      }
      let driver: Driver;
      // provenance is the server's record (chart file, learned captures, web citations), whatever the model wrote
      const provenance = [...research.provenance, ...(result?.validation.driver.provenance ?? [])].filter((p, i, arr) => arr.findIndex((q) => q.source === p.source && q.ref === p.ref) === i).slice(0, 12);
      if (result?.validation.ok) {
        driver = { ...result.validation.driver, provenance, modelId: result.model, source: result.source };
        dstep.ok(`${driver.actions.length} actions, validated against the allowlist`, { model: result.model, effort: result.effort, latencyMs: result.latencyMs, source: result.source, recordedFrom: result.recordedFrom, evidence: `${driver.actions.length} actions · ${result.attempts} attempt(s)` });
      } else {
        // last resort: the curated template, honestly labelled
        const draft: DriverDraft | undefined = cap === 'midi' ? (research.profile ? templateMidiDraft(card, research.profile, research) : undefined)
          : cap === 'ir' ? templateIrDraft(card, research) : cap === 'local' ? templateLocalDraft(card, research, executor.kind) : undefined;
        if (!draft) {
          dstep.fail('The selected transport has no supported fallback');
          fail('Could not write commands for the selected MIDI device', { sentence: 'I could not prepare this device’s MIDI controls', hint: 'Review its MIDI chart on the Mac, then retry setup', action: 'retry' });
          return;
        }
        const v = validateDriver(draft, ids, vctx);
        if (!v.ok) {
          dstep.fail(`no valid driver: ${formatIssues(v.issues).slice(0, 300)}`);
          fail('could not write a valid driver');
          return;
        }
        driver = { ...v.driver, provenance, modelId: 'template', source: 'fixture' };
        dstep.ok('model draft rejected; curated template used (no Meta model wrote this driver)', { model: result?.model ?? 'template', latencyMs: result?.latencyMs, evidence: 'template driver', sentence: 'Using saved device commands after the model failed' });
      }
      const unresolved = dryResolve(driver);
      if (unresolved.length) log(`[drive] unresolved actions: ${unresolved.join('; ')}`);
      t.driver = driver;
      t.driverIssues = result?.validation.issues;
      d.hub.broadcast('driver.spec', driver);
      d.hub.broadcast('driver.status', { driverId, cardId: t.cardId, phase: 'verifying', actions: driver.actions.map((a) => ({ actionId: a.actionId, label: a.label.slice(0, 40), verified: 'pending' as const })), modelId: driver.modelId });
      flow.check();

      // ---------------------------------------------------------------- VERIFY
      flow.enter('verify');
      const virtualScreen = !!virtualScreenExecutor(t.card);
      const camera = virtualScreen
        ? d.roster.devices().find((device) => device.deviceId === t.selectedBy && device.online && device.capabilities.includes('camera'))
        : pickSensor(d.roster, 'camera', { preferDeviceId: t.detection?.sensorDeviceId });
      const headsets = online(d.roster, 'mic').filter((device) => device.kind === 'quest');
      const headset = headsets.find((device) => device.deviceId === t.detection?.sensorDeviceId)
        ?? headsets.find((device) => device.deviceId === t.selectedBy) ?? headsets[0];
      // A real synth is heard through the headset; fixture instruments keep their own analyser.
      const mic = pickSensor(d.roster, 'mic', { preferDeviceId: cap === 'midi' && executor.kind !== 'sim' ? headset?.deviceId : executor.deviceId });
      const verifyGuidance = stateGuidance(t, 'verifying');
      if (cap === 'midi' && mic && !isVisualSynthPort(driver.executor.port)) verifyGuidance.sentence = mic.kind === 'quest'
        ? 'Listening through the headset mic…'
        : mic.kind === 'sim' ? 'Checking the simulated synth…' : 'Listening through the connected microphone…';
      if (isVisualSynthPort(driver.executor.port)) verifyGuidance.sentence = 'Watching the selected screen change…';
      d.targets.setState(t, 'verifying', `${driver.actions.length} actions to prove`, verifyGuidance);
      // The identity query is device output too: keep it inside verification.
      if (cap === 'midi') {
        const identity = await flow.wait(tryLink({ roster: d.roster, dispatcher: d.dispatcher }, card, cap, { linkId, profile, preferDeviceId: executor.deviceId, signal, probeIdentity: !research.profile?.reviewedChart }));
        if (!identity.executor || identity.executor.deviceId !== executor.deviceId || identity.executor.port?.id !== executor.port?.id || identity.result.verdict === 'mismatch') {
          fail(identity.result.reason ?? 'the connected instrument changed', { sentence: 'Check the connected instrument', hint: 'Connect the instrument you selected, then retry or cancel', action: 'retry' });
          return;
        }
        t.link = identity.result;
        d.hub.broadcast('link.result', identity.result);
      }
      const vstep = d.steps.begin('verify', `verifying on the real ${card.name}`, { ...base, kind: 'proof', ...verifyGuidance });
      if (isVisualSynthPort(driver.executor.port)) visualRestore = { ...driver.executor, driverId };
      const summary = await flow.wait(verifyDriver(
        { dispatcher: d.dispatcher, sam: d.sam, heard: d.heard ? (...args) => flow.retry(() => d.heard!(...args), retryNotice) : undefined, readVolume: d.readVolume, restoreVolume: d.restoreVolume, silentSpeech: d.silentSpeech, log, settleMs: (tt, a) => d.settleMs?.(tt, a.encode.kind === 'ir' ? 'ir' : driver.transport) ?? (driver.transport === 'ir' ? 2000 : 350) },
        t,
        driver,
        {
          cameraDeviceId: camera?.deviceId,
          micDeviceId: mic?.deviceId,
          irCandidates: research.irLibrary?.candidates,
          signal,
          onStep: (title, detail) => !signal.aborted && d.steps.note('verify', title, { ...base, kind: 'proof', detail, ...verifyGuidance }),
          onEvidence: (e) => {
            if (signal.aborted) return;
            t.evidence.push(e);
            d.hub.broadcast('verify.result', e);
            const sent = e.sent.op.kind === 'ir' ? `IR ${e.sent.op.bytes?.map((b) => b.toString(16).padStart(2, '0')).join(' ') ?? 'raw'}` : e.sent.op.kind === 'midi' ? `${e.sent.op.msg.toUpperCase()}${e.sent.op.number !== undefined ? ` ${e.sent.op.number}` : ''}${typeof e.sent.op.value === 'number' ? `=${e.sent.op.value}` : ''}` : `${e.sent.op.op}`;
            d.steps.note('verify', `${e.actionId}: sent ${sent} · expected ${e.expected.effect} · ${e.observed.note ?? e.observed.metric}`, { ...base, kind: 'proof', status: e.pass ? 'ok' : 'fail', evidence: `${e.pass ? 'seen ✓' : 'not seen ✗'} Δ${e.observed.delta}`, detail: JSON.stringify(e.observed), ...verifyGuidance });
          },
        },
      ));
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
        fail('no action could be verified on the device; controls stay disarmed');
        return;
      }
      vstep.ok(`${summary.passed} verified, ${summary.failed} missed${summary.irMatch ? ` · codes: ${summary.irMatch.brand} CH${summary.irMatch.channel}` : ''}`, { evidence: `${summary.passed} ✓ ${summary.failed} ✗` });
      verified = summary;
    }
    if (!verified) return;
    const summary = verified;
    flow.check();
    if (isVisualSynthPort(summary.driver.executor.port)) {
      await flow.wait(d.dispatcher.exec(executor.deviceId, { kind: 'midi', msg: 'panic', channel: 1 }, { port: executor.port?.id, cardId: t.cardId, driverId, actionId: 'restore-visual-defaults', waitForSlot: true, signal }));
      visualRestore = undefined;
    }
    // VERIFY may leave a light off or in its night-light mode, where dimmer steps do nothing: put it back on for the controls
    if (cap === 'ir') {
      const lit = (a: Driver['actions'][number]) => summary.verification[a.actionId] === 'pass' && a.expect?.sense === 'camera' && a.expect.effect === 'on' && !/night/i.test(`${a.actionId} ${a.label}`);
      const on = summary.driver.actions.find((a) => lit(a) && /full/i.test(`${a.actionId} ${a.label}`)) ?? summary.driver.actions.find(lit);
      if (on) {
        try {
          await flow.wait(d.dispatcher.exec(executor.deviceId, resolveOp(on), { port: executor.port?.id, cardId: t.cardId, driverId, actionId: on.actionId, lightCap: true, waitForSlot: true, signal, timeoutMs: 4000 }));
          d.steps.note('verify', `left the ${card.name} on (${on.label}) for the controls`, { ...base, kind: 'proof' });
        } catch (e) {
          log(`[verify] could not relight the ${card.name}: ${(e as Error).message}`);
        }
      }
    }

    d.targets.setState(t, 'verified', `${summary.passed} of ${summary.driver.actions.length} actions verified`);

    // ---------------------------------------------------------------- FORGE
    flow.enter('forge');
    const forge = d.forge();
    if (!forge) {
      d.steps.note('forge', 'no forge available; controls not generated', { ...base, kind: 'proof', status: 'fail', ...failureGuidance('forge') });
      fail('no forge available; controls not generated');
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
    const fr = await flow.retry(async () => {
      const result = await forge.generate({ device: { cardId: card.cardId, name: card.name.slice(0, 80), maker: card.maker.slice(0, 80), model: card.model.slice(0, 80), category: card.category, notes: card.notes?.slice(0, 600) }, driver: summary.driver, verification: summary.verification, ...(crop ? { crop } : {}), runId: base.runId, signal, onProgress: (p) => Object.assign(p, stepGuidance(p.phase as AgentPhase, p.status)) });
      flow.check();
      if (!result.ok || !result.uiSpec) throw new Error(result.error ?? 'forge failed');
      return result;
    }, retryNotice);
    if (!fr.ok || !fr.uiSpec) {
      fstep.fail(fr.error ?? 'forge failed', { model: fr.model, effort: fr.effort, latencyMs: fr.latencyMs, source: fr.source, recordedFrom: fr.recordedFrom });
      fail(`verified, but no controls could be generated: ${fr.error ?? 'forge failed'}`);
      return;
    }
    t.specId = fr.uiSpec.specId;
    t.controlCount = fr.uiSpec.gen3d.controls.length;
    if (fr.fallback) d.steps.note('forge', `live forge failed (${fr.fallback.slice(0, 120)}): template fallback`, { ...base, kind: 'proof', status: 'fail', model: d.spark.model, evidence: 'template fallback' });
    fstep.ok(`${fr.uiSpec.hackset.hacks.length} hacks, ${fr.uiSpec.gen3d.controls.length} controls (rev ${fr.uiSpec.rev})${fr.fallback ? ' · template fallback' : ''}`, { model: fr.model, effort: fr.effort, latencyMs: fr.latencyMs, source: fr.source, recordedFrom: fr.recordedFrom, evidence: (fr.fallback ? 'template fallback' : fr.uiSpec.hackset.hacks.map((h) => h.name).join(' · ')).slice(0, 64) });
    d.targets.setState(t, 'forged', `${fr.uiSpec.hackset.hacks.length} hacks ready`);
    flow.check();

    // ---------------------------------------------------------------- ARM
    flow.clear();
    // CE_DEMO=1: the silent visual synth (no irreversible action) arms itself once verified; everything else asks.
    const auto = demoMode() && isVisualSynthPort(summary.driver.executor.port) && !summary.driver.actions.some((a) => a.confirm === 'hold');
    const armed = auto ? d.arm.auto(t, summary.driver, 'ControlAnything demo (CE_DEMO=1, verified silent visuals)')
      : await flow.wait(d.arm.request(t, summary.driver, undefined, signal));
    if (armed.armed) d.hub.broadcast('driver.status', { driverId, cardId: t.cardId, phase: 'armed', actions: summary.driver.actions.map((a) => ({ actionId: a.actionId, verified: summary.verification[a.actionId] ?? 'untested' })), modelId: summary.driver.modelId });
  } catch (e) {
    const reason = signal.aborted ? signal.reason : e;
    const guidance = reason instanceof PhaseTimeout ? failureGuidance(reason.phase, true) : signal.aborted ? CANCELLED_GUIDANCE : failureGuidance(flow.phase);
    // A replacement run owns the target now. Late work from the old run may only close its own steps.
    d.steps.failRun(base.runId, guidance);
    if (t.abort !== abort || t.runId !== base.runId) return;
    const detail = reason instanceof Error ? reason.message : String(reason);
    if (!signal.aborted) log(`[loop] ${t.cardId} failed: ${detail}`);
    d.steps.note(flow.phase === 'learn' ? 'research' : flow.phase, detail.slice(0, 160), { ...base, kind: 'proof', status: 'fail', ...guidance });
    d.targets.setState(t, 'failed', detail.slice(0, 300), guidance);
  } finally {
    flow.clear();
    // Verification freezes the silent screen to distinguish MIDI changes from animation.
    // Restore after a miss/cancellation too; never queue cleanup behind a replacement run.
    if (visualRestore && t.abort === abort && t.runId === base.runId) {
      try {
        await d.dispatcher.exec(visualRestore.deviceId, { kind: 'midi', msg: 'panic', channel: 1 }, {
          port: visualRestore.port, cardId: t.cardId, driverId: visualRestore.driverId,
          actionId: 'restore-visual-defaults', timeoutMs: 1000, signal: AbortSignal.timeout(1100),
        });
      } catch (error) { log(`[verify] could not restore visual defaults: ${(error as Error).message}`); }
    }
    if (t.abort === abort) t.abort = undefined;
  }
}

export type { LinkCapability };
export { allowedCcs };
