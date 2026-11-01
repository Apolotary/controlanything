/**
 * Several sim pages can be open on the same origin (the full /sim/ page, and /sim/?embed=room inside the
 * Quest app's desktop emulator). Exactly one of them is the LEADER: it pairs, executes and senses. The others
 * are followers that mirror the lamp from the leader's broadcasts and forward remote presses to it.
 *
 * Leadership is a Web Lock. A full page always wins: it asks an embedded leader to yield, and an embed takes
 * over again when the full page closes.
 */
import type { CodeSet, LampCmd } from './ir/table';
import type { LampState } from './room/lamp';

export type SyncMsg =
  | { type: 'state'; state: LampState; codeSetId: string; from: string; at: number }
  | { type: 'press'; cmd: LampCmd; channel: 1 | 2; from: string }
  | { type: 'yield'; from: string }
  | { type: 'ask'; from: string };

const LOCK = 'ce-sim-leader';
/** Omit that keeps the union apart (plain Omit collapses it). */
type Outgoing<T> = T extends unknown ? Omit<T, 'from'> : never;

export class SimSync {
  readonly id = Math.random().toString(36).slice(2, 10);
  private readonly bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ce-sim') : undefined;
  leader = false;
  private release?: () => void;
  onLeader: (leader: boolean) => void = () => {};
  onMessage: (m: SyncMsg) => void = () => {};

  constructor(readonly full: boolean) {
    if (this.bc) {
      this.bc.onmessage = (ev) => {
        const m = ev.data as SyncMsg;
        if (!m || m.from === this.id) return;
        if (m.type === 'yield' && this.leader && !this.full) this.giveUp();
        this.onMessage(m);
      };
    }
  }

  post(m: Outgoing<SyncMsg>): void {
    this.bc?.postMessage({ ...m, from: this.id });
  }

  broadcastState(state: LampState, codeSet: CodeSet): void {
    this.post({ type: 'state', state, codeSetId: codeSet.id, at: Date.now() });
  }

  /** Start the election. Without Web Locks every page is its own leader. */
  async start(): Promise<void> {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      this.setLeader(true);
      return;
    }
    // the lock is held for as long as the callback's promise is pending (holdAsync resolves on giveUp)
    const got = await new Promise<boolean>((resolveGot) => {
      void locks.request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolveGot(false);
          return undefined;
        }
        resolveGot(true);
        return this.holdAsync();
      });
    });
    if (got) return;
    this.setLeader(false);
    if (this.full) this.post({ type: 'yield' }); // ask an embedded leader to step aside
    this.post({ type: 'ask' });
    this.queue();
  }

  private queue(): void {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    void locks?.request(LOCK, () => this.holdAsync());
  }

  private holdAsync(): Promise<void> {
    this.setLeader(true);
    return new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  private giveUp(): void {
    if (!this.release) return;
    this.release();
    this.release = undefined;
    this.setLeader(false);
    // an embed takes over again as soon as the full page goes away
    setTimeout(() => this.queue(), 50);
  }

  private setLeader(v: boolean): void {
    if (this.leader === v) return;
    this.leader = v;
    this.onLeader(v);
  }
}
