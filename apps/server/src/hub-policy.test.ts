import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import { makeMessage, type HelloPayload, type PayloadOf } from '@ce/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { loadConfig } from './config';
import { createContext } from './context';
import { allowedSocketOrigin, sameHostOrigin } from './origin';
import { createAgent } from './agent';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function harness() {
  const ctx = createContext(loadConfig({ MODEL_MODE: 'fixture', CE_TRUST_LOOPBACK: '1' }), { registryFile: null, isLocal: () => true, log: () => {} });
  cleanup.push(() => ctx.hub.close());
  const connect = (origin?: string) => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), terminate: vi.fn() });
    const req = { headers: { host: 'localhost:8787', ...(origin ? { origin } : {}) }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
    (ctx.hub as unknown as { onConnection(ws: WebSocket, req: IncomingMessage): void }).onConnection(ws as unknown as WebSocket, req);
    return {
      hello: (payload: HelloPayload) => ws.emit('message', Buffer.from(JSON.stringify(makeMessage('hello', payload))), false),
      pair: () => ws.emit('message', Buffer.from(JSON.stringify(makeMessage('pair.start', { name: 'Quest', kind: 'quest' }))), false),
      payloads: (type: string) => ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string)).filter((m) => m.type === type).map((m) => m.payload),
      close: () => ws.emit('close'),
    };
  };
  return { ctx, connect };
}

describe('browser origin policy', () => {
  it.each(['http://localhost:8787', 'https://localhost:8443'])('accepts the server page at %s across ports', (origin) => {
    expect(allowedSocketOrigin({ host: 'localhost:8787', origin })).toBe(true);
    expect(sameHostOrigin({ host: 'localhost:8787', origin })).toBe(true);
  });
  it('accepts native sockets without assigning page ownership', () => {
    expect(allowedSocketOrigin({ host: 'localhost:8787' })).toBe(true);
    expect(sameHostOrigin({ host: 'localhost:8787' })).toBe(false);
    const h = harness();
    const native = h.connect();
    native.pair();
    expect(native.payloads('pair.status')[0].status).toBe('pending');
    const page = h.connect('http://localhost:8787');
    page.pair();
    expect(page.payloads('pair.status')[0].status).toBe('approved');
    expect(page.payloads('pair.approved')[0].deviceToken).toBeTruthy();
  });
  it.each(['https://unrelated.example', 'null', 'http://localhost.evil:8787', 'http://localhost:8787/path'])('rejects browser Origin %s before upgrade', (origin) => {
    expect(allowedSocketOrigin({ host: 'localhost:8787', origin })).toBe(false);
    const { ctx } = harness();
    const server = new EventEmitter();
    ctx.hub.attach(server as Server);
    const socket = { end: vi.fn(), destroy: vi.fn() };
    server.emit('upgrade', { url: '/ws', headers: { host: 'localhost:8787', origin } }, socket, Buffer.alloc(0));
    expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('403'));
  });
});

describe('executor connection presence', () => {
  it('publishes fresh synth cards immediately for pairing, USB changes, standby tabs and reloads', () => {
    const { ctx, connect } = harness();
    const agent = createAgent(ctx, { macLocal: false, tagsFile: null, forge: () => undefined });
    cleanup.push(() => agent.close());
    const questIdentity = ctx.registry.add({ name: 'Quest 3', kind: 'quest' });
    const quest = connect();
    quest.hello({ deviceToken: questIdentity.token });
    const target = agent.targets.create({ cardId: 'synth', card: {
      cardId: 'synth', name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field', category: 'synthesizer',
      confidence: 1, protocols: ['midi'], requires: ['midi'], evidence: [],
    } });
    agent.addTag({ targetId: target.cardId, label: 'Synth' }, questIdentity.device);
    const latestTag = () => quest.payloads('tags.state').at(-1)?.tags[0];
    expect(latestTag()).toMatchObject({ connection: 'offline', action: 'open-companion' });

    const { token } = ctx.registry.add({ name: 'Mac', kind: 'mac' });
    const mac = connect();
    mac.hello({ deviceToken: token, executor: true, capabilities: [], ports: [] });
    expect(latestTag()).toMatchObject({ connection: 'offline', hint: 'Plug the synth into your Mac' });
    expect(latestTag().action).toBeUndefined();
    const ports: NonNullable<PayloadOf<'hello'>['ports']> = [{ id: 'out', name: 'OP-1 Field', kind: 'midi-out', state: 'connected' }];
    mac.hello({ deviceToken: token, executor: true, capabilities: ['midi'], ports });
    expect(latestTag().connection).toBe('setup');
    mac.hello({ deviceToken: token, ports: [] });
    expect(latestTag()).toMatchObject({ connection: 'offline', hint: 'Plug the synth into your Mac' });
    mac.hello({ deviceToken: token, ports });
    const standby = connect();
    standby.hello({ deviceToken: token, executor: false, capabilities: [], ports: [] });
    expect(latestTag().connection).toBe('setup');
    standby.close();
    expect(latestTag().connection).toBe('setup');
    mac.close();
    expect(latestTag()).toMatchObject({ connection: 'offline', action: 'open-companion' });
    const reloadedMac = connect();
    reloadedMac.hello({ deviceToken: token, executor: true, capabilities: ['midi'], ports });
    expect(latestTag().connection).toBe('setup');
    quest.close();
    const reloadedQuest = connect();
    reloadedQuest.hello({ deviceToken: questIdentity.token });
    expect(reloadedQuest.payloads('tags.state').at(-1)?.tags[0]).toMatchObject({ cardId: 'synth', connection: 'setup' });
    expect(ctx.registry.list()).toHaveLength(2);
    expect(agent.steps.list()).toEqual([]);
  });

  it('keeps active ports and capabilities when a standby opens, and follows leadership changes', () => {
    const { ctx, connect } = harness();
    const { token } = ctx.registry.add({ name: 'Mac', kind: 'mac' });
    const owner = connect();
    const standby = connect();
    const ports: NonNullable<PayloadOf<'hello'>['ports']> = [{ id: 'out', name: 'Synth', kind: 'midi-out' }];
    owner.hello({ deviceToken: token, executor: true, capabilities: ['midi', 'ir'], ports });
    standby.hello({ deviceToken: token, executor: false, capabilities: [], ports: [] });
    expect(ctx.hub.devices()[0]).toMatchObject({ ports, capabilities: ['midi', 'ir'], connections: 2 });
    owner.hello({ deviceToken: token, executor: false, capabilities: [], ports: [] });
    standby.hello({ deviceToken: token, executor: true, capabilities: ['midi'], ports });
    expect(ctx.hub.devices()[0]).toMatchObject({ ports, capabilities: ['midi'] });
    standby.close();
    expect(ctx.hub.devices()[0]).toMatchObject({ capabilities: [], connections: 1 });
    expect(ctx.hub.devices()[0].ports).toBeUndefined();
  });
});
