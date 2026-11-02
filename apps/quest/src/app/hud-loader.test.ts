import { describe, expect, it, vi } from 'vitest';
import type { Hud } from './hud-contract';
import { tolerant } from './hud-loader';

describe('tolerant HUD guard', () => {
  it('routes calls to a method re-assigned after the first read (annotation override)', () => {
    const original = vi.fn();
    const hud = tolerant({ upsertTarget: original } as unknown as Hud, 'test');
    hud.upsertTarget({ id: 'a' } as never);
    const override = vi.fn();
    hud.upsertTarget = override;
    hud.upsertTarget({ id: 'b' } as never);
    expect(original).toHaveBeenCalledTimes(1);
    expect(override).toHaveBeenCalledWith({ id: 'b' });
  });

  it('turns missing methods and exceptions into logged no-ops', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hud = tolerant({ setScanning: () => { throw new Error('boom'); } } as unknown as Hud, 'test');
    expect(() => hud.setScanning(true)).not.toThrow();
    expect(() => hud.clearTargets()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    error.mockRestore();
    warn.mockRestore();
  });
});
