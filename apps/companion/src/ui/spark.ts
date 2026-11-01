/** Small inline SVGs: a value sparkline and an IR pulse train. Built with createElementNS (no innerHTML). */

const NS = 'http://www.w3.org/2000/svg';

function svg(w: number, h: number, className: string): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('width', String(w));
  s.setAttribute('height', String(h));
  s.setAttribute('class', className);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function path(d: string, cls: string): SVGPathElement {
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', cls);
  return p;
}

/** Values over time; `mark` (0..1 along x) draws the moment the command was sent. */
export function sparkline(values: number[], opts: { w?: number; h?: number; mark?: number; className?: string; minSpan?: number } = {}): SVGSVGElement {
  const w = opts.w ?? 120;
  const h = opts.h ?? 24;
  const s = svg(w, h, `spark ${opts.className ?? ''}`);
  if (values.length < 2) return s;
  // never stretch a tiny change to full height: the line has to tell the truth about the size
  const minSpan = opts.minSpan ?? 0;
  const vlo = Math.min(...values);
  const vhi = Math.max(...values);
  const pad = Math.max(0, minSpan - (vhi - vlo)) / 2;
  const lo = vlo - pad;
  const span = vhi - vlo + 2 * pad || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`);
  if (opts.mark !== undefined) {
    const x = (Math.min(1, Math.max(0, opts.mark)) * (w - 2) + 1).toFixed(1);
    s.append(path(`M${x},1 L${x},${h - 1}`, 'spark-mark'));
  }
  s.append(path(`M${pts.join(' L')}`, 'spark-line'));
  return s;
}

/** IR marks (high) and spaces (low) along time; long gaps are compressed so the bits stay visible. */
export function pulseTrain(us: readonly number[], opts: { w?: number; h?: number } = {}): SVGSVGElement {
  const w = opts.w ?? 140;
  const h = opts.h ?? 18;
  const s = svg(w, h, 'pulses');
  if (us.length < 2) return s;
  const clipped = us.map((x) => Math.min(x, 5000));
  const total = clipped.reduce((a, b) => a + b, 0) || 1;
  let x = 1;
  let d = `M1,${h - 2}`;
  clipped.forEach((dur, i) => {
    const dx = (dur / total) * (w - 2);
    const y = i % 2 === 0 ? 2 : h - 2;
    d += ` L${x.toFixed(1)},${y} L${(x + dx).toFixed(1)},${y}`;
    x += dx;
  });
  d += ` L${x.toFixed(1)},${h - 2}`;
  s.append(path(d, 'pulse-line'));
  return s;
}
