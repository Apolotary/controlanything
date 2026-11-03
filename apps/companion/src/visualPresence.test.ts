import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceVisualRenderer, VisualSynthPresence, VISUAL_PRESENCE_CHANNEL, VISUAL_STALE_MS } from './visualPresence';

class Wire {
  static all = new Set<Wire>();
  onmessage?: (event: { data: unknown }) => void;
  constructor(readonly name: string) { Wire.all.add(this); }
  postMessage(data: unknown) { for (const peer of Wire.all) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data }); }
  close() { Wire.all.delete(this); }
}
const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('BroadcastChannel', Wire); });
afterEach(() => { cleanup.splice(0).forEach((dispose) => dispose()); Wire.all.clear(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const watch = (owner: string, changed = vi.fn()) => {
  const monitor = new VisualSynthPresence(() => owner, changed); cleanup.push(() => monitor.dispose()); return monitor;
};
const render = (owner: string, visible = () => true) => {
  const renderer = announceVisualRenderer(owner, visible); cleanup.push(() => renderer.dispose()); return renderer;
};

describe('owner-scoped visible renderer presence', () => {
  it('connects only the companion that opened the screen and discovers an already open screen', () => {
    render('mac-one');
    const one = watch('mac-one'), two = watch('mac-two');
    expect(one.connected()).toBe(true); expect(two.connected()).toBe(false);
  });

  it('disconnects immediately on hidden/closed and reconnects on visible without periodic status churn', async () => {
    const changed = vi.fn(), monitor = watch('mac', changed); let visible = true;
    const renderer = render('mac', () => visible);
    expect(monitor.connected()).toBe(true); expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); expect(changed).toHaveBeenCalledTimes(1);
    visible = false; renderer.update(); expect(monitor.connected()).toBe(false);
    visible = true; renderer.update(); expect(monitor.connected()).toBe(true);
    renderer.dispose(); expect(monitor.connected()).toBe(false); expect(changed).toHaveBeenCalledTimes(4);
  });

  it('expires a crashed renderer and preserves another visible screen belonging to the same owner', async () => {
    const monitor = watch('mac'); const wire = new Wire(VISUAL_PRESENCE_CHANNEL);
    wire.postMessage({ type: 'renderer', owner: 'mac', renderer: 'crashed', visible: true });
    expect(monitor.connected()).toBe(true);
    await vi.advanceTimersByTimeAsync(VISUAL_STALE_MS); expect(monitor.connected()).toBe(false);
    const first = render('mac'), second = render('mac');
    first.dispose(); expect(monitor.connected()).toBe(true);
    second.dispose(); expect(monitor.connected()).toBe(false);
  });

  it('ignores malformed presence and standalone visuals without an owner', () => {
    const monitor = watch('mac'), wire = new Wire(VISUAL_PRESENCE_CHANNEL);
    wire.postMessage({ type: 'renderer', owner: 'mac', renderer: 'bad', visible: 'true' });
    const renderer = announceVisualRenderer(null, () => true); cleanup.push(() => renderer.dispose());
    expect(monitor.connected()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });
});
