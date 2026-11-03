import { describe, expect, it } from 'vitest';
import { targetChipLabel } from './target-chip';

describe('target chip words', () => {
  it('distinguishes a detection, a pending tag, and the identified device name', () => {
    expect(targetChipLabel({ label: 'Ceiling light' }, 'annotate')).toBe('Ceiling light');
    expect(targetChipLabel({ label: 'Ceiling light', tagged: true, identifying: true }, 'annotate')).toBe('✓ Ceiling light · Identifying…');
    expect(targetChipLabel({ label: 'KOIZUMI ceiling light', tagged: true, identifying: false }, 'annotate')).toBe('✓ KOIZUMI ceiling l…');
  });

  it('offers untagging only when a tagged annotation is hovered', () => {
    expect(targetChipLabel({ label: 'Ceiling light' }, 'annotate', true)).toBe('Ceiling light · Pinch to tag');
    expect(targetChipLabel({ label: 'Ceiling light', tagged: true, identifying: true }, 'annotate', true)).toBe('Pinch to untag');
    expect(targetChipLabel({ label: 'Ceiling light', tagged: true, connection: 'ready' }, 'control', true)).toBe('✓ Ceiling light · Ready');
  });

  it.each([
    ['ready', false, 'Ready'], ['setup', false, 'Needs setup'], ['setup', true, 'Setting up…'],
    ['offline', false, 'Not connected'], ['unknown', false, 'Not connected'],
  ] as const)('describes connection %s with busy=%s in Control', (connection, busy, status) => {
    expect(targetChipLabel({ label: 'Ceiling light', tagged: true, connection, busy }, 'control')).toBe(`✓ Ceiling light · ${status}`);
  });
});
