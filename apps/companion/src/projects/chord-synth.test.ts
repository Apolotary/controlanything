import { describe, expect, it, vi } from 'vitest';
import { CHORDS, ChordSynth, chordNotes, midiFrequency, noteName } from './chord-synth';

function audio() {
  const oscillators: Array<{ type: string; frequency: { setValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const gains: Array<{ gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state: 'suspended', currentTime: 10, destination: {},
    onstatechange: null as (() => void) | null,
    resume: vi.fn(async () => { context.state = 'running'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
    createOscillator: vi.fn(() => {
      const oscillator = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
      oscillators.push(oscillator); return oscillator;
    }),
    createGain: vi.fn(() => {
      const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain); return gain;
    }),
  };
  const create = vi.fn(() => context as unknown as AudioContext);
  return { context, oscillators, gains, create };
}
const initial = { chord_c: 0, chord_am: 0, chord_f: 0, chord_g: 0, silence: 0 };

describe('trusted chord demo audio', () => {
  it('uses the requested voicings, octave names and standard pitch', () => {
    expect(chordNotes('chord_c')).toEqual([60, 64, 67, 71]);
    expect(chordNotes('chord_am')).toEqual([57, 60, 64, 67]);
    expect(chordNotes('chord_f')).toEqual([53, 57, 60, 64]);
    expect(chordNotes('chord_g')).toEqual([55, 59, 62, 65]);
    expect(Object.values(CHORDS).map(chord => chord.label)).toEqual(['Cmaj7', 'Am7', 'Fmaj7', 'G7']);
    expect(midiFrequency(69)).toBe(440); expect(midiFrequency(60)).toBeCloseTo(261.625565);
    expect([60, 64, 67, 71].map(noteName)).toEqual(['C4', 'E4', 'G4', 'B4']);
  });
  it('does not allocate audio until explicitly enabled and never replays initial or disabled-state counters', async () => {
    const a = audio(), synth = new ChordSynth(a.create);
    synth.consume({ ...initial, chord_c: 4 });
    expect(a.create).not.toHaveBeenCalled();
    await synth.enable();
    expect(a.create).toHaveBeenCalledOnce(); expect(synth.enabled).toBe(true);
    synth.consume({ ...initial, chord_c: 4 }); expect(a.oscillators).toHaveLength(0);
    synth.consume({ ...initial, chord_c: 5 }); expect(a.oscillators).toHaveLength(4);
    synth.disable(); synth.consume({ ...initial, chord_c: 6 });
    await synth.enable(); synth.consume({ ...initial, chord_c: 6 });
    expect(a.oscillators).toHaveLength(4);
    synth.consume({ ...initial, chord_c: 7 }); expect(a.oscillators).toHaveLength(8);
  });
  it('schedules a quiet four-note envelope with a hard stop under one second and cleans up completion', async () => {
    const a = audio(), changed = vi.fn(), synth = new ChordSynth(a.create, changed);
    synth.bind(initial); await synth.enable(); synth.consume({ ...initial, chord_c: 1 });
    expect(synth.current).toMatchObject({ id: 'chord_c', label: 'Cmaj7', noteLabels: ['C4', 'E4', 'G4', 'B4'] });
    a.oscillators.forEach((oscillator, index) => {
      expect(oscillator.type).toBe('triangle');
      expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(midiFrequency(CHORDS.chord_c.notes[index]!), 10);
      expect(oscillator.start).toHaveBeenCalledWith(10); expect(oscillator.stop).toHaveBeenCalledWith(10.82);
      expect(a.gains[index]!.gain.setValueAtTime).toHaveBeenCalledWith(0, 10);
      expect(a.gains[index]!.gain.linearRampToValueAtTime.mock.calls).toEqual([[0.035, 10.025], [0.022, 10.15], [0, 10.78]]);
    });
    a.oscillators.forEach(oscillator => oscillator.onended?.());
    expect(synth.current).toBeUndefined(); expect(changed).toHaveBeenLastCalledWith(undefined);
    for (const oscillator of a.oscillators) expect(oscillator.disconnect).toHaveBeenCalledOnce();
    for (const gain of a.gains) expect(gain.disconnect).toHaveBeenCalledOnce();
  });
  it('replaces the previous chord without accumulating voices, and silence wins over a simultaneous chord', async () => {
    const a = audio(), synth = new ChordSynth(a.create);
    synth.bind(initial); await synth.enable();
    synth.consume({ ...initial, chord_c: 1 });
    const oldEnd = a.oscillators[0]!.onended;
    synth.consume({ ...initial, chord_c: 1, chord_am: 1 });
    expect(a.oscillators.filter(oscillator => !oscillator.disconnect.mock.calls.length)).toHaveLength(4);
    for (const oscillator of a.oscillators.slice(0, 4)) expect(oscillator.stop).toHaveBeenLastCalledWith(10);
    oldEnd?.(); expect(synth.current?.id).toBe('chord_am');
    synth.consume({ ...initial, chord_c: 1, chord_am: 1, chord_g: 1, silence: 1 });
    expect(a.oscillators).toHaveLength(8); expect(synth.current).toBeUndefined(); expect(synth.enabled).toBe(true);
    expect(a.oscillators.every(oscillator => oscillator.disconnect.mock.calls.length)).toBe(true);
    synth.consume({ ...initial, chord_c: 1, chord_am: 1, chord_g: 2, silence: 1 });
    expect(a.oscillators).toHaveLength(12); expect(synth.current?.id).toBe('chord_g');
  });
  it('does not turn replay snapshots, counter jumps, duplicates or invalid values into a burst of notes', async () => {
    const a = audio(), synth = new ChordSynth(a.create);
    await synth.enable(); synth.consume({ ...initial, chord_c: 5 });
    synth.consume({ ...initial, chord_c: 7 });
    synth.consume({ ...initial, chord_c: 8, chord_am: 1 });
    synth.consume({ ...initial, chord_c: 8, chord_am: 1 });
    synth.consume({ ...initial, chord_c: NaN, chord_am: Infinity });
    expect(a.oscillators).toHaveLength(0);
    synth.consume({ ...initial, chord_c: 1 }); expect(a.oscillators).toHaveLength(4);
    synth.consume(initial); expect(synth.current).toBeUndefined();
  });
  it('requires a fresh enable after bind/reset and discards pending unlock on stop', async () => {
    const a = audio(), synth = new ChordSynth(a.create);
    let resume!: () => void;
    a.context.resume.mockImplementation(() => new Promise<void>(resolve => { resume = () => { a.context.state = 'running'; resolve(); }; }));
    synth.bind(initial); const enabling = synth.enable();
    synth.consume({ ...initial, chord_c: 1 }); synth.stop(); resume(); await enabling;
    expect(synth.enabled).toBe(false); synth.consume({ ...initial, chord_c: 2 }); expect(a.oscillators).toHaveLength(0);
    a.context.resume.mockImplementation(async () => { a.context.state = 'running'; });
    await synth.enable(); synth.consume({ ...initial, chord_c: 3 }); expect(a.oscillators).toHaveLength(4);
    synth.reset({ ...initial, chord_g: 7 }); expect(synth.enabled).toBe(false); expect(synth.current).toBeUndefined();
    await synth.enable(); synth.consume({ ...initial, chord_g: 7 }); expect(a.oscillators).toHaveLength(4);
  });
  it('stays disabled on unlock failure and can retry without replaying a chord', async () => {
    const a = audio(), synth = new ChordSynth(a.create);
    synth.bind(initial); a.context.resume.mockRejectedValueOnce(new Error('blocked'));
    await expect(synth.enable()).rejects.toThrow('blocked'); expect(synth.enabled).toBe(false);
    synth.consume({ ...initial, chord_f: 1 });
    await synth.enable(); synth.consume({ ...initial, chord_f: 1 }); expect(a.oscillators).toHaveLength(0);
    synth.consume({ ...initial, chord_f: 2 }); expect(a.oscillators).toHaveLength(4);
  });
  it('withdraws readiness on an unexpected audio interruption and requires explicit re-enable', async () => {
    const a = audio(), unavailable = vi.fn(), synth = new ChordSynth(a.create, undefined, unavailable);
    synth.bind(initial); await synth.enable(); synth.consume({ ...initial, chord_c: 1 });
    a.context.state = 'interrupted'; a.context.onstatechange?.();
    expect(synth.enabled).toBe(false); expect(synth.current).toBeUndefined();
    expect(a.oscillators.every(oscillator => oscillator.disconnect.mock.calls.length)).toBe(true);
    expect(unavailable).toHaveBeenCalledOnce();
    a.context.onstatechange?.(); expect(unavailable).toHaveBeenCalledOnce();
    a.context.state = 'running'; a.context.onstatechange?.();
    synth.consume({ ...initial, chord_c: 2 });
    expect(synth.enabled).toBe(false); expect(a.oscillators).toHaveLength(4);
    await synth.enable(); synth.consume({ ...initial, chord_c: 3 });
    expect(synth.enabled).toBe(true); expect(a.oscillators).toHaveLength(8);
    synth.disable(); a.context.state = 'suspended'; a.context.onstatechange?.();
    synth.dispose();
    expect(unavailable).toHaveBeenCalledOnce(); expect(a.context.onstatechange).toBeNull();
  });
  it('disposes active or pending audio and prevents a delayed unlock or future reuse', async () => {
    const a = audio(), synth = new ChordSynth(a.create);
    synth.bind(initial); await synth.enable(); synth.consume({ ...initial, chord_c: 1 });
    synth.dispose(); synth.dispose();
    expect(a.context.close).toHaveBeenCalledOnce(); expect(synth.enabled).toBe(false);
    expect(a.oscillators.every(oscillator => oscillator.disconnect.mock.calls.length)).toBe(true);
    await expect(synth.enable()).rejects.toThrow('disposed');
    const b = audio(), pending = new ChordSynth(b.create);
    let resume!: () => void;
    b.context.resume.mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
    const enable = pending.enable(); pending.dispose(); resume(); await enable;
    expect(pending.enabled).toBe(false); expect(b.oscillators).toHaveLength(0);
  });
});
