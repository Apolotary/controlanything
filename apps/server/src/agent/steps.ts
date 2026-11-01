/**
 * The live work log: every step of the loop is an `agent.step` broadcast (with model id, effort and latency
 * when a model did the work) and kept in a ring buffer for GET /api/agent/steps.
 */
import { type AgentPhase, type AgentStepPayload, newId } from '@ce/protocol';
import type { Hub } from '../hub';

export interface StepHandle {
  readonly stepId: string;
  /** update the running step (detail, model fields) */
  update(patch: Partial<AgentStepPayload>): void;
  ok(detail?: string, patch?: Partial<AgentStepPayload>): AgentStepPayload;
  fail(detail?: string, patch?: Partial<AgentStepPayload>): AgentStepPayload;
}

export interface StepOptions {
  cardId?: string;
  runId?: string;
  detail?: string;
  kind?: 'proof' | 'opinion';
  model?: string;
  effort?: string;
  source?: 'live' | 'fixture';
}

export class StepLog {
  private readonly items: AgentStepPayload[] = [];
  private readonly listeners = new Set<(s: AgentStepPayload) => void>();

  constructor(
    private readonly hub: Pick<Hub, 'broadcast'>,
    private readonly log: (line: string) => void = () => {},
    private readonly max = 500,
  ) {}

  onStep(fn: (s: AgentStepPayload) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(cardId?: string): AgentStepPayload[] {
    return cardId ? this.items.filter((s) => s.cardId === cardId) : [...this.items];
  }

  /** Start a running step; finish it with ok()/fail(). */
  begin(phase: AgentPhase, title: string, o: StepOptions = {}): StepHandle {
    const startedAt = Date.now();
    const step: AgentStepPayload = { stepId: newId('s'), phase, status: 'running', title: title.slice(0, 200), startedAt };
    if (o.cardId) step.cardId = o.cardId;
    if (o.runId) step.runId = o.runId;
    if (o.detail) step.detail = o.detail.slice(0, 4000);
    if (o.kind) step.kind = o.kind;
    if (o.model) step.model = o.model;
    if (o.effort) step.effort = o.effort;
    if (o.source) step.source = o.source;
    this.emit(step);
    const finish = (status: 'ok' | 'fail', detail?: string, patch?: Partial<AgentStepPayload>): AgentStepPayload => {
      const endedAt = Date.now();
      Object.assign(step, patch ?? {}, { status, endedAt });
      if (detail !== undefined) step.detail = detail.slice(0, 4000);
      if (step.latencyMs === undefined && (step.model || patch?.model)) step.latencyMs = endedAt - startedAt;
      this.emit(step);
      return { ...step };
    };
    return {
      stepId: step.stepId,
      update: (patch) => {
        Object.assign(step, patch);
        this.emit(step);
      },
      ok: (detail, patch) => finish('ok', detail, patch),
      fail: (detail, patch) => finish('fail', detail, patch),
    };
  }

  /** A step that is already finished (one line). */
  note(phase: AgentPhase, title: string, o: StepOptions & { status?: 'ok' | 'fail'; evidence?: string; latencyMs?: number } = {}): AgentStepPayload {
    const now = Date.now();
    const step: AgentStepPayload = { stepId: newId('s'), phase, status: o.status ?? 'ok', title: title.slice(0, 200), startedAt: now, endedAt: now };
    if (o.cardId) step.cardId = o.cardId;
    if (o.runId) step.runId = o.runId;
    if (o.detail) step.detail = o.detail.slice(0, 4000);
    if (o.kind) step.kind = o.kind;
    if (o.model) step.model = o.model;
    if (o.effort) step.effort = o.effort;
    if (o.source) step.source = o.source;
    if (o.evidence) step.evidence = o.evidence.slice(0, 64);
    if (o.latencyMs !== undefined) step.latencyMs = o.latencyMs;
    this.emit(step);
    return step;
  }

  private emit(step: AgentStepPayload): void {
    const copy = { ...step };
    const i = this.items.findIndex((s) => s.stepId === copy.stepId);
    if (i >= 0) this.items[i] = copy;
    else {
      this.items.push(copy);
      if (this.items.length > this.max) this.items.shift();
    }
    const tag = copy.model ? ` [${copy.model}${copy.effort ? ` ${copy.effort}` : ''}${copy.latencyMs !== undefined ? ` ${(copy.latencyMs / 1000).toFixed(1)}s` : ''}]` : '';
    this.log(`[agent] ${copy.phase} ${copy.status} ${copy.title}${copy.evidence ? ` · ${copy.evidence}` : ''}${tag}`);
    try {
      this.hub.broadcast('agent.step', copy);
    } catch (e) {
      this.log(`[agent] step broadcast failed: ${(e as Error).message}`);
    }
    for (const fn of this.listeners) fn(copy);
  }
}
