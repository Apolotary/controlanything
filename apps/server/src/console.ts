/**
 * Approve pairings from the server terminal: each new request is printed with its code;
 * type "y" (or "y K7Q4M2" when several wait) to approve, "n" to deny. Also "devices" and "pending".
 */
import { createInterface } from 'node:readline';
import { formatCode, normalizeCode } from '@ce/protocol';
import type { ServerContext } from './context';
import { PairingError } from './pairing/manager';

export function startConsoleApprovals(ctx: ServerContext, input: NodeJS.ReadableStream = process.stdin, print: (line: string) => void = console.log): () => void {
  const off = [
    ctx.pairing.on('pending', (p) => {
      print(`\n[pair] ${p.name} (${p.kind}) wants to join · code ${p.display}${p.origin ? ` · from ${p.origin}` : ''}`);
      print('[pair] type "y" + Enter to approve, "n" to deny');
    }),
    ctx.pairing.on('approved', (e) => print(`[pair] approved ${e.device.name} (${e.device.kind}) as ${e.device.deviceId} by ${e.approvedBy}`)),
    ctx.pairing.on('denied', (e) => print(`[pair] request ${e.pairingId} ${e.reason}`)),
  ];
  const rl = createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    const [cmd = '', arg] = line.trim().split(/\s+/, 2);
    const c = cmd.toLowerCase();
    if (c === 'pending') {
      const list = ctx.pairing.listPending();
      print(list.length ? list.map((p) => `[pair] ${p.display}  ${p.name} (${p.kind})`).join('\n') : '[pair] nothing is waiting');
      return;
    }
    if (c === 'devices') {
      for (const d of ctx.hub.devices()) print(`[space] ${d.online ? '●' : '○'} ${d.deviceId}  ${d.name} (${d.kind}${d.canApprove ? ', approver' : ''})`);
      return;
    }
    if (!['y', 'yes', 'n', 'no'].includes(c)) return;
    const pending = ctx.pairing.listPending();
    const target = arg ? pending.find((p) => p.code === normalizeCode(arg)) : pending.length === 1 ? pending[0] : undefined;
    if (!target) {
      print(pending.length ? `[pair] ${pending.length} requests wait; type "${c} <code>" (${pending.map((p) => p.display).join(', ')})` : '[pair] nothing is waiting for approval');
      return;
    }
    try {
      if (c.startsWith('y')) ctx.pairing.approve({ code: target.code, pairingId: target.pairingId }, { type: 'console' });
      else ctx.pairing.deny({ pairingId: target.pairingId }, { type: 'console' });
    } catch (e) {
      print(`[pair] ${e instanceof PairingError ? e.message : (e as Error).message} (${formatCode(target.code)})`);
    }
  });
  return () => {
    for (const f of off) f();
    rl.close();
  };
}
