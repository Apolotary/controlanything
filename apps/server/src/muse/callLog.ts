/**
 * One record and one log line per model call (live, FIXTURE, or failed): model id, latency, tokens.
 * The demo shows these (GET /api/muse/calls); the hackathon requires every runtime call to be a Meta model.
 */
export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface CallRecord {
  at: number;
  /** what the call was for, e.g. "identify", "device_card", "transcribe" */
  label: string;
  /** Meta model id, or "fixture" */
  model: string;
  source: 'live' | 'fixture';
  ok: boolean;
  latencyMs: number;
  format?: string;
  effort?: string;
  finishReason?: string;
  usage?: CallUsage;
  /** transcription only */
  audioMs?: number;
  /** fixture replay of a recorded real response: the model that produced it */
  recordedFrom?: string;
  fallbacks?: string[];
  error?: string;
}

export interface CallTotals {
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export class CallLog {
  private readonly items: CallRecord[] = [];
  private readonly sums: CallTotals = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };

  constructor(
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly max = 200,
  ) {}

  add(r: CallRecord): void {
    this.items.push(r);
    if (this.items.length > this.max) this.items.shift();
    this.sums.calls++;
    if (!r.ok) this.sums.failures++;
    if (r.usage) {
      this.sums.promptTokens += r.usage.promptTokens;
      this.sums.completionTokens += r.usage.completionTokens;
      this.sums.reasoningTokens += r.usage.reasoningTokens ?? 0;
    }
    this.log(formatCall(r));
  }

  /** Newest last. */
  list(): CallRecord[] {
    return [...this.items];
  }

  totals(): CallTotals {
    return { ...this.sums };
  }
}

export function formatCall(r: CallRecord): string {
  const parts = [`[muse] ${r.label}`, `model=${r.model}`];
  if (r.source === 'fixture') parts.push(r.recordedFrom ? `FIXTURE(recorded from ${r.recordedFrom})` : 'FIXTURE');
  if (r.format) parts.push(`format=${r.format}`);
  if (r.effort) parts.push(`effort=${r.effort}`);
  if (r.usage) {
    const u = r.usage;
    parts.push(`in=${u.promptTokens}${u.cachedTokens ? ` (cached ${u.cachedTokens})` : ''}`);
    parts.push(`out=${u.completionTokens}${u.reasoningTokens ? ` (reasoning ${u.reasoningTokens})` : ''}`);
  }
  if (r.audioMs !== undefined) parts.push(`audio=${(r.audioMs / 1000).toFixed(1)}s`);
  parts.push(`${(r.latencyMs / 1000).toFixed(2)}s`);
  if (r.finishReason) parts.push(`finish=${r.finishReason}`);
  if (r.fallbacks?.length) parts.push(`fallback=${r.fallbacks.join(',')}`);
  if (!r.ok) parts.push(`FAILED: ${r.error ?? 'error'}`);
  return parts.join(' ');
}
