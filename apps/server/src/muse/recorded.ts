/**
 * Recorded real responses, so judges can run the demo from the repo without a key.
 *
 *   Record: MODEL_API_KEY set + MUSE_RECORD=1 -> every keyed live call (chatJson name, or `fixture`/`label`)
 *           writes apps/server/fixtures/recorded/<key>.json (response text + model + usage; never the prompt or key).
 *   Replay: fixture mode loads that folder; a recorded response wins over the canned FIXTURE for the same key.
 *           Results still say source "fixture" and carry `recordedFrom` (the real model id).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallUsage } from './callLog';

export interface RecordedCall {
  /** fixture key: json_schema name, or the `fixture`/`label` option */
  name: string;
  model: string;
  recordedAt: string;
  latencyMs: number;
  usage?: CallUsage;
  /** answer text exactly as returned (after <think> removal) */
  text: string;
}

export function recordingFile(dir: string, name: string): string {
  return join(dir, `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

/** Load every <key>.json in `dir` (missing dir = none). Bad files are skipped. */
export function loadRecorded(dir: string | undefined): Map<string, RecordedCall> {
  const out = new Map<string, RecordedCall>();
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedCall;
      if (typeof r?.name === 'string' && typeof r?.text === 'string' && typeof r?.model === 'string') out.set(r.name, r);
    } catch {
      // not a recording
    }
  }
  return out;
}

export function fileRecorder(dir: string, log: (line: string) => void = console.log): (rec: RecordedCall) => void {
  return (rec) => {
    try {
      mkdirSync(dir, { recursive: true });
      const file = recordingFile(dir, rec.name);
      writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      log(`[muse] recorded ${rec.name} -> ${file}`);
    } catch (e) {
      log(`[muse] could not record ${rec.name}: ${(e as Error).message}`);
    }
  };
}
