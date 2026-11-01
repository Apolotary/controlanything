import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayloadSchemas } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { createContext, type RunningServers, type ServerContext, startServers } from '../context';
import { resolveMuseConfig } from '../muse';
import type { EditSet } from './editPatch';
import { createForge } from './forge';
import { useForge } from './routes';
import { contentEvents, LIGHT_DRAFT, mockFetch, sseResponse } from './testkit';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(): Promise<{ ctx: ServerContext; base: string; local: { v: boolean }; calls: ReturnType<typeof mockFetch>['calls'] }> {
  const tmp = mkdtempSync(join(tmpdir(), 'ce-gen3d-http-'));
  const companion = join(tmp, 'companion');
  mkdirSync(companion);
  writeFileSync(join(companion, 'index.html'), '<!doctype html><title>t</title>');
  const local = { v: true };
  const muse = resolveMuseConfig({ FIXTURE_DELAY_MS: '0' });
  const config = {
    https: { host: '127.0.0.1', port: 0, enabled: false },
    http: { host: '127.0.0.1', port: 0, enabled: true },
    publicHost: '127.0.0.1',
    certDir: join(tmp, 'certs'),
    dataDir: join(tmp, 'data'),
    staticDirs: { companion, quest: join(tmp, 'q'), sim: join(tmp, 's') },
    trustFirstDevice: false,
    trustLoopback: true,
    consoleApprove: false,
    muse,
  } as unknown as ServerConfig;
  const ctx = createContext(config, { log: () => {}, registryFile: null, isLocal: () => local.v });
  const edit: EditSet = { behaviors: [], controls: [], feedback: [], parts: [{ id: 'p_h_dim', kind: 'archetype', archetype: 'lever', controlId: 'h_dim', params: { length: 0.22, accent: '#FF2020' } }], remove: [], summary: 'big red lever', title: '' };
  const f = mockFetch([() => sseResponse(contentEvents(JSON.stringify(LIGHT_DRAFT))), () => sseResponse(contentEvents(JSON.stringify(edit)))]);
  useForge(ctx, createForge({ muse: resolveMuseConfig({ MODEL_API_KEY: 'sk-test' }), fetchImpl: f.impl, callLog: ctx.calls }));
  const servers: RunningServers = await startServers(ctx, createApp(ctx));
  cleanups.push(async () => {
    await servers.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  return { ctx, base: `http://127.0.0.1:${ctx.bound.http}`, local, calls: f.calls };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('gen3d HTTP routes', () => {
  it('generates for a sample card, edits it, serves it, and broadcasts agent.step + ui.spec', async () => {
    const { ctx, base } = await start();
    const sent: [string, unknown][] = [];
    vi.spyOn(ctx.hub, 'broadcast').mockImplementation(((type: string, payload: unknown) => {
      sent.push([type, payload]);
      return 0;
    }) as typeof ctx.hub.broadcast);

    const g = await post(`${base}/api/gen3d/generate`, { cardId: 'card_light' });
    expect(g.status).toBe(200);
    const gj = (await g.json()) as any;
    expect(gj).toMatchObject({ ok: true, model: 'muse-spark-1.3', source: 'live', uiSpec: { specId: 'spec_card_light', cardId: 'card_light', rev: 1 } });

    const e = await post(`${base}/api/gen3d/edit`, { specId: 'spec_card_light', instruction: 'make the dimmer a big red lever' });
    expect(e.status).toBe(200);
    const ej = (await e.json()) as any;
    expect(ej).toMatchObject({ ok: true, touched: ['parts:p_h_dim'], untouchedIdentical: true, uiSpec: { rev: 2 } });

    const s = await fetch(`${base}/api/gen3d/specs/spec_card_light`);
    expect(((await s.json()) as any).rev).toBe(2);
    expect(((await (await fetch(`${base}/api/gen3d/specs`)).json()) as any).specs).toHaveLength(1);

    const specs = sent.filter(([t]) => t === 'ui.spec').map(([, p]) => p);
    expect(specs).toHaveLength(2);
    for (const p of specs) expect(PayloadSchemas['ui.spec'].safeParse(p).success).toBe(true);
    const steps = sent.filter(([t]) => t === 'agent.step').map(([, p]) => p);
    expect(steps.length).toBeGreaterThan(5);
    for (const p of steps) expect(PayloadSchemas['agent.step'].safeParse(p).success).toBe(true);
    // every Meta call is in the shared call log (GET /api/muse/calls)
    const calls = ((await (await fetch(`${base}/api/muse/calls`)).json()) as any).calls;
    expect(calls.map((c: { label: string }) => c.label)).toEqual(['gen3d.forge', 'gen3d.edit']);
  });

  it('streams progress as Server-Sent Events with ?stream=1', async () => {
    const { base } = await start();
    const res = await post(`${base}/api/gen3d/generate?stream=1`, { cardId: 'card_light' });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('event: progress');
    expect(text).toMatch(/event: result\ndata: \{"ok":true/);
  });

  it('answers 404 for unknown cards/specs, 400 for bad bodies, 401 off-host without a token', async () => {
    const { base, local } = await start();
    expect((await post(`${base}/api/gen3d/generate`, { cardId: 'card_nope' })).status).toBe(404);
    expect((await post(`${base}/api/gen3d/edit`, { specId: 'spec_nope', instruction: 'x' })).status).toBe(404);
    expect((await post(`${base}/api/gen3d/edit`, { specId: 'x' })).status).toBe(400);
    local.v = false;
    expect((await post(`${base}/api/gen3d/generate`, { cardId: 'card_light' })).status).toBe(401);
  });
});
