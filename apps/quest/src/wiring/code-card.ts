/**
 * The code card: a world-anchored glass panel beside the selected device where Muse's wiring streams in, token by token,
 * in monospace, ~14 lines visible and auto-scrolling. Under it the phase line (writing / validating / dry-run / ready).
 * When the program is ready it shows the title and a one-line explanation for a few seconds, then collapses to a pill:
 * "<title> · running · both palms out = stop".
 *
 * Look: the shared Horizon tokens (hud/v2/look.ts: glassPanel, LOOK); the code itself is troika text in the bundled
 * JetBrains Mono (hud/v2/text.ts), because uikit's MSDF atlas is Inter only. The source is always labelled honestly:
 * LIVE / FIXTURE / TEMPLATE. The card takes no input.
 */
import { Group, Mesh, MeshBasicMaterial, RingGeometry, CircleGeometry, LineLoop, BufferGeometry, Float32BufferAttribute, LineBasicMaterial, Vector3, Quaternion } from 'three';
import { Container, Text, withOpacity } from '@pmndrs/uikit';
import type { Panel } from '@pmndrs/uikit-horizon';
import { glassPanel, icon, isBrowser, LOOK } from '../hud/v2/look';
import { makeText, type SdfText } from '../hud/v2/text';
import type { WireCodeView, WireCalibrationView } from '../hud/contract';

export const CODE_CARD = {
  widthM: 0.34, padding: 20, gap: 10, headerH: 40, rows: 14, fontSize: 0.0108, lineHeight: 1.25, innerPad: 12, cols: 42,
  /** the typed-out reveal never runs behind the stream by more than this many seconds */
  revealS: 1.4,
} as const;
const AREA_H = Math.round(CODE_CARD.rows * CODE_CARD.fontSize * CODE_CARD.lineHeight * 1000 + 2 * CODE_CARD.innerPad - 4);

/** Text safe for both fonts (Inter's covered subset): anything else becomes '?', never a CDN fallback fetch. */
export function fontSafe(text: string): string {
  return text.replace(/[^\t\n\r -~ -¬®-ÿ–—‘’“”•…↑↓−]/gu, '?');
}

/** Break long source lines at ~cols so every visual row is one row of the card; continuation rows are indented. */
export function wrapCode(code: string, cols: number = CODE_CARD.cols): string[] {
  const rows: string[] = [];
  for (const raw of code.replace(/\r/g, '').replace(/\t/g, '  ').split('\n')) {
    if (raw.length <= cols) { rows.push(raw); continue; }
    const indent = /^\s*/.exec(raw)![0].length;
    let rest = raw, first = true;
    while (rest.length > cols) {
      const room = first ? cols : cols - indent - 2;
      let cut = Math.max(rest.lastIndexOf(' ', room), rest.lastIndexOf(',', room) + 1, rest.lastIndexOf('(', room) + 1);
      if (cut < room * 0.5) cut = room;
      rows.push(rest.slice(0, cut).replace(/\s+$/, ''));
      rest = ' '.repeat(indent + 2) + rest.slice(cut).replace(/^\s+/, '');
      first = false;
    }
    rows.push(rest);
  }
  return rows;
}

const KEYWORDS = /\b(?:const|let|var|if|else|return|for|of|in|function|true|false|null|undefined|typeof|new|break|continue)\b/y;
/** troika colorRanges for the visible text: comments dim, strings and numbers tinted, keywords and the three inputs picked out. */
export function highlight(text: string): Record<number, number> {
  const ranges: Record<number, number> = { 0: 0xe8e8ee };
  const mark = (at: number, color: number) => { ranges[at] = color; };
  let i = 0;
  const n = text.length;
  const setRest = (at: number) => { if (at < n) mark(at, 0xe8e8ee); };
  while (i < n) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i); const stop = end < 0 ? n : end;
      mark(i, 0x8b8b96); setRest(stop); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      mark(i, 0xa5e3b8); setRest(j); i = j; continue;
    }
    if (/[0-9]/.test(c) && !/[A-Za-z_$]/.test(text[i - 1] ?? ' ')) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(text[j]!)) j++;
      mark(i, 0xf6c177); setRest(j); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      KEYWORDS.lastIndex = 0;
      if (KEYWORDS.test(word) && KEYWORDS.lastIndex === word.length) { mark(i, 0xc4a7ff); setRest(j); }
      else if (word === 's' || word === 'out' || word === 'mem') { mark(i, 0x7dd3fc); setRest(j); }
      i = j; continue;
    }
    i++;
  }
  return ranges;
}

const DOT: Record<string, string> & { asked: string; running: string; failed: string; stopped: string } = { asked: '#7DD3FC', writing: '#FDE68A', validating: '#FDE68A', 'dry-run': '#FDE68A', verifying: '#FDE68A', calibrating: '#7DD3FC', ready: '#86EFAC', running: '#86EFAC', stopped: '#A1A1A6', failed: '#FDA4AF' };
const BADGE = {
  live: { text: 'LIVE', color: '#86EFAC' },
  fixture: { text: 'FIXTURE', color: '#FDE68A' },
  template: { text: 'TEMPLATE', color: '#FDBA74' },
} as const;

function clip(text: string, max: number): string {
  const one = fontSafe(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

export function headerText(view: Pick<WireCodeView, 'model' | 'source' | 'request' | 'title' | 'mode' | 'phase'>): string {
  if (view.model === 'not-called') return 'Choose the device first';
  const what = clip(view.request, 40);
  const done = view.phase === 'calibrating' || view.phase === 'ready' || view.phase === 'running' || view.phase === 'stopped';
  // No Meta model wrote a template or a recorded fixture: say so instead of naming a model that did not write it.
  if (view.source === 'template') return `Template wiring for "${what}" (no Meta model wrote it)`;
  if (view.source === 'fixture' && (!view.model || /^(fixture|muse)$/i.test(view.model))) return `Recorded wiring for "${what}"`;
  const who = view.model || 'Muse';
  if (view.phase === 'failed') return `${who} could not wire "${what}"`;
  return done ? `${who} wired "${what}"` : `${who} is wiring "${what}"…`;
}

/** The whole card as the controller sees it; also what tests read back. */
export interface CodeCardState {
  header: string; badge: string; code: string; phase: string; explanation: string; calibration: string; pill: string; mode: 'full' | 'pill';
}

export class CodeCard extends Group {
  private readonly root?: Panel;
  private readonly head?: Container;
  private readonly dot?: Container;
  private readonly header?: Text;
  private readonly badgeBox?: Container;
  private readonly badge?: Text;
  private readonly body?: Container;
  private readonly footer?: Container;
  private readonly phaseRow?: Container;
  private readonly phaseCheck?: Container;
  private readonly phaseText?: Text;
  private readonly explain?: Text;
  private readonly calibrate?: Container;
  private readonly calibrateText?: Text;
  private readonly calibrateBar?: Container;
  private readonly pillRow?: Container;
  private readonly pillDot?: Container;
  private readonly pillText?: Text;
  private readonly pillHint?: Text;
  private readonly pillHintRow?: Container;
  private readonly code: SdfText;
  private view: WireCodeView | null = null;
  private target = '';
  private shown = 0;
  private lastText = '';
  private textClock = 0;
  private time = 0;
  private opacity = 0;
  readonly state: CodeCardState = { header: '', badge: '', code: '', phase: '', explanation: '', calibration: '', pill: '', mode: 'full' };

  constructor() {
    super();
    this.name = 'wire-code-card';
    this.visible = false;
    this.code = makeText({ text: ' ', size: CODE_CARD.fontSize, mono: true, anchorX: 'left', anchorY: 'top', color: '#e8e8ee' });
    this.code.name = 'wire-code';
    this.code.renderOrder = LOOK.render.card + 12;
    this.code.userData.lineHeight = CODE_CARD.lineHeight;
    this.code.position.set(-CODE_CARD.widthM / 2 + (CODE_CARD.padding + CODE_CARD.innerPad) * 0.001,
      -(CODE_CARD.padding + CODE_CARD.headerH + CODE_CARD.gap + CODE_CARD.innerPad - 2) * 0.001, 0.002);
    if (!isBrowser) { this.add(this.code); return; }
    const { padding, gap } = CODE_CARD;
    this.root = glassPanel({ width: CODE_CARD.widthM, padding, gap, renderOrder: LOOK.render.card + 1, pointerEvents: 'none', anchorX: 'center' } as never);
    this.root.name = 'wire-code-panel';
    const head = this.head = new Container({ flexDirection: 'row', alignItems: 'center', gap: 10, height: CODE_CARD.headerH, flexShrink: 0 });
    this.dot = new Container({ width: 10, height: 10, borderRadius: 5, backgroundColor: DOT.asked, flexShrink: 0 });
    this.header = new Text({ text: '', fontSize: 14, fontWeight: 'semi-bold', color: LOOK.text.primary, flexGrow: 1, flexShrink: 1, wordBreak: 'break-word', maxHeight: CODE_CARD.headerH } as never);
    this.badgeBox = new Container({ height: 22, paddingX: 8, borderRadius: 11, alignItems: 'center', backgroundColor: withOpacity('#ffffff', 0.1), flexShrink: 0 });
    this.badge = new Text({ text: '', fontSize: 11, fontWeight: 'semi-bold', color: '#86EFAC', letterSpacing: 0.6, whiteSpace: 'nowrap' } as never);
    this.badgeBox.add(this.badge);
    head.add(this.dot, this.header, this.badgeBox);
    this.body = new Container({ flexDirection: 'column', gap, flexShrink: 0 });
    const area = new Container({ height: AREA_H, flexShrink: 0, borderRadius: 14, backgroundColor: withOpacity('#000000', 0.36) });
    this.footer = new Container({ flexDirection: 'column', gap: 6, flexShrink: 0 });
    this.phaseRow = new Container({ flexDirection: 'row', alignItems: 'center', gap: 6 });
    this.phaseCheck = new Container({ width: 16, height: 16, display: 'none', flexShrink: 0 });
    this.phaseCheck.add(icon('check', 16));
    this.phaseText = new Text({ text: '', fontSize: 14, fontWeight: 'medium', color: LOOK.text.primary,
      flexGrow: 1, flexShrink: 1, minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-word' } as never);
    this.phaseRow.add(this.phaseCheck, this.phaseText);
    this.explain = new Text({ text: '', fontSize: 13, fontWeight: 'medium', color: LOOK.text.secondary, wordBreak: 'break-word', display: 'none' } as never);
    this.calibrate = new Container({ flexDirection: 'column', gap: 8, display: 'none' });
    this.calibrateText = new Text({ text: '', fontSize: 17, fontWeight: 'semi-bold', color: LOOK.text.primary, wordBreak: 'break-word' } as never);
    const track = new Container({ height: 6, borderRadius: 3, backgroundColor: withOpacity('#ffffff', 0.16) });
    this.calibrateBar = new Container({ height: 6, width: '0%', borderRadius: 3, backgroundColor: '#ffffff' } as never);
    track.add(this.calibrateBar);
    this.calibrate.add(this.calibrateText, track);
    this.footer.add(this.phaseRow, this.explain, this.calibrate);
    this.body.add(area, this.footer);
    // two short lines: "<title> · running", then the stop gesture
    this.pillRow = new Container({ flexDirection: 'column', gap: 6, display: 'none' });
    const pillTop = new Container({ flexDirection: 'row', alignItems: 'center', gap: 8 });
    this.pillDot = new Container({ width: 10, height: 10, borderRadius: 5, backgroundColor: DOT.running, flexShrink: 0 });
    this.pillText = new Text({ text: '', fontSize: 15, fontWeight: 'semi-bold', color: LOOK.text.primary, flexShrink: 1, wordBreak: 'break-word' } as never);
    pillTop.add(this.pillDot, this.pillText);
    this.pillHintRow = new Container({ flexDirection: 'row', alignItems: 'center', gap: 6 });
    const hand = new Container({ width: 16, height: 16, flexShrink: 0 });
    hand.add(icon('hand', 16));
    this.pillHint = new Text({ text: 'both palms out = stop', fontSize: 13, fontWeight: 'medium', color: LOOK.text.secondary, whiteSpace: 'nowrap' } as never);
    this.pillHintRow.add(hand, this.pillHint);
    this.pillRow.add(pillTop, this.pillHintRow);
    this.root.add(head, this.body, this.pillRow);
    // troika text is not a uikit component: it sits beside the panel in the same group (same origin: top centre)
    this.add(this.root, this.code);
  }

  /** uikit root for the HUD's per-frame update. */
  get uiRoot(): { update(dtMs: number): void } | undefined { return this.root; }
  /** Height of the laid-out card in metres (for placing it). */
  get heightM(): number { return (this.root?.size.peek()?.[1] ?? 340) * LOOK.pixelSize; }
  get widthM(): number { return this.state.mode === 'pill' ? Math.min(CODE_CARD.widthM, (this.root?.size.peek()?.[0] ?? 340) * LOOK.pixelSize) : CODE_CARD.widthM; }

  set(view: WireCodeView | null, calibration?: WireCalibrationView | null): void {
    const prev = this.view;
    this.view = view;
    if (!view) { this.target = ''; this.shown = 0; this.state.code = ''; return; }
    // A new program starts the code over; a repair (`code` replaced) retypes from the first changed character.
    const newCode = view.code;
    if (!prev || prev.wiringId !== view.wiringId) { this.shown = 0; this.lastText = ''; }
    else if (!newCode.startsWith(this.target.slice(0, this.shown))) this.shown = Math.min(this.shown, commonPrefix(this.target, newCode));
    this.target = newCode;
    this.state.header = headerText(view);
    this.state.badge = BADGE[view.source].text;
    this.state.mode = view.mode;
    const check = /✓/.test(view.phaseLine);
    this.state.phase = fontSafe(view.phaseLine.replace(/✓/g, '')).replace(/\s+/g, ' ').trim();
    this.state.explanation = view.explanation && view.mode === 'full' ? fontSafe(`${view.title ? `${view.title}. ` : ''}${view.explanation}`) : '';
    this.state.calibration = calibration ? calibration.message : '';
    this.state.pill = view.mode === 'pill' ? `${clip(view.title || view.request, 40)} · ${view.stopped ? 'stopped · ask again' : view.phase === 'failed' ? 'failed' : 'running'}` : '';
    if (!this.root) return;
    const full = view.mode === 'full';
    this.header!.setProperties({ text: this.state.header });
    this.dot!.setProperties({ backgroundColor: DOT[view.phase] ?? DOT.asked });
    const badge = BADGE[view.source];
    this.badge!.setProperties({ text: badge.text, color: badge.color });
    this.badgeBox!.setProperties({ display: full ? 'flex' : 'none' });
    this.body!.setProperties({ display: full ? 'flex' : 'none' });
    this.head!.setProperties({ display: full ? 'flex' : 'none' });
    this.pillRow!.setProperties({ display: full ? 'none' : 'flex' });
    this.pillText!.setProperties({ text: this.state.pill });
    this.pillDot!.setProperties({ backgroundColor: view.stopped || view.phase === 'failed' ? (view.phase === 'failed' ? DOT.failed : DOT.stopped) : DOT.running });
    this.pillHintRow!.setProperties({ display: view.stopped || view.phase === 'failed' ? 'none' : 'flex' });
    const calibrating = !!calibration && full;
    this.phaseRow!.setProperties({ display: calibrating ? 'none' : 'flex' });
    this.phaseText!.setProperties({ text: this.state.phase });
    this.phaseCheck!.setProperties({ display: check ? 'flex' : 'none' });
    this.explain!.setProperties({ display: this.state.explanation && !calibrating ? 'flex' : 'none', text: this.state.explanation });
    this.calibrate!.setProperties({ display: calibrating ? 'flex' : 'none' });
    if (calibration) {
      this.calibrateText!.setProperties({ text: fontSafe(calibration.message) });
      this.calibrateBar!.setProperties({ width: `${Math.round(Math.max(0, Math.min(1, calibration.progress)) * 100)}%` } as never);
    }
    this.code.visible = full;
  }

  /** Per frame. `dtMs` drives the reveal; the typed-out text refreshes at ~15 Hz. */
  update(dtMs: number, visible: boolean): void {
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
    this.time += dt;
    this.opacity += ((visible && this.view ? 1 : 0) - this.opacity) * Math.min(1, dt / LOOK.motion.appearS * 3);
    this.visible = this.opacity > 0.01 && !!this.view;
    if (!this.view) return;
    this.scale.setScalar(0.92 + 0.08 * this.opacity);
    // Reveal: follow the stream; when a big chunk lands at once, catch up within revealS.
    if (this.shown < this.target.length) {
      const backlog = this.target.length - this.shown;
      this.shown = Math.min(this.target.length, this.shown + Math.max(Math.ceil(backlog / (CODE_CARD.revealS * 60)), Math.round(180 * dt)));
    }
    this.textClock += dt;
    if (this.textClock >= 1 / 15 || this.shown >= this.target.length && this.lastText !== this.rows(this.shown >= this.target.length)) {
      this.textClock = 0;
      const typing = this.shown < this.target.length || this.view.phase === 'asked' || this.view.phase === 'writing';
      const next = this.rows(typing);
      if (next !== this.lastText) {
        this.lastText = next;
        this.state.code = next;
        const t = this.code as unknown as { text: string; colorRanges: Record<number, number>; sync(cb?: () => void): void };
        t.text = next; t.colorRanges = highlight(next); t.sync();
      }
    }
    (this.code as unknown as { fillOpacity: number }).fillOpacity = this.opacity;
    this.root?.update(Math.min(100, dtMs));
  }

  /** The last CODE_CARD.rows rows of what has been typed so far (with a blinking caret while it types). */
  private rows(caret: boolean): string {
    const typed = fontSafe(this.target.slice(0, this.shown));
    const rows = wrapCode(typed);
    const tail = rows.slice(-CODE_CARD.rows);
    if (caret && Math.floor(this.time * 2.2) % 2 === 0) tail[tail.length - 1] = `${tail[tail.length - 1] ?? ''}_`;
    return tail.join('\n') || ' ';
  }

  override dispose(): void {
    this.code.dispose();
    this.root?.dispose();
    this.clear();
  }
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// --- calibration markers (world space) --------------------------------------------------------------------------------

/**
 * Drawn while the wearer touches the screen's corners: a ring that fills around the held fingertip, a dot where each corner
 * was taken, and (briefly, once both are in) the outline of the calibrated screen.
 */
export class CalibrationMarkers extends Group {
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly fill: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly dots: Mesh<CircleGeometry, MeshBasicMaterial>[] = [];
  private readonly outline: LineLoop<BufferGeometry, LineBasicMaterial>;
  private outlineUntil = -Infinity;
  private time = 0;
  private readonly facing = new Quaternion();

  constructor() {
    super();
    this.name = 'wire-calibration-markers';
    this.visible = false;
    const order = LOOK.render.hands;
    this.ring = new Mesh(new RingGeometry(0.024, 0.028, 48), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false }));
    this.fill = new Mesh(new CircleGeometry(0.024, 40), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }));
    for (const m of [this.ring, this.fill]) { m.renderOrder = order; m.visible = false; m.frustumCulled = false; this.add(m); }
    for (let i = 0; i < 2; i++) {
      const dot = new Mesh(new CircleGeometry(0.009, 24), new MeshBasicMaterial({ color: 0x86efac, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
      dot.renderOrder = order; dot.visible = false; dot.frustumCulled = false; this.dots.push(dot); this.add(dot);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(12), 3));
    this.outline = new LineLoop(geometry, new LineBasicMaterial({ color: 0x86efac, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
    this.outline.renderOrder = order; this.outline.visible = false; this.outline.frustumCulled = false;
    this.add(this.outline);
  }

  /** corners: captured world points (or null); tip: the held fingertip; progress 0..1 */
  set(corners: readonly (Vector3 | null)[], tip: Vector3 | null, progress: number, headQuaternion: Quaternion, dt: number): void {
    this.time += dt;
    this.facing.copy(headQuaternion);
    const show = !!tip && progress > 0.02;
    this.ring.visible = this.fill.visible = show;
    if (tip && show) {
      for (const m of [this.ring, this.fill]) { m.position.copy(tip); m.quaternion.copy(this.facing); }
      this.fill.scale.setScalar(Math.max(0.05, progress));
      this.ring.material.opacity = 0.35 + 0.5 * progress;
      this.fill.material.opacity = 0.15 + 0.35 * progress;
    }
    this.dots.forEach((dot, i) => {
      const p = corners[i];
      dot.visible = !!p;
      if (p) { dot.position.copy(p); dot.quaternion.copy(this.facing); dot.scale.setScalar(1 + 0.12 * Math.sin(this.time * 4)); }
    });
    if (this.time > this.outlineUntil) this.outline.visible = false;
    this.visible = show || this.dots.some((d) => d.visible) || this.outline.visible;
  }

  /** Show the calibrated screen's outline for a moment. corners: TL, TR, BR, BL in world space. */
  showOutline(corners: readonly [Vector3, Vector3, Vector3, Vector3], seconds = 3): void {
    const attr = this.outline.geometry.getAttribute('position') as Float32BufferAttribute;
    corners.forEach((c, i) => attr.setXYZ(i, c.x, c.y, c.z));
    attr.needsUpdate = true;
    this.outlineUntil = this.time + seconds;
    this.outline.visible = true; this.visible = true;
  }

  hideAll(): void { this.visible = false; this.outline.visible = false; this.outlineUntil = -Infinity; }

  override dispose(): void {
    for (const m of [this.ring, this.fill, ...this.dots]) { m.geometry.dispose(); m.material.dispose(); }
    this.outline.geometry.dispose(); this.outline.material.dispose();
    this.clear();
  }
}

