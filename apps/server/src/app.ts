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
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { saveTake, takeExists, takeName } from './takes';
import { sameBridgeOrigin, sameHostOrigin, trustedServerHost } from './origin';
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
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

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
  const originPorts = () => [ctx.config.http.enabled ? ctx.bound.http ?? ctx.config.http.port : 0, ctx.config.https.enabled ? ctx.bound.https ?? ctx.config.https.port : 0].filter((port) => port > 0);
  // A foreign browser page must not inherit this Mac's loopback ownership (including DNS rebinding).
  // Native clients without Origin still authenticate normally; browser clients use the bridge's own origin.
  api.use((req, res, next) => {
    if (!trustedServerHost(req.headers.host, ctx.config.publicHost ? [ctx.config.publicHost] : [])
      || (req.headers.origin !== undefined && !sameBridgeOrigin(req.headers, originPorts()))
      || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'forbidden', message: 'Use this bridge from its own local address.' });
      return;
    }
    next();
  });
  const privateRead = (req: Request, res: Response, next: NextFunction) => {
    const c = caller(req);
    if (c.local || c.device) return next();
    res.status(401).json({ error: 'unauthorized', message: 'This view needs a paired device token or localhost.' });
  };
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
  api.get('/clients', privateRead, (_req, res) => {
    res.json(ctx.hub.clients());
  });

  api.get('/helper', (_req, res) => {
    res.json({ urls: helperPairUrls(ctx.bound.http ?? ctx.config.http.port), helpers: helperDevices(ctx.hub.devices()) });
  });

  // every model call with its model id, latency and tokens (for the demo's "which Meta model did what")
  api.get('/muse/calls', privateRead, (_req, res) => {
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

  // OS speech rendered on the Mac and played by the headset (Quest Browser has no speechSynthesis). macOS `say` only:
  // no AI voice model. Short lines, localhost or a paired device; a small cache makes repeated Buddy lines instant.
  const speechCache = new Map<string, Buffer>();
  const speechVoice = process.env.CE_SPEECH_VOICE || 'Samantha';
  // Warm the voice once so the first Buddy line is not the slow one.
  if (process.platform === 'darwin' && !process.env.VITEST) {
    const warm = mkdtempSync(join(tmpdir(), 'ce-speech-'));
    execFile('say', ['-v', speechVoice, '-o', join(warm, 'warm.wav'), '--file-format=WAVE', '--data-format=LEI16@22050', '--', 'ready'], { timeout: 15_000 },
      () => rmSync(warm, { recursive: true, force: true }));
  }
  api.post('/speech', express.json({ limit: '8kb' }), async (req, res) => {
    const c = caller(req);
    if (!c.device && !c.local) { res.status(401).json({ error: 'unauthorized', message: 'Speech needs a paired device token or localhost.' }); return; }
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!text) { res.status(400).json({ error: 'bad_request', message: 'POST {"text": "..."}' }); return; }
    if (process.platform !== 'darwin') { res.status(501).json({ error: 'unsupported', message: 'OS speech is only available on macOS.' }); return; }
    let wav = speechCache.get(text);
    if (!wav) {
      const dir = mkdtempSync(join(tmpdir(), 'ce-speech-')), out = join(dir, 'line.wav');
      try {
        await new Promise<void>((resolve, reject) => execFile('say', ['-v', speechVoice, '-r', '195', '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', '--', text],
          { timeout: 15_000 }, (error) => (error ? reject(error) : resolve())));
        wav = readFileSync(out);
      } catch (e) {
        res.status(500).json({ error: 'speech_failed', message: (e as Error).message.slice(0, 200) }); return;
      } finally { rmSync(dir, { recursive: true, force: true }); }
      speechCache.set(text, wav);
      if (speechCache.size > 40) speechCache.delete(speechCache.keys().next().value!);
    }
    res.type('audio/wav').send(wav);
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

  // Captures stay in private runtime data, outside Vite's public folder and the Git publication tree.
  const takesDir = join(ctx.config.dataDir, 'takes');
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
      const r = saveTake(takesDir, take, req.body);
      ctx.log(`[takes] ${take}: ${r.files.length} files, ${Math.round(r.bytes / 1024)} KB -> ${r.dir}`);
      res.json({ ok: true, take, ...r, replay: `/sim/?take=${encodeURIComponent(take)}` });
    } catch (e) {
      res.status(400).json({ error: 'bad_take', message: (e as Error).message });
    }
  });
  api.get('/takes/:take', privateRead, (req, res) => {
    const take = takeName(String(req.params.take));
    res.json({ take, exists: Boolean(take && takeExists(takesDir, take)) });
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

  // New recordings are local-only by default. Opting into LAN replay is deliberate, never publication by build.
  app.use('/quest/takes', (req, res, next) => {
    if (!trustedServerHost(req.headers.host, ctx.config.publicHost ? [ctx.config.publicHost] : [])
      || (req.headers.origin !== undefined && !sameBridgeOrigin(req.headers, originPorts())) || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'forbidden', message: 'Use this bridge from its own local address.' });
      return;
    }
    if (ctx.isLocal(req.socket.remoteAddress) || ctx.registry.authenticate(bearer(req)) || process.env.CE_SHARE_TAKES === '1') return next();
    const relativePath = req.path.replace(/^\//, '');
    // The two checked-in emulator takes are synthetic public fixtures, served by the normal static app below.
    if (/^take-2026-11-02T02-(?:22-10|45-47)\//.test(relativePath)) return next();
    res.status(401).json({ error: 'unauthorized', message: 'Recorded takes are private. Replay on the Mac, or explicitly enable LAN sharing with CE_SHARE_TAKES=1.' });
  }, express.static(takesDir, { dotfiles: 'deny', index: false }));

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
