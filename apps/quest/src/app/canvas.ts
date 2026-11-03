import { newId, type CanvasStatePayload, type PayloadOf } from '@ce/protocol';
import type { CanvasView } from '../hud/contract';

export interface CanvasTarget { targetId: string; cardId: string; busy?: boolean }
type CanvasMessage = 'canvas.get' | 'canvas.request' | 'canvas.cancel' | 'canvas.restore' | 'canvas.action';
interface CanvasDeps {
  selected(): CanvasTarget | undefined;
  send(type: CanvasMessage, payload: unknown): boolean;
  render(view: CanvasView | null): void;
  pauseControls(): void;
}

/** Selected-object canvas requests and shared game snapshots; never a hardware control sender. */
export class ObjectCanvas {
  private selected?: CanvasTarget;
  private state?: CanvasStatePayload;
  private lastReady?: CanvasStatePayload;
  private pending?: { id: string; cardId: string; generation: boolean };
  private loading = false;
  private shown = false;
  private readonly cancelled = new Set<string>();
  private readonly voice = new Set<string>();
  get open(): boolean { return this.shown; }
  hasDocument(cardId: string): boolean { return this.selected?.cardId === cardId && !!this.state?.document; }
  constructor(private readonly d: CanvasDeps) {}

  syncSelection(): void {
    const next = this.d.selected();
    if (next?.targetId === this.selected?.targetId && next?.cardId === this.selected?.cardId) return;
    this.reset(); this.selected = next;
    if (next) this.loading = this.d.send('canvas.get', { cardId: next.cardId });
  }

  openOrCreate(targetId: string): void {
    this.syncSelection(); const target = this.selected;
    if (!target || target.targetId !== targetId || this.d.selected()?.busy || this.pending || this.loading && this.shown) return;
    if (this.state?.document) {
      const previous = this.state;
      this.loading = this.d.send('canvas.get', { cardId: target.cardId });
      if (this.loading) this.show({ ...previous, status: 'generating', requestId: undefined, message: 'Opening the latest saved game…' });
      else this.failed('The server is disconnected. Reconnect to open the saved game.');
      return;
    }
    this.request(target, 'Make a short game inspired by this object.');
  }

  private request(target: CanvasTarget, prompt: string): void {
    const requestId = newId('canvas');
    this.pending = { id: requestId, cardId: target.cardId, generation: true }; this.loading = false;
    const payload = { requestId, cardId: target.cardId, prompt, ...(this.state?.document ? { baseRevision: this.state.document.revision } : {}) };
    if (this.d.send('canvas.request', payload)) this.show({ cardId: target.cardId, requestId, status: 'generating', document: this.state?.document, message: 'Muse is making a game for this object.' });
    else this.failed('The server is disconnected. Reconnect and try again.');
  }

  action(targetId: string, action: Omit<PayloadOf<'canvas.action'>, 'requestId' | 'cardId'>): void {
    const target = this.current(targetId);
    if (!target || !this.shown || this.pending || this.state?.status !== 'ready' || action.revision !== this.state.document?.revision) return;
    const requestId = newId('canvas'); this.pending = { id: requestId, cardId: target.cardId, generation: false };
    if (!this.d.send('canvas.action', { ...action, requestId, cardId: target.cardId })) this.failed('The server is disconnected. Reconnect to continue.');
  }

  restore(targetId: string, revision: number, baseRevision: number): void {
    const target = this.current(targetId), document = this.state?.document;
    if (!target || !this.shown || this.pending || this.state?.status !== 'ready' || !document || baseRevision !== document.revision
      || !document.history.some((item) => item.revision === revision && revision < baseRevision)) return;
    const requestId = newId('canvas'); this.pending = { id: requestId, cardId: target.cardId, generation: true };
    if (this.d.send('canvas.restore', { requestId, cardId: target.cardId, revision, baseRevision })) this.show({ ...this.state!, status: 'generating', requestId, message: 'Restoring the previous version…' });
    else this.failed('The server is disconnected. Reconnect to restore this version.');
  }

  /** Voice generation states use the selected request's utterance ID. A question alone opens nothing. */
  allowVoice(targetId: string, requestId: string): void {
    this.syncSelection(); if (!this.current(targetId)) return;
    this.voice.clear(); this.voice.add(requestId);
  }
  cancelVoice(requestId: string): void {
    this.voice.delete(requestId);
    this.rememberCancelled(requestId);
    if (this.pending?.id !== requestId) return;
    this.cancelPending();
    if (this.lastReady) this.show(this.lastReady); else { this.shown = false; this.d.render(null); }
  }

  receive(state: CanvasStatePayload): void {
    const target = this.current();
    if (!target || state.cardId !== target.cardId || state.document && state.document.cardId !== target.cardId) return;
    const id = state.requestId;
    if (id && this.cancelled.has(id)) return;
    const own = !!id && id === this.pending?.id, spoken = !!id && this.voice.has(id);
    if (this.pending && !own && !spoken) return;
    if (spoken && this.pending && !own) this.cancelPending();
    const fetched = !id && this.loading;
    const shared = this.shown && this.state?.document && state.document?.canvasId === this.state.document.canvasId;
    if (!own && !spoken && !fetched && !shared) return;
    if (state.document && this.state?.document?.canvasId === state.document.canvasId && state.document.revision < this.state.document.revision) return;
    this.loading = false;
    if (state.status === 'generating') {
      if (id && (own || spoken)) this.pending = { id, cardId: target.cardId, generation: true };
    } else {
      if (own || spoken) this.pending = undefined;
      if (state.status === 'ready' && state.document) this.lastReady = state;
      if (id) { this.rememberCancelled(id); this.voice.delete(id); }
    }
    if (fetched && !state.document && state.status === 'ready') {
      this.state = this.lastReady = undefined; this.shown = false; this.d.render(null); return;
    }
    if (fetched && state.status === 'error' && !state.document && this.lastReady?.document) state = { ...state, document: this.lastReady.document };
    this.state = state;
    this.show(state);
  }

  close(targetId?: string): void {
    if (targetId && targetId !== this.selected?.targetId) return;
    this.cancelPending(); this.loading = false;
    for (const id of this.voice) this.rememberCancelled(id);
    this.voice.clear(); this.shown = false;
    if (this.lastReady) this.state = this.lastReady;
    this.d.render(null);
  }
  disconnect(): void { this.reset(); this.selected = undefined; }
  private reset(): void { this.close(); this.state = this.lastReady = undefined; }
  private current(targetId?: string): CanvasTarget | undefined {
    const target = this.d.selected();
    return target && target.targetId === this.selected?.targetId && target.cardId === this.selected.cardId && (!targetId || target.targetId === targetId) ? target : undefined;
  }
  private show(state: CanvasStatePayload): void {
    const target = this.current(); if (!target) return;
    this.state = state; this.shown = true; this.d.pauseControls();
    this.d.render({ targetId: target.targetId, state });
  }
  private failed(message: string): void {
    this.pending = undefined;
    if (this.selected) this.show({ cardId: this.selected.cardId, status: 'error', document: this.lastReady?.document, message });
  }
  private cancelPending(): void {
    const pending = this.pending; this.pending = undefined;
    if (!pending) return;
    this.rememberCancelled(pending.id);
    if (pending.generation) this.d.send('canvas.cancel', { requestId: pending.id, cardId: pending.cardId });
  }
  private rememberCancelled(id: string): void { this.cancelled.add(id); while (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.values().next().value!); }
}
