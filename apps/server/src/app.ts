/**
 * HTTP API and static hosting. Built client apps are served from the same origin as /ws,
 * so a self-signed certificate accepted once covers the page and its WebSocket.
 *
 *   GET    /api/health                    mode, models, uptime, connected clients (public)
 *   GET    /api/clients                   sockets per paired device: role, age, owner/superseded (public, no tokens)
 *   GET    /api/helper                    short pairing URLs and companion presence (public)
 *   GET    /api/muse/calls                every model call: model id, latency, tokens (public)
 *   POST   /api/pair/start                {name, kind, capabilities} -> {pairingId, code, display, qr, expiresAt, pollSecret, status}
 *   GET    /api/pair/status               ?pairingId&pollSecret -> {status, deviceId?, deviceToken? (once)}
 *   POST   /api/pair/approve              {code, pairingId?}   approver only
 *   POST   /api/pair/deny                 {pairingId | code}   approver only
 *   GET    /api/pair/pending              approver only
 *   GET    /api/devices                   approver only
 *   DELETE /api/devices/:id               approver only (revoke)
 *   GET    /api/me                        the device a Bearer token belongs to
 *   POST   /api/transcribe                audio/wav body (paired device or localhost)
 *   POST   /api/gen3d/generate            {device, driver, verification?} | {cardId} -> hack set + ce.gen3d/1 ui.spec (?stream=1 SSE)
 *   POST   /api/gen3d/edit                {specId, instruction}  -> patched ui.spec (rev+1; "undo"/"redo")
 *   GET    /api/gen3d/specs[/:specId]     current generated specs
 *   GET    /api/skins/<id>.webp           Muse Image panel skin (public)
 *   GET    /p/:pairingId                  QR target -> /companion/?approve=<id> (the #code fragment is kept)
 *   /companion/, /quest/, /sim/           built apps (apps/companion/dist, apps/quest/dist, apps/sim/dist)
 *
 * Approver = a paired device with canApprove (Authorization: Bearer <deviceToken>) or any localhost request.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PairApproveRequest, PairDenyRequest, PairStartRequest, PROTOCOL_VERSION } from '@ce/protocol';
import express, { type NextFunction, type Request, type Response } from 'express';
import { SERVER_NAME, SERVER_VERSION } from './config';
import type { ServerContext } from './context';
import { agentRouter } from './agent/routes';
import { buddyRouter } from './buddy';
import { libraryRouter } from './agent/libraryRoutes';
import { gen3dRouter, skinsRouter } from './gen3d';
import { MAX_AUDIO_BYTES, requestCancellation, RequestCancelledError, TranscribeInputError, TranscribeUpstreamError } from './muse';
import { type Approver, PairingError } from './pairing/manager';
import type { DeviceRecord } from './pairing/registry';
import { saveTake, TAKES_DIR, takeExists, takeName } from './takes';
import { sameHostOrigin } from './origin';
import { helperPairUrls } from './net';
import { helperDevices } from './helpers';

function bearer(req: Request): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
  return m?.[1];
}

function publicDevice(d: DeviceRecord) {
  const { tokenHash: _hidden, ...rest } = d;
  return rest;
}

function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`);
}

export function createApp(ctx: ServerContext): express.Express {
  const app = express();
  app.disable('x-powered-by');

  const caller = (req: Request) => {
    const address = req.socket.remoteAddress;
    return { address, local: ctx.isLocal(address), device: ctx.registry.authenticate(bearer(req)) };
  };
  const requireApprover = (req: Request): Approver => {
    const c = caller(req);
    if (c.device?.canApprove) return { type: 'device', deviceId: c.device.deviceId };
    if (c.local) return { type: 'local', address: c.address };
    if (c.device) throw new PairingError('forbidden', 'This device may not approve others (only a quest, mac or iphone, or localhost).', 403);
    throw new PairingError('forbidden', 'Send Authorization: Bearer <deviceToken> of a paired quest, mac or iphone.', 401);
  };

  const api = express.Router();
  // generous so feature routes (e.g. image payloads) work; add new routers below, before the /api 404 handler
  api.use(express.json({ limit: '16mb' }));

  api.get('/health', (_req, res) => {
    const m = ctx.config.muse;
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      mode: ctx.muse.mode,
      keyConfigured: Boolean(m.apiKey),
      models: { chat: m.model, transcribe: m.transcribeModel, reasoningEffort: m.reasoningEffort ?? null },
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      startedAt: new Date(ctx.startedAt).toISOString(),
      space: { spaceId: ctx.registry.spaceId, pairedDevices: ctx.registry.size },
      clients: ctx.hub.stats(),
      pendingPairings: ctx.pairing.listPending().length,
      usage: ctx.calls.totals(),
      recording: Boolean(m.recordDir),
      urls: ctx.urls(),
      warnings: m.warnings,
    });
  });

  // read-only: every socket per paired device with role, age and owner/superseded state (spot duplicate tabs)
  api.get('/clients', (_req, res) => {
    res.json(ctx.hub.clients());
  });

  api.get('/helper', (_req, res) => {
    res.json({ urls: helperPairUrls(ctx.bound.http ?? ctx.config.http.port), helpers: helperDevices(ctx.hub.devices()) });
  });

  // every model call with its model id, latency and tokens (for the demo's "which Meta model did what")
  api.get('/muse/calls', (_req, res) => {
    res.json({ mode: ctx.muse.mode, totals: ctx.calls.totals(), calls: ctx.calls.list() });
  });

  api.post('/pair/start', (req, res) => {
    const body = PairStartRequest.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {name, kind, capabilities?}.', issues: issuesOf(body.error) });
      return;
    }
    const c = caller(req);
    res.status(201).json(ctx.pairing.start(body.data, { origin: c.address, autoApprove: c.local && sameHostOrigin(req.headers) }));
  });

  api.get('/pair/status', (req, res) => {
    const pairingId = typeof req.query.pairingId === 'string' ? req.query.pairingId : '';
    const pollSecret = typeof req.query.pollSecret === 'string' ? req.query.pollSecret : '';
    if (!pairingId || !pollSecret) {
      res.status(400).json({ error: 'bad_request', message: 'Query needs pairingId and pollSecret.' });
      return;
    }
    res.json(ctx.pairing.status(pairingId, pollSecret));
  });

  api.post('/pair/approve', (req, res) => {
    const approver = requireApprover(req);
    const body = PairApproveRequest.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {code, pairingId?}.', issues: issuesOf(body.error) });
      return;
    }
    const r = ctx.pairing.approve(body.data, approver);
    res.json({ pairingId: r.pairingId, approvedBy: r.approvedBy, device: publicDevice(r.device) });
  });

  api.post('/pair/deny', (req, res) => {
    const approver = requireApprover(req);
    const body = PairDenyRequest.safeParse(req.body ?? {});
    if (!body.success || (!body.data.pairingId && !body.data.code)) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {pairingId} or {code}.' });
      return;
    }
    res.json(ctx.pairing.deny(body.data, approver));
  });

  api.get('/pair/pending', (req, res) => {
    requireApprover(req);
    res.json({ pending: ctx.pairing.listPending() });
  });

  api.get('/devices', (req, res) => {
    requireApprover(req);
    res.json({ spaceId: ctx.registry.spaceId, devices: ctx.hub.devices() });
  });

  api.use('/library', libraryRouter(ctx));

  api.delete('/devices/:id', (req, res) => {
    requireApprover(req);
    const id = String(req.params.id);
    if (!ctx.registry.remove(id)) {
      res.status(404).json({ error: 'not_found', message: `No paired device "${id}".` });
      return;
    }
    ctx.hub.disconnectDevice(id, 'revoked');
    res.status(204).end();
  });

  api.get('/me', (req, res) => {
    const c = caller(req);
    if (!c.device) {
      res.status(401).json({ error: 'unauthorized', message: 'Unknown or revoked device token.', local: c.local });
      return;
    }
    res.json({ device: publicDevice(c.device), local: c.local, spaceId: ctx.registry.spaceId });
  });

  api.post(
    '/transcribe',
    express.raw({ type: ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }),
    async (req, res) => {
      const c = caller(req);
      if (!c.device && !c.local) {
        res.status(401).json({ error: 'unauthorized', message: 'Transcription needs a paired device token or localhost.' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        res.status(400).json({ error: 'bad_request', message: 'POST the WAV bytes with Content-Type: audio/wav.' });
        return;
      }
      const { signal, dispose } = requestCancellation(req, res);
      try {
        res.json(await ctx.transcriber.transcribe(new Uint8Array(req.body), signal));
      } catch (e) {
        if (e instanceof RequestCancelledError) return;
        if (e instanceof TranscribeInputError || e instanceof TranscribeUpstreamError) {
          res.status(e.status).json({ error: e.name, message: e.message });
          return;
        }
        throw e;
      } finally {
        dispose();
      }
    },
  );

  // generated hack sets + 3D controls (POST /api/gen3d/generate, POST /api/gen3d/edit, GET /api/gen3d/specs[/:id])
  api.use('/gen3d', gen3dRouter(ctx));
  api.use('/skins', skinsRouter(ctx));
  // the discovery loop: targets, work log, exec monitor, curated profiles, select / arm / panic (see agent/routes.ts)
  api.use('/agent', agentRouter(ctx));
  // the Muse buddy: show it real objects (POST /api/buddy/react, /api/buddy/sticker; see buddy/routes.ts)
  api.use('/buddy', buddyRouter(ctx));

  // recorded takes: the headset app on this Mac hands its zip to the server (localhost only), which unpacks it into
  // apps/quest/public/takes/<take>/ so it replays at once (/sim/?take=<take>) and can be committed
  api.post('/takes/:take', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '64mb' }), (req, res) => {
    if (!ctx.isLocal(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'forbidden', message: 'Takes are saved into the repo from this Mac only.' });
      return;
    }
    const take = takeName(String(req.params.take));
    if (!take || !Buffer.isBuffer(req.body) || !req.body.length) {
      res.status(400).json({ error: 'bad_request', message: 'POST /api/takes/<take-name> with the take zip as the body.' });
      return;
    }
    try {
      const r = saveTake(TAKES_DIR, take, req.body);
      ctx.log(`[takes] ${take}: ${r.files.length} files, ${Math.round(r.bytes / 1024)} KB -> ${r.dir}`);
      res.json({ ok: true, take, ...r, replay: `/sim/?take=${encodeURIComponent(take)}` });
    } catch (e) {
      res.status(400).json({ error: 'bad_take', message: (e as Error).message });
    }
  });
  api.get('/takes/:take', (req, res) => {
    const take = takeName(String(req.params.take));
    res.json({ take, exists: Boolean(take && takeExists(TAKES_DIR, take)) });
  });

  api.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route ${req.method} ${req.originalUrl}` });
  });
  app.use('/api', api);

  app.get('/pair', (_req, res) => {
    res.redirect(302, '/companion/?pair=1');
  });

  // QR target. Browsers keep the #code fragment across this redirect.
  app.get('/p/:pairingId', (req, res) => {
    res.redirect(302, `/companion/?approve=${encodeURIComponent(String(req.params.pairingId))}`);
  });

  // takes saved after the last build are served from the source folder, so no rebuild is needed to replay one
  app.use('/quest/takes', express.static(TAKES_DIR));

  // static client apps
  app.use((req, res, next) => {
    const m = /^\/(companion|quest|sim|vsynth)$/.exec(req.path);
    if (m) {
      res.redirect(301, `/${m[1]}/${req.originalUrl.slice(req.path.length)}`);
      return;
    }
    next();
  });
  for (const [name, dir] of Object.entries({ ...ctx.config.staticDirs, vsynth: join(ctx.config.staticDirs.companion, 'vsynth') })) {
    app.use(
      `/${name}`,
      express.static(dir, {
        index: 'index.html',
        setHeaders: (res, file) => {
          if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use(`/${name}`, (_req, res) => {
      if (existsSync(join(dir, 'index.html'))) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      res
        .status(503)
        .type('html')
        .send(`<!doctype html><meta charset="utf-8"><title>${name} not built</title><p>The ${name} app is not built yet (${dir} is missing). Run <code>npm run build</code> or <code>npm run dev</code>.</p>`);
    });
  }
  app.get('/', (_req, res) => {
    res.redirect(302, '/companion/');
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PairingError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'bad_request', message: 'Body is not valid JSON.' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large', message: 'Request body is too large.' });
      return;
    }
    ctx.log(`[http] error: ${e?.message ?? String(err)}`);
    res.status(500).json({ error: 'internal', message: 'Internal server error.' });
  });

  return app;
}
