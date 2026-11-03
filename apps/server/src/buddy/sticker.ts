/**
 * Collection stickers: Muse Image (`muse-image-1.0`, `/v1/images/edits`) turns the crop of each object the user
 * showed the buddy into a tiny die-cut sticker for its shelf. reasoning_strength "low", every tool off, webp.
 *
 * It never blocks the reaction: the headset fires it in parallel and shows the raw crop on the shelf until the
 * sticker arrives (~12 s). The background is asked to be flat chroma green so the headset can key it out.
 * Bytes stay server-side at /api/buddy/stickers/<id>.webp (public, unguessable content hash).
 * MUSE_RECORD=1 / BUDDY_RECORD=1 saves them to fixtures/recorded/buddy/; FIXTURE mode replays by object name.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STICKER_MODEL = 'muse-image-1.0';
export const STICKER_TIMEOUT_MS = 45_000;

export function stickerPrompt(object?: string): string {
  const what = object && object !== 'nothing' && object !== 'something' ? `the ${object}` : 'the main object being held';
  return [
    `Turn ${what} in this photo into a cute die-cut sticker for a collection album.`,
    'Flat kawaii vector illustration of just that object, centred, simplified shapes, bold clean outlines, soft cel shading, keep its real colours.',
    'Thick pure white sticker border around the object silhouette. No hand, no fingers, no people.',
    'The whole background outside the white border is one flat solid chroma-key green (#00FF00), no shadow, no gradient, no text, no letters.',
  ].join(' ');
}

export interface StickerResult {
  ok: boolean;
  id?: string;
  /** server path, /api/buddy/stickers/<id>.webp */
  url?: string;
  model: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  latencyMs: number;
  error?: string;
}

export class StickerStore {
  private readonly items = new Map<string, Uint8Array>();
  constructor(private readonly max = 64) {}
  put(bytes: Uint8Array): string {
    const id = `stk_${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
    this.items.set(id, bytes);
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
    return id;
  }
  get(id: string): Uint8Array | undefined {
    return this.items.get(id);
  }
}

export const stickerUrl = (id: string) => `/api/buddy/stickers/${id}.webp`;

interface RecordedSticker {
  kind: 'buddy-sticker';
  object: string;
  model: string;
  latencyMs: number;
  recordedAt: string;
  file: string;
}

function snippet(s: string, n = 240): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export class StickerPainter {
  private live = 0;
  private replayIndex = 0;

  constructor(
    private readonly o: {
      mode: 'live' | 'fixture';
      apiKey: string;
      baseUrl: string;
      store: StickerStore;
      recordDir?: string;
      replayDir: string;
      maxLive?: number;
      fetchImpl?: typeof fetch;
      log: (line: string) => void;
      onCall?: (r: StickerResult & { at: number }) => void;
    },
  ) {}

  async paint(jpegBase64: string, object?: string): Promise<StickerResult> {
    const started = Date.now();
    const done = (r: StickerResult) => {
      this.o.onCall?.({ ...r, at: started });
      return r;
    };
    if (this.o.mode === 'fixture') return done(this.replay(object, started));
    if (this.live >= (this.o.maxLive ?? 40)) return done({ ok: false, model: STICKER_MODEL, source: 'live', latencyMs: 0, error: 'sticker budget for this server run is used up (BUDDY_MAX_STICKERS)' });
    this.live++;
    const fail = (error: string): StickerResult => ({ ok: false, model: STICKER_MODEL, source: 'live', latencyMs: Date.now() - started, error });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STICKER_TIMEOUT_MS);
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: STICKER_MODEL,
          prompt: stickerPrompt(object),
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
          output_format: 'webp',
          reasoning_strength: 'low',
          tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
          images: [{ image_url: `data:image/jpeg;base64,${jpegBase64}` }],
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) return done(fail(`Meta Model API HTTP ${res.status}: ${snippet(text)}`));
      let b64: unknown;
      try {
        b64 = JSON.parse(text)?.data?.[0]?.b64_json;
      } catch {
        return done(fail(`Meta Model API returned non-JSON: ${snippet(text)}`));
      }
      if (typeof b64 !== 'string' || !b64) return done(fail('Muse Image returned no image'));
      const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      const id = this.o.store.put(bytes);
      const out: StickerResult = { ok: true, id, url: stickerUrl(id), model: STICKER_MODEL, source: 'live', latencyMs: Date.now() - started };
      this.record(object ?? 'something', bytes, out.latencyMs);
      return done(out);
    } catch (e) {
      return done(fail(controller.signal.aborted ? `Muse Image did not answer within ${STICKER_TIMEOUT_MS / 1000}s` : `Could not reach the Meta Model API: ${(e as Error).message}`));
    } finally {
      clearTimeout(timer);
    }
  }

  private record(object: string, bytes: Uint8Array, latencyMs: number): void {
    const dir = this.o.recordDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const key = `sticker.${object.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 24)}.${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}`;
      writeFileSync(join(dir, `${key}.webp`), bytes);
      const meta: RecordedSticker = { kind: 'buddy-sticker', object, model: STICKER_MODEL, latencyMs, recordedAt: new Date().toISOString(), file: `${key}.webp` };
      writeFileSync(join(dir, `${key}.json.tmp`), `${JSON.stringify(meta, null, 2)}\n`);
      renameSync(join(dir, `${key}.json.tmp`), join(dir, `${key}.json`));
      this.o.log(`[buddy] recorded ${key}`);
    } catch (e) {
      this.o.log(`[buddy] could not record the sticker: ${(e as Error).message}`);
    }
  }

  private replay(object: string | undefined, started: number): StickerResult {
    const dir = this.o.replayDir;
    const all: RecordedSticker[] = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((n) => n.startsWith('sticker.') && n.endsWith('.json')).sort()) {
        try {
          const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedSticker;
          if (r?.kind === 'buddy-sticker' && existsSync(join(dir, r.file))) all.push(r);
        } catch {
          // not a recording
        }
      }
    }
    const same = all.filter((r) => object && r.object === object);
    const rec = same[0] ?? (all.length ? all[this.replayIndex++ % all.length] : undefined);
    if (!rec) return { ok: false, model: 'fixture', source: 'fixture', latencyMs: 0, error: 'FIXTURE: no recorded sticker' };
    const id = this.o.store.put(new Uint8Array(readFileSync(join(dir, rec.file))));
    return { ok: true, id, url: stickerUrl(id), model: 'fixture', source: 'fixture', recordedFrom: rec.model, latencyMs: Date.now() - started };
  }
}
