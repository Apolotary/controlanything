import { describe, expect, it } from 'vitest';
import { PairCodeEntry, pairingCode } from './pair-code';

describe('immersive pairing code entry', () => {
  it('uses the unambiguous alphabet, bounds input and permits correction', () => {
    const entry = new PairCodeEntry();
    expect(entry.display).toBe('···-···');
    for (const key of '0O1ILK7Q4M2Z') entry.key(key);
    expect(entry.value).toBe('K7Q4M2');
    expect(entry.display).toBe('K7Q-4M2');
    expect(entry.valid).toBe(true);
    entry.key('Back');
    expect(entry.valid).toBe(false);
    expect(entry.display).toBe('K7Q-4M·');
  });

  it('accepts a formatted short code and rejects URLs and incomplete input', () => {
    expect(pairingCode(' k7q-4m2 ')).toBe('K7Q4M2');
    expect(pairingCode('K7Q')).toBeNull();
    expect(pairingCode('https://other.test/p/K7Q4M2')).toBeNull();
  });
});
