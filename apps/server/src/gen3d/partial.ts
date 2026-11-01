/**
 * Finds completed elements of top-level arrays in a JSON object that is still streaming, e.g. each finished
 * item of `"controls": [...]` while the rest of the spec is still being generated. Lets json_schema mode show
 * the object assembling the same way tool calls do. Feed it the growing text; it never re-parses old items.
 */
export interface PartialItem {
  /** top-level key of the array, e.g. "controls" */
  key: string;
  index: number;
  value: unknown;
}

export class TopLevelItemScanner {
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escape = false;
  /** last complete string at depth 1 (a candidate key) */
  private lastString = '';
  private stringStart = -1;
  private key = '';
  /** the key whose array we are inside (depth 2), and where the current element started */
  private arrayKey = '';
  private elementStart = -1;
  private counts = new Map<string, number>();

  /** Scan the new part of `text` (the whole text so far) and return elements that just completed. */
  push(text: string): PartialItem[] {
    const out: PartialItem[] = [];
    for (; this.pos < text.length; this.pos++) {
      const ch = text[this.pos];
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === '\\') this.escape = true;
        else if (ch === '"') {
          this.inString = false;
          if (this.depth === 1 && this.stringStart >= 0) {
            try {
              this.lastString = JSON.parse(text.slice(this.stringStart, this.pos + 1));
            } catch {
              this.lastString = '';
            }
          }
        }
        continue;
      }
      switch (ch) {
        case '"':
          this.inString = true;
          this.stringStart = this.pos;
          break;
        case ':':
          if (this.depth === 1) this.key = this.lastString;
          break;
        case '{':
        case '[':
          this.depth++;
          if (this.depth === 2 && ch === '[') this.arrayKey = this.key;
          if (this.depth === 3 && this.arrayKey) this.elementStart = this.pos;
          break;
        case '}':
        case ']':
          if (this.depth === 3 && this.elementStart >= 0 && this.arrayKey) {
            const raw = text.slice(this.elementStart, this.pos + 1);
            const index = this.counts.get(this.arrayKey) ?? 0;
            this.counts.set(this.arrayKey, index + 1);
            try {
              out.push({ key: this.arrayKey, index, value: JSON.parse(raw) });
            } catch {
              // not an object/array element after all; ignore
            }
            this.elementStart = -1;
          }
          if (this.depth === 2) this.arrayKey = '';
          this.depth = Math.max(0, this.depth - 1);
          break;
      }
    }
    return out;
  }
}
