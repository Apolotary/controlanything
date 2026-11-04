import { describe, expect, it, vi } from 'vitest';
import { DemoAudioMaster } from './demo-audio';

describe('one shared master with local browser permission', () => {
  it('receives room settings without sending them back or granting autoplay', () => {
    const master = new DemoAudioMaster(), send = vi.fn(), unlock = vi.fn(), output = vi.fn();
    master.bind(send); master.onUnlock(unlock); master.registerOutput(output);
    master.receive({ volume: .7, muted: false });
    expect(output).toHaveBeenLastCalledWith(.7); expect(send).not.toHaveBeenCalled(); expect(unlock).not.toHaveBeenCalled();
    expect(master.unlocked).toBe(false); master.unlock(); expect(unlock).toHaveBeenCalledOnce();
  });
  it('keeps unattended forced mute local while publishing deliberate room changes', () => {
    const master = new DemoAudioMaster(), send = vi.fn(); master.bind(send); master.forceMute(true);
    master.set(.6, false);
    expect(master.state).toEqual({ volume: .6, muted: false }); expect(master.effectiveVolume).toBe(0);
    expect(send).toHaveBeenCalledExactlyOnceWith({ volume: .6, muted: false });
    master.forceMute(false); expect(master.effectiveVolume).toBe(.6);
    master.receive({ volume: 4, muted: false }); expect(master.effectiveVolume).toBe(.6);
  });
});
