import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  draw: vi.fn(), render: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(), relayDispose: vi.fn(),
  announce: vi.fn(), presenceUpdate: vi.fn(), presenceDispose: vi.fn(), fail: false,
  onChange: undefined as undefined | ((label: string) => void),
}));
vi.mock('@ce/vsynth', () => ({
  createVisualSynth: (_canvas: unknown, options: { onChange(label: string): void }) => {
    if (mocks.fail) throw new Error('Graphics unavailable');
    mocks.onChange = options.onChange;
    return { renderAt: mocks.draw, render: mocks.render, start: mocks.start, stop: mocks.stop, dispose: mocks.dispose };
  },
  createVisualSynthRelay: () => ({ dispose: mocks.relayDispose }),
}));
vi.mock('./visualPresence', () => ({ announceVisualRenderer: mocks.announce }));
import { VisualSynthLauncher } from './visualLauncher';

class Element {
  children: Element[] = [];
  parent?: Element;
  textContent = '';
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  append(...children: Element[]) { this.children.push(...children); children.forEach((child) => { child.parent = this; }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute() {}
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string) { this.listeners.get(type)?.forEach((listener) => listener({ preventDefault() {} })); }
}
let body: Element, doc: { hidden: boolean; body: Element; createElement(): Element; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.clearAllMocks(); mocks.fail = false; mocks.onChange = undefined;
  mocks.announce.mockReturnValue({ update: mocks.presenceUpdate, dispose: mocks.presenceDispose });
  body = new Element();
  doc = { hidden: false, body, createElement: () => new Element(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('document', doc); vi.stubGlobal('devicePixelRatio', 2); vi.stubGlobal('innerWidth', 1280); vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('addEventListener', vi.fn()); vi.stubGlobal('removeEventListener', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('automatic in-page visual screen', () => {
  it('draws before announcing actual visibility, mounts once, and never opens a popup', () => {
    const popup = vi.fn(); vi.stubGlobal('window', { open: popup });
    const launcher = new VisualSynthLauncher({ owner: () => 'mac', connected: () => true });
    expect(launcher.open()).toBe(true); expect(launcher.available).toBe(true);
    expect(mocks.draw.mock.invocationCallOrder[0]).toBeLessThan(mocks.announce.mock.invocationCallOrder[0]!);
    expect(mocks.announce).toHaveBeenCalledWith('mac', expect.any(Function));
    launcher.open(); expect(body.children).toHaveLength(1); expect(mocks.announce).toHaveBeenCalledOnce();
    expect(popup).not.toHaveBeenCalled();
    launcher.close(); expect(body.children).toHaveLength(0); expect(mocks.presenceDispose).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(mocks.relayDispose).toHaveBeenCalledOnce();
  });

  it('never calls hidden or disconnected screens ready and withdraws on identity change', () => {
    let connected = true, owner = 'mac'; doc.hidden = true;
    const launcher = new VisualSynthLauncher({ owner: () => owner, connected: () => connected });
    launcher.open(); const available = mocks.announce.mock.calls[0]![1] as () => boolean;
    expect(available()).toBe(false); expect(mocks.start).not.toHaveBeenCalled();
    doc.hidden = false; launcher.update(); expect(available()).toBe(true); expect(mocks.start).toHaveBeenCalled();
    connected = false; launcher.update(); expect(available()).toBe(false); expect(mocks.stop).toHaveBeenCalled();
    connected = true; launcher.update(); expect(available()).toBe(true);
    owner = 'different'; launcher.update(); expect(available()).toBe(false); expect(launcher.opened).toBe(false);
  });

  it('does not publish readiness when graphics fail or lose their context', () => {
    const launcher = new VisualSynthLauncher({ owner: () => 'mac', connected: () => true });
    mocks.fail = true; expect(launcher.open()).toBe(false); expect(mocks.announce).not.toHaveBeenCalled();
    mocks.fail = false; expect(launcher.open()).toBe(true);
    body.children[0]!.children[0]!.emit('webglcontextlost');
    expect(launcher.available).toBe(false); expect(mocks.presenceUpdate).toHaveBeenCalled();
    const retry = body.children[0]!.children[1]!.children[1]!;
    expect(retry.textContent).toBe('Try again'); retry.emit('click');
    expect(launcher.available).toBe(true); expect(body.children).toHaveLength(1);
    launcher.close();
  });

  it('preserves the live effect label through lifecycle updates and resizes on the normal animation clock', () => {
    const launcher = new VisualSynthLauncher({ owner: () => 'mac', connected: () => true });
    launcher.open(); mocks.onChange!('Water ripples · 71%');
    const output = body.children[0]!.children[2]!;
    launcher.update(); expect(output.textContent).toBe('Water ripples · 71%');
    doc.hidden = true; launcher.update(); expect(output.textContent).toContain('Paused');
    doc.hidden = false; launcher.update(); expect(output.textContent).toBe('Water ripples · 71%');
    const resize = vi.mocked(globalThis.addEventListener).mock.calls.find(([type]) => type === 'resize')?.[1] as () => void;
    resize(); expect(mocks.render).toHaveBeenCalledWith(expect.any(Number));
    expect(mocks.draw).toHaveBeenCalledExactlyOnceWith(0);
    launcher.close();
  });
});
