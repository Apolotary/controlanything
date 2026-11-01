/**
 * Live check of the "say line" oracle on this Mac: `say` speaks the line while ffmpeg records the microphone,
 * then Muse Voice Transcribe hears it back and the transcript is scored against the line. With MUSE_RECORD=1
 * the transcript is saved to apps/server/fixtures/recorded/transcribe/<slug>.json so the oracle replays keyless.
 *
 *   MUSE_RECORD=1 npx tsx apps/server/scripts/say-line-live.ts ["Control everything is online."] [--mic ":0"]
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipDurationMs, hearBack, similarity } from '../src/agent/heard';
import { loadConfig, loadDotEnv } from '../src/config';
import { CallLog, createTranscriber } from '../src/muse';

loadDotEnv();
const config = loadConfig(process.env);
const args = process.argv.slice(2);
const micIdx = args.indexOf('--mic');
const mic = micIdx >= 0 ? args[micIdx + 1] : ':0';
const line = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--mic') ?? 'Control everything is online.';
const calls = new CallLog((l) => console.log(l));
const transcriber = createTranscriber(config.muse, { callLog: calls });
console.log(`mode=${config.muse.mode} record=${config.muse.recordDir ? 'yes' : 'no'} line="${line}" mic=${mic}`);

const dir = mkdtempSync(join(tmpdir(), 'ce-say-'));
const wavPath = join(dir, 'clip.wav');
const seconds = Math.ceil(clipDurationMs(line) / 1000) + 1;
process.on('unhandledRejection', (e) => {
  console.log(`unhandled: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'avfoundation', '-i', mic, '-t', String(seconds), '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', wavPath]);
let ffErr = '';
ff.on('error', (e) => console.log(`ffmpeg could not start: ${e.message}`));
ff.stderr.on('data', (d) => (ffErr += d.toString()));
console.log(`recording ${seconds} s from avfoundation ${mic} …`);
await new Promise((r) => setTimeout(r, 700)); // let the recorder open the device
await new Promise<void>((resolve) => execFile('say', [line], () => resolve()));
const code = await new Promise<number>((resolve) => ff.on('exit', (c) => resolve(c ?? 1)));
if (code !== 0) {
  console.log(`ffmpeg exited ${code}: ${ffErr.trim().slice(0, 300)}`);
  console.log('Could not record the microphone (grant microphone access to the terminal, or pass --mic ":<index>" from `ffmpeg -f avfoundation -list_devices true -i ""`).');
  process.exit(1);
}
const wav = new Uint8Array(readFileSync(wavPath));
console.log(`recorded ${Math.round(wav.length / 1024)} KB`);
const heard = await hearBack({ transcriber, recordDir: config.muse.recordDir, replayDir: config.muse.replayDir, log: (l) => console.log(l) }, line, wav);
console.log(`heard: "${heard.transcript}" by ${heard.recordedFrom ?? heard.model} (${heard.source}) in ${heard.latencyMs} ms`);
console.log(`similarity ${heard.similarity} -> ${heard.pass ? 'PASS' : 'MISS'} (dice ${similarity(line, heard.transcript)})`);
rmSync(dir, { recursive: true, force: true });
