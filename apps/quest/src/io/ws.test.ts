import { afterEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from './ws';
import { QuestApp } from '../app/app';

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  static current: FakeSocket;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  close = vi.fn();
  constructor() { FakeSocket.current = this; }
}
afterEach(() => vi.unstubAllGlobals());

describe('socket trust and playback', () => {
  it('only reuses saved credentials for the page origin or loopback', () => {
    const page = { origin: 'https://mac.local:8443' };
    expect(WsClient.allowsSavedToken('wss://mac.local:8443/ws', page)).toBe(true);
    expect(WsClient.allowsSavedToken('ws://localhost:8787/ws', page)).toBe(true);
    expect(WsClient.allowsSavedToken('ws://127.0.0.1:8787/ws', page)).toBe(true);
    expect(WsClient.allowsSavedToken('ws://[::1]:8787/ws', page)).toBe(true);
    expect(WsClient.allowsSavedToken('wss://mac.local:9443/ws', page)).toBe(false);
    expect(WsClient.allowsSavedToken('wss://other.test/ws', page)).toBe(false);
    expect(WsClient.allowsSavedToken('wss://localhost.other.test/ws', page)).toBe(false);
  });

  it('isolates every outbound and live inbound message during playback while allowing recorded injection', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new WsClient('ws://localhost/ws', () => ({ deviceToken: 'token', role: 'hmd', capabilities: [] }));
    client.start(); FakeSocket.current.onopen?.();
    const handler = vi.fn(); client.onAny(handler);
    client.setPlayback(true);
    for (const type of ['control.event', 'hack.invoke', 'arm.confirm', 'tag.add', 'control.setup', 'voice.text', 'panic']) {
      expect(client.send(type, {})).toBeNull();
    }
    const message = { v: 1 as const, type: 'replay.example', id: 'recorded', ts: 1, from: 'server', payload: {} };
    FakeSocket.current.onmessage?.({ data: JSON.stringify(message) });
    expect(handler).not.toHaveBeenCalled();
    client.inject(message);
    expect(handler).toHaveBeenCalledExactlyOnceWith(message);
    expect(FakeSocket.current.send).toHaveBeenCalledTimes(1);
    client.stop();
  });
});

it('never includes a saved headset token in hello for a foreign override', () => {
  vi.stubGlobal('location', { origin: 'https://mac.local:8443' });
  const app = Object.create(QuestApp.prototype) as QuestApp;
  Object.assign(app, { ws: { url: 'wss://other.test/ws' }, identity: { deviceToken: 'saved-owner-token' }, mic: { ready: false }, params: new URLSearchParams() });
  expect(Reflect.get(app, 'helloPayload').call(app).deviceToken).toBe('');
  Object.assign(app, { freshSocketIdentity: true, identity: { deviceToken: 'new-destination-token' } });
  expect(Reflect.get(app, 'helloPayload').call(app).deviceToken).toBe('new-destination-token');
});

it('only advertises the headset microphone after it is prepared and enabled', () => {
  vi.stubGlobal('location', { origin: 'https://mac.local:8443' });
  const app = Object.create(QuestApp.prototype) as QuestApp;
  const mic = { ready: false }, params = new URLSearchParams();
  Object.assign(app, { ws: { url: 'wss://mac.local:8443/ws' }, mic, params });
  const capabilities = () => Reflect.get(app, 'helloPayload').call(app).capabilities as string[];
  expect(capabilities()).not.toContain('mic');
  mic.ready = true;
  expect(capabilities()).toContain('mic');
  params.set('mic', '0');
  expect(capabilities()).not.toContain('mic');
});
