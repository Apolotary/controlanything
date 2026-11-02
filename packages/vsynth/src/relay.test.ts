import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisualSynthPort, createVisualSynthRelay } from './relay.js';
import type { VisualSynthTarget } from './relay.js';
import { applyVisualSynthMidi, createVisualSynthState } from './state.js';

class TestChannel {
  static open = new Set<TestChannel>();
  static sent = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { TestChannel.open.add(this); }
  postMessage(data: unknown): void {
    TestChannel.sent++;
    for (const channel of TestChannel.open) {
      if (channel !== this && channel.name === this.name) {
        queueMicrotask(() => {
          if (TestChannel.open.has(channel)) channel.onmessage?.({ data: structuredClone(data) } as MessageEvent<unknown>);
        });
      }
    }
  }
  close(): void { TestChannel.open.delete(this); }
}

function receiver(): VisualSynthTarget {
  let parameters = createVisualSynthState();
  return {
    receiveMidi(bytes) {
      const change = applyVisualSynthMidi(parameters, bytes);
      if (!change) return false;
      parameters = change.parameters;
      return true;
    },
    reset() { parameters = createVisualSynthState(); },
    setState(state) { parameters = { ...state }; },
    getState: () => ({ ...parameters }),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('visual instrument tab relay', () => {
  beforeEach(() => { TestChannel.open.clear(); TestChannel.sent = 0; vi.stubGlobal('BroadcastChannel', TestChannel); });
  afterEach(() => { vi.unstubAllGlobals(); TestChannel.open.clear(); });

  it('restores current values when a visual page opens after MIDI setup', async () => {
    const port = createVisualSynthPort();
    port.receiveMidi([0xb0, 71, 127]);
    port.receiveMidi([0xc0, 2]);
    const page = receiver();
    const relay = createVisualSynthRelay(page);
    await flush();
    expect(page.getState()).toEqual(port.getState());
    expect(page.getState().warp).toBe(1);
    expect(page.getState().pattern).toBe(2);
    relay.dispose(); port.dispose();
    expect(TestChannel.open.size).toBe(0);
  });

  it('delivers commands and Stop once without rebroadcast loops', async () => {
    const port = createVisualSynthPort();
    const page = receiver();
    const relay = createVisualSynthRelay(page);
    await flush();
    const messagesBefore = TestChannel.sent;
    port.receiveMidi([0xb0, 7, 0]);
    await flush();
    expect(page.getState().brightness).toBe(0);
    expect(TestChannel.sent).toBe(messagesBefore + 1);
    relay.reset();
    await flush();
    expect(port.getState()).toEqual(createVisualSynthState());
    expect(page.getState()).toEqual(createVisualSynthState());
    expect(TestChannel.sent).toBe(messagesBefore + 2);
    relay.dispose(); port.dispose();
  });

  it('lets the active simulator respond to synchronization requests', async () => {
    const scene = receiver();
    scene.receiveMidi([0xb0, 71, 127]);
    let leader = false;
    const sceneRelay = createVisualSynthRelay(scene, { authoritative: () => leader });
    const firstPage = receiver();
    const firstRelay = createVisualSynthRelay(firstPage);
    await flush();
    expect(firstPage.getState().warp).toBe(0.4);
    leader = true;
    const secondPage = receiver();
    const secondRelay = createVisualSynthRelay(secondPage);
    await flush();
    expect(secondPage.getState().warp).toBe(1);
    sceneRelay.dispose(); firstRelay.dispose(); secondRelay.dispose();
  });
});
