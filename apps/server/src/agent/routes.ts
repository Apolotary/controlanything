/**
 * HTTP views of the agent (debugging, the companion console, judges):
 *
 *   GET  /api/agent/targets            every target with state, card, link, driver, verification, evidence
 *   GET  /api/agent/targets/:cardId    one target
 *   GET  /api/agent/scan/latest        the newest scan result per camera client (pick a detection without a HUD)
 *   GET  /api/agent/steps[?cardId]     the work log (agent.step history)
 *   GET  /api/agent/exec               the black-box monitor: every op sent and its ack
 *   GET  /api/agent/profiles[/:id]     curated device data (apps/server/data/devices)
 *   POST /api/agent/select             {frameId, detId} | {cardId} | {deviceId}  approver or localhost
 *   POST /api/agent/arm                {armId, approve, hold?}                  approver or localhost
 *   POST /api/agent/panic              {reason?, cardId?}                       paired device or localhost
 *   GET  /api/agent/daemons            running daemons + the room hack set
 *   POST /api/agent/room/run           {hackId, value?}  run a room combo / start-stop a daemon (approver or localhost)
 *   POST /api/agent/room/undo          undo the last combo (approver or localhost)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArmConfirmPayload, PanicPayload, TargetSelectPayload } from '@ce/protocol';
import express, { type Request } from 'express';
import type { ServerContext } from '../context';
import { DATA_DIR } from '../devices/profiles';
import { getAgent } from './index';

function bearer(req: Request): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
  return m?.[1];
}

export function agentRouter(ctx: ServerContext): express.Router {
  const r = express.Router();
  const agent = getAgent(ctx);
  const caller = (req: Request) => {
    const device = ctx.registry.authenticate(bearer(req));
    const local = ctx.isLocal(req.socket.remoteAddress);
    return { device, local, canApprove: Boolean(device?.canApprove) || local };
  };

  r.get('/targets', (_req, res) => {
    res.json({ targets: agent.targets.list().map((t) => agent.targets.summary(t)) });
  });
  r.get('/targets/:cardId', (req, res) => {
    const t = agent.targets.get(String(req.params.cardId));
    if (!t) {
      res.status(404).json({ error: 'not_found', message: `No target "${req.params.cardId}".` });
      return;
    }
    res.json(agent.targets.summary(t));
  });
  r.get('/scan/latest', (req, res) => {
    const sender = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const frames = sender ? [agent.scan.latest(sender)].filter(Boolean) : ctx.hub.devices().map((d) => agent.scan.latest(d.deviceId)).filter(Boolean);
    res.json({ frames: frames.map((f) => ({ frameId: f!.frame.frameId, deviceId: f!.deviceId, width: f!.frame.width, height: f!.frame.height, capturedAt: f!.frame.capturedAt, detections: f!.detections })) });
  });
  r.get('/steps', (req, res) => {
    res.json({ steps: agent.steps.list(typeof req.query.cardId === 'string' ? req.query.cardId : undefined) });
  });
  r.get('/exec', (_req, res) => {
    res.json({ sent: agent.dispatcher.sent.slice(-100) });
  });
  r.get('/profiles', (_req, res) => {
    res.json({ dir: DATA_DIR, files: agent.profiles.files, midi: [...agent.profiles.midi.keys()], ir: agent.profiles.ir ? { id: agent.profiles.ir.id, candidates: agent.profiles.ir.candidates.length } : null, koizumi: Boolean(agent.profiles.koizumi) });
  });
  r.get('/profiles/:id', (req, res) => {
    const id = String(req.params.id).replace(/[^A-Za-z0-9_.-]/g, '');
    const file = join(DATA_DIR, `${id}.json`);
    if (!id || !existsSync(file)) {
      res.status(404).json({ error: 'not_found', message: `No profile "${id}".` });
      return;
    }
    res.type('json').send(readFileSync(file, 'utf8'));
  });
  r.post('/select', (req, res) => {
    const c = caller(req);
    if (!c.canApprove) {
      res.status(403).json({ error: 'forbidden', message: 'Selecting a target needs an approver token or localhost.' });
      return;
    }
    const body = TargetSelectPayload.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {frameId, detId} | {cardId} | {deviceId}.' });
      return;
    }
    const t = agent.select(body.data, { deviceId: c.device?.deviceId ?? 'localhost', name: c.device?.name ?? 'localhost' });
    if (!t) {
      res.status(404).json({ error: 'not_found', message: 'No detection, target or device matched the selection.' });
      return;
    }
    res.status(202).json(agent.targets.summary(t));
  });
  r.post('/arm', (req, res) => {
    const c = caller(req);
    if (!c.canApprove) {
      res.status(403).json({ error: 'forbidden', message: 'Arming needs an approver token or localhost.' });
      return;
    }
    const body = ArmConfirmPayload.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', message: 'Body must be {armId, approve, hold?}.' });
      return;
    }
    const ok = agent.arm.onConfirm(body.data, { deviceId: c.device?.deviceId, name: c.device?.name ?? 'localhost', canApprove: true, local: c.local });
    res.status(ok ? 200 : 404).json({ ok, pending: agent.arm.pendingIds() });
  });
  r.get('/daemons', (_req, res) => {
    res.json({ daemons: agent.daemons.list(), room: agent.roomSpec()?.hackset ?? null });
  });
  r.post('/room/run', (req, res) => {
    const c = caller(req);
    if (!c.canApprove) {
      res.status(403).json({ error: 'forbidden', message: 'Running a room hack needs an approver token or localhost.' });
      return;
    }
    const room = agent.roomSpec() ?? agent.publishRoom();
    const hackId = typeof req.body?.hackId === 'string' ? req.body.hackId : '';
    const hack = room?.hackset?.hacks.find((h) => h.id === hackId);
    if (!room || !hack) {
      res.status(404).json({ error: 'not_found', message: `No room hack "${hackId}" (have ${room?.hackset?.hacks.map((h) => h.id).join(', ') ?? 'none yet'}).` });
      return;
    }
    const value = typeof req.body?.value === 'number' || typeof req.body?.value === 'boolean' ? req.body.value : true;
    const r2 = agent.control.onControlEvent({ widgetId: hack.id, value, ts: Date.now(), specId: room.specId, phase: 'end' }, c.device?.name ?? 'localhost');
    res.status(202).json(r2);
  });
  r.post('/room/undo', async (req, res) => {
    const c = caller(req);
    if (!c.canApprove) {
      res.status(403).json({ error: 'forbidden', message: 'Undo needs an approver token or localhost.' });
      return;
    }
    res.json(await agent.combos.undo());
  });
  r.post('/panic', (req, res) => {
    const c = caller(req);
    if (!c.device && !c.local) {
      res.status(401).json({ error: 'unauthorized', message: 'Panic needs a paired device token or localhost.' });
      return;
    }
    const body = PanicPayload.safeParse(req.body ?? {});
    res.json(agent.control.panic(body.success ? (body.data.reason ?? 'http panic') : 'http panic', body.success ? body.data.cardId : undefined));
  });
  return r;
}
