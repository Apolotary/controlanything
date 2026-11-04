import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCardPayload } from '@ce/protocol';
import type { ServerContext } from '../context';
import { MidiChartStore } from '../devices/midi-charts';
import { getAgent } from './index';
import { agentRouter } from './routes';

vi.mock('./index', () => ({ getAgent: vi.fn() }));
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.mocked(getAgent).mockReset();
});
const card: DeviceCardPayload = { cardId: 'orion', name: 'Orion 6', maker: 'Example', model: 'Orion 6', category: 'synthesizer', confidence: .9, protocols: ['midi'], requires: ['midi'], evidence: [] };
const body = { cardId: 'orion', reviewed: true, expectedRevision: 0, chart: { maker: 'Example', model: 'Orion 6', channel: 3,
  source: { title: 'Orion manual', url: 'https://example.com/orion/manual', section: 'Page 42' }, parameters: [{ cc: 74, name: 'Cutoff', min: 20, max: 100 }] } };

async function setup(local = true) {
  const target = { card, armed: false, abort: undefined as AbortController | undefined };
  const agent = { targets: { get: (id: string) => id === card.cardId ? target : undefined }, midiCharts: new MidiChartStore(), invalidateMidiChart: vi.fn(), setup: vi.fn(), dispatcher: { exec: vi.fn() } };
  vi.mocked(getAgent).mockReturnValue(agent as unknown as ReturnType<typeof getAgent>);
  const ctx = { registry: { authenticate: (token: string) => token === 'owner' ? { name: 'Paired owner', canApprove: true } : undefined }, isLocal: () => local } as unknown as ServerContext;
  const app = express(); app.use(express.json()); app.use(agentRouter(ctx));
  const server = createServer(app); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (data: unknown, token?: string) => fetch(`${base}/midi-charts`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
  return { base, post, target, agent };
}

describe('reviewed MIDI chart API', () => {
  it('stores the reviewed subset, preserves CAS revision and sends no device/setup commands', async () => {
    const h = await setup();
    expect(await (await fetch(`${h.base}/midi-charts/orion`)).json()).toMatchObject({ card: { cardId: 'orion' }, revision: 0, chart: null });
    const response = await h.post(body); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 1, chart: { revision: 1, reviewedBy: 'Mac owner', chart: body.chart } });
    expect((await h.post(body)).status).toBe(409);
    expect(h.agent.invalidateMidiChart).toHaveBeenCalledExactlyOnceWith('orion');
    expect(h.agent.setup).not.toHaveBeenCalled(); expect(h.agent.dispatcher.exec).not.toHaveBeenCalled();
  });
  it('requires owner access and explicit reviewed identity, and refuses an active setup', async () => {
    const h = await setup(false);
    expect((await h.post(body)).status).toBe(403);
    expect((await fetch(`${h.base}/midi-charts/orion`)).status).toBe(401); // unpaired GETs stop at the router's room-diagnostics guard
    expect((await h.post({ ...body, reviewed: false }, 'owner')).status).toBe(400);
    expect((await h.post({ ...body, chart: { ...body.chart, model: 'Another device' } }, 'owner')).status).toBe(400);
    h.target.armed = true; expect((await h.post(body, 'owner')).status).toBe(409);
    h.target.armed = false; h.target.abort = new AbortController(); expect((await h.post(body, 'owner')).status).toBe(409);
    h.target.abort.abort(); expect((await h.post(body, 'owner')).status).toBe(200);
    expect(h.agent.dispatcher.exec).not.toHaveBeenCalled();
  });
});
