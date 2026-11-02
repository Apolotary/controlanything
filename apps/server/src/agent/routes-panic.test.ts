import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../context';
import { getAgent } from './index';
import { agentRouter } from './routes';

vi.mock('./index', () => ({ getAgent: vi.fn() }));

describe('HTTP Stop', () => {
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
