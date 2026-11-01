/**
 * FORGE: a verified Driver in, a ui.spec out ({specId, cardId, driverId, rev, gen3d, hackset}; @ce/protocol UiSpecPayload).
 *
 *   generate  Muse Spark writes the hack set (json_schema, streamed; each finished hack is previewed as it
 *             closes) -> mandatory checks: schema -> bindings (driver actionIds, ranges) -> presentation ->
 *             safety (3 Hz, oracle, undo, names) -> composition -> compile to ce.gen3d/1 -> geometry
 *             (packages/gen3d repairSpec + validateSpec). On errors: up to 2 repairs at medium effort with
 *             the issues and the previous answer fed back. The result carries a check report.
 *   edit      instruction + current spec -> EditSet (json_schema) -> applyPatch by id (untouched items stay
 *             byte-identical, proven per edit) -> validate + bindings -> bounded repair -> rev+1.
 *   undo/redo republish an older/newer revision as a NEW rev (nothing is lost); rearm refreshes armed flags.
 *
 * Every model call is a Meta model (live) or a replay of a recorded Meta call (FIXTURE, recordedFrom), and
 * every progress event carries the model id, effort and latency.
 */
import { museResponseFormat, newId, type UiSpecPayload } from '@ce/protocol';
import type { Control, Gen3dSpec, HackItem, Part } from '@ce/gen3d';
import type { CallLog } from '../muse/callLog';
import { RequestCancelledError } from '../muse/cancellation';
import type { MuseConfig, ReasoningEffort } from '../muse/config';
import { compileHackset, previewHack, rearmSpec, withStatus } from './compile';
import { issue, type Issue, type Stage } from './issues';
import { applyEdit, EditSet, syncHackset } from './editPatch';
import { editMessages, forgeMessages } from './forgePrompt';
import { ForgeDevice, ForgeDriver, verificationOf, type VerifyState } from './forgeTypes';
import { draftIssues, isStepper } from './forgeVerify';
import { draftAccent, draftToHack, ForgeDraft, type Hack, HackDraft, HACKSET_VERSION, type HackSet } from './hackset';
import { TopLevelItemScanner } from './partial';
import { costUsd, type StreamMessage, StreamClient, type StreamUsage } from './stream';
import { LiveTransport, loadRecordedRuns, type ModelTransport, ReplayTransport, type TransportResult, type TransportSession } from './transport';

export const FORGE_KIT = 'ce.hackset/1+ce.gen3d/1';
export const DEFAULT_FORGE_MODEL = 'muse-spark-1.3';
export const DEFAULT_EFFORT: ReasoningEffort = 'low';
export const REPAIR_EFFORT: ReasoningEffort = 'medium';
export const MAX_REPAIRS = 2;
/** a whitespace run this long outside a string means the decoder is looping (seen on Wonder, research/12) */
export const WHITESPACE_GUARD = 400;

// --- public types --------------------------------------------------------------------------------

/** A valid @ce/protocol agent.step payload (plus `item`, the piece that just streamed in). */
export interface ForgeProgress {
  stepId: string;
  runId: string;
  cardId: string;
  phase: 'forge' | 'verify' | 'deploy';
  status: 'running' | 'ok' | 'fail';
  title: string;
  detail?: string;
  /** proof = deterministic check; opinion = the model's answer */
  kind: 'proof' | 'opinion';
  /** <= 64 chars for the worklog row */
  evidence?: string;
  /** Meta model id (or the recorded one when replaying) */
  model: string;
  effort?: string;
  latencyMs?: number;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  startedAt: number;
  endedAt?: number;
  /** a finished piece of the object while the model is still writing (broadcast as ui.partial) */
  item?: { kind: 'hack'; seq: number; hack: Hack; control: Control; part?: Part; hackItem?: HackItem };
}

export interface StageSummary {
  errors: number;
  warnings: number;
}

export interface CheckReport {
  ok: boolean;
  /** model calls behind this result (1 = first shot) */
  attempts: number;
  stages: Record<Exclude<Stage, 'request'>, StageSummary>;
  errors: Issue[];
  warnings: Issue[];
  /** deterministic fixes applied without a model call */
  fixes: string[];
  history: { attempt: number; effort: string; latencyMs: number; errors: number; codes: string[] }[];
}

/** @ce/protocol ui.spec payload with the fields FORGE always sets made required. */
export type UiSpec = UiSpecPayload & {
  specId: string;
  cardId: string;
  driverId: string;
  title: string;
  rev: number;
  gen3d: Gen3dSpec;
  hackset: HackSet;
  source: 'live' | 'fixture';
  modelId: string;
  check: { ok: boolean; attempts: number; errors: number; warnings: number };
};

export interface ForgeRequest {
  device: ForgeDevice;
  driver: ForgeDriver;
  verification?: Record<string, VerifyState>;
  room?: { device: ForgeDevice; driver: ForgeDriver }[];
  request?: string;
  model?: string;
  effort?: ReasoningEffort;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (p: ForgeProgress) => void;
}

export interface EditRequest {
  specId: string;
  instruction: string;
  model?: string;
  effort?: ReasoningEffort;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (p: ForgeProgress) => void;
}

export interface ForgeResult {
  ok: boolean;
  uiSpec?: UiSpec;
  report: CheckReport;
  model: string;
  effort: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  /** replay: the request text of the recorded run that was played back */
  recordedRequest?: string;
  latencyMs: number;
  usage: StreamUsage;
  costUsd: number;
  error?: string;
}

export interface EditResult extends ForgeResult {
  touched: string[];
  untouchedIdentical: boolean;
  summary?: string;
  /** "undo" / "redo" handled without a model call */
  history?: 'undo' | 'redo';
}

export type ForgeEvent = { type: 'progress'; progress: ForgeProgress } | { type: 'spec'; uiSpec: UiSpec };

export class ForgeInputError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ForgeInputError';
  }
}

export interface Forge {
  readonly mode: 'live' | 'fixture';
  /** generate (or regenerate) the hack set + 3D spec for a device; same as forge() */
  generate(req: ForgeRequest): Promise<ForgeResult>;
  forge(req: ForgeRequest): Promise<ForgeResult>;
  /** regenerate for a device forged before, reusing its stored device, driver, room and evidence */
  generateFor(cardId: string, req?: Omit<ForgeRequest, 'device' | 'driver'>): Promise<ForgeResult>;
  /** the device, driver and evidence stored for a card, if it was forged */
  target(cardId: string): { device: ForgeDevice; driver: ForgeDriver; verification: Record<string, VerifyState> } | undefined;
  edit(req: EditRequest): Promise<EditResult>;
  undo(specId: string): EditResult;
  redo(specId: string): EditResult;
  rearm(specId: string, verification: Record<string, VerifyState>): UiSpec;
  get(specId: string): UiSpec | undefined;
  specIdFor(cardId: string): string;
  list(): UiSpec[];
  /** every progress event and every published ui.spec (for the WebSocket bridge); returns unsubscribe */
  subscribe(fn: (e: ForgeEvent) => void): () => void;
}

export interface ForgeDeps {
  muse: MuseConfig;
  callLog?: CallLog;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** override the transport (tests) */
  transport?: ModelTransport;
  /** live + MUSE_RECORD=1: where finished runs are saved; replay: where they are read from */
  recordDir?: string;
  replayDir?: string;
  /** replay pace: 1 = recorded timing, 0 = instant */
  replaySpeed?: number;
  model?: string;
}

// --- helpers ----------------------------------------------------------------------------------------

const STAGES: Exclude<Stage, 'request'>[] = ['schema', 'bindings', 'presentation', 'geometry', 'safety', 'composition'];

function emptyUsage(): StreamUsage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
}

function addUsage(a: StreamUsage, b?: StreamUsage): StreamUsage {
  if (!b) return a;
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens, cachedTokens: a.cachedTokens + b.cachedTokens };
}

function report(errors: Issue[], warnings: Issue[], fixes: string[], history: CheckReport['history']): CheckReport {
  const stages = Object.fromEntries(STAGES.map((s) => [s, { errors: 0, warnings: 0 }])) as CheckReport['stages'];
  for (const i of errors) if (i.stage !== 'request') stages[i.stage].errors++;
  for (const i of warnings) if (i.stage !== 'request') stages[i.stage].warnings++;
  return { ok: errors.length === 0, attempts: history.length, stages, errors, warnings, fixes, history };
}

const fmtIssue = (i: Issue) => `${i.path}: ${i.message}`;

function schemaIssues(e: { issues: { path: PropertyKey[]; message: string }[] }): Issue[] {
  return e.issues.slice(0, 20).map((i) => issue('schema', 'schema', i.path.map(String).join('.') || '(root)', i.message));
}

function stageLine(r: CheckReport): string {
  return STAGES.map((s) => `${s} ${r.stages[s].errors ? `✗${r.stages[s].errors}` : '✓'}`).join(' · ');
}

/** Whitespace run at the end of the text, outside strings (cheap: only the tail is scanned). */
function trailingWhitespace(text: string): number {
  let n = 0;
  for (let i = text.length - 1; i >= 0 && n <= WHITESPACE_GUARD; i--) {
    const ch = text.charCodeAt(i);
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9) n++;
    else break;
  }
  return n;
}

const RISES = new Set(['brighter', 'on', 'louder', 'tone-up']);
const FALLS = new Set(['dimmer', 'off', 'quieter', 'tone-down']);

/** A stepper's first command must raise its param: swap [darker, brighter] or, for a warmth param, [cooler, warmer]. */
function stepperInverted(h: HackDraft, driver: ForgeDriver): boolean {
  const byId = new Map(driver.actions.map((a) => [a.actionId, a]));
  if (!isStepper(h, byId)) return false;
  const [up, down] = h.commands.map((c) => byId.get(c.action)?.expect?.effect ?? '');
  const p = h.params.find((x) => x.id === h.control.param) ?? h.params[0];
  const name = `${p?.name ?? ''} ${p?.id ?? ''}`.toLowerCase();
  if (/warm/.test(name)) return up === 'cooler' && down === 'warmer';
  if (/cool|white|kelvin|cct/.test(name)) return up === 'warmer' && down === 'cooler';
  return FALLS.has(up) && RISES.has(down);
}

/** Deterministic fixes the model need not be asked for. */
function normalizeDraft(draft: ForgeDraft, driver: ForgeDriver): { draft: ForgeDraft; fixes: string[] } {
  const fixes: string[] = [];
  const hacks = draft.hacks.map((h): HackDraft => {
    const next = structuredClone(h);
    const actions = new Map(driver.actions.map((a) => [a.actionId, a]));
    // the driver knows the undo action: use it when the model left the undo empty
    if (next.kind === 'action' && !next.inverse.commands.length && !next.inverse.restore) {
      const inv = next.commands.map((c) => actions.get(c.action)?.inverseActionId).filter(Boolean) as string[];
      if (inv.length && inv.length === next.commands.length) {
        next.inverse.commands = [...inv].reverse().map((action) => ({ action, delayMs: 0, param: '', value: 0 }));
        fixes.push(`${h.id}: undo taken from the driver (${inv.join(', ')})`);
      }
    }
    // irreversible on the device -> hold to confirm
    if (next.commands.some((c) => actions.get(c.action)?.confirm === 'hold') && next.confirm !== 'hold') {
      next.confirm = 'hold';
      next.reversible = false;
      next.inverse = { commands: [], restore: '' };
      fixes.push(`${h.id}: confirm "hold" (the driver marks it irreversible)`);
    }
    if (stepperInverted(next, driver)) {
      next.commands = [next.commands[1], next.commands[0]];
      fixes.push(`${h.id}: stepper commands reordered so the first raises "${next.control.param}"`);
    }
    // a control with exactly one param: point dangling refs at it
    if (next.kind === 'control' && next.params.length === 1) {
      const only = next.params[0].id;
      if (next.control.param !== only) {
        fixes.push(`${h.id}: control.param "${next.control.param}" -> "${only}"`);
        next.control.param = only;
      }
      for (const c of next.commands) {
        if (c.param && c.param !== only) {
          fixes.push(`${h.id}: command param "${c.param}" -> "${only}"`);
          c.param = only;
        }
      }
      if (next.inverse.restore && next.inverse.restore !== only && !draft.hacks.some((o) => o.params.some((p) => p.id === next.inverse.restore))) {
        fixes.push(`${h.id}: inverse.restore -> "${only}"`);
        next.inverse.restore = only;
      }
    }
    return next;
  });
  return { draft: { ...draft, hacks }, fixes };
}

function canonicalHackset(draft: ForgeDraft, device: ForgeDevice, driver: ForgeDriver, verification: Record<string, VerifyState>, modelId: string, source: 'live' | 'fixture'): HackSet {
  const hs: HackSet = {
    spec: HACKSET_VERSION,
    device: { id: device.cardId, name: device.name.slice(0, 60), ...(device.category ? { kind: device.category.slice(0, 32) } : {}), channel: { type: driver.transport, ...(driver.executor?.deviceId ? { via: driver.executor.deviceId } : {}) } },
    hacks: draft.hacks.map(draftToHack),
    daemons: [],
    source,
    modelId,
  };
  return withStatus(hs, verification);
}

// --- store ---------------------------------------------------------------------------------------

interface Entry {
  specId: string;
  device: ForgeDevice;
  driver: ForgeDriver;
  room: { device: ForgeDevice; driver: ForgeDriver }[];
  verification: Record<string, VerifyState>;
  revs: UiSpec[];
  cursor: number;
}

const MAX_REVS = 30;

// --- the forge -------------------------------------------------------------------------------------

export function createForge(deps: ForgeDeps): Forge {
  const log = deps.log ?? (() => {});
  const transport: ModelTransport =
    deps.transport ??
    (deps.muse.mode === 'live'
      ? new LiveTransport(new StreamClient({ apiKey: deps.muse.apiKey, baseUrl: deps.muse.baseUrl, fetchImpl: deps.fetchImpl }), deps.recordDir, log)
      : new ReplayTransport(loadRecordedRuns(deps.replayDir), { speed: deps.replaySpeed ?? 1 }));
  const defaultModel = deps.model ?? DEFAULT_FORGE_MODEL;
  const store = new Map<string, Entry>();
  const listeners = new Set<(e: ForgeEvent) => void>();

  const publish = (e: ForgeEvent) => {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        log(`[gen3d] listener failed: ${(err as Error).message}`);
      }
    }
  };

  const specIdFor = (cardId: string) => `spec_${cardId.replace(/[^A-Za-z0-9_.:-]/g, '_')}`.slice(0, 64);

  /** One model call through the transport, logged in the shared Meta call log. */
  async function call(
    session: TransportSession,
    label: string,
    messages: StreamMessage[],
    rf: unknown,
    model: string,
    effort: ReasoningEffort,
    onText: (soFar: string) => void,
    signal?: AbortSignal,
  ): Promise<TransportResult & { degenerate?: boolean }> {
    const guard = new AbortController();
    const onAbort = () => guard.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let degenerate = false;
    const at = Date.now();
    try {
      const res = await session.call(
        { label, model, messages, responseFormat: rf as Record<string, unknown>, reasoningEffort: effort, maxTokens: 16_000, promptCacheKey: 'ce-forge-1' },
        {
          onContent: (_d, soFar) => {
            if (trailingWhitespace(soFar) > WHITESPACE_GUARD) {
              degenerate = true;
              guard.abort();
              return;
            }
            onText(soFar);
          },
        },
        { signal: guard.signal },
      );
      if (degenerate) {
        deps.callLog?.add({ at, label, model, source: transport.source, ok: false, latencyMs: Date.now() - at, format: 'json_schema', effort, error: 'whitespace loop (aborted by guard)' });
        return { ...res, content: '', degenerate: true };
      }
      deps.callLog?.add({ at, label, model: res.source === 'fixture' ? 'fixture' : res.model, source: res.source, ok: true, latencyMs: res.latencyMs, format: 'json_schema', effort, finishReason: res.finishReason, usage: res.usage ? { ...res.usage, totalTokens: res.usage.promptTokens + res.usage.completionTokens } : undefined, recordedFrom: res.recordedFrom });
      return res;
    } catch (e) {
      if (degenerate && !signal?.aborted) {
        deps.callLog?.add({ at, label, model, source: transport.source, ok: false, latencyMs: Date.now() - at, format: 'json_schema', effort, error: 'whitespace loop (aborted by guard)' });
        return { content: '', toolCalls: [], model, latencyMs: Date.now() - at, chunks: 0, source: transport.source, degenerate: true };
      }
      if (e instanceof RequestCancelledError) throw e;
      deps.callLog?.add({ at, label, model, source: transport.source, ok: false, latencyMs: Date.now() - at, format: 'json_schema', effort, error: (e as Error).message.slice(0, 300) });
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function stepper(runId: string, cardId: string, onProgress: ((p: ForgeProgress) => void) | undefined) {
    let n = 0;
    return (p: Omit<ForgeProgress, 'stepId' | 'runId' | 'startedAt' | 'cardId' | 'kind'> & { stepId?: string; startedAt?: number; kind?: ForgeProgress['kind'] }) => {
      const full = { stepId: p.stepId ?? `${runId}.${++n}`, runId, cardId, startedAt: p.startedAt ?? Date.now(), kind: p.kind ?? (p.phase === 'verify' ? 'proof' : 'opinion'), ...p } as ForgeProgress;
      try {
        onProgress?.(full);
      } catch {
        // a caller's progress handler must not break generation
      }
      publish({ type: 'progress', progress: full });
      return full;
    };
  }

  function commit(entry: Entry, ui: UiSpec): UiSpec {
    entry.revs = entry.revs.slice(0, entry.cursor + 1);
    entry.revs.push(ui);
    if (entry.revs.length > MAX_REVS) entry.revs.shift();
    entry.cursor = entry.revs.length - 1;
    store.set(entry.specId, entry);
    publish({ type: 'spec', uiSpec: ui });
    return ui;
  }

  const latestRev = (e: Entry) => Math.max(0, ...e.revs.map((r) => r.rev));

  async function forge(req: ForgeRequest): Promise<ForgeResult> {
    const dev = ForgeDevice.safeParse(req.device);
    const drv = ForgeDriver.safeParse(req.driver);
    if (!dev.success || !drv.success) {
      const bad = [...(dev.success ? [] : dev.error.issues.map((i) => `device.${i.path.join('.')}: ${i.message}`)), ...(drv.success ? [] : drv.error.issues.map((i) => `driver.${i.path.join('.')}: ${i.message}`))];
      throw new ForgeInputError('forge needs {device, driver} (SPEC §3.2)', bad.slice(0, 20));
    }
    const device = dev.data;
    const driver = drv.data;
    const runId = req.runId ?? newId('forge_');
    const model = req.model ?? defaultModel;
    const firstEffort = req.effort ?? DEFAULT_EFFORT;
    const verification = verificationOf(driver, req.verification);
    const request = req.request?.trim() || `generate a hack set for the ${device.name}`;
    const specId = specIdFor(device.cardId);
    const existing = store.get(specId);
    const step = stepper(runId, device.cardId, req.onProgress);
    const session = transport.session({ kit: FORGE_KIT, task: 'generate', cardId: device.cardId, request, mode: 'json' });
    const rf = museResponseFormat('ce_hackset', ForgeDraft, { description: 'The hack set for one device: hacks bound to its driver actions.' });
    const started = Date.now();
    let usage = emptyUsage();
    let errors: Issue[] = [];
    let warnings: Issue[] = [];
    let fixes: string[] = [];
    const history: CheckReport['history'] = [];
    let previous: string | undefined;
    let result: { hackset: HackSet; gen3d: Gen3dSpec; title: string } | undefined;
    let last: TransportResult | undefined;
    let modelUsed = model;

    try {
      for (let attempt = 1; attempt <= 1 + MAX_REPAIRS; attempt++) {
        const effort = attempt === 1 ? firstEffort : REPAIR_EFFORT;
        const t0 = Date.now();
        const gen = step({
          phase: 'forge',
          status: 'running',
          title: attempt === 1 ? `Forging hacks for ${device.name}` : `Repair ${attempt - 1}/${MAX_REPAIRS}: fixing ${errors.length} issue${errors.length === 1 ? '' : 's'}`,
          detail: attempt === 1 ? `request: ${request}` : errors.slice(0, 3).map(fmtIssue).join(' | '),
          model,
          effort,
          source: transport.source,
        });
        const scanner = new TopLevelItemScanner();
        let streamed = 0;
        const res = await call(
          session,
          attempt === 1 ? 'gen3d.forge' : 'gen3d.forge.repair',
          forgeMessages({ device, driver, verification, request, room: req.room, current: existing?.revs[existing.cursor]?.hackset, repair: attempt > 1 ? { issues: errors.slice(0, 20).map(fmtIssue), previous } : undefined }),
          rf,
          model,
          effort,
          (soFar) => {
            for (const it of scanner.push(soFar)) {
              if (it.key !== 'hacks') continue;
              const d = HackDraft.safeParse(it.value);
              if (!d.success) continue;
              const h = draftToHack(d.data);
              const seq = streamed++;
              const pv = previewHack(h, seq, device, driver, verification, draftAccent(d.data));
              step({ phase: 'forge', status: 'ok', title: `+ ${h.name}`, detail: h.blurb, model, effort, latencyMs: Date.now() - t0, source: transport.source, item: { kind: 'hack', seq, hack: h, control: pv.control, part: pv.part, hackItem: pv.item } });
            }
          },
          req.signal,
        );
        last = res;
        modelUsed = res.recordedFrom ?? res.model ?? model;
        usage = addUsage(usage, res.usage);
        step({ stepId: gen.stepId, startedAt: gen.startedAt, endedAt: Date.now(), phase: 'forge', status: res.degenerate ? 'fail' : 'ok', title: res.degenerate ? 'Muse looped on whitespace; retrying' : `Muse answered in ${(res.latencyMs / 1000).toFixed(1)} s`, detail: res.usage ? `in ${res.usage.promptTokens} (cached ${res.usage.cachedTokens}) · out ${res.usage.completionTokens} (reasoning ${res.usage.reasoningTokens})` : undefined, model: modelUsed, effort, latencyMs: res.latencyMs, source: res.source, recordedFrom: res.recordedFrom });

        // 1. schema
        let draft: ForgeDraft | undefined;
        errors = [];
        warnings = [];
        if (res.degenerate) errors.push(issue('schema', 'degenerate_output', '(root)', 'the answer degenerated into whitespace; answer with the JSON object only'));
        else {
          let value: unknown;
          try {
            value = JSON.parse(res.content);
          } catch {
            errors.push(issue('schema', 'not_json', '(root)', `the answer is not valid JSON (finish=${res.finishReason ?? '?'})`));
          }
          if (!errors.length) {
            const p = ForgeDraft.safeParse(value);
            if (!p.success) errors.push(...schemaIssues(p.error));
            else draft = p.data;
          }
        }
        // 2-5. bindings, presentation, safety, composition
        if (draft) {
          const n = normalizeDraft(draft, driver);
          draft = n.draft;
          fixes = n.fixes;
          const all = draftIssues(draft, driver);
          errors = all.filter((i) => i.severity === 'error');
          warnings = all.filter((i) => i.severity === 'warn');
        }
        // 6. compile + geometry (packages/gen3d validators)
        if (draft && !errors.length) {
          const hackset = canonicalHackset(draft, device, driver, verification, modelUsed, res.source);
          const rev = existing ? latestRev(existing) + 1 : 1;
          const accents = Object.fromEntries(draft.hacks.map((d) => [d.id, draftAccent(d)]).filter(([, a]) => a)) as Record<string, string>;
          const compiled = compileHackset({ specId, rev, title: draft.title, hackset, device, driver, verification, accents, modelIds: [modelUsed], source: res.source });
          fixes.push(...compiled.fixes);
          warnings.push(...compiled.warnings.map((w) => issue('geometry', w.code, w.path, w.message, 'warn')));
          if (!compiled.ok) errors.push(...compiled.errors.map((e) => issue('geometry', e.code, e.path, e.message)));
          else result = { hackset, gen3d: compiled.spec, title: draft.title };
        }
        history.push({ attempt, effort, latencyMs: res.latencyMs, errors: errors.length, codes: [...new Set(errors.map((e) => e.code))] });
        const r = report(errors, warnings, fixes, history);
        step({ phase: 'verify', status: errors.length ? 'fail' : 'ok', title: errors.length ? `Checks failed: ${errors.length} issue${errors.length === 1 ? '' : 's'}` : 'Checks passed', evidence: errors.length ? `✗ ${[...new Set(errors.map((x) => x.code))].slice(0, 3).join(', ')}`.slice(0, 64) : 'schema · bindings · geometry · safety ✓', detail: `${stageLine(r)}${errors.length ? ` | ${errors.slice(0, 2).map(fmtIssue).join(' | ')}` : ''}`, model: modelUsed, effort, latencyMs: Date.now() - started, source: res.source, recordedFrom: res.recordedFrom, endedAt: Date.now() });
        if (!errors.length) break;
        previous = res.content.slice(0, 12_000);
        // geometry errors come from the compiler, not the model: a repair would not help
        if (errors.every((e) => e.stage === 'geometry')) break;
      }
    } catch (e) {
      session.finish(false);
      if (e instanceof RequestCancelledError) throw e;
      const msg = (e as Error).message;
      step({ phase: 'forge', status: 'fail', title: 'Muse call failed', detail: msg.slice(0, 300), model, effort: firstEffort, latencyMs: Date.now() - started, source: transport.source, endedAt: Date.now() });
      return { ok: false, report: report([issue('schema', 'model_call', '(root)', msg)], [], fixes, history), model, effort: firstEffort, source: transport.source, latencyMs: Date.now() - started, usage, costUsd: costUsd(model, usage), error: msg };
    }
    session.finish(Boolean(result));
    const rep = report(result ? [] : errors, warnings, fixes, history);
    const base = { report: rep, model: modelUsed, effort: firstEffort, source: last?.source ?? transport.source, recordedFrom: last?.recordedFrom, recordedRequest: session.recordedRequest, latencyMs: Date.now() - started, usage, costUsd: costUsd(modelUsed, usage) };
    if (!result) return { ok: false, ...base, error: `verification failed after ${history.length} attempt(s)` };
    const ui: UiSpec = {
      specId,
      cardId: device.cardId,
      driverId: driver.driverId,
      title: result.gen3d.title,
      rev: result.gen3d.rev,
      gen3d: result.gen3d,
      hackset: result.hackset,
      source: base.source,
      modelId: modelUsed,
      ...(base.recordedFrom ? { recordedFrom: base.recordedFrom } : {}),
      check: { ok: true, attempts: rep.attempts, errors: 0, warnings: rep.warnings.length },
    };
    const entry: Entry = existing ?? { specId, device, driver, room: req.room ?? [], verification, revs: [], cursor: -1 };
    Object.assign(entry, { device, driver, room: req.room ?? entry.room, verification });
    commit(entry, ui);
    const controls = result.hackset.hacks.filter((h) => h.kind === 'control').length;
    step({ phase: 'deploy', status: 'ok', title: `Hack set ready: ${result.hackset.hacks.length} hacks (${controls} controls)`, evidence: `${result.gen3d.controls.filter((c) => c.armed).length}/${result.gen3d.controls.length} armed · rev ${ui.rev}`, detail: `${result.gen3d.controls.filter((c) => c.armed).length}/${result.gen3d.controls.length} armed · rev ${ui.rev}${rep.attempts > 1 ? ` · repaired ${rep.attempts - 1}×` : ''}`, model: modelUsed, effort: firstEffort, latencyMs: base.latencyMs, source: base.source, recordedFrom: base.recordedFrom, endedAt: Date.now() });
    return { ok: true, uiSpec: ui, ...base };
  }

  function getEntry(specId: string): Entry {
    const e = store.get(specId);
    if (!e || e.cursor < 0) throw new ForgeInputError(`no spec "${specId}"; forge one first`, [], 404);
    return e;
  }

  function historyMove(specId: string, dir: 'undo' | 'redo'): EditResult {
    const e = getEntry(specId);
    const to = dir === 'undo' ? e.cursor - 1 : e.cursor + 1;
    const cur = e.revs[e.cursor];
    const empty = { model: cur.modelId, effort: '-', source: cur.source, latencyMs: 0, usage: emptyUsage(), costUsd: 0, touched: [] as string[], untouchedIdentical: true, history: dir };
    if (to < 0 || to >= e.revs.length) {
      return { ok: false, ...empty, report: report([issue('schema', `nothing_to_${dir}`, '(root)', `nothing to ${dir}`)], [], [], []), error: `nothing to ${dir}` };
    }
    const target = e.revs[to];
    const rev = latestRev(e) + 1;
    // republish the older/newer content as a new revision; history keeps every revision
    const ui: UiSpec = { ...structuredClone(target), rev, gen3d: { ...structuredClone(target.gen3d), rev } };
    e.cursor = to;
    e.revs[to] = ui;
    store.set(specId, e);
    publish({ type: 'spec', uiSpec: ui });
    return { ok: true, ...empty, uiSpec: ui, report: report([], [], [], []), summary: `${dir} -> content of an earlier revision as rev ${rev}` };
  }

  async function edit(req: EditRequest): Promise<EditResult> {
    const e = getEntry(req.specId);
    const instruction = req.instruction.trim();
    if (!instruction) throw new ForgeInputError('edit needs an instruction');
    if (/^(undo|undo that|go back|revert( that)?)[.!]?$/i.test(instruction)) return historyMove(req.specId, 'undo');
    if (/^(redo|redo that)[.!]?$/i.test(instruction)) return historyMove(req.specId, 'redo');
    const current = e.revs[e.cursor];
    const runId = req.runId ?? newId('edit_');
    const model = req.model ?? defaultModel;
    const firstEffort = req.effort ?? DEFAULT_EFFORT;
    const step = stepper(runId, e.device.cardId, req.onProgress);
    const session = transport.session({ kit: FORGE_KIT, task: 'edit', cardId: e.device.cardId, request: instruction, mode: 'json' });
    const rf = museResponseFormat('ce_gen3d_edit', EditSet, { description: 'Changed items of a ce.gen3d/1 object, by id.' });
    const started = Date.now();
    let usage = emptyUsage();
    let errors: Issue[] = [];
    let warnings: Issue[] = [];
    const history: CheckReport['history'] = [];
    let previous: string | undefined;
    let applied: { spec: Gen3dSpec; touched: string[]; untouchedIdentical: boolean; summary: string } | undefined;
    let last: TransportResult | undefined;
    let modelUsed = model;
    try {
      for (let attempt = 1; attempt <= 1 + MAX_REPAIRS; attempt++) {
        const effort = attempt === 1 ? firstEffort : REPAIR_EFFORT;
        const gen = step({ phase: 'forge', status: 'running', title: attempt === 1 ? `Editing: ${instruction}`.slice(0, 200) : `Repair ${attempt - 1}/${MAX_REPAIRS}: fixing ${errors.length} issue${errors.length === 1 ? '' : 's'}`, model, effort, source: transport.source });
        const res = await call(session, attempt === 1 ? 'gen3d.edit' : 'gen3d.edit.repair', editMessages({ spec: current.gen3d, hackset: current.hackset, driver: e.driver, instruction, repair: attempt > 1 ? { issues: errors.slice(0, 20).map(fmtIssue), previous } : undefined }), rf, model, effort, () => {}, req.signal);
        last = res;
        modelUsed = res.recordedFrom ?? res.model ?? model;
        usage = addUsage(usage, res.usage);
        step({ stepId: gen.stepId, startedAt: gen.startedAt, endedAt: Date.now(), phase: 'forge', status: res.degenerate ? 'fail' : 'ok', title: res.degenerate ? 'Muse looped on whitespace; retrying' : `Muse answered in ${(res.latencyMs / 1000).toFixed(1)} s`, model: modelUsed, effort, latencyMs: res.latencyMs, source: res.source, recordedFrom: res.recordedFrom });
        errors = [];
        warnings = [];
        let set: EditSet | undefined;
        if (res.degenerate) errors.push(issue('schema', 'degenerate_output', '(root)', 'the answer degenerated into whitespace; answer with the JSON object only'));
        else {
          try {
            const p = EditSet.safeParse(JSON.parse(res.content));
            if (!p.success) errors.push(...schemaIssues(p.error));
            else set = p.data;
          } catch {
            errors.push(issue('schema', 'not_json', '(root)', 'the answer is not valid JSON'));
          }
        }
        if (set) {
          const a = applyEdit(current.gen3d, set, e.driver);
          errors.push(...a.issues.filter((i) => i.severity === 'error'));
          warnings.push(...a.issues.filter((i) => i.severity === 'warn'));
          if (a.ok && a.spec) applied = { spec: a.spec, touched: a.touched, untouchedIdentical: a.untouchedIdentical, summary: set.summary };
        }
        history.push({ attempt, effort, latencyMs: res.latencyMs, errors: errors.length, codes: [...new Set(errors.map((x) => x.code))] });
        const r = report(errors, warnings, [], history);
        step({ phase: 'verify', status: errors.length ? 'fail' : 'ok', title: errors.length ? `Checks failed: ${errors.length} issue${errors.length === 1 ? '' : 's'}` : `Checks passed · ${applied?.touched.length ?? 0} items changed, the rest byte-identical`, detail: `${stageLine(r)}${errors.length ? ` | ${errors.slice(0, 2).map(fmtIssue).join(' | ')}` : ''}`, model: modelUsed, effort, latencyMs: Date.now() - started, source: res.source, recordedFrom: res.recordedFrom, endedAt: Date.now() });
        if (applied) break;
        previous = res.content.slice(0, 12_000);
      }
    } catch (err) {
      session.finish(false);
      if (err instanceof RequestCancelledError) throw err;
      const msg = (err as Error).message;
      step({ phase: 'forge', status: 'fail', title: 'Muse call failed', detail: msg.slice(0, 300), model, effort: firstEffort, latencyMs: Date.now() - started, source: transport.source, endedAt: Date.now() });
      return { ok: false, report: report([issue('schema', 'model_call', '(root)', msg)], [], [], history), model, effort: firstEffort, source: transport.source, latencyMs: Date.now() - started, usage, costUsd: costUsd(model, usage), error: msg, touched: [], untouchedIdentical: true };
    }
    session.finish(Boolean(applied));
    const rep = report(applied ? [] : errors, warnings, [], history);
    const base = { report: rep, model: modelUsed, effort: firstEffort, source: last?.source ?? transport.source, recordedFrom: last?.recordedFrom, recordedRequest: session.recordedRequest, latencyMs: Date.now() - started, usage, costUsd: costUsd(modelUsed, usage) };
    if (!applied) return { ok: false, ...base, error: `edit failed verification after ${history.length} attempt(s)`, touched: [], untouchedIdentical: true };
    const hackset = syncHackset(current.hackset, applied.spec, e.driver);
    const rearmed = rearmSpec({ ...applied.spec, modelId: modelUsed.slice(0, 60), source: base.source }, hackset, e.verification);
    const rev = latestRev(e) + 1;
    const ui: UiSpec = {
      specId: e.specId,
      cardId: e.device.cardId,
      driverId: e.driver.driverId,
      title: rearmed.spec.title,
      rev,
      gen3d: { ...rearmed.spec, rev },
      hackset: rearmed.hackset,
      source: base.source,
      modelId: modelUsed,
      ...(base.recordedFrom ? { recordedFrom: base.recordedFrom } : {}),
      check: { ok: true, attempts: rep.attempts, errors: 0, warnings: rep.warnings.length },
    };
    commit(e, ui);
    step({ phase: 'deploy', status: 'ok', title: `Edit applied: ${applied.summary || instruction}`.slice(0, 200), detail: `rev ${rev} · changed ${applied.touched.join(', ') || 'nothing'}`, model: modelUsed, effort: firstEffort, latencyMs: base.latencyMs, source: base.source, recordedFrom: base.recordedFrom, endedAt: Date.now() });
    return { ok: true, uiSpec: ui, ...base, touched: applied.touched, untouchedIdentical: applied.untouchedIdentical, summary: applied.summary };
  }

  function rearm(specId: string, verification: Record<string, VerifyState>): UiSpec {
    const e = getEntry(specId);
    e.verification = { ...e.verification, ...verification };
    const cur = e.revs[e.cursor];
    const r = rearmSpec(cur.gen3d, cur.hackset, e.verification);
    const rev = latestRev(e) + 1;
    return commit(e, { ...cur, rev, gen3d: { ...r.spec, rev }, hackset: r.hackset });
  }

  const target = (cardId: string) => {
    const e = store.get(specIdFor(cardId));
    return e ? { device: e.device, driver: e.driver, verification: e.verification } : undefined;
  };

  return {
    mode: transport.source === 'live' ? 'live' : 'fixture',
    generate: forge,
    forge,
    target,
    generateFor: (cardId, req = {}) => {
      const e = store.get(specIdFor(cardId));
      if (!e) throw new ForgeInputError(`no device "${cardId}" has been forged yet; send {device, driver}`, [], 404);
      return forge({ room: e.room, verification: e.verification, ...req, device: e.device, driver: e.driver });
    },
    edit,
    undo: (id) => historyMove(id, 'undo'),
    redo: (id) => historyMove(id, 'redo'),
    rearm,
    get: (id) => {
      const e = store.get(id);
      return e && e.cursor >= 0 ? e.revs[e.cursor] : undefined;
    },
    specIdFor,
    list: () => [...store.values()].filter((e) => e.cursor >= 0).map((e) => e.revs[e.cursor]),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
