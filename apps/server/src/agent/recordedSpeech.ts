/**
 * A recorded clip that stands in for the Mac's voice while this Mac must stay silent (CE_MAC_SILENT=1). The
 * "say line" oracle (a clip -> Muse Voice Transcribe -> transcript similarity, heard.ts) can then still run end
 * to end without a sound being made, and every piece of evidence names the recording instead of pretending the
 * Mac spoke: the ack says "not spoken", the evidence says "recorded clip … not this Mac speaking".
 *
 * Clips live in apps/server/fixtures/audio/<slug>.wav with the line they contain in
 * fixtures/recorded/transcribe/<slug>.json (recorded live with scripts/say-line-live.ts, which also records the
 * model's transcript, so FIXTURE mode replays the real answer).
 *
 * TODO(hardware session): record the Mac's own line ("Hello from Mac", recorded driver draft a2) with
 * say-line-live.ts once sound is allowed on this machine again; until then the one committed clip is used for
 * every line, and labelled as such.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from './heard';

export interface RecordedSpeech {
  /** the words on the recording (what the transcript is compared with) */
  line: string;
  /** mono 16-bit PCM WAV, what Muse Voice Transcribe accepts */
  wav: Uint8Array;
  /** what the evidence says about where the audio came from */
  label: string;
  file: string;
}

const DEFAULT_DIR = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** The committed clips, keyed by slug(line); returns a lookup that falls back to the first clip for any other line. */
export function loadRecordedSpeech(dir: string = DEFAULT_DIR, log?: (line: string) => void): ((line: string) => RecordedSpeech | undefined) | undefined {
  const audio = join(dir, 'audio');
  if (!existsSync(audio)) return undefined;
  const clips = new Map<string, RecordedSpeech>();
  for (const file of readdirSync(audio).filter((n) => n.endsWith('.wav')).sort()) {
    const key = basename(file, '.wav');
    let line = key.replace(/-/g, ' ');
    try {
      line = (JSON.parse(readFileSync(join(dir, 'recorded', 'transcribe', `${key}.json`), 'utf8')) as { line?: string }).line ?? line;
    } catch {
      // no transcript recorded yet: the file name is the line
    }
    const wav = new Uint8Array(readFileSync(join(audio, file)));
    clips.set(key, { line, wav, file, label: `recorded clip "${line.slice(0, 48)}" (fixtures/audio/${file}), not this Mac speaking (CE_MAC_SILENT)` });
  }
  if (!clips.size) return undefined;
  log?.(`[silent] ${clips.size} recorded clip(s) stand in for the Mac's voice: ${[...clips.keys()].join(', ')}`);
  const first = clips.values().next().value;
  return (line: string) => clips.get(slug(line)) ?? first;
}
