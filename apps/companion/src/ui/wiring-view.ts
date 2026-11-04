/**
 * DOM for the wiring: the calm card (one status line, a source chip, a "See code" toggle) and the Details
 * "Wiring" tab. Both are idempotent: nodes are built once and each render only writes what changed, so a
 * repeated message, a re-render or a stable state never rebuilds the DOM (the page stays flicker-free).
 * Everything from the wire is rendered with textContent.
 */
import { $, clock, el, secs } from './dom';
import { type Wiring, deviceLabel, phaseWord, sourceLabel, wiringActive, wiringLine } from './wiring';

export function setText(node: HTMLElement, text: string): void { if (node.textContent !== text) node.textContent = text; }
export function setHidden(node: HTMLElement, hidden: boolean): void { if (node.hidden !== hidden) node.hidden = hidden; }
function setClass(node: HTMLElement, className: string): void { if (node.className !== className) node.className = className; }
function setAttr(node: HTMLElement, name: string, value: string): void { if (node.getAttribute(name) !== value) node.setAttribute(name, value); }

/**
 * Show streaming code in a <pre>: a longer version of what is already there appends only the new text, anything
 * else rewrites it. Returns the text now shown. A stable text touches nothing.
 */
export function showCode(pre: HTMLElement, shown: string, text: string): string {
  if (text === shown) return shown;
  if (shown && text.startsWith(shown)) pre.append(text.slice(shown.length)); else pre.textContent = text;
  if (pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80) pre.scrollTop = pre.scrollHeight;
  return text;
}

const sourceClass = (w: Wiring): string => `wiring-chip ${w.source}`;

/** The simple card on the calm Mac screen. */
export class WiringCard {
  private expanded = false;
  private key = '';
  private shown = '';
  private readonly root = $('wiring-card');
  private readonly line = $('wiring-line');
  private readonly chip = $('wiring-chip');
  private readonly toggle = $('wiring-toggle');
  private readonly code = $('wiring-code');

  constructor() {
    this.toggle.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.key = '';
      this.draw(this.last);
    });
  }

  private last: { w: Wiring | undefined; device: string } = { w: undefined, device: '' };

  render(w: Wiring | undefined, deviceName?: string): void {
    const device = deviceLabel(deviceName);
    this.last = { w, device };
    const key = w ? `${w.wiringId}:${w.rev}:${device}:${this.expanded}` : '';
    if (key === this.key) return;
    this.key = key;
    this.draw(this.last);
  }

  private draw({ w, device }: { w: Wiring | undefined; device: string }): void {
    this.key = w ? `${w.wiringId}:${w.rev}:${device}:${this.expanded}` : '';
    setHidden(this.root, !w);
    if (!w) { this.shown = ''; return; }
    setText(this.line, wiringLine(w, device));
    setClass(this.root, `wiring-card panel${wiringActive(w) ? ' working' : ''}${w.phase === 'failed' ? ' failed' : ''}`);
    setText(this.chip, sourceLabel(w.source));
    setClass(this.chip, sourceClass(w));
    setAttr(this.chip, 'title', w.source === 'live' ? `Written live by ${w.model}` : w.source === 'fixture' ? 'A recorded FIXTURE: no Meta model wrote this' : 'A template wiring: no Meta model wrote this');
    setHidden(this.toggle, !w.code);
    setText(this.toggle, this.expanded ? 'Hide code' : 'See code');
    setAttr(this.toggle, 'aria-expanded', String(this.expanded));
    setHidden(this.code, !this.expanded || !w.code);
    if (this.expanded) this.shown = showCode(this.code, this.shown, w.code);
  }
}

/** The Details "Wiring" tab: the current code, its model and source, and the notes of each phase. */
export class WiringPanel {
  private key = '';
  private shown = '';
  private notesKey = '';
  private readonly empty = el('p', { className: 'empty', text: 'No wiring yet. Ask for what your hands should do in your headset: Muse writes it live, and the program streams in here.' });
  private readonly title = el('div', { className: 'wiring-title' });
  private readonly explanation = el('div', { className: 'wiring-explanation dim' });
  private readonly request = el('div', { className: 'wiring-request dim small' });
  private readonly facts = el('div', { className: 'facts wiring-facts' });
  private readonly notes = el('ul', { className: 'wiring-notes' });
  private readonly issues = el('ul', { className: 'wiring-issues' });
  private readonly code = el('pre', { className: 'wiring-source', id: 'wiring-source' });
  private readonly body = el('div', { className: 'wiring-body' }, this.title, this.explanation, this.request, this.facts, this.notes, this.issues, this.code);

  constructor(private readonly host: HTMLElement) {
    host.replaceChildren(this.empty, this.body);
  }

  render(w: Wiring | undefined, deviceName?: string): void {
    const device = deviceLabel(deviceName);
    const key = w ? `${w.wiringId}:${w.rev}:${device}` : '';
    if (key === this.key) return;
    this.key = key;
    setHidden(this.empty, !!w);
    setHidden(this.body, !w);
    if (!w) { this.shown = ''; this.notesKey = ''; return; }
    setText(this.title, w.title || wiringLine(w, device).replace(/…$/, ''));
    setText(this.explanation, w.explanation ?? '');
    setHidden(this.explanation, !w.explanation);
    setText(this.request, w.request ? `You asked: “${w.request}”` : '');
    setHidden(this.request, !w.request);
    const facts: [string, string][] = [
      ['model', w.source === 'template' ? 'none (template)' : w.model],
      ['source', sourceLabel(w.source)],
      ['phase', phaseWord(w.phase)],
      ['device', device],
      ...(w.latencyMs !== undefined ? [['time', secs(w.latencyMs)] as [string, string]] : []),
      ...(w.needs.length ? [['needs', w.needs.map((n) => n === 'screen' ? 'screen calibration' : `${n} hand`).join(', ')] as [string, string]] : []),
      ...(w.actions.length ? [['drives', w.actions.map((a) => a.label || a.actionId).join(', ')] as [string, string]] : []),
    ];
    const factsKey = JSON.stringify(facts);
    if (this.facts.dataset.key !== factsKey) {
      this.facts.dataset.key = factsKey;
      this.facts.replaceChildren(...facts.map(([k, v]) => el('span', { className: k === 'source' ? `wiring-fact ${w.source}` : 'wiring-fact' }, `${k} `, el('b', { text: v }))));
    }
    const notes = w.notes.map((n) => `${clock(n.at)} · ${phaseWord(n.phase)}${n.text ? ` · ${n.text}` : ''}`);
    const notesKey = notes.join('\n');
    if (notesKey !== this.notesKey) {
      this.notesKey = notesKey;
      this.notes.replaceChildren(...notes.map((text) => el('li', { text })));
    }
    const issuesKey = w.issues.join('\n');
    if (this.issues.dataset.key !== issuesKey) {
      this.issues.dataset.key = issuesKey;
      this.issues.replaceChildren(...w.issues.map((text) => el('li', { text })));
    }
    setHidden(this.issues, !w.issues.length);
    this.shown = showCode(this.code, this.shown, w.code);
  }
}
