/**
 * Live check of the brain's model calls with the key in .env (never printed), recording every reply so the
 * demo runs without a key: SAM 3.1 scan prompts on a test frame, Muse Spark identification of the top
 * detection, and a Muse Spark driver draft validated against the curated chart.
 *
 *   MUSE_RECORD=1 npx tsx apps/server/scripts/brain-live.ts [path/to/frame.jpg] [--prompts "a,b"] [--no-drive]
 *
 * Cost: about $0.01 per prompt + $0.005 identify + $0.02-0.05 driver. Budget-safe.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@ce/protocol';
import { cropJpeg, identify } from '../src/agent/identify';
import { drive } from '../src/agent/drive';
import { research } from '../src/agent/research';
import type { TargetDetection } from '../src/agent/types';
import { loadConfig, loadDotEnv } from '../src/config';
import { allowedCcs, loadProfiles } from '../src/devices/profiles';
import { CallLog, createMuseChat } from '../src/muse';
import { decodeJpeg } from '../src/oracle/image';
import { createWebSearcher } from '../src/research/websearch';
import { polygonFor } from '../src/scan/polygon';
import { createSam, decodeMask } from '../src/scan/sam';
import { scanPrompts } from '../src/agent/scan';
import { WONDER_MODEL } from '../src/agent/drive';

loadDotEnv();
const config = loadConfig(process.env);
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? new URL('../../../research/meta-docs/live/scan-scene.jpg', import.meta.url).pathname;
const promptsArg = args.indexOf('--prompts');
const prompts = promptsArg >= 0 ? args[promptsArg + 1].split(',').map((s) => s.trim()) : scanPrompts();
const noDrive = args.includes('--no-drive');

const log = (line: string) => console.log(line);
const calls = new CallLog(log);
const m = config.muse;
console.log(`mode=${m.mode} record=${m.recordDir ? 'yes' : 'no'} prompts=${prompts.join(' | ')} frame=${file}`);
if (m.mode !== 'live') console.log('no MODEL_API_KEY: this will exercise the FIXTURE paths only');

const jpegBuf = readFileSync(file);
const img = decodeJpeg(new Uint8Array(jpegBuf));
const jpegB64 = jpegBuf.toString('base64');
console.log(`frame ${img.width}x${img.height}, ${Math.round(jpegBuf.length / 1024)} KB`);

const sam = createSam(m, { callLog: calls, log });
const t0 = Date.now();
const runs = await sam.segmentAll(prompts, jpegB64, { width: img.width, height: img.height, label: 'scan' });
console.log(`SAM wall ${Date.now() - t0} ms`);
for (const r of runs) {
  console.log(`  ${r.prompt}: ${r.records.length} object(s) in ${r.latencyMs} ms${r.error ? ` ERROR ${r.error}` : ''}`);
  for (const rec of r.records.slice(0, 6)) {
    const raster = decodeMask(rec);
    const poly = polygonFor(raster && rec.mask ? { data: raster, width: rec.mask.width, height: rec.mask.height, x0: rec.x1, y0: rec.y1 } : null, [rec.x1, rec.y1, rec.x2 - rec.x1 + 1, rec.y2 - rec.y1 + 1]);
    console.log(`     id ${rec.id} box [${rec.x1},${rec.y1},${rec.x2},${rec.y2}] c=${rec.confidence?.toFixed(2)} mask=${rec.mask ? `${rec.mask.width}x${rec.mask.height} -> ${poly.length}-pt polygon` : 'none'}`);
  }
}

// identify the most confident specific detection
const best = runs
  .flatMap((r) => r.records.map((rec) => ({ rec, prompt: r.prompt })))
  .filter((x) => x.prompt !== 'electronic device')
  .sort((a, b) => (b.rec.confidence ?? 0) - (a.rec.confidence ?? 0))[0] ?? runs.flatMap((r) => r.records.map((rec) => ({ rec, prompt: r.prompt })))[0];
if (!best) {
  console.log('nothing detected; stopping');
  process.exit(0);
}
const det: TargetDetection = {
  frameId: 'live', detId: 'live:0', sensorDeviceId: 'script', label: best.prompt, prompt: best.prompt, score: best.rec.confidence ?? 1,
  box: [best.rec.x1, best.rec.y1, best.rec.x2 - best.rec.x1 + 1, best.rec.y2 - best.rec.y1 + 1], width: img.width, height: img.height, jpeg: jpegB64, capturedAt: Date.now(),
};
const spark = createMuseChat(m, { callLog: calls, log });
const crop = cropJpeg(img, det.box);
console.log(`identify: crop ${Math.round((crop.length * 3) / 4 / 1024)} KB of a ${det.label}`);
const id = await identify(spark, det, crop, jpegB64, { cardId: newId('card-'), effort: 'low' });
console.log(`  -> ${id.card.name} | ${id.card.maker} ${id.card.model} | ${id.card.category} | confidence ${id.card.confidence} | requires ${id.card.requires?.join(',')} | ${id.model} ${id.effort} ${id.latencyMs} ms`);
console.log(`  evidence: ${id.card.evidence.join(' / ')}`);

if (!noDrive) {
  const profiles = loadProfiles();
  const web = createWebSearcher(m, { callLog: calls });
  const cap = id.card.requires?.includes('midi') ? 'midi' : id.card.requires?.includes('ir') ? 'ir' : 'local';
  const r = await research({ profiles, web }, id.card, cap, { allowWeb: cap === 'midi' });
  console.log(`research: ${r.profile ? `chart ${r.profile.id}` : r.irLibrary ? `${r.irLibrary.candidates.length} IR candidates` : r.modelId ? `web search by ${r.modelId}` : 'nothing'}`);
  const wonder = m.mode === 'live' ? createMuseChat({ ...m, model: WONDER_MODEL }, { callLog: calls, log }) : undefined;
  const result = await drive({ spark, wonder, log }, id.card, r, cap, { driverId: 'drv-live', executor: { deviceId: 'script' }, executorKind: cap === 'ir' ? 'cardputer' : 'mac' }, { allowedCcs: r.profile ? allowedCcs(r.profile) : undefined, irLibrary: r.irLibrary, executorKind: cap === 'ir' ? 'cardputer' : 'mac', emitsLight: cap === 'ir' }, {
    onAttempt: (a) => console.log(`  drive attempt ${a.attempt}: ${a.model} ${a.effort} ${a.ok ? 'valid' : 'rejected'} ${a.latencyMs} ms${a.error ? ` (${a.error})` : ''}${a.issues ? `\n${a.issues}` : ''}`),
  });
  if (result) {
    console.log(`driver: ${result.validation.ok ? 'VALID' : 'INVALID'} ${result.draft.actions.length} actions by ${result.model} (${result.effort}) in ${result.latencyMs} ms`);
    for (const a of result.validation.driver.actions) console.log(`   ${a.actionId}: ${a.label} [${a.kind}] ${JSON.stringify(a.encode)} expect ${a.expect?.sense}:${a.expect?.effect}`);
  } else console.log('driver: no valid draft from any model');
}
const t = calls.totals();
console.log(`calls: ${t.calls} (${t.failures} failed), tokens in ${t.promptTokens} out ${t.completionTokens} (reasoning ${t.reasoningTokens})`);
