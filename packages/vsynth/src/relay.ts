import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState, VISUAL_SYNTH_CHANNEL } from './state.js';
import type { VisualSynthParameters } from './state.js';

export interface VisualSynthTarget {
  receiveMidi(bytes: readonly number[]): boolean | void;
  reset(): void;
  setState(parameters: VisualSynthParameters): void;
  getState(): VisualSynthParameters;
}

export interface VisualSynthRelay {
  receiveMidi(bytes: readonly number[]): boolean;
  reset(): void;
  dispose(): void;
}

/** Same-origin visual pages and the virtual output share MIDI events, never audio. */
export function createVisualSynthRelay(target: VisualSynthTarget, options: { authoritative?: boolean | (() => boolean) } = {}): VisualSynthRelay {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(VISUAL_SYNTH_CHANNEL);
  if (channel) {
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== 'object' || data === null || !('type' in data)) return;
      const message = data as Record<string, unknown>;
      if (message.type === 'midi' && Array.isArray(message.bytes) && message.bytes.every((byte) => typeof byte === 'number')) {
        target.receiveMidi(message.bytes);
      } else if (message.type === 'reset') {
        target.reset();
      } else if (message.type === 'state' && isVisualSynthState(message.parameters)) {
        target.setState(message.parameters);
      } else if (message.type === 'request-state' && (typeof options.authoritative === 'function' ? options.authoritative() : options.authoritative)) {
        channel.postMessage({ type: 'state', parameters: target.getState() });
      }
    };
    channel.postMessage({ type: 'request-state' });
  }
  return {
    receiveMidi(bytes) {
      if (!applyVisualSynthMidi(target.getState(), bytes)) return false;
      target.receiveMidi(bytes);
      channel?.postMessage({ type: 'midi', bytes: [...bytes] });
      return true;
    },
    reset() {
      target.reset();
      channel?.postMessage({ type: 'reset' });
    },
    dispose() { channel?.close(); },
  };
}

/** Headless companion port retains state when the visual page opens after setup. */
export function createVisualSynthPort(): VisualSynthTarget & { dispose(): void } {
  let parameters = createVisualSynthState();
  const target: VisualSynthTarget = {
    receiveMidi(bytes) {
      const change = applyVisualSynthMidi(parameters, bytes);
      if (!change) return false;
      parameters = change.parameters;
      return true;
    },
    reset() { parameters = createVisualSynthState(); },
    setState(state) { if (isVisualSynthState(state)) parameters = { ...state }; },
    getState: () => ({ ...parameters }),
  };
  const relay = createVisualSynthRelay(target, { authoritative: true });
  return { ...target, receiveMidi: relay.receiveMidi, reset: relay.reset, dispose: relay.dispose };
}
