import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../context';
import { getAgent } from './index';
import { libraryRouter } from './libraryRoutes';

vi.mock('./index', () => ({ getAgent: vi.fn() }));

describe('authenticated library routes', () => {
  it('requires a paired token for reads and owner authority for changes', () => {
    vi.mocked(getAgent).mockReturnValue({} as ReturnType<typeof getAgent>);
    const authenticate = vi.fn((token) => token === 'owner' ? { canApprove: true } : token === 'bridge' ? { canApprove: false } : undefined);
    const router = libraryRouter({ registry: { authenticate } } as unknown as ServerContext);
    const check = router.stack[0].handle;
    for (const [token, method, expected] of [['', 'GET', 401], ['bridge', 'DELETE', 403], ['bridge', 'GET', 0], ['owner', 'POST', 0]] as const) {
      const next = vi.fn(), json = vi.fn(), status = vi.fn();
      const res = { status, json } as unknown as Response;
      status.mockReturnValue(res);
      check({ method, get: () => token ? `Bearer ${token}` : undefined } as unknown as Request, res, next);
      if (expected) { expect(status).toHaveBeenCalledWith(expected); expect(next).not.toHaveBeenCalled(); }
      else expect(next).toHaveBeenCalledOnce();
    }
  });

  it('returns summaries and restores the requested saved version', () => {
    const libraryState = vi.fn(() => ({ devices: [] })), restoreVersion = vi.fn(() => true);
    vi.mocked(getAgent).mockReturnValue({ libraryState, restoreVersion } as unknown as ReturnType<typeof getAgent>);
    const router = libraryRouter({} as ServerContext);
    const json = vi.fn(), status = vi.fn();
    const res = { json, status } as unknown as Response;
    status.mockReturnValue(res);
    router.stack.find((layer) => layer.route?.path === '/')!.route!.stack[0].handle({} as Request, res, vi.fn());
    expect(json).toHaveBeenCalledWith({ devices: [] });
    router.stack.find((layer) => layer.route?.path === '/restore')!.route!.stack[0].handle(
      { body: { cardId: 'light', versionId: 'saved-version' } } as Request, res, vi.fn());
    expect(restoreVersion).toHaveBeenCalledWith('light', 'saved-version');
    expect(status).toHaveBeenCalledWith(200);
  });
});
