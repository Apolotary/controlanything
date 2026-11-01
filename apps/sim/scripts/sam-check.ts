/**
 * Does SAM 3.1 see the virtual device? Develops one sim camera frame in Node (same layers, same camera code
 * and sensor noise as the browser), sends it to SAM 3.1 with one concept prompt (ONE API call), and compares
 * the best detection with the exact box from the render's id mask.
 *
 *   npx tsx apps/sim/scripts/sam-check.ts [--state off|full|l3|warm|cool|night] [--view room|desk]
 *        [--prompt "ceiling light"] [--image frame.jpg] [--save out.png] [--dry]
 *
 * Needs MODEL_API_KEY in the repo-root .env (read here, never printed). Exit code 0 = detected (IoU >= 0.5).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { applyVignette, compose, type CameraParams } from '../src/room/compose';
import { decodeCel } from '../src/room/hdr';
import { DEFAULT_STATE, type LampState, targetDisplay } from '../src/room/lamp';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const ROOM = join(here, '../public/room');
const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : def;
};
const flag = (name: string) => args.includes(name);

const STATES: Record<string, LampState> = {
  off: { ...DEFAULT_STATE, power: 'off' },
  full: { ...DEFAULT_STATE, power: 'on', level: 10 },
  l3: { ...DEFAULT_STATE, power: 'on', level: 3 },
  warm: { ...DEFAULT_STATE, power: 'on', level: 10, cctK: 2700 },
  cool: { ...DEFAULT_STATE, power: 'on', level: 10, cctK: 6500 },
  night: { ...DEFAULT_STATE, power: 'night' },
};
const PROMPT_TO_DEVICE: Record<string, string> = {
  'ceiling light': 'ceiling-light',
  synthesizer: 'synth',
  'electronic device': 'synth',
  laptop: 'laptop',
  'remote control': 'remote',
  'air conditioner': 'air-conditioner',
};

const view = opt('--view', 'room')!;
const stateName = opt('--state', 'full')!;
const prompt = opt('--prompt', 'ceiling light')!;
const meta = JSON.parse(readFileSync(join(ROOM, 'meta.json'), 'utf8'));

function frame(): { dataUrl: string; width: number; height: number } {
  const img = opt('--image');
  if (img) {
    const buf = readFileSync(img);
    const mime = /\.png$/i.test(img) ? 'image/png' : 'image/jpeg';
    const png = mime === 'image/png' ? PNG.sync.read(buf) : undefined;
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, width: png?.width ?? meta.width, height: png?.height ?? meta.height };
  }
  const state = STATES[stateName];
  if (!state) throw new Error(`unknown --state ${stateName} (${Object.keys(STATES).join(', ')})`);
  const L = Object.fromEntries(['sky', 'lamp', 'night'].map((n) => [n, decodeCel(gunzipSync(readFileSync(join(ROOM, view, `${n}.cel.gz`))))]));
  const layers = { width: L.sky!.width, height: L.sky!.height, sky: L.sky!.data, lamp: L.lamp!.data, night: L.night!.data };
  applyVignette(layers);
  const out = new Uint8ClampedArray(layers.width * layers.height * 4);
  compose(layers, targetDisplay(state), meta.camera as CameraParams, out, { noise: 1, seed: 1234 });
  const png = new PNG({ width: layers.width, height: layers.height });
  png.data = Buffer.from(out.buffer);
  const bytes = PNG.sync.write(png);
  const save = opt('--save');
  if (save) writeFileSync(save, bytes);
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width: layers.width, height: layers.height };
}

interface Det {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c?: number;
}

/** "<0f>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;...|>,id..." */
function parseSam(text: string): Det[] {
  const out: Det[] = [];
  for (const m of text.matchAll(/(?:f>|,)(\d+)<\|box;([^|]*)\|>/g)) {
    const kv = Object.fromEntries(m[2]!.split(';').map((p) => [p.slice(0, p.indexOf('=')), Number(p.slice(p.indexOf('=') + 1))]));
    out.push({ id: Number(m[1]), x1: kv.x1!, y1: kv.y1!, x2: kv.x2!, y2: kv.y2!, c: kv.c });
  }
  return out;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const inter = ix * iy;
  return inter / (aw * ah + bw * bh - inter);
}

async function main(): Promise<void> {
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.MODEL_API_KEY?.trim();
  const base = (process.env.MUSE_API_BASE?.trim() || 'https://api.meta.ai/v1').replace(/\/$/, '');
  const f = frame();
  const truthDev = (meta.views[view]?.devices as { id: string; boxPx: [number, number, number, number] }[]).find((d) => d.id === PROMPT_TO_DEVICE[prompt]);
  console.log(`sim frame: view=${view} state=${opt('--image') ? '(file)' : stateName} ${f.width}x${f.height} · prompt "${prompt}" · ground truth ${truthDev ? truthDev.boxPx.join(',') : 'n/a'}`);
  if (flag('--dry')) return;
  if (!key) {
    console.error('No MODEL_API_KEY in the environment or the repo-root .env: cannot call SAM 3.1 (use --save to just write the frame).');
    process.exit(2);
  }
  const t0 = performance.now();
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sam-3.1',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: f.dataUrl }] }],
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
    }),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    console.error(`SAM 3.1 HTTP ${res.status} after ${ms} ms: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }
  const json = (await res.json()) as { output?: { content?: { type: string; text?: string }[] }[]; usage?: Record<string, unknown> };
  const text = (json.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('\n');
  const dets = parseSam(text);
  console.log(`sam-3.1 answered in ${ms} ms · ${dets.length} detection(s) · billed ${JSON.stringify(json.usage ?? {})}`);
  let best = 0;
  for (const d of dets) {
    const box: [number, number, number, number] = [d.x1, d.y1, d.x2 - d.x1 + 1, d.y2 - d.y1 + 1];
    const o = truthDev ? iou(box, truthDev.boxPx) : 0;
    if ((d.c ?? 1) >= 0.5) best = Math.max(best, o);
    console.log(`  #${d.id} box ${box.join(',')} confidence ${d.c?.toFixed(3) ?? '?'}${truthDev ? ` IoU vs truth ${o.toFixed(2)}` : ''}`);
  }
  const pass = best >= 0.5;
  console.log(pass ? `PASS: SAM 3.1 sees the virtual ${prompt} (IoU ${best.toFixed(2)})` : `FAIL: no "${prompt}" detection overlapping the virtual device`);
  process.exit(pass ? 0 : 1);
}

void main();
