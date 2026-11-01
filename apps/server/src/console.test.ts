import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { startConsoleApprovals } from './console';
import { createContext } from './context';

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('console approvals', () => {
  it('prints pending requests and approves with "y" or denies with "n <code>"', async () => {
    const ctx = createContext(loadConfig({}), { log: () => {}, registryFile: null, isLocal: () => false });
    const input = new PassThrough();
    const lines: string[] = [];
    const stop = startConsoleApprovals(ctx, input, (l) => lines.push(l));
    try {
      const a = ctx.pairing.start({ name: 'Cardputer', kind: 'cardputer' }, { origin: '10.0.0.5' });
      expect(lines.join('\n')).toContain(`Cardputer (cardputer) wants to join · code ${a.display} · from 10.0.0.5`);
      input.write('y\n');
      await tick();
      expect(ctx.pairing.status(a.pairingId, a.pollSecret).status).toBe('approved');

      const b = ctx.pairing.start({ name: 'DevTerm', kind: 'devterm' }, { origin: '10.0.0.6' });
      const c = ctx.pairing.start({ name: 'Phone', kind: 'web' }, { origin: '10.0.0.7' });
      input.write('y\n'); // ambiguous: two waiting
      await tick();
      expect(lines.at(-1)).toMatch(/2 requests wait/);
      input.write(`n ${c.display.toLowerCase()}\n`);
      await tick();
      expect(ctx.pairing.status(c.pairingId, c.pollSecret).status).toBe('denied');
      expect(ctx.pairing.status(b.pairingId, b.pollSecret).status).toBe('pending');
    } finally {
      stop();
      ctx.hub.close();
    }
  });
});
