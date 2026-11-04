/**
 * One live headset tab. Quest Browser opens a new tab on every `am start`; the old tab kept the passthrough camera
 * (the new one got "Could not start video source") and kept sending control values as the same Quest identity.
 *
 * Rule (agreed with the server side): a tab claims ownership only while it is visible (on load, on
 * visibilitychange → visible, and on Enter AR). The newest claim wins. Claims travel two ways:
 * - a BroadcastChannel between same-origin tabs (works without the server, and before the socket is open);
 * - the socket: every `hello` is a claim, plus an explicit `session.claim` on an already-open socket. The server tells
 *   the older socket `session.superseded` and closes it with 4409; that tab must not reconnect.
 * A superseded tab stops its camera, scanner, mic and sends, and shows a static page with "Use this tab", which reloads
 * (and so claims again).
 */

export const CLOSE_SUPERSEDED = 4409;
export const SUPERSEDED_MESSAGE = 'session.superseded';
export const CLAIM_MESSAGE = 'session.claim';
const CHANNEL = 'ce-quest-instance';

export type ClaimReason = 'load' | 'visible' | 'enter-ar';
export type SupersededBy = 'tab' | 'server';

interface ClaimNote { type: 'claim'; tabId: string; at: number; reason: ClaimReason }

export interface SingleInstanceOptions {
  /** Called once when another tab (or the server) took over. */
  onSuperseded: (by: SupersededBy) => void;
  /** Called on every claim this tab makes (send `session.claim` on an open socket). */
  onClaim?: (reason: ClaimReason) => void;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener'>;
  channel?: () => Pick<BroadcastChannel, 'postMessage' | 'close'> & { onmessage: ((e: MessageEvent) => void) | null };
}

export class SingleInstance {
  readonly tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  superseded = false;
  supersededBy?: SupersededBy;
  private channel?: ReturnType<NonNullable<SingleInstanceOptions['channel']>>;
  private readonly doc: NonNullable<SingleInstanceOptions['doc']>;

  constructor(private readonly opts: SingleInstanceOptions) {
    this.doc = opts.doc ?? document;
  }

  start(): this {
    try {
      this.channel = this.opts.channel ? this.opts.channel() : typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : undefined;
    } catch {
      this.channel = undefined;
    }
    if (this.channel) {
      this.channel.onmessage = (e: MessageEvent) => {
        const note = e.data as Partial<ClaimNote> | null;
        if (note?.type === 'claim' && note.tabId && note.tabId !== this.tabId) this.supersede('tab');
      };
    }
    if (this.doc.visibilityState === 'visible') this.claim('load');
    this.doc.addEventListener('visibilitychange', () => {
      if (this.doc.visibilityState === 'visible') this.claim('visible');
    });
    return this;
  }

  /** Take ownership (newest claim wins). A superseded tab cannot claim; it reloads instead. */
  claim(reason: ClaimReason): boolean {
    if (this.superseded) return false;
    try {
      this.channel?.postMessage({ type: 'claim', tabId: this.tabId, at: Date.now(), reason } satisfies ClaimNote);
    } catch {
      // a closed channel: the server path still works
    }
    this.opts.onClaim?.(reason);
    return true;
  }

  supersede(by: SupersededBy): void {
    if (this.superseded) return;
    this.superseded = true;
    this.supersededBy = by;
    try { this.channel?.close(); } catch { /* already closed */ }
    this.channel = undefined;
    this.opts.onSuperseded(by);
  }
}

/** Static "Opened in another tab" page; "Use this tab" reloads, which claims again. */
export function showSupersededPage(doc: Document = document, reload: () => void = () => location.reload()): HTMLElement {
  const existing = doc.getElementById('superseded');
  if (existing) return existing;
  const el = doc.createElement('div');
  el.id = 'superseded';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-labelledby', 'superseded-title');
  el.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b0f13;color:#eef3f6;font:16px/1.45 Inter,system-ui,sans-serif;text-align:center';
  const card = doc.createElement('div');
  card.style.cssText = 'max-width:420px';
  const title = doc.createElement('h1');
  title.id = 'superseded-title';
  title.textContent = 'Opened in another tab';
  title.style.cssText = 'font-size:24px;margin:0 0 12px';
  const text = doc.createElement('p');
  text.textContent = 'ControlAnything is running in a newer Quest Browser tab. Close this one. This tab has stopped its camera, microphone and controls.';
  text.style.cssText = 'margin:0 0 20px;color:#b9c6ce';
  const button = doc.createElement('button');
  button.id = 'btn-use-this-tab';
  button.type = 'button';
  button.textContent = 'Use this tab';
  button.style.cssText = 'font:600 16px Inter,system-ui,sans-serif;padding:12px 22px;border-radius:999px;border:1px solid #6fd3c2;background:#123;color:#eef3f6;cursor:pointer';
  button.onclick = () => { button.disabled = true; button.textContent = 'Taking over…'; reload(); };
  card.append(title, text, button);
  el.append(card);
  doc.body.append(el);
  return el;
}
