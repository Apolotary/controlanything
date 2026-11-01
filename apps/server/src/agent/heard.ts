/**
 * "Say line" oracle: the Mac speaks a line, a microphone client records it (sense audio-clip), and Muse Voice
 * Transcribe must hear it back. The evidence is the similarity between the line and the transcript.
 * A Meta model is the judge here, so in FIXTURE mode the transcript is replayed from a recording of the real
 * call (apps/server/fixtures/recorded/transcribe/<slug>.json), labelled as such.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transcriber } from '../muse/transcribe';

export const TRANSCRIPT_THRESHOLD = 0.5;

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'line';
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Dice coefficient over words, with a bigram fallback for single-word lines. 1 = identical, 0 = nothing shared. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const grams = (w: string[]) => (w.length >= 2 ? w.slice(0, -1).map((x, i) => `${x} ${w[i + 1]}`) : w);
  const score = (x: string[], y: string[]) => {
    const set = new Map<string, number>();
    for (const g of x) set.set(g, (set.get(g) ?? 0) + 1);
    let hit = 0;
    for (const g of y) {
      const n = set.get(g) ?? 0;
      if (n > 0) {
        hit++;
        set.set(g, n - 1);
      }
    }
    return (2 * hit) / (x.length + y.length);
  };
  // words count most; shared bigrams confirm order
  return Math.round((0.7 * score(wa, wb) + 0.3 * score(grams(wa), grams(wb))) * 1000) / 1000;
}

export interface RecordedTranscript {
  kind: 'transcript';
  line: string;
  transcript: string;
  model: string;
  recordedAt: string;
  durationMs: number;
  similarity: number;
}

export interface HeardResult {
  transcript: string;
  similarity: number;
  pass: boolean;
  model: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  latencyMs: number;
}

export interface HeardDeps {
  transcriber: Transcriber;
  /** live + MUSE_RECORD=1: save the transcript here (…/transcribe) */
  recordDir?: string;
  /** fixture: read recorded transcripts here */
  replayDir?: string;
  log?: (line: string) => void;
}

function file(dir: string, line: string): string {
  return join(dir, 'transcribe', `${slug(line)}.json`);
}

/** Transcribe a clip of the Mac saying `line` and score it. Fixture mode replays a recorded transcript for that line. */
export async function hearBack(deps: HeardDeps, line: string, wav: Uint8Array, signal?: AbortSignal): Promise<HeardResult> {
  const started = Date.now();
  if (deps.transcriber.mode === 'fixture' && deps.replayDir) {
    const f = file(deps.replayDir, line);
    if (existsSync(f)) {
      try {
        const rec = JSON.parse(readFileSync(f, 'utf8')) as RecordedTranscript;
        const sim = similarity(line, rec.transcript);
        return { transcript: rec.transcript, similarity: sim, pass: sim >= TRANSCRIPT_THRESHOLD, model: 'fixture', source: 'fixture', recordedFrom: rec.model, latencyMs: Date.now() - started };
      } catch {
        // fall through to the fixture transcriber
      }
    }
  }
  const r = await deps.transcriber.transcribe(wav, signal);
  const sim = similarity(line, r.text);
  const out: HeardResult = { transcript: r.text, similarity: sim, pass: sim >= TRANSCRIPT_THRESHOLD, model: r.model, source: r.source, latencyMs: Date.now() - started };
  if (r.source === 'live' && deps.recordDir) {
    try {
      const f = file(deps.recordDir, line);
      mkdirSync(join(deps.recordDir, 'transcribe'), { recursive: true });
      const rec: RecordedTranscript = { kind: 'transcript', line, transcript: r.text, model: r.model, recordedAt: new Date().toISOString(), durationMs: r.durationMs, similarity: sim };
      writeFileSync(`${f}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
      renameSync(`${f}.tmp`, f);
      deps.log?.(`[heard] recorded transcript for "${line.slice(0, 40)}"`);
    } catch (e) {
      deps.log?.(`[heard] could not record: ${(e as Error).message}`);
    }
  }
  return out;
}

/** How long a `say` of this text takes, roughly (macOS default voice ~165 wpm), plus a margin for the recorder. */
export function clipDurationMs(line: string): number {
  const n = words(line).length;
  return Math.min(8000, 1500 + n * 420);
}
