/** The per-target state machine store; every transition is a `target.status` broadcast. */
import { newId, type AgentGuidance, type TargetState, type TargetStatusPayload } from '@ce/protocol';
import type { Hub } from '../hub';
import type { Target } from './types';
import { stateGuidance } from './guidance';

export class TargetStore {
  private readonly targets = new Map<string, Target>();
  private readonly listeners = new Set<(t: Target) => void>();

  constructor(
    private readonly hub: Pick<Hub, 'broadcast'>,
    private readonly log: (line: string) => void = () => {},
  ) {}

  list(): Target[] {
    return [...this.targets.values()];
  }

  get(cardId: string): Target | undefined {
    return this.targets.get(cardId);
  }

  remove(cardId: string): boolean {
    return this.targets.delete(cardId);
  }

  onChange(fn: (t: Target) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private counters = new Map<string, number>();

  /** "ceiling-light-1", "synthesizer-2": stable across runs for the same path, so recorded runs replay. */
  nextCardId(label: string): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';
    const n = (this.counters.get(slug) ?? 0) + 1;
    this.counters.set(slug, n);
    const id = `${slug}-${n}`;
    return this.targets.has(id) ? newId(`${slug}-`) : id;
  }

  create(partial: Partial<Target> & { cardId?: string } = {}): Target {
    const t: Target = {
      cardId: partial.cardId ?? this.nextCardId(partial.detection?.label ?? partial.card?.category ?? 'device'),
      runId: partial.runId ?? newId('run-'),
      state: 'scanned',
      since: Date.now(),
      verification: {},
      evidence: [],
      armed: false,
      stepIndex: {},
      paramValues: {},
      ...partial,
    };
    this.targets.set(t.cardId, t);
    return t;
  }

  /** Move a target to a state and tell every client. */
  setState(t: Target, state: TargetState, detail?: string, guidance?: AgentGuidance): void {
    if (this.targets.get(t.cardId) !== t) return;
    t.state = state;
    t.since = Date.now();
    t.detail = detail;
    if (state === 'failed' && detail) t.lastError = detail;
    const words = guidance ?? stateGuidance(t, state);
    t.sentence = words.sentence;
    t.hint = words.hint;
    t.action = words.action;
    const payload: TargetStatusPayload = { cardId: t.cardId, runId: t.runId, state, since: t.since, ...words };
    if (detail) payload.detail = detail.slice(0, 300);
    if (t.driver) payload.driverId = t.driver.driverId;
    if (t.specId) payload.specId = t.specId;
    if (t.link?.executorDeviceId) payload.executorDeviceId = t.link.executorDeviceId;
    this.log(`[target] ${t.cardId} -> ${state}${detail ? `: ${detail}` : ''}`);
    try {
      this.hub.broadcast('target.status', payload);
    } catch (e) {
      this.log(`[target] status broadcast failed: ${(e as Error).message}`);
    }
    for (const fn of this.listeners) fn(t);
  }

  /** Public view (no frame bytes). */
  summary(t: Target): Record<string, unknown> {
    const { detection, abort: _a, research, ...rest } = t;
    return {
      ...rest,
      detection: detection ? { ...detection, jpeg: `<${detection.jpeg.length} chars>` } : undefined,
      research: research ? { brief: research.brief.slice(0, 2000), provenance: research.provenance, profile: research.profile?.id, allowedCcs: research.allowedCcs ? [...research.allowedCcs] : undefined, learned: research.learned?.map(({ rawUs, ...l }) => ({ ...l, rawUsLength: rawUs.length })) } : undefined,
    };
  }
}
