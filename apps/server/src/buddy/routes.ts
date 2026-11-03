/**
 * The Muse buddy (AR mascot you show real objects to):
 *
 *   POST /api/buddy/react               {jpeg, quest?, seen?, via?} -> {reaction, model, source, latencyMs, recordedFrom?}
 *   POST /api/buddy/sticker             {jpeg, object?}       -> {ok, url?, model, source, latencyMs, error?}
 *   GET  /api/buddy/stickers/<id>.webp  a painted sticker (public; content-hash id)
 *   GET  /api/buddy/status              mode, models, budgets used
 *
 * Callers: a paired device (Authorization: Bearer <deviceToken>) or localhost.
 * Env: BUDDY_RECORD=1 (or MUSE_RECORD=1) records live answers into fixtures/recorded/buddy/ for FIXTURE replay;
 *      BUDDY_EFFORT=minimal|low|… (default low);
 *      BUDDY_STICKERS=0 turns Muse Image stickers off; BUDDY_MAX_CALLS / BUDDY_MAX_STICKERS cap live spend per run.
 */
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { RequestCancelledError, requestCancellation } from '../muse';
import { BUDDY_RECORDED_DIR, BuddyBrain, buddyEffort } from './reaction';
import { STICKER_MODEL, StickerPainter, StickerStore } from './sticker';

const MAX_JPEG_B64 = 2_000_000;
const ReactBody = z.object({
  jpeg: z.string().min(100).max(MAX_JPEG_B64),
  quest: z.string().max(120).optional(),
  seen: z.array(z.string().max(60)).max(16).optional(),
  via: z.enum(['hand', 'yolo', 'gaze', 'photo']).optional(),
});
const StickerBody = z.object({ jpeg: z.string().min(100).max(MAX_JPEG_B64), object: z.string().max(60).optional() });

const stripDataUrl = (s: string) => s.replace(/^data:image\/[a-z]+;base64,/i, '');

export function buddyRouter(ctx: ServerContext): express.Router {
  const r = express.Router();
  const env = process.env;
  const record = ctx.muse.mode === 'live' && (env.BUDDY_RECORD === '1' || env.MUSE_RECORD === '1');
  const recordDir = record ? BUDDY_RECORDED_DIR : undefined;
  const brain = new BuddyBrain(ctx, { recordDir, maxLiveCalls: Number(env.BUDDY_MAX_CALLS) || 300, effort: buddyEffort(env.BUDDY_EFFORT) });
  const store = new StickerStore();
  const stickersOn = env.BUDDY_STICKERS !== '0';
  const painter = new StickerPainter({
    mode: ctx.muse.mode,
    apiKey: ctx.config.muse.apiKey,
    baseUrl: ctx.config.muse.baseUrl,
    store,
    recordDir,
    replayDir: BUDDY_RECORDED_DIR,
    maxLive: Number(env.BUDDY_MAX_STICKERS) || 40,
    log: ctx.log,
    onCall: (c) => ctx.calls.add({ at: c.at, label: 'buddy_sticker', model: c.model, source: c.source, ok: c.ok, latencyMs: c.latencyMs, ...(c.recordedFrom ? { recordedFrom: c.recordedFrom } : {}), ...(c.error ? { error: c.error } : {}) }),
  });

  const allowed = (req: Request, res: Response): boolean => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
    if (ctx.isLocal(req.socket.remoteAddress) || ctx.registry.authenticate(m?.[1])) return true;
    res.status(401).json({ error: 'unauthorized', message: 'The buddy needs a paired device token or localhost.' });
    return false;
  };

  r.get('/status', (_req, res) => {
    // the configured model ids (in FIXTURE mode the replies are recordings of these; the headset adds "(FIXTURE)")
    res.json({ mode: ctx.muse.mode, models: { react: ctx.config.muse.model, sticker: stickersOn ? STICKER_MODEL : null }, recording: Boolean(recordDir) });
  });

  r.post('/react', async (req, res) => {
    if (!allowed(req, res)) return;
    const body = ReactBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {jpeg: base64, quest?, seen?}.' });
      return;
    }
    const { signal, dispose } = requestCancellation(req, res);
    try {
      const out = await brain.react({ ...body.data, jpeg: stripDataUrl(body.data.jpeg) }, signal);
      ctx.log(`[buddy] ${out.reaction.object} -> ${out.reaction.emotion}/${out.reaction.action}${out.reaction.questMet ? ' (quest met)' : ''} · ${out.model} ${out.latencyMs} ms`);
      res.json(out);
    } catch (e) {
      if (e instanceof RequestCancelledError || signal.aborted) return;
      ctx.log(`[buddy] react failed: ${(e as Error).message}`);
      res.status(502).json({ error: 'model_error', message: (e as Error).message });
    } finally {
      dispose();
    }
  });

  r.post('/sticker', async (req, res) => {
    if (!allowed(req, res)) return;
    if (!stickersOn) {
      res.json({ ok: false, model: STICKER_MODEL, source: ctx.muse.mode, latencyMs: 0, error: 'stickers are off (BUDDY_STICKERS=0)' });
      return;
    }
    const body = StickerBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {jpeg: base64, object?}.' });
      return;
    }
    const out = await painter.paint(stripDataUrl(body.data.jpeg), body.data.object);
    if (out.ok) ctx.log(`[buddy] sticker for ${body.data.object ?? 'object'} · ${out.model} ${out.latencyMs} ms`);
    else ctx.log(`[buddy] sticker failed: ${out.error}`);
    res.json(out);
  });

  r.get('/stickers/:file', (req, res) => {
    const m = /^(stk_[a-f0-9]{32})\.webp$/.exec(String(req.params.file));
    const bytes = m ? store.get(m[1]) : undefined;
    if (!bytes) {
      res.status(404).json({ error: 'not_found', message: 'No such sticker.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/webp').send(Buffer.from(bytes));
  });

  return r;
}
