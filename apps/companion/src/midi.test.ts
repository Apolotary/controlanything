import { afterEach, describe, expect, it, vi } from 'vitest';
import { MidiBridge } from './midi';

afterEach(() => vi.unstubAllGlobals());

describe('MIDI permission recovery', () => {
  it('reopens a plain MIDI grant without asking for new SysEx permission', async () => {
    const query = vi.fn(async ({ sysex }: { sysex: boolean }) => ({ state: sysex ? 'prompt' : 'granted' }));
    const requestMIDIAccess = vi.fn(async () => ({ inputs: new Map(), outputs: new Map() }));
    vi.stubGlobal('navigator', { permissions: { query }, requestMIDIAccess });
    expect(await MidiBridge.alreadyGranted()).toBe(true);
    const midi = new MidiBridge();
    await midi.enable(true);
    expect(requestMIDIAccess).toHaveBeenCalledExactlyOnceWith({ sysex: false });
    expect(midi.enabled).toBe(true);
    expect(midi.sysex).toBe(false);
  });

  it('restores an existing SysEx grant and leaves a first run waiting for a click', async () => {
    const query = vi.fn(async () => ({ state: 'granted' }));
    const requestMIDIAccess = vi.fn(async () => ({ inputs: new Map(), outputs: new Map() }));
    vi.stubGlobal('navigator', { permissions: { query }, requestMIDIAccess });
    const midi = new MidiBridge();
    expect(await MidiBridge.alreadyGranted()).toBe(true);
    await midi.enable(true);
    expect(requestMIDIAccess).toHaveBeenCalledExactlyOnceWith({ sysex: true });
    query.mockResolvedValue({ state: 'prompt' });
    expect(await MidiBridge.alreadyGranted()).toBe(false);
    expect(requestMIDIAccess).toHaveBeenCalledOnce();
  });
});
