import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../context';
import { getAgent } from './index';
import { agentRouter } from './routes';

vi.mock('./index', () => ({ getAgent: vi.fn() }));

describe('HTTP Stop', () => {
  it('keeps harness receipts owner-only and distinguishes checked code from current authorization', () => {
    const receipt = { runId: 'wire-one', cardId: 'visual-synth-mac', status: 'checked' };
    const get = vi.fn(() => receipt);
    vi.mocked(getAgent).mockReturnValue({ harness: { list: () => [receipt], get }, wireReady: () => undefined } as unknown as ReturnType<typeof getAgent>);
    let local = false;
    const ctx = { registry: { authenticate: () => undefined }, isLocal: () => local,
      muse: { model: 'muse-spark-1.3', mode: 'live' } } as unknown as ServerContext;
    const router = agentRouter(ctx);
    const route = router.stack.find((layer: { route?: { path: string } }) => layer.route?.path === '/harness/runs/:runId')!.route!;
    const req = { params: { runId: 'wire-one' }, get: () => undefined, socket: { remoteAddress: '192.0.2.1' } } as unknown as Request;
    const json = vi.fn(), status = vi.fn();
    const res = { json, status } as unknown as Response;
    status.mockReturnValue(res);
    route.stack[0].handle(req, res, vi.fn());
    expect(status).toHaveBeenCalledWith(403); expect(get).not.toHaveBeenCalled();
    local = true; json.mockClear();
    route.stack[0].handle(req, res, vi.fn());
    expect(get).toHaveBeenCalledWith('wire-one');
    expect(json).toHaveBeenCalledWith({ ...receipt, currentlyAuthorized: false });
  });

  it('uses the complete shared panic operation', () => {
    const panic = vi.fn(() => ({ disarmed: ['light'], sent: 1 }));
    vi.mocked(getAgent).mockReturnValue({ panic } as unknown as ReturnType<typeof getAgent>);
    const ctx = { registry: { authenticate: () => undefined }, isLocal: () => true } as unknown as ServerContext;
    const router = agentRouter(ctx);
    const route = router.stack.find((layer: { route?: { path: string } }) => layer.route?.path === '/panic')!.route!;
    const req = { body: { reason: 'HTTP Stop', cardId: 'light' }, get: () => undefined, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
    const json = vi.fn();
    route.stack[0].handle(req, { json } as unknown as Response, vi.fn());
    expect(panic).toHaveBeenCalledWith('HTTP Stop', 'light');
    expect(json).toHaveBeenCalledWith({ disarmed: ['light'], sent: 1 });
  });
});
