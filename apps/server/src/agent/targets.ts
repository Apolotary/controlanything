/** The per-target state machine store; every transition is a `target.status` broadcast. */
import { newId, type AgentGuidance, type TargetState, type TargetStatusPayload } from '@ce/protocol';
import type { Hub } from '../hub';
import type { Target } from './types';
import { stateGuidance } from './guidance';

export type TargetChange = 'state' | 'value';

export class TargetStore {
  private readonly targets = new Map<string, Target>();
  private readonly listeners = new Set<(t: Target, kind: TargetChange) => void>();
  private statusProjection?: (target: Target, status: TargetStatusPayload) => TargetStatusPayload;

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

  /** Attach current connection/control availability to saved or reconnecting states. */
  setStatusProjection(project: (target: Target, status: TargetStatusPayload) => TargetStatusPayload): void { this.statusProjection = project; }

  remove(cardId: string): boolean {
    return this.targets.delete(cardId);
  }

  onChange(fn: (t: Target, kind: TargetChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Notify durable observers. kind 'value': only an acknowledged control value changed (a dial, up to 20 Hz), so
   * observers may batch it; 'state': anything else.
   */
  changed(t: Target, kind: TargetChange = 'state'): void {
    if (this.targets.get(t.cardId) === t) for (const fn of this.listeners) fn(t, kind);
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
    this.log(`[target] ${t.cardId} -> ${state}${detail ? `: ${detail}` : ''}`);
    try {
      this.hub.broadcast('target.status', this.status(t));
    } catch (e) {
      this.log(`[target] status broadcast failed: ${(e as Error).message}`);
    }
    this.changed(t);
  }

  /** Current wire state for a reconnect; reading it never starts work. */
  status(t: Target): TargetStatusPayload {
    const status: TargetStatusPayload = {
      cardId: t.cardId, runId: t.runId, state: t.state, since: t.since,
      sentence: t.sentence, hint: t.hint, action: t.action, detail: t.detail?.slice(0, 300),
      driverId: t.driver?.driverId, specId: t.specId,
      executorDeviceId: t.link?.executorDeviceId ?? t.driver?.executor.deviceId,
    };
    return this.statusProjection?.(t, status) ?? status;
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
