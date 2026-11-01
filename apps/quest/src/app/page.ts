/** The 2D launcher page (outside XR): pairing card, buttons, status, approvals, last frame with boxes, log. */
import QRCode from 'qrcode';
import type { Det } from '../io/v1';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export class Page {
  readonly enter = $<HTMLButtonElement>('btn-enter');
  readonly prepare = $<HTMLButtonElement>('btn-prepare');
  readonly scan = $<HTMLButtonElement>('btn-scan');
  readonly record = $<HTMLButtonElement>('btn-record');
  readonly save = $<HTMLButtonElement>('btn-save');
  readonly repair = $<HTMLButtonElement>('btn-repair');
  readonly takeFile = $<HTMLInputElement>('take-file');
  readonly takeMode = $<HTMLSelectElement>('take-mode');
  readonly stage = $<HTMLDivElement>('stage');
  private readonly logEl = $<HTMLPreElement>('log');
  private readonly statusEl = $<HTMLDListElement>('status');
  private readonly xrMsg = $<HTMLParagraphElement>('xr-msg');
  private readonly frame = $<HTMLCanvasElement>('frame');
  private readonly frameMsg = $<HTMLParagraphElement>('frame-msg');
  private lines: string[] = [];

  badge(id: 'b-mode' | 'b-ws', text: string, cls: '' | 'ok' | 'warn' | 'bad' = ''): void {
    const el = $(id);
    el.textContent = text;
    el.className = `badge ${cls}`;
  }

  xrMessage(text: string): void {
    this.xrMsg.textContent = text;
  }

  log(text: string, level: LogLevel = 'info'): void {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    this.lines.push(`<span class="${level}">${t} ${esc}</span>`);
    if (this.lines.length > 200) this.lines.shift();
    this.logEl.innerHTML = this.lines.join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[quest] ${text}`);
  }

  status(rows: Record<string, string | number | boolean | undefined>): void {
    const html = Object.entries(rows)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/</g, '&lt;')}</dd>`)
      .join('');
    if (this.statusEl.innerHTML !== html) this.statusEl.innerHTML = html;
  }

  showPairing(p: { display: string; qr: string; message?: string } | null): void {
    const card = $('pair-card');
    card.hidden = !p;
    if (!p) return;
    $('pair-code').textContent = p.display;
    $('pair-msg').textContent = p.message ?? 'Approve it on the Mac companion, or type y in the server terminal.';
    void QRCode.toCanvas($<HTMLCanvasElement>('pair-qr'), p.qr, { margin: 1, width: 140 });
  }

  showApprovals(list: { pairingId: string; name: string; kind: string; display: string }[], onAnswer: (id: string, approve: boolean) => void): void {
    const card = $('approvals');
    card.hidden = !list.length;
    const ul = $('approval-list');
    ul.replaceChildren(
      ...list.map((a) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${a.name} <small class="muted">${a.kind}</small> <code>${a.display}</code></span>`;
        const yes = document.createElement('button');
        yes.textContent = 'Approve';
        yes.onclick = () => onAnswer(a.pairingId, true);
        const no = document.createElement('button');
        no.textContent = 'Deny';
        no.className = 'secondary';
        no.onclick = () => onAnswer(a.pairingId, false);
        const span = document.createElement('span');
        span.className = 'row';
        span.append(yes, no);
        li.append(span);
        return li;
      }),
    );
  }

  /** Draw the last frame the server saw, with the detections that came back. */
  async showFrame(jpegBase64: string, w: number, h: number, dets: Det[] = [], note = ''): Promise<void> {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${jpegBase64}`;
    await img.decode().catch(() => undefined);
    const c = this.frame;
    c.width = 320;
    c.height = Math.round((320 * h) / w);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const s = c.width / w;
    ctx.lineWidth = 2;
    ctx.font = '11px "Share Tech Mono", monospace';
    for (const d of dets) {
      ctx.strokeStyle = '#38F0FF';
      ctx.strokeRect(d.box[0] * s, d.box[1] * s, d.box[2] * s, d.box[3] * s);
      ctx.fillStyle = 'rgba(10,14,18,0.8)';
      const label = `${d.label} ${Math.round(d.score * 100)}`;
      ctx.fillRect(d.box[0] * s, d.box[1] * s - 13, ctx.measureText(label).width + 6, 13);
      ctx.fillStyle = '#F3F7FA';
      ctx.fillText(label, d.box[0] * s + 3, d.box[1] * s - 3);
    }
    this.frameMsg.textContent = note || `${w}×${h} · ${dets.length} detection(s)`;
  }

  setButton(b: HTMLButtonElement, text: string, on = false, disabled = false): void {
    b.textContent = text;
    b.classList.toggle('on', on);
    b.disabled = disabled;
  }
}
