import { CODE_ALPHABET, CODE_LENGTH, isValidCode, normalizeCode } from '@ce/protocol';

/** A short-code keyboard stays usable in immersive AR, where DOM inputs are unavailable. */
export class PairCodeEntry {
  value = '';

  key(key: string): void {
    if (key === 'Back') this.value = this.value.slice(0, -1);
    else if (key.length === 1 && CODE_ALPHABET.includes(key) && this.value.length < CODE_LENGTH) this.value += key;
  }

  get display(): string { const code = this.value.padEnd(CODE_LENGTH, '·'); return `${code.slice(0, 3)}-${code.slice(3)}`; }
  get valid(): boolean { return isValidCode(this.value); }
}

export function pairingCode(value: string): string | null {
  return isValidCode(value) ? normalizeCode(value) : null;
}

export const PAIR_CODE_KEYS = [...CODE_ALPHABET];
