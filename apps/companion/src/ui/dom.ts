/** Tiny DOM helpers. Everything from the wire is rendered with textContent, never as HTML. */

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Props = { id?: string; className?: string; text?: string; title?: string; data?: Record<string, string> };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.id) e.id = props.id;
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  if (props.data) for (const [k, v] of Object.entries(props.data)) e.dataset[k] = v;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function button(label: string, onClick: (ev: MouseEvent) => void, className = ''): HTMLButtonElement {
  const b = el('button', { text: label, className });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function clock(t = Date.now()): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 1) return `${s.toFixed(1)} s ago`;
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return clock(t);
}

export function secs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function untilText(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'expired';
}

/** Append a line to a monitor, keep it bounded, stick to the bottom if the user hasn't scrolled up. */
export function appendLine(pre: HTMLElement, text: string, className = '', max = 400): void {
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.append(el('div', { text, className }));
  while (pre.childElementCount > max) pre.firstElementChild?.remove();
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

/**
 * Batch renders per section into the next animation frame, with a timer fallback: occluded windows and
 * some embedded panes never fire requestAnimationFrame, and the panels must still update.
 */
export function scheduler(render: Record<string, () => void>): (section: string) => void {
  const due = new Set<string>();
  let queued = false;
  const flush = () => {
    if (!queued) return;
    queued = false;
    const list = [...due];
    due.clear();
    for (const s of list) render[s]?.();
  };
  return (section) => {
    due.add(section);
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
    setTimeout(flush, 120);
  };
}
