/**
 * Server wiring for FORGE: one shared forge per server context (so the discovery loop, the WebSocket
 * gen3d.* messages and these HTTP routes see the same specs and undo history), a bridge that broadcasts
 * every progress step as `agent.step`, every hack previewed while the model writes as `ui.partial`, and
 * every published spec as `ui.spec`, and the HTTP routes:
 *
 *   POST /api/gen3d/generate  {device, driver, verification?, room?, request?, model?, effort?}
 *                             or {cardId, request?} for a device forged before (or a sample card: card_light, card_op1f)
 *                             -> ForgeResult (JSON), or Server-Sent Events with ?stream=1 (event: progress | result)
 *   POST /api/gen3d/edit      {specId, instruction, model?, effort?}   ("undo" / "redo" need no model call)
 *                             -> EditResult (JSON), or SSE with ?stream=1
 *   GET  /api/gen3d/specs     current specs;  GET /api/gen3d/specs/:specId  one ui.spec
 *   GET  /api/skins/<id>.webp a painted panel skin (public; see skinsRouter)
 *
 * Callers: a paired device (Authorization: Bearer <deviceToken>) or localhost.
 */
import { join } from 'node:path';
import type { AgentStepPayload } from '@ce/protocol';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { SERVER_ROOT } from '../config';
import type { ServerContext } from '../context';
import { REASONING_EFFORTS } from '../muse/config';
import { RequestCancelledError, requestCancellation } from '../muse/cancellation';
import { createForge, type Forge, ForgeInputError, type ForgeProgress } from './forge';
import { ForgeDevice, ForgeDriver, VerifyState } from './forgeTypes';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DEVICE, FORGE_OP1_DRIVER, FORGE_OP1_VERIFIED } from './sampleDevices';

export const RECORDED_GEN3D_DIR = join(SERVER_ROOT, 'fixtures/recorded/gen3d');

const forges = new WeakMap<ServerContext, Forge>();

/** Use a given forge for this server (tests, or a caller that built its own); the broadcast bridge is attached. */
export function useForge(ctx: ServerContext, f: Forge): Forge {
  forges.set(ctx, f);
  bridge(ctx, f);
  return f;
}

const routeBridges = new WeakMap<Forge, () => void>();

function bridge(ctx: ServerContext, f: Forge): void {
  if (routeBridges.has(f)) return;
  const off = f.subscribe((e) => {
    try {
      if (e.type === 'spec') {
        ctx.hub.broadcast('ui.spec', e.uiSpec);
        return;
      }
      ctx.hub.broadcast('agent.step', toAgentStep(e.progress));
      const it = e.progress.item;
      if (it) ctx.hub.broadcast('ui.partial', { specId: f.specIdFor(e.progress.cardId), cardId: e.progress.cardId, runId: e.progress.runId, seq: it.seq, control: it.control, ...(it.part ? { part: it.part } : {}), ...(it.hackItem ? { hackItem: it.hackItem } : {}), hack: it.hack });
    } catch (err) {
      ctx.log(`[gen3d] broadcast failed: ${(err as Error).message}`);
    }
  });
  routeBridges.set(f, off);
}

/** The discovery agent owns broadcasting when it runs: drop the plain route bridge so nothing is sent twice. */
export function detachRouteBridge(f: Forge): void {
  routeBridges.get(f)?.();
  routeBridges.delete(f);
}

/** The agent.step wire payload of a progress event (drops the streamed item). */
export function toAgentStep(p: ForgeProgress): AgentStepPayload {
  const { item: _item, ...step } = p;
  return { ...step, title: step.title.slice(0, 200), ...(step.detail ? { detail: step.detail.slice(0, 4000) } : {}), ...(step.evidence ? { evidence: step.evidence.slice(0, 64) } : {}), ...(step.effort ? { effort: step.effort.slice(0, 16) } : {}) };
}

/**
 * The server's forge (created on first use). Live when MODEL_API_KEY is set (recording runs with MUSE_RECORD=1),
 * otherwise it replays recorded runs from apps/server/fixtures/recorded/gen3d (FIXTURE, recordedFrom = model id).
 */
export function getForge(ctx: ServerContext, opts: { broadcast?: boolean } = {}): Forge {
  let f = forges.get(ctx);
  if (f) return f;
  const m = ctx.config.muse;
  const replaySpeed = Number(process.env.GEN3D_REPLAY_SPEED ?? 1);
  f = createForge({
    muse: m,
    callLog: ctx.calls,
    log: ctx.log,
    recordDir: m.recordDir ? RECORDED_GEN3D_DIR : undefined,
    replayDir: m.mode === 'fixture' ? RECORDED_GEN3D_DIR : undefined,
    replaySpeed: Number.isFinite(replaySpeed) && replaySpeed >= 0 ? replaySpeed : 1,
    // muse-image-1.0 panel skins, painted after the controls arm (GEN3D_SKIN=0 turns them off)
    skin: process.env.GEN3D_SKIN !== '0',
  });
  if (opts.broadcast !== false) bridge(ctx, f);
  forges.set(ctx, f);
  return f;
}

/**
 * GET /api/skins/<id>.webp: painted panel skins. Public on purpose: the headset's texture loader cannot send a
 * Bearer token, ids are unguessable, and the images are decorative.
 */
export function skinsRouter(ctx: ServerContext): express.Router {
  const r = express.Router();
  r.get('/:file', (req, res) => {
    const m = /^(skn_[A-Za-z0-9]+)\.webp$/.exec(String(req.params.file));
    const s = m ? getForge(ctx).skins?.get(m[1]) : undefined;
    if (!s) {
      res.status(404).json({ error: 'not_found', message: 'No such skin.' });
      return;
    }
    res.set({ 'Content-Type': s.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' }).send(Buffer.from(s.bytes));
  });
  return r;
}

const SAMPLES: Record<string, { device: ForgeDevice; driver: ForgeDriver; verification: Record<string, VerifyState> }> = {
  card_light: { device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED },
  card_op1f: { device: FORGE_OP1_DEVICE, driver: FORGE_OP1_DRIVER, verification: FORGE_OP1_VERIFIED },
};

const Effort = z.enum(REASONING_EFFORTS);

const GenerateBody = z.object({
  cardId: z.string().max(64).optional(),
  device: ForgeDevice.optional(),
  driver: ForgeDriver.optional(),
  verification: z.record(z.string(), VerifyState).optional(),
  room: z.array(z.object({ device: ForgeDevice, driver: ForgeDriver })).max(12).optional(),
  request: z.string().max(500).optional(),
  model: z.string().max(64).optional(),
  effort: Effort.optional(),
  /** base64 JPEG of the device (scan crop), for the Muse Image panel skin */
  crop: z.object({ jpegBase64: z.string().min(1).max(12_000_000), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }).optional(),
});

const EditBody = z.object({
  specId: z.string().min(1).max(64),
  instruction: z.string().min(1).max(500),
  model: z.string().max(64).optional(),
  effort: Effort.optional(),
});

function bearer(req: Request): string | undefined {
  return /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '')?.[1];
}

/** SSE when ?stream=1 or Accept: text/event-stream; returns a progress sink and a finisher. */
function responder(req: Request, res: Response) {
  const sse = req.query.stream === '1' || /text\/event-stream/.test(req.get('accept') ?? '');
  if (sse) {
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
  }
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return {
    onProgress: sse ? (p: ForgeProgress) => send('progress', p) : undefined,
    finish: (status: number, body: unknown) => {
      if (sse) {
        send('result', body);
        res.end();
      } else res.status(status).json(body);
    },
  };
}

export function gen3dRouter(ctx: ServerContext): express.Router {
  const r = express.Router();
  const forge = () => getForge(ctx);

  r.use((req, res, next) => {
    const local = ctx.isLocal(req.socket.remoteAddress);
    if (local || ctx.registry.authenticate(bearer(req))) return next();
    res.status(401).json({ error: 'unauthorized', message: 'gen3d needs a paired device token or localhost.' });
  });

  r.post('/generate', async (req, res) => {
    const body = GenerateBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {device, driver, verification?, request?} or {cardId, request?}.', issues: body.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const b = body.data;
    // inline device + driver, else the device forged before under that card, else a sample card (demo)
    const target: { device: ForgeDevice; driver: ForgeDriver; verification?: Record<string, VerifyState> } | undefined =
      b.device && b.driver ? { device: b.device, driver: b.driver, verification: b.verification } : b.cardId ? (forge().target(b.cardId) ?? SAMPLES[b.cardId]) : undefined;
    if (!target) {
      res.status(404).json({ error: 'not_found', message: `Send {device, driver} for "${b.cardId ?? '?'}" (sample cards: ${Object.keys(SAMPLES).join(', ')}).` });
      return;
    }
    const out = responder(req, res);
    const { signal, dispose } = requestCancellation(req, res);
    try {
      const result = await forge().generate({ ...target, verification: b.verification ?? target.verification, room: b.room, request: b.request, model: b.model, effort: b.effort, crop: b.crop, signal, onProgress: out.onProgress });
      out.finish(result.ok ? 200 : 422, result);
    } catch (e) {
      if (e instanceof RequestCancelledError) return;
      if (e instanceof ForgeInputError) return out.finish(e.status, { error: 'bad_request', message: e.message, issues: e.issues });
      ctx.log(`[gen3d] generate failed: ${(e as Error).message}`);
      out.finish(500, { error: 'internal', message: (e as Error).message });
    } finally {
      dispose();
    }
  });

  r.post('/edit', async (req, res) => {
    const body = EditBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {specId, instruction}.', issues: body.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const out = responder(req, res);
    const { signal, dispose } = requestCancellation(req, res);
    try {
      const result = await forge().edit({ ...body.data, signal, onProgress: out.onProgress });
      out.finish(result.ok ? 200 : 422, result);
    } catch (e) {
      if (e instanceof RequestCancelledError) return;
      if (e instanceof ForgeInputError) return out.finish(e.status, { error: e.status === 404 ? 'not_found' : 'bad_request', message: e.message, issues: e.issues });
      ctx.log(`[gen3d] edit failed: ${(e as Error).message}`);
      out.finish(500, { error: 'internal', message: (e as Error).message });
    } finally {
      dispose();
    }
  });

  r.get('/specs', (_req, res) => {
    res.json({ mode: forge().mode, specs: forge().list().map((s) => ({ specId: s.specId, cardId: s.cardId, rev: s.rev, title: s.title, modelId: s.modelId, source: s.source })) });
  });

  r.get('/specs/:specId', (req, res) => {
    const s = forge().get(String(req.params.specId));
    if (!s) {
      res.status(404).json({ error: 'not_found', message: `No spec "${req.params.specId}".` });
      return;
    }
    res.json(s);
  });

  return r;
}
