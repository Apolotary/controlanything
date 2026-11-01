/**
 * The headset as an approver: other devices (Cardputer, DevTerm, iPhone…) waiting to join show up as
 * `pair.pending`; the user approves with a pinch on the HUD card, or by LOOKING at the device's QR code
 * (the server decodes QR codes in scan frames with purpose "pair", SPEC §2).
 */
import type { PendingPairing } from '@ce/protocol';
import { Emitter } from '../app/emitter';
import type { ApprovalView } from '../app/hud-contract';
import type { Envelope, WsClient } from '../io/ws';

export class Approvals extends Emitter<{ change: ApprovalView[]; resolved: { pairingId: string; approved: boolean; name?: string } }> {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(private readonly ws: WsClient) {
    super();
    ws.on('pair.pending', (m: Envelope) => {
      const p = m.payload as PendingPairing;
      if (!p?.pairingId) return;
      this.pending.set(p.pairingId, p);
      this.changed();
    });
    ws.on('pair.approved', (m: Envelope) => this.resolve((m.payload as { pairingId: string }).pairingId, true, (m.payload as { name?: string }).name));
    ws.on('pair.denied', (m: Envelope) => this.resolve((m.payload as { pairingId: string }).pairingId, false));
    // drop expired entries
    setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [id, p] of this.pending) if (p.expiresAt < now) dirty = this.pending.delete(id) || dirty;
      if (dirty) this.changed();
    }, 5000);
  }

  get list(): ApprovalView[] {
    return [...this.pending.values()].map((p) => ({ pairingId: p.pairingId, name: p.name, kind: p.kind, display: p.display }));
  }

  get count(): number {
    return this.pending.size;
  }

  approve(pairingId: string): boolean {
    const p = this.pending.get(pairingId);
    if (!p) return false;
    return this.ws.send('pair.approve', { code: p.code, pairingId }) !== null;
  }

  deny(pairingId: string): boolean {
    if (!this.pending.has(pairingId)) return false;
    return this.ws.send('pair.deny', { pairingId }) !== null;
  }

  /** Approve the only (or oldest) waiting device: keyboard shortcut and voice "approve". */
  approveFirst(): boolean {
    const first = [...this.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt)[0];
    return first ? this.approve(first.pairingId) : false;
  }

  private resolve(pairingId: string, approved: boolean, name?: string): void {
    if (!pairingId) return;
    const had = this.pending.delete(pairingId);
    if (had) {
      this.emit('resolved', { pairingId, approved, name });
      this.changed();
    }
  }

  private changed(): void {
    this.emit('change', this.list);
  }
}
