import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebGLRenderer } from 'three';
import { endXr, frameReferenceSpace, startXr } from './xr';

function session() {
  const space = {} as XRReferenceSpace;
  return {
    space,
    enabledFeatures: ['local-floor', 'hand-tracking'],
    requestReferenceSpace: vi.fn(async (_type: XRReferenceSpaceType) => space),
    end: vi.fn(async () => {}),
  };
}

function renderer() {
  const state: { session: XRSession | null; space: XRReferenceSpace | null } = { session: null, space: null };
  const xr = {
    setReferenceSpaceType: vi.fn(),
    setSession: vi.fn(async (value: XRSession) => {
      state.session = value;
      state.space = (value as unknown as ReturnType<typeof session>).space;
    }),
    getSession: () => state.session,
    getReferenceSpace: () => state.space,
  };
  return { state, xr, value: { xr } as unknown as WebGLRenderer };
}

afterEach(() => vi.unstubAllGlobals());

describe('XR startup and reference space lifecycle', () => {
  it('ends only the current session and allows another session to be entered and ended', async () => {
    const r = renderer();
    await expect(endXr(r.value)).resolves.toBeUndefined();
    const old = session(), current = session();
    r.state.session = old as unknown as XRSession;
    await endXr(r.value);
    expect(old.end).toHaveBeenCalledOnce();
    r.state.session = current as unknown as XRSession;
    await endXr(r.value);
    expect(old.end).toHaveBeenCalledOnce();
    expect(current.end).toHaveBeenCalledOnce();
  });
  it('resolves floor support before initializing the renderer once', async () => {
    const s = session();
    const r = renderer();
    vi.stubGlobal('navigator', { xr: { requestSession: vi.fn(async () => s) } });

    const result = await startXr(r.value);

    expect(s.requestReferenceSpace).toHaveBeenCalledWith('local-floor');
    expect(r.xr.setReferenceSpaceType).toHaveBeenCalledWith('local-floor');
    expect(r.xr.setSession).toHaveBeenCalledExactlyOnceWith(s);
    expect(s.requestReferenceSpace.mock.invocationCallOrder[0]).toBeLessThan(r.xr.setSession.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ session: s, refSpace: s.space, features: ['local-floor', 'hand-tracking'] });
    expect(s.end).not.toHaveBeenCalled();
  });

  it('uses local when floor is unavailable without retrying renderer initialization', async () => {
    const s = session();
    s.requestReferenceSpace.mockRejectedValueOnce(new Error('floor unavailable'));
    const r = renderer();
    vi.stubGlobal('navigator', { xr: { requestSession: vi.fn(async () => s) } });

    await startXr(r.value);

    expect(s.requestReferenceSpace.mock.calls.map(([type]) => type)).toEqual(['local-floor', 'local']);
    expect(r.xr.setReferenceSpaceType).toHaveBeenCalledExactlyOnceWith('local');
    expect(r.xr.setSession).toHaveBeenCalledExactlyOnceWith(s);
  });

  it('ends a failed setup before trying a new session', async () => {
    const failed = session();
    const fresh = session();
    const request = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(fresh);
    vi.stubGlobal('navigator', { xr: { requestSession: request } });
    const r = renderer();
    r.xr.setSession.mockRejectedValueOnce(new Error('layer setup failed'));

    const result = await startXr(r.value);

    expect(result.session).toBe(fresh);
    expect(result.attempt).toBe('ar+hands+hit');
    expect(failed.end).toHaveBeenCalledOnce();
    expect(failed.end.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]!);
    expect(r.xr.setSession.mock.calls.map(([s]) => s)).toEqual([failed, fresh]);
  });

  it('closes sessions without a usable reference space and reports the ladder failures', async () => {
    const sessions = Array.from({ length: 3 }, () => {
      const s = session();
      s.requestReferenceSpace.mockRejectedValue(new Error('spaces unavailable'));
      return s;
    });
    const request = vi.fn();
    for (const s of sessions) request.mockResolvedValueOnce(s);
    vi.stubGlobal('navigator', { xr: { requestSession: request } });
    const r = renderer();

    await expect(startXr(r.value)).rejects.toThrow('ar-minimal: spaces unavailable');

    for (const s of sessions) expect(s.end).toHaveBeenCalledOnce();
    expect(r.xr.setSession).not.toHaveBeenCalled();
  });

  it('ends a session when the renderer has no reference space after initialization', async () => {
    const missing = session();
    const fresh = session();
    vi.stubGlobal('navigator', { xr: { requestSession: vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(fresh) } });
    const r = renderer();
    r.xr.setSession.mockImplementationOnce(async (s) => { r.state.session = s; });

    expect((await startXr(r.value)).session).toBe(fresh);
    expect(missing.end).toHaveBeenCalledOnce();
  });

  it('reads the active reference space each frame, including renderer offsets', () => {
    const r = renderer();
    const s = session() as unknown as XRSession;
    const frame = { session: s } as XRFrame;
    r.state.session = s;
    r.state.space = {} as XRReferenceSpace;
    expect(frameReferenceSpace(r.value, frame)).toBe(r.state.space);
    const offset = {} as XRReferenceSpace;
    r.state.space = offset;
    expect(frameReferenceSpace(r.value, frame)).toBe(offset);
  });

  it('rejects frames from an ended session after re-entry and frames without an active space', () => {
    const r = renderer();
    const old = session() as unknown as XRSession;
    const current = session() as unknown as XRSession;
    r.state.session = current;
    r.state.space = {} as XRReferenceSpace;
    expect(frameReferenceSpace(r.value, { session: old } as XRFrame)).toBeUndefined();
    expect(frameReferenceSpace(r.value)).toBeUndefined();
    expect(frameReferenceSpace(r.value, { session: current } as XRFrame)).toBe(r.state.space);
    r.state.space = null;
    expect(frameReferenceSpace(r.value, { session: current } as XRFrame)).toBeUndefined();
  });
});
