/**
 * The virtual synth's screen: the current page's four coloured encoders, the last received message, and a
 * scope of the synth's own output. It follows incoming CCs to their page, so a camera (or a judge) sees the
 * device react. Drawn into its own canvas; the room view can also paste it onto the synth in the desk photo.
 */
import { CC_BY_NUMBER, ENCODER_COLORS, PAGES, tempoFromCc } from './ccmap';
import type { CcEvent, NoteEvent, SynthEngine } from './engine';

export const SCREEN_W = 480;
export const SCREEN_H = 240;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

export class SynthScreen {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private page = 0;
  private last?: { text: string; sub: string; cc?: number; at: number };
  private activity = 0;
  private td = new Float32Array(1024);
  private raf = 0;
  private dirty = true;
  private lastDraw = 0;
  onDraw?: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly engine: SynthEngine,
  ) {
    this.canvas = canvas;
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    this.g = canvas.getContext('2d')!;
    engine.onCc((e) => this.onCc(e));
    engine.onNote((e) => this.onNote(e));
    engine.onState(() => (this.dirty = true));
  }

  start(): void {
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const live = this.engine.running && (this.engine.activeNotes().length > 0 || this.engine.looping);
      if (!this.dirty && !live && this.activity <= 0) return;
      if (t - this.lastDraw < 33) return; // <= 30 fps
      this.lastDraw = t;
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private onCc(e: CcEvent): void {
    const idx = PAGES.findIndex((p) => p.ccs.includes(e.cc));
    if (idx >= 0 && e.applied) this.page = idx;
    this.last = {
      text: e.def ? `${e.def.sim.toUpperCase()} ${e.value}` : `CC${e.cc} ${e.value}`,
      sub: e.def ? `CC${e.cc} · ${e.def.chart}${e.applied ? '' : ' · ' + e.note}` : e.note,
      cc: e.cc,
      at: e.at,
    };
    this.activity = 1;
    this.dirty = true;
  }

  private onNote(e: NoteEvent): void {
    if (!e.on) return;
    this.last = {
      text: `NOTE ${noteName(e.note)}`,
      sub: e.accepted ? `ch ${e.channel} · velocity ${e.velocity}` : `ch ${e.channel}: ignored (synth listens on ch ${this.engine.channel})`,
      at: e.at,
    };
    this.activity = 1;
    this.dirty = true;
  }

  draw(): void {
    this.dirty = false;
    const g = this.g;
    const W = SCREEN_W;
    const H = SCREEN_H;
    g.fillStyle = '#050608';
    g.fillRect(0, 0, W, H);
    const page = PAGES[this.page]!;
    const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    // header
    g.fillStyle = '#e8edf2';
    g.font = `600 18px ${mono}`;
    g.textBaseline = 'middle';
    g.fillText(page.title, 14, 18);
    g.font = `13px ${mono}`;
    g.fillStyle = '#8b95a1';
    const bpm = tempoFromCc(this.engine.cc.get(80) ?? 74);
    const right = `CH${this.engine.channel}  ${bpm} BPM${this.engine.looping ? '  ▶ LOOP' : ''}`;
    g.fillText(right, W - 14 - g.measureText(right).width - 18, 18);
    // MIDI activity dot (decays; stays lit during a sweep instead of flashing)
    g.fillStyle = `rgba(80, 255, 170, ${0.15 + 0.85 * Math.max(0, this.activity)})`;
    g.beginPath();
    g.arc(W - 16, 18, 5, 0, Math.PI * 2);
    g.fill();
    this.activity -= 0.06;
    // last message
    if (this.last) {
      const age = Date.now() - this.last.at;
      const a = age < 2500 ? 1 : Math.max(0.35, 1 - (age - 2500) / 3000);
      g.globalAlpha = a;
      g.fillStyle = '#ffffff';
      g.font = `600 16px ${mono}`;
      g.fillText(this.last.text, 14, 44);
      g.fillStyle = '#8b95a1';
      g.font = `11px ${mono}`;
      g.fillText(this.last.sub.slice(0, 64), 14, 62);
      g.globalAlpha = 1;
      if (age < 6000) this.dirty = true;
    }
    // encoders
    const n = page.ccs.length;
    page.ccs.forEach((cc, i) => {
      const def = CC_BY_NUMBER.get(cc)!;
      const v = this.engine.cc.get(cc) ?? 0;
      const cx = (W / n) * (i + 0.5);
      const cy = 122;
      const r = 32;
      const a0 = Math.PI * 0.75;
      const a1 = Math.PI * 2.25;
      g.lineWidth = 7;
      g.lineCap = 'round';
      g.strokeStyle = '#1d232b';
      g.beginPath();
      g.arc(cx, cy, r, a0, a1);
      g.stroke();
      const color = def.encoder ? ENCODER_COLORS[def.encoder] : '#cfd6de';
      g.strokeStyle = color;
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + (a1 - a0) * (v / 127));
      g.stroke();
      if (this.last?.cc === cc && Date.now() - this.last.at < 1500) {
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(cx, cy, r + 9, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = '#e8edf2';
      g.font = `600 15px ${mono}`;
      const t = String(v);
      g.fillText(t, cx - g.measureText(t).width / 2, cy);
      g.fillStyle = color;
      g.font = `11px ${mono}`;
      const label = def.sim.length > 14 ? def.sim.slice(0, 13) + '…' : def.sim;
      g.fillText(label, cx - g.measureText(label).width / 2, cy + r + 16);
    });
    // scope
    const an = this.engine.analyser;
    const top = 192;
    g.strokeStyle = '#1a2027';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(10, top + 22);
    g.lineTo(W - 10, top + 22);
    g.stroke();
    if (an && this.engine.running) {
      if (this.td.length !== an.fftSize) this.td = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(this.td);
      g.strokeStyle = '#7cf7c8';
      g.lineWidth = 1.5;
      g.beginPath();
      const step = Math.floor(this.td.length / (W - 20));
      for (let x = 0; x < W - 20; x++) {
        const s = this.td[x * step]!;
        const y = top + 22 - Math.max(-1, Math.min(1, s * 2.2)) * 20;
        if (x === 0) g.moveTo(10 + x, y);
        else g.lineTo(10 + x, y);
      }
      g.stroke();
    } else {
      g.fillStyle = '#56606b';
      g.font = `11px ${mono}`;
      g.fillText('audio off: click "Start audio"', 14, top + 22);
    }
    this.onDraw?.();
  }
}
