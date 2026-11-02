import { describe, expect, it } from 'vitest';
import { ModeState } from './modes';

describe('local tags and server snapshots', () => {
  it('associates simultaneous picks by their position even when identification returns in reverse order', () => {
    const state = new ModeState();
    state.add('left', { label: 'Ceiling light', position: { x: -1, y: 2, z: -1 } });
    state.add('right', { label: 'Ceiling light', position: { x: 1, y: 2, z: -1 } });
    state.snapshot([
      { cardId: 'right-card', label: 'Ceiling light', name: 'Right light', connection: 'offline', position: { x: 1, y: 2, z: -1 } },
      { cardId: 'left-card', label: 'Ceiling light', name: 'Left light', connection: 'setup', position: { x: -1, y: 2, z: -1 } },
    ]);
    expect(state.tags.get('left')?.cardId).toBe('left-card');
    expect(state.tags.get('right')?.cardId).toBe('right-card');
    expect(state.tags.size).toBe(2);
  });

  it('matches the original capture after a tagged object moves during identification', () => {
    const state = new ModeState();
    const tag = state.add('synth', { label: 'Keyboard', position: { x: 0, y: 1, z: -1 } });
    tag.position = { x: 2, y: 1, z: -1 };
    state.snapshot([{ cardId: 'keyboard-card', label: 'Keyboard', connection: 'setup', position: { x: 0, y: 1, z: -1 } }]);
    expect(state.tags.size).toBe(1);
    expect(state.tags.get('synth')).toMatchObject({ cardId: 'keyboard-card', position: { x: 2, y: 1, z: -1 } });
  });

  it('preserves local picks until answered, removes absent confirmed tags, and distrusts a lost connection', () => {
    const state = new ModeState();
    state.add('pending', { label: 'Keyboard' });
    state.snapshot([{ cardId: 'light', label: 'Light', connection: 'ready' }]);
    state.disconnected();
    expect(state.byCard('light')?.connection).toBe('unknown');
    state.snapshot([]);
    expect(state.tags.size).toBe(1);
    expect(state.tags.get('pending')?.pending).toBeTruthy();
  });

  it('untagging before identification arrives removes the eventual server tag instead of reviving it', () => {
    const state = new ModeState();
    state.add('pending', { label: 'Keyboard', position: { x: 0, y: 1, z: -1 } });
    state.remove('pending');
    state.snapshot([{ cardId: 'synth', label: 'Keyboard', connection: 'setup', position: { x: 0, y: 1, z: -1 } }]);
    expect(state.tags.size).toBe(0);
    expect(state.removals.has('synth')).toBe(true);
    state.snapshot([]);
    expect(state.removals.size).toBe(0);
  });

  it('clears the offline hint when the next full snapshot reports an online bridge', () => {
    const state = new ModeState();
    state.snapshot([{ cardId: 'synth', label: 'Keyboard', connection: 'offline', hint: 'Plug the synth into your Mac and open the Mac app.' }]);
    state.snapshot([{ cardId: 'synth', label: 'Keyboard', connection: 'setup' }]);
    expect(state.byCard('synth')).toMatchObject({ connection: 'setup', hint: undefined });
  });

  it('only allows setup in Control with a confirmed online tag', () => {
    const state = new ModeState();
    state.add('light', { label: 'Light' });
    expect(state.canSetup('light')).toBe(false);
    state.accept({ cardId: 'server-light', label: 'Light', connection: 'setup' });
    expect(state.canSetup('light')).toBe(false);
    state.mode = 'control';
    expect(state.canSetup('light')).toBe(true);
    state.tags.get('light')!.busy = true;
    expect(state.canSetup('light')).toBe(false);
    state.tags.get('light')!.busy = false;
    state.disconnected();
    expect(state.canSetup('light')).toBe(false);
  });
});
