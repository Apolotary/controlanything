import { once } from 'node:events';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebBluetoothGimbalLink } from './links';

describe('Chrome gimbal pipe', () => {
  it('refuses foreign pages before they can replace the local Bluetooth tab', async () => {
    const link = new WebBluetoothGimbalLink({ port: 0 });
    const opened = link.open();
    const server = (link as unknown as { server: Server }).server;
    if (!server.listening) await once(server, 'listening');
    const origin = link.url.replace('localhost', '127.0.0.1').replace(/\/$/, '');
    const url = origin.replace('http:', 'ws:') + '/pipe';
    let good: WebSocket | undefined;
    try {
      const refused = new WebSocket(url, { origin: 'https://attacker.example' });
      refused.on('error', () => {});
      const status = await new Promise<number>((resolve) => refused.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); }));
      refused.terminate();
      expect(status).toBe(401); // ws verifyClient's default denial status
      good = new WebSocket(url, { origin });
      await once(good, 'open');
      good.send(JSON.stringify({ hello: 'Local pipe fixture' }));
      expect((await opened).name).toBe('Local pipe fixture');
      expect(link.connected).toBe(true);
    } finally { good?.terminate(); await link.close(); }
  });
});
