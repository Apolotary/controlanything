/**
 * Panel skins: Muse Image (`muse-image-1.0`) paints a dark, text-free background texture for a device's
 * holographic panel in the device's own visual language, from its scan crop (`/v1/images/edits`) or, with no
 * crop, from a prompt (`/v1/images/generations`). reasoning_strength "low", every tool off, webp output.
 *
 * It runs in parallel with the hack-set call and never gates arming: the controls arm first and the skin
 * arrives as a later revision (research/03 measured ~12.6 s). Bytes are kept server-side and served at
 * /api/skins/<id>.webp, so WebSocket messages only carry the URL. With MUSE_RECORD=1 the painted images are
 * saved under fixtures/recorded/gen3d/skins/ and FIXTURE mode replays them (by card, then device category).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@ce/protocol';
import { cancellableDelay, forwardCancellation, throwIfCancelled } from '../muse/cancellation';
import type { ForgeDevice } from './forgeTypes';

export const SKIN_MODEL = 'muse-image-1.0';
export const SKIN_SIZE = '1600x600';
export const SKIN_TIMEOUT_MS = 60_000;
export const SKIN_PROMPT_VERSION = 2;

export interface SkinCrop {
  /** base64 JPEG, no data: prefix */
  jpegBase64: string;
  width?: number;
  height?: number;
}

export interface SkinRequest {
  device: ForgeDevice;
  /** driver transport, used to pick a recording when replaying */
  transport?: string;
  crop?: SkinCrop;
  signal?: AbortSignal;
}

export interface SkinResult {
  ok: boolean;
  skinId?: string;
  /** server path, e.g. /api/skins/skn_….webp */
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
  mode: 'edit' | 'generate';
  /** muse-image-1.0, or "fixture" when replayed */
  model: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  latencyMs: number;
  error?: string;
}

// --- the prompt -----------------------------------------------------------------------------------

function materials(device: ForgeDevice): string {
  const what = `${device.category ?? ''} ${device.name} ${device.notes ?? ''}`.toLowerCase();
  if (/light|lamp|ceiling/.test(what)) return 'warm white paper and frosted acrylic grain, kept mostly dark charcoal, with only a faint amber glow along the outer edges';
  if (/synth|drum|sampler|groove|keyboard|op-1|midi/.test(what)) return 'brushed grey aluminium with fine machining marks';
  if (/computer|laptop|mac/.test(what)) return 'space-grey anodised aluminium with a hint of a cool screen glow';
  if (/phone/.test(what)) return 'glass and satin metal';
  return "the device's own surface materials";
}

/** The panel-skin prompt: the device's materials and colours, dark and legible, nothing drawn on it. */
export function skinPrompt(device: ForgeDevice, withCrop: boolean): string {
  const accents = device.accents?.length ? `, with thin accent lines in ${device.accents.join(', ')}` : ' and its own accent colours';
  const subject = withCrop ? `Turn this photo of a ${device.name} into` : `Create`;
  return [
    `${subject} a flat, front-facing background texture for a floating holographic control panel${withCrop ? '' : ` for a ${device.name}${device.category ? ` (${device.category})` : ''}`}.`,
    `Use only its materials and colours: ${materials(device)}${accents}.`,
    'Make it dark (deep charcoal, about 15% brightness) and matte, with low contrast in the middle so bright labels stay legible; subtle machined edges and fine grain only near the borders.',
    'Do not depict the device itself or any object or light source: only an abstract surface in its materials.',
    'Draw no text, letters, numbers, logos, knobs, buttons, keys, sliders, screens or icons: the controls are drawn on top of it.',
    'Orthographic, evenly lit, no shadows, no perspective, no background scene.',
  ].join(' ');
}

// --- store ------------------------------------------------------------------------------------------

export interface StoredSkin {
  bytes: Uint8Array;
  mime: string;
  at: number;
}

/** Painted skins by id, in memory (they live as long as the specs that reference them). */
export class SkinStore {
  private readonly items = new Map<string, StoredSkin>();
  constructor(private readonly max = 64) {}

  put(bytes: Uint8Array, mime = 'image/webp'): string {
    const id = newId('skn_');
    this.items.set(id, { bytes, mime, at: Date.now() });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
    return id;
  }

  get(id: string): StoredSkin | undefined {
    return this.items.get(id);
  }

  get size(): number {
    return this.items.size;
  }
}

export const skinUrl = (id: string) => `/api/skins/${id}.webp`;

/** Width and height of a WebP (VP8X, VP8 or VP8L); undefined if it is not one. */
export function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  const s = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 30 || s(0, 4) !== 'RIFF' || s(8, 4) !== 'WEBP') return undefined;
  const chunk = s(12, 4);
  if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (chunk === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

// --- painters ---------------------------------------------------------------------------------------

export interface SkinPainter {
  readonly source: 'live' | 'fixture';
  paint(req: SkinRequest): Promise<SkinResult>;
}

/** What a recording says about the run it came from (the webp bytes sit next to it). */
export interface RecordedSkin {
  kind: 'gen3d-skin';
  cardId: string;
  category?: string;
  transport?: string;
  deviceName: string;
  mode: 'edit' | 'generate';
  model: string;
  promptVersion: number;
  latencyMs: number;
  width?: number;
  height?: number;
  recordedAt: string;
  /** the webp file next to this json */
  file: string;
}

function snippet(s: string, n = 300): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export class LiveSkinPainter implements SkinPainter {
  readonly source = 'live' as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly o: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; store: SkinStore; recordDir?: string; log?: (line: string) => void; timeoutMs?: number },
  ) {
    if (!o.apiKey) throw new Error('LiveSkinPainter needs MODEL_API_KEY');
    this.base = (o.baseUrl || 'https://api.meta.ai/v1').replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** The exact JSON body sent to the Meta Model API. */
  body(req: SkinRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: SKIN_MODEL,
      prompt: skinPrompt(req.device, Boolean(req.crop)),
      n: 1,
      size: SKIN_SIZE,
      response_format: 'b64_json',
      output_format: 'webp',
      reasoning_strength: 'low',
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
    };
    if (req.crop) body.images = [{ image_url: `data:image/jpeg;base64,${req.crop.jpegBase64}` }];
    return body;
  }

  async paint(req: SkinRequest): Promise<SkinResult> {
    const mode = req.crop ? 'edit' : 'generate';
    const started = Date.now();
    const fail = (error: string): SkinResult => ({ ok: false, mode, model: SKIN_MODEL, source: 'live', latencyMs: Date.now() - started, error });
    throwIfCancelled(req.signal);
    const controller = new AbortController();
    const unlink = forwardCancellation(req.signal, controller);
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs ?? SKIN_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.base}/images/${mode === 'edit' ? 'edits' : 'generations'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(this.body(req)),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) return fail(`Meta Model API HTTP ${res.status}: ${snippet(text)}`);
      let b64: string | undefined;
      try {
        b64 = JSON.parse(text)?.data?.[0]?.b64_json;
      } catch {
        return fail(`Meta Model API returned non-JSON: ${snippet(text)}`);
      }
      if (typeof b64 !== 'string' || !b64) return fail('Muse Image returned no image');
      const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      const size = webpSize(bytes);
      const skinId = this.o.store.put(bytes);
      const out: SkinResult = { ok: true, skinId, url: skinUrl(skinId), ...size, bytes: bytes.length, mode, model: SKIN_MODEL, source: 'live', latencyMs: Date.now() - started };
      this.record(req, out, bytes);
      return out;
    } catch (e) {
      if (req.signal?.aborted) return fail('cancelled');
      if (controller.signal.aborted) return fail(`Muse Image did not answer within ${Math.round((this.o.timeoutMs ?? SKIN_TIMEOUT_MS) / 1000)}s`);
      return fail(`Could not reach the Meta Model API: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private record(req: SkinRequest, r: SkinResult, bytes: Uint8Array): void {
    if (!this.o.recordDir) return;
    try {
      mkdirSync(this.o.recordDir, { recursive: true });
      const key = `skin.${req.device.cardId.replace(/[^A-Za-z0-9_-]/g, '_')}.${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}`;
      writeFileSync(join(this.o.recordDir, `${key}.webp`), bytes);
      const meta: RecordedSkin = {
        kind: 'gen3d-skin',
        cardId: req.device.cardId,
        ...(req.device.category ? { category: req.device.category } : {}),
        ...(req.transport ? { transport: req.transport } : {}),
        deviceName: req.device.name,
        mode: r.mode,
        model: SKIN_MODEL,
        promptVersion: SKIN_PROMPT_VERSION,
        latencyMs: r.latencyMs,
        ...(r.width ? { width: r.width, height: r.height } : {}),
        recordedAt: new Date().toISOString(),
        file: `${key}.webp`,
      };
      writeFileSync(join(this.o.recordDir, `${key}.json.tmp`), `${JSON.stringify(meta, null, 2)}\n`);
      renameSync(join(this.o.recordDir, `${key}.json.tmp`), join(this.o.recordDir, `${key}.json`));
      this.o.log?.(`[gen3d] recorded skin for ${req.device.cardId} -> ${join(this.o.recordDir, key)}.webp`);
    } catch (e) {
      this.o.log?.(`[gen3d] could not record the skin: ${(e as Error).message}`);
    }
  }
}

export function loadRecordedSkins(dir: string | undefined): (RecordedSkin & { path: string })[] {
  if (!dir || !existsSync(dir)) return [];
  const out: (RecordedSkin & { path: string })[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedSkin;
      if (r?.kind === 'gen3d-skin' && existsSync(join(dir, r.file))) out.push({ ...r, path: join(dir, r.file) });
    } catch {
      // not a recording
    }
  }
  return out;
}

/** FIXTURE: plays back a recorded Muse Image skin (same card, else same category, else same transport). */
export class ReplaySkinPainter implements SkinPainter {
  readonly source = 'fixture' as const;
  constructor(private readonly o: { dir?: string; store: SkinStore; speed?: number }) {}

  find(req: SkinRequest): (RecordedSkin & { path: string }) | undefined {
    const all = loadRecordedSkins(this.o.dir);
    const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
    const newest = (list: typeof all) => [...list].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    return (
      newest(all.filter((r) => r.cardId === req.device.cardId)) ??
      newest(all.filter((r) => same(r.category, req.device.category))) ??
      newest(all.filter((r) => same(r.transport, req.transport)))
    );
  }

  async paint(req: SkinRequest): Promise<SkinResult> {
    const started = Date.now();
    const rec = this.find(req);
    const mode = req.crop ? 'edit' : 'generate';
    if (!rec) return { ok: false, mode, model: 'fixture', source: 'fixture', latencyMs: 0, error: `FIXTURE: no recorded skin for "${req.device.cardId}" or another ${req.device.category ?? 'device'}` };
    const speed = this.o.speed ?? 1;
    if (speed > 0) await cancellableDelay(rec.latencyMs * speed, req.signal);
    const bytes = new Uint8Array(readFileSync(rec.path));
    const skinId = this.o.store.put(bytes);
    return { ok: true, skinId, url: skinUrl(skinId), ...(rec.width ? { width: rec.width, height: rec.height } : webpSize(bytes)), bytes: bytes.length, mode: rec.mode, model: 'fixture', source: 'fixture', recordedFrom: rec.model, latencyMs: Date.now() - started };
  }
}
