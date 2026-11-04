/**
 * What the Mac shows while Muse wires the wearer's hands to a device: the program streams in (wire.progress),
 * is validated and dry-run, and becomes ready (wire.ready). This module is only state and words: the DOM lives
 * in wiring-view.ts, the full-screen overlay in visualLauncher.ts. Everything here is plain data so it can be
 * tested without a browser. The code is only ever shown as text; it never runs on the Mac.
 */
import type { WireAction, WireProgressPayload, WireReadyPayload, WireStoppedPayload } from '@ce/protocol';

export type WiringPhase = WireProgressPayload['phase'] | 'stopped';
export type WiringSource = WireProgressPayload['source'];

export interface WiringNote { at: number; phase: WiringPhase; text: string }

export interface Wiring {
  cardId: string;
  wiringId: string;
  requestId?: string;
  phase: WiringPhase;
  request?: string;
  title?: string;
  explanation?: string;
  /** The program so far: grows with each codeDelta, replaced by `code`, authoritative at wire.ready. */
  code: string;
  model: string;
  source: WiringSource;
  latencyMs?: number;
  /** Validator / dry-run findings of the latest round. */
  issues: string[];
  note?: string;
  actions: WireAction[];
  needs: string[];
  startedAt: number;
  updatedAt: number;
  /** When it became ready or failed. */
  endedAt?: number;
  /** One line per phase the wiring went through, with the server's note. */
  notes: WiringNote[];
  /** Counts every visible change: a renderer that saw this rev has nothing to redraw. */
  rev: number;
}

type Stamped<T> = { id: string; payload: T };

const ACTIVE: WiringPhase[] = ['writing', 'validating', 'dry-run', 'verifying'];
export const wiringActive = (w?: Pick<Wiring, 'phase'>): boolean => !!w && ACTIVE.includes(w.phase);
/** The overlay on the visual synth hides this long after the wiring is ready. */
export const WIRING_OVERLAY_HIDE_MS = 8000;

export class WiringState {
  private readonly byCard = new Map<string, Wiring>();
  private readonly seen = new Set<string>();
  private readonly retiredWirings = new Set<string>();
  private readonly retiredRequests = new Set<string>();

  private remember(set: Set<string>, key: string): void {
    set.add(key); if (set.size > 400) set.delete(set.values().next().value!);
  }
  private retire(w: Wiring): void {
    this.remember(this.retiredWirings, `${w.cardId}\0${w.wiringId}`);
    if (w.requestId) this.remember(this.retiredRequests, `${w.cardId}\0${w.requestId}`);
  }
  private retired(p: { cardId: string; wiringId: string; requestId?: string }): boolean {
    return this.retiredWirings.has(`${p.cardId}\0${p.wiringId}`) || !!p.requestId && this.retiredRequests.has(`${p.cardId}\0${p.requestId}`);
  }

  private first(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 400) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private fresh(cardId: string, wiringId: string, model: string, source: WiringSource, now: number, requestId?: string): Wiring {
    const previous = this.byCard.get(cardId);
    if (previous && previous.wiringId !== wiringId) this.retire(previous);
    const wiring: Wiring = { cardId, wiringId, requestId, phase: 'writing', code: '', model, source, issues: [], actions: [], needs: [], startedAt: now, updatedAt: now, notes: [], rev: 0 };
    this.byCard.set(cardId, wiring);
    return wiring;
  }

  /** wire.progress. Returns true when something visible changed (a repeated message changes nothing). */
  progress(message: Stamped<WireProgressPayload>, now = Date.now()): boolean {
    if (!this.first(message.id)) return false;
    const p = message.payload;
    if (this.retired(p)) return false;
    let w = this.byCard.get(p.cardId);
    if (w?.wiringId === p.wiringId && w.requestId && p.requestId && w.requestId !== p.requestId) return false;
    const isNew = !w || w.wiringId !== p.wiringId;
    if (!w || isNew) w = this.fresh(p.cardId, p.wiringId, p.model, p.source, now, p.requestId);
    else if (w.phase === 'ready') return false; // a late progress message never un-readies a wiring
    const before = signature(w);
    const phaseBefore = isNew ? undefined : w.phase;
    w.phase = p.phase; w.model = p.model; w.source = p.source;
    if (p.requestId !== undefined) w.requestId = p.requestId;
    if (p.request !== undefined) w.request = p.request;
    if (p.title !== undefined) w.title = p.title;
    if (p.explanation !== undefined) w.explanation = p.explanation;
    if (p.latencyMs !== undefined) w.latencyMs = p.latencyMs;
    if (p.issues !== undefined) w.issues = p.issues;
    if (p.note !== undefined) w.note = p.note;
    if (p.code !== undefined) w.code = p.code;
    else if (p.codeDelta) w.code += p.codeDelta;
    if (p.phase === 'writing' && phaseBefore && phaseBefore !== 'writing') w.endedAt = undefined; // a repair round
    if (p.phase === 'failed') w.endedAt = now;
    if (p.phase === 'failed' && w.latencyMs === undefined) w.latencyMs = now - w.startedAt;
    const last = w.notes.at(-1);
    const text = p.note ?? '';
    if (!last || last.phase !== p.phase) w.notes.push({ at: now, phase: p.phase, text });
    else if (text && last.text !== text) last.text = text;
    if (w.notes.length > 24) w.notes.shift();
    const changed = isNew || signature(w) !== before;
    if (changed) { w.updatedAt = now; w.rev++; }
    return changed;
  }

  /** wire.ready: the validated, dry-run program. Its code is the authoritative text. */
  ready(message: Stamped<WireReadyPayload>, now = Date.now()): boolean {
    if (!this.first(message.id)) return false;
    const p = message.payload;
    if (this.retired(p)) return false;
    const known = this.byCard.get(p.cardId);
    if (known?.wiringId === p.wiringId && known.requestId && p.requestId && known.requestId !== p.requestId) return false;
    const w = known && known.wiringId === p.wiringId ? known : this.fresh(p.cardId, p.wiringId, p.model, p.source, now, p.requestId);
    const before = signature(w);
    w.phase = 'ready'; w.code = p.code; w.title = p.title; w.explanation = p.explanation; w.model = p.model; w.source = p.source;
    if (p.requestId !== undefined) w.requestId = p.requestId;
    w.actions = p.actions; w.needs = [...p.needs];
    w.endedAt ??= now;
    w.latencyMs ??= now - w.startedAt;
    if (w.notes.at(-1)?.phase !== 'ready') w.notes.push({ at: now, phase: 'ready', text: `${p.actions.length} action${p.actions.length === 1 ? '' : 's'}` });
    const changed = signature(w) !== before || w.rev === 0;
    if (changed) { w.updatedAt = now; w.rev++; }
    return changed;
  }

  /** Only the matching server-acknowledged ask epoch may stop the displayed program. */
  stopped(message: Stamped<WireStoppedPayload>, now = Date.now()): boolean {
    if (!this.first(message.id) || !message.payload.ok) return false;
    const p = message.payload, w = this.byCard.get(p.cardId);
    if (!w || w.requestId !== p.requestId || p.wiringId && w.wiringId !== p.wiringId || w.phase === 'stopped') return false;
    this.stop(w, p.releaseConfirmed === false ? 'Wiring stopped. Device release was not confirmed; use Stop all if needed.' : 'Stopped. Ask Muse again in Quest.', now);
    return true;
  }

  private stop(w: Wiring, note: string, now: number): void {
    this.retire(w); w.phase = 'stopped'; w.note = note; w.endedAt = w.updatedAt = now; w.rev++;
    w.notes.push({ at: now, phase: 'stopped', text: note });
  }

  /** Global panic is distinct from the scoped palms stop and withdraws all displayed readiness. */
  stopAll(now = Date.now()): boolean {
    let changed = false;
    for (const w of this.byCard.values()) if (w.phase !== 'stopped') { this.stop(w, 'Stop all received. Ask Muse again in Quest.', now); changed = true; }
    return changed;
  }

  /** A device's own latest wiring. */
  get(cardId: string): Wiring | undefined { return this.byCard.get(cardId); }

  /** The wiring to show: the focused device's, else the most recently updated one. */
  current(cardId?: string): Wiring | undefined {
    const own = cardId ? this.byCard.get(cardId) : undefined;
    if (own) return own;
    let latest: Wiring | undefined;
    for (const w of this.byCard.values()) if (!latest || w.updatedAt >= latest.updatedAt) latest = w;
    return latest;
  }

  clear(cardId?: string): void {
    if (cardId) this.byCard.delete(cardId); else this.byCard.clear();
  }
}

function signature(w: Wiring): string {
  return [w.requestId, w.phase, w.model, w.source, w.title, w.explanation, w.request, w.latencyMs, w.note, w.issues.join('\u0001'), w.code, w.actions.length, w.needs.join(',')].join('\u0000');
}

// --- words ------------------------------------------------------------------------------------

/** "ControlAnything Visual Synth" is "the Visual synth" to the wearer. */
export function deviceLabel(name?: string): string {
  if (!name) return 'your device';
  return /visual[\s-]synth/i.test(name) ? 'Visual synth' : name;
}

/** Honest provenance: written live by the model, a recorded FIXTURE, or a Template no Meta model wrote. */
export function sourceLabel(source: WiringSource): 'live' | 'FIXTURE' | 'Template' {
  return source === 'live' ? 'live' : source === 'fixture' ? 'FIXTURE' : 'Template';
}

/** The one calm status line of the simple card. */
export function wiringLine(w: Pick<Wiring, 'phase' | 'model' | 'source' | 'title' | 'note' | 'issues'>, device: string): string {
  switch (w.phase) {
    case 'writing':
      return w.source === 'template' ? `Template wiring for the ${device} (no Meta model wrote this)…` : `${w.model} is wiring your hands to the ${device}…`;
    case 'validating': return 'Checking the wiring…';
    case 'dry-run': return `Dry-running the wiring${w.note ? ` · ${w.note}` : ''}…`;
    case 'verifying': return `Verifying the wiring on the ${device}…`;
    case 'ready': return `Wiring ready: ${w.title || 'your hands are wired'}`;
    case 'failed': return `Wiring failed${w.issues[0] ? `: ${w.issues[0]}` : ''}`;
    case 'stopped': return w.note ?? 'Stopped. Ask Muse again in Quest.';
  }
}

export const phaseWord = (phase: WiringPhase): string => phase === 'dry-run' ? 'dry-run' : phase;

/** The overlay on the visual synth: the line above the streaming code. */
export function overlayHeading(w: Pick<Wiring, 'phase' | 'model' | 'source' | 'title' | 'note' | 'issues'>, device: string): string {
  return wiringLine(w, device).replace(/…$/, '');
}
