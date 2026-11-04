import express from 'express';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMessage, type AnyMessage, type MessageType, type PayloadOf } from '@ce/protocol';
import { createContext, startServers } from '../context';
import { loadConfig } from '../config';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const config = loadConfig({ MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  config.https.enabled = false; config.http.enabled = true; config.http.host = '127.0.0.1';
  const ctx = createContext(config, { registryFile: null, projectsFile: null, isLocal: () => false, log: () => {} });
  const server = await startServers(ctx, express()); cleanup.push(() => server.close());
  async function connect(privileged: boolean, shared?: ReturnType<typeof ctx.registry.add>) {
    const record = shared ?? ctx.registry.add({ name: privileged ? 'Owner' : 'Device', kind: privileged ? 'quest' : 'devterm', canApprove: privileged });
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.bound.http}/ws`); const messages: AnyMessage[] = [];
    socket.on('message', (d) => messages.push(JSON.parse(String(d))));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); cleanup.push(() => socket.terminate());
    const send = <T extends MessageType>(type: T, payload: PayloadOf<T>, to?: string) => socket.send(JSON.stringify(makeMessage(type, payload, { to })));
    send('hello', { deviceToken: record.token, executor: false });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'welcome')).toBe(true));
    return { send, messages, socket, id: record.device.deviceId, record };
  }
  return { ctx, connect };
}
describe('project hub authorization', () => {
  it('keeps preset creation owner-only and server-bound without relaying its command', async () => {
    const h = await setup(), owner = await h.connect(true), observer = await h.connect(true), device = await h.connect(false);
    device.send('project.preset', { requestId: 'not-owner', presetId: 'chord-garden-v1' });
    await vi.waitFor(() => expect(device.messages.some(m => m.type === 'log' && (m.payload as PayloadOf<'log'>).code === 'forbidden')).toBe(true));
    expect(h.ctx.projects.service.catalog().projects).toHaveLength(0);
    owner.send('project.preset', { requestId: 'chords', presetId: 'chord-garden-v1' }, observer.id);
    await vi.waitFor(() => expect(h.ctx.projects.service.catalog().projects).toHaveLength(1));
    expect(observer.messages.some(m => m.type === 'project.preset')).toBe(false);
    expect(device.messages.some(m => m.type === 'project.state')).toBe(false);
    const projectId = h.ctx.projects.service.catalog().projects[0].projectId;
    expect(h.ctx.projects.service.snapshot(projectId)).toMatchObject({ document: { source: 'preset', presetId: 'chord-garden-v1' }, preview: { count: 0 } });
  });
  it('expires the rendering socket even while another tab with the same device identity stays connected', async () => {
    // Two companion tabs of one Mac stay connected together (a headset identity keeps only its newest tab: hub single instance).
    const h = await setup(), mac = h.ctx.registry.add({ name: 'Mac', kind: 'mac', canApprove: true });
    const owner = await h.connect(true, mac), sameDevice = await h.connect(true, mac), viewer = await h.connect(true), unprivileged = await h.connect(false);
    owner.send('project.request', { requestId: 'create', prompt: 'Make an orb' });
    await vi.waitFor(() => expect(h.ctx.projects.service.catalog().projects).toHaveLength(1));
    const projectId = h.ctx.projects.service.catalog().projects[0].projectId;
    unprivileged.send('project.preview', { projectId, revision: 1, active: true });
    await vi.waitFor(() => expect(unprivileged.messages.some(m => m.type === 'log' && (m.payload as PayloadOf<'log'>).code === 'forbidden')).toBe(true));
    expect(h.ctx.projects.service.snapshot(projectId)?.preview?.count).toBe(0);
    owner.send('project.preview', { projectId, revision: 1, active: true });
    await vi.waitFor(() => expect(h.ctx.projects.service.snapshot(projectId)?.preview?.count).toBe(1));
    owner.socket.close();
    await vi.waitFor(() => expect(h.ctx.projects.service.snapshot(projectId)?.preview?.count).toBe(0));
    expect(sameDevice.socket.readyState).toBe(WebSocket.OPEN);
    await vi.waitFor(() => expect(viewer.messages.some(m => m.type === 'project.state' && (m.payload as PayloadOf<'project.state'>).preview?.count === 0)).toBe(true));
  });
  it('never relays project commands, rejects unprivileged writes and server-state spoofing', async () => {
    const h = await setup(), owner = await h.connect(true), otherOwner = await h.connect(true), device = await h.connect(false);
    owner.send('project.request', { requestId: 'create', prompt: 'Make an orb' }); // deliberately no to:server
    await vi.waitFor(() => expect(owner.messages.some((m) => m.type === 'project.state' && (m.payload as PayloadOf<'project.state'>).document)).toBe(true));
    expect(otherOwner.messages.some((m) => m.type === 'project.request')).toBe(false);
    expect(device.messages.some((m) => m.type === 'project.state')).toBe(false);
    const document = h.ctx.projects.service.catalog().projects[0];
    device.send('project.action', { requestId: 'evil', projectId: document.projectId, revision: 1, actionId: 'amount', value: 0.1 }, owner.id);
    await vi.waitFor(() => expect(device.messages.some((m) => m.type === 'log' && (m.payload as PayloadOf<'log'>).code === 'forbidden')).toBe(true));
    expect(h.ctx.projects.service.snapshot(document.projectId)?.values?.amount).toBe(0.5);
    expect(owner.messages.some((m) => m.type === 'project.action')).toBe(false);
    owner.send('project.state', { projectId: document.projectId, status: 'ready', revision: 999, values: { amount: 0 } });
    await vi.waitFor(() => expect(owner.messages.some((m) => m.type === 'log' && (m.payload as PayloadOf<'log'>).code === 'server_only')).toBe(true));
    expect(h.ctx.projects.service.snapshot(document.projectId)?.revision).toBe(1);
  });
});
