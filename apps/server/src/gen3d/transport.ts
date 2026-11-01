/**
 * How the gen3d pipeline reaches a model: LIVE (the Meta Model API, streamed) or REPLAY (recorded real
 * runs, re-streamed at their recorded pace so the headset still sees the object assemble).
 *
 * Recording (MODEL_API_KEY + MUSE_RECORD=1): every finished generate/edit run is saved as one file under
 * apps/server/fixtures/recorded/gen3d/ with each model call's answer text, timing, usage and model id
 * (never the prompt or the key). Replay (no key): a run with the same task, device and request is played
 * back call by call through the same verification; otherwise the newest run for that task and device.
 * Replayed results say source "fixture" and carry `recordedFrom` (the Meta model that produced them).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancellableDelay, throwIfCancelled } from '../muse/cancellation';
import { ModelCallError } from '../muse/adapter';
import type { StreamClient, StreamedToolCall, StreamHandlers, StreamRequest, StreamResult, StreamUsage } from './stream';

export interface RecordedModelCall {
  label: string;
  model: string;
  effort?: string;
  text: string;
  toolCalls?: { name: string; arguments: string; id: string }[];
  finishReason?: string;
  latencyMs: number;
  ttftMs?: number;
  usage?: StreamUsage;
}

/** What a recorded run was made against, so a replay can pick it for a similar device. */
export interface RunTarget {
  kit: string;
  task: 'generate' | 'edit';
  cardId: string;
  request: string;
  mode: 'json' | 'tools';
  /** device.card category, e.g. "lighting", "synthesizer", "computer" */
  category?: string;
  /** driver transport: midi | ir | local */
  transport?: string;
  deviceName?: string;
  /** the driver's actions at recording time (ids + what they do), for remapping on replay */
  actions?: { actionId: string; kind: string; sense?: string; effect?: string; msg?: string; number?: number }[];
}

export interface RecordedRun extends RunTarget {
  kind: 'gen3d-run';
  recordedAt: string;
  calls: RecordedModelCall[];
  /** did the run end with a verified output */
  ok: boolean;
}

/** How a replayed run was chosen: the same card and request, the same card, or a similar device. */
export type ReplayMatch = 'exact' | 'card' | 'category' | 'transport';

export interface TransportRequest extends StreamRequest {
  /** "gen3d.generate", "gen3d.repair", "gen3d.edit" */
  label: string;
}

export interface TransportResult extends StreamResult {
  source: 'live' | 'fixture';
  /** replay: the Meta model that produced the recorded answer */
  recordedFrom?: string;
}

export interface ModelTransport {
  readonly source: 'live' | 'fixture';
  /** one transport session per pipeline run: replay picks the recorded run here */
  session(run: RunTarget): TransportSession;
}

export interface TransportSession {
  readonly recordedRequest?: string;
  /** replay: how the recorded run was matched (category/transport = another device: ids may need remapping) */
  readonly match?: ReplayMatch;
  /** replay: the recorded driver's actions */
  readonly recordedActions?: RunTarget['actions'];
  call(req: TransportRequest, handlers: StreamHandlers, opts?: { signal?: AbortSignal }): Promise<TransportResult>;
  /** live + recording: persist the run when it finishes */
  finish(ok: boolean): void;
}

export function runKey(r: { kit: string; task: string; cardId: string; request: string }): string {
  const norm = r.request.trim().toLowerCase().replace(/\s+/g, ' ');
  const h = createHash('sha256').update(`${r.kit}\n${r.task}\n${r.cardId}\n${norm}`).digest('hex').slice(0, 10);
  return `${r.task}.${r.cardId.replace(/[^A-Za-z0-9_-]/g, '_')}.${h}`;
}

// --- live ------------------------------------------------------------------------------------

export class LiveTransport implements ModelTransport {
  readonly source = 'live' as const;
  constructor(
    private readonly client: Pick<StreamClient, 'stream'>,
    private readonly recordDir?: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  session(run: RunTarget): TransportSession {
    const calls: RecordedModelCall[] = [];
    return {
      call: async (req, handlers, opts) => {
        const res = await this.client.stream(req, handlers, opts);
        calls.push({
          label: req.label,
          model: res.model,
          effort: req.reasoningEffort,
          text: res.content,
          toolCalls: res.toolCalls.length ? res.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments, id: t.id })) : undefined,
          finishReason: res.finishReason,
          latencyMs: res.latencyMs,
          ttftMs: res.ttftMs,
          usage: res.usage,
        });
        return { ...res, source: 'live' };
      },
      finish: (ok) => {
        if (!this.recordDir || !calls.length) return;
        const rec: RecordedRun = { kind: 'gen3d-run', ...run, recordedAt: new Date().toISOString(), calls, ok };
        try {
          mkdirSync(this.recordDir, { recursive: true });
          const file = join(this.recordDir, `${runKey(run)}.json`);
          writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
          renameSync(`${file}.tmp`, file);
          this.log(`[gen3d] recorded ${run.task} for ${run.cardId} -> ${file}`);
        } catch (e) {
          this.log(`[gen3d] could not record: ${(e as Error).message}`);
        }
      },
    };
  }
}

// --- replay ----------------------------------------------------------------------------------

export function loadRecordedRuns(dir: string | undefined): RecordedRun[] {
  if (!dir || !existsSync(dir)) return [];
  const out: RecordedRun[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedRun;
      if (r?.kind === 'gen3d-run' && Array.isArray(r.calls) && r.calls.length) out.push(r);
    } catch {
      // not a recording
    }
  }
  return out;
}

export interface ReplayOptions {
  /** 1 = recorded pace, 0 = instant, 0.5 = twice as fast */
  speed?: number;
}

export class ReplayTransport implements ModelTransport {
  readonly source = 'fixture' as const;
  constructor(
    private readonly runs: RecordedRun[],
    private readonly o: ReplayOptions = {},
  ) {}

  /** recorded runs, newest last */
  list(): RecordedRun[] {
    return [...this.runs];
  }

  /**
   * The recorded run to play back: the same card and request if there is one; else the best of the same
   * card, the same device category or the same transport (in that order), preferring runs whose actions the
   * live driver also has, then verified runs, then the newest.
   */
  find(run: RunTarget): { rec: RecordedRun; match: ReplayMatch } | undefined {
    const key = runKey(run);
    const pool = this.runs.filter((r) => r.kit === run.kit && r.task === run.task);
    const exact = pool.filter((r) => runKey(r) === key).sort((a, b) => Number(b.ok) - Number(a.ok) || b.recordedAt.localeCompare(a.recordedAt))[0];
    if (exact) return { rec: exact, match: 'exact' };
    const live = new Set((run.actions ?? []).map((a) => a.actionId));
    const overlap = (r: RecordedRun) => (r.actions?.length && live.size ? r.actions.filter((a) => live.has(a.actionId)).length / r.actions.length : 0);
    const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
    const scored = pool
      .map((r) => {
        const match: ReplayMatch | undefined = r.cardId === run.cardId ? 'card' : same(r.category, run.category) ? 'category' : same(r.transport, run.transport) ? 'transport' : undefined;
        const tier = match === 'card' ? 3 : match === 'category' ? 2 : match === 'transport' ? 1 : 0;
        return { r, match, score: tier * 10 + overlap(r) * 5 + (r.ok ? 1 : 0) + (r.mode === run.mode ? 0.5 : 0) };
      })
      .filter((x) => x.match)
      .sort((a, b) => b.score - a.score || b.r.recordedAt.localeCompare(a.r.recordedAt));
    return scored[0] ? { rec: scored[0].r, match: scored[0].match! } : undefined;
  }

  session(run: RunTarget): TransportSession {
    const found = this.find(run);
    const rec = found?.rec;
    let i = 0;
    return {
      recordedRequest: rec?.request,
      match: found?.match,
      recordedActions: rec?.actions,
      call: async (req, handlers, opts) => {
        throwIfCancelled(opts?.signal);
        if (!rec) {
          throw new ModelCallError(`FIXTURE: no recorded ${run.task} run for "${run.cardId}" or another ${run.category ?? run.transport ?? 'device'} (record one live with MUSE_RECORD=1)`);
        }
        const c = rec.calls[i++];
        if (!c) throw new ModelCallError(`FIXTURE: the recorded run for "${run.cardId}" has no call #${i} (${req.label})`);
        return replayCall(c, handlers, this.o.speed ?? 1, opts?.signal);
      },
      finish: () => {},
    };
  }
}

async function replayCall(c: RecordedModelCall, h: StreamHandlers, speed: number, signal?: AbortSignal): Promise<TransportResult> {
  const started = Date.now();
  const wait = async (ms: number) => {
    if (speed > 0 && ms > 0) await cancellableDelay(ms * speed, signal);
  };
  await wait(c.ttftMs ?? Math.min(2000, c.latencyMs / 2));
  const streamMs = Math.max(0, c.latencyMs - (c.ttftMs ?? 0));
  const toolCalls: StreamedToolCall[] = [];
  if (c.toolCalls?.length) {
    for (const [index, t] of c.toolCalls.entries()) {
      await wait(streamMs / c.toolCalls.length);
      const at = Date.now() - started;
      const call = { index, id: t.id, name: t.name, arguments: t.arguments, startedMs: at, doneMs: at };
      toolCalls.push(call);
      h.onToolCall?.(call);
    }
  }
  let content = '';
  if (c.text) {
    const pieces = 40;
    const size = Math.max(1, Math.ceil(c.text.length / pieces));
    for (let p = 0; p < c.text.length; p += size) {
      await wait(streamMs / pieces);
      const d = c.text.slice(p, p + size);
      content += d;
      h.onContent?.(d, content);
    }
  }
  return {
    content,
    toolCalls,
    finishReason: c.finishReason,
    usage: c.usage,
    model: c.model,
    ttftMs: c.ttftMs,
    latencyMs: Date.now() - started,
    chunks: 0,
    source: 'fixture',
    recordedFrom: c.model,
  };
}
