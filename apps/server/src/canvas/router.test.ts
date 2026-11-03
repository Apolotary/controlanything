import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMessage, type MessageType, type PayloadOf } from '@ce/protocol';
import { createContext } from '../context';
import { loadConfig } from '../config';
import { createAgent } from '../agent';
import type { HubMessageEvent } from '../hub';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); });
function setup() {
  const config = loadConfig({ MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' });
  const ctx = createContext(config, { registryFile: null, log: () => {} });
  const broadcast = vi.spyOn(ctx.hub, 'broadcast'), send = vi.spyOn(ctx.hub, 'sendToDevice'), listen = vi.spyOn(ctx.hub, 'onMessage');
  const agent = createAgent(ctx, { macLocal: false, tagsFile: null, forge: () => undefined });
  const exec = vi.spyOn(agent.dispatcher, 'exec');
  agent.targets.create({ cardId: 'book', card: { cardId: 'book', name: 'Blue book', maker: 'unknown', model: '', category: 'other', confidence: .8, protocols: [], evidence: ['Blue cover'] } });
  agent.addTag({ targetId: 'book', label: 'Blue book' }, { deviceId: 'quest' });
  agent.setMode('control');
  cleanup.push(() => { agent.close(); ctx.hub.close(); });
  const emit = <T extends MessageType>(type: T, payload: PayloadOf<T>, canApprove = true) => listen.mock.calls[0][0]({
    message: makeMessage(type, payload, { from: 'quest', to: 'server' }),
    device: { deviceId: 'quest', name: 'Quest', kind: 'quest', capabilities: ['camera'], canApprove, tokenHash: 'fake', pairedAt: 1 },
    connection: { local: false } as HubMessageEvent['connection'],
  });
  const states = () => broadcast.mock.calls.flatMap(([type, payload]) => type === 'canvas.state' ? [payload as PayloadOf<'canvas.state'>] : []);
  return { agent, emit, exec, states, send };
}
describe('canvas agent routing', () => {
  it('creates, plays, and forgets an unconnected tagged object without physical setup or execution', async () => {
    const h = setup();
    h.emit('canvas.request', { cardId: 'book', requestId: 'create', prompt: 'Make a game' });
    await vi.waitFor(() => expect(h.states().at(-1)).toMatchObject({ status: 'ready', requestId: 'create', document: { revision: 1 }, game: { phase: 'preview' } }));
    h.emit('canvas.action', { cardId: 'book', requestId: 'play', revision: 1, action: 'play' });
    expect(h.states().at(-1)!.game?.phase).toBe('playing');
    expect(h.agent.targets.get('book')!.armed).toBe(false); expect(h.exec).not.toHaveBeenCalled(); expect(h.agent.arm.pendingIds()).toEqual([]);
    h.emit('library.forget', { cardId: 'book' });
    h.emit('canvas.get', { cardId: 'book' });
    expect(h.send.mock.calls.at(-1)).toMatchObject(['quest', 'canvas.state', { status: 'error' }]);
  });
  it('rejects unprivileged creation and untagged objects with correlated errors', () => {
    const h = setup();
    h.emit('canvas.request', { cardId: 'book', requestId: 'forbidden', prompt: 'Make a game' }, false);
    expect(h.send.mock.calls.at(-1)).toMatchObject(['quest', 'canvas.state', { requestId: 'forbidden', status: 'error' }]);
    h.emit('canvas.request', { cardId: 'absent', requestId: 'absent', prompt: 'Make a game' });
    expect(h.send.mock.calls.at(-1)).toMatchObject(['quest', 'canvas.state', { requestId: 'absent', status: 'error' }]);
    expect(h.states()).toHaveLength(0); expect(h.exec).not.toHaveBeenCalled();
  });
  it('voice requests use the same selected object pipeline and utterance request ID', async () => {
    const h = setup(); h.emit('voice.text', { cardId: 'book', utteranceId: 'spoken', text: 'Create a game with this book', final: true });
    await vi.waitFor(() => expect(h.states().at(-1)).toMatchObject({ status: 'ready', requestId: 'spoken', document: { revision: 1 } }));
    expect(h.exec).not.toHaveBeenCalled();
  });
  it('voice undo with a selected canvas cannot enter physical undo', async () => {
    const h = setup(); h.emit('canvas.request', { cardId: 'book', requestId: 'create', prompt: 'Make a game' });
    await vi.waitFor(() => expect(h.states().at(-1)?.document?.revision).toBe(1));
    const undo = vi.spyOn(h.agent.control, 'undo');
    h.emit('voice.text', { cardId: 'book', utteranceId: 'undo-game', text: 'undo this game', final: true });
    await Promise.resolve();
    expect(undo).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
    expect(h.states().at(-1)?.document?.revision).toBe(1);
  });
});
