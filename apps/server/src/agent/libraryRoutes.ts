import { LibraryForgetPayload, LibraryRenamePayload, LibraryRestorePayload } from '@ce/protocol';
import express from 'express';
import type { ServerContext } from '../context';
import { getAgent } from './index';

/** Paired clients can read saved devices; only owners can change the library. */
export function libraryRouter(ctx: ServerContext): express.Router {
  const router = express.Router();
  const agent = getAgent(ctx);
  router.use((req, res, next) => {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '')?.[1];
    const device = ctx.registry.authenticate(token);
    if (!device) {
      res.status(401).json({ error: 'unauthorized', message: 'Use a paired device token to open the library.' });
      return;
    }
    if (req.method !== 'GET' && !device.canApprove) {
      res.status(403).json({ error: 'forbidden', message: 'Only an owner may change saved devices.' });
      return;
    }
    next();
  });
  router.get('/', (_req, res) => { res.json(agent.libraryState()); });
  router.post('/restore', (req, res) => {
    const body = LibraryRestorePayload.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'bad_request' }); return; }
    const ok = agent.restoreVersion(body.data.cardId, body.data.versionId);
    res.status(ok ? 200 : 404).json({ ok });
  });
  router.post('/rename', (req, res) => {
    const body = LibraryRenamePayload.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'bad_request' }); return; }
    const ok = agent.rename(body.data.cardId, body.data.displayName);
    res.status(ok ? 200 : 404).json({ ok });
  });
  router.delete('/:cardId', (req, res) => {
    const body = LibraryForgetPayload.safeParse(req.params);
    if (!body.success) { res.status(400).json({ error: 'bad_request' }); return; }
    const ok = agent.forget(body.data.cardId);
    res.status(ok ? 200 : 404).json({ ok });
  });
  return router;
}
