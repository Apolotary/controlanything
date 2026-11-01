/**
 * Progressive assembly of a spec from a streaming json_schema response. The Meta constrained decoder emits
 * keys alphabetically (anchor, behaviors, controls, device, feedback, ..., parts, ...), so complete array
 * items can be pulled out of the partial text and shown while the rest is still being generated: the
 * object visibly assembles during the ~8-20 s a Spark/Wonder call takes.
 */
import { Behavior, Control, Feedback, Part } from './schema';

export interface PartialSpec {
  title?: string;
  controls: Control[];
  parts: Part[];
  behaviors: Behavior[];
  feedback: Feedback[];
  /** items that closed but failed their item schema */
  rejected: number;
}

/** Find the array value of a top-level key in a (possibly truncated) JSON text and split its complete objects. */
export function completeArrayItems(text: string, key: string): string[] {
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`, 'g');
  const m = re.exec(text);
  if (!m) return [];
  let i = m.index + m[0].length;
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        items.push(text.slice(start, i + 1));
        start = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return items;
}

function parseItems<T>(text: string, key: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }, rejected: { n: number }): T[] {
  const out: T[] = [];
  for (const raw of completeArrayItems(text, key)) {
    try {
      const r = schema.safeParse(JSON.parse(raw));
      if (r.success && r.data !== undefined) out.push(r.data);
      else rejected.n++;
    } catch {
      rejected.n++;
    }
  }
  return out;
}

/** Best-effort partial spec from streamed text. Safe to call on every delta (cheap for a few KB). */
export function scanPartialSpec(text: string): PartialSpec {
  const rejected = { n: 0 };
  const title = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  const out: PartialSpec = {
    controls: parseItems(text, 'controls', Control, rejected),
    parts: parseItems(text, 'parts', Part, rejected),
    behaviors: parseItems(text, 'behaviors', Behavior, rejected),
    feedback: parseItems(text, 'feedback', Feedback, rejected),
    rejected: rejected.n,
  };
  if (title !== undefined) out.title = JSON.parse(`"${title}"`) as string;
  return out;
}
