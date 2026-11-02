/** Safe, readable JSON rendering for the Details drawer. */
import { el } from './dom';

function line(indent: number, ...parts: Node[]): HTMLElement {
  const d = el('div', { className: 'jl' });
  d.style.paddingLeft = `${indent * 2}ch`;
  d.append(...parts);
  return d;
}

const p = (t: string) => el('span', { className: 'jp', text: t });
const s = (t: string) => el('span', { className: 'js', text: JSON.stringify(t) });
const k = (t: string) => el('span', { className: 'jk', text: JSON.stringify(t) });
const v = (t: string) => el('span', { className: 'jv', text: t });

/** Short arrays of numbers stay on one line (IR timings, MIDI bytes). */
function inline(x: unknown): boolean {
  return Array.isArray(x) && x.length <= 48 && x.every((y) => typeof y === 'number');
}

function scalar(x: unknown): Node {
  if (typeof x === 'string') return s(x);
  if (x === null) return v('null');
  if (Array.isArray(x)) return v(`[${x.join(', ')}]`);
  return v(String(x));
}

function walk(out: HTMLElement[], x: unknown, indent: number, prefix: Node[], comma: boolean): void {
  const tail = comma ? [p(',')] : [];
  if (x && typeof x === 'object' && !inline(x)) {
    const isArr = Array.isArray(x);
    const entries = isArr ? (x as unknown[]).map((y, i) => [String(i), y] as const) : Object.entries(x as Record<string, unknown>);
    if (!entries.length) {
      out.push(line(indent, ...prefix, p(isArr ? '[]' : '{}'), ...tail));
      return;
    }
    out.push(line(indent, ...prefix, p(isArr ? '[' : '{')));
    entries.forEach(([key, val], i) => {
      const pre = isArr ? [] : [k(key), p(': ')];
      walk(out, val, indent + 1, pre, i < entries.length - 1);
    });
    out.push(line(indent, p(isArr ? ']' : '}'), ...tail));
    return;
  }
  out.push(line(indent, ...prefix, scalar(x), ...tail));
}

/** Render a value as highlighted, indented JSON lines (with an optional leading comment). */
export function jsonView(value: unknown, comment?: string): DocumentFragment {
  const lines: HTMLElement[] = [];
  if (comment) for (const c of comment.split('\n')) lines.push(line(0, el('span', { className: 'jc', text: `// ${c}` })));
  if (value !== undefined) walk(lines, value, 0, [], false);
  const f = document.createDocumentFragment();
  f.append(...lines);
  return f;
}
