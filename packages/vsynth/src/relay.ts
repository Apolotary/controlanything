import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState, VISUAL_SYNTH_CHANNEL } from './state.js';
import type { VisualSynthParameters } from './state.js';

export interface VisualSynthTarget {
  receiveMidi(bytes: readonly number[]): boolean | void;
  reset(): void;
  setState(parameters: VisualSynthParameters): void;
  getState(): VisualSynthParameters;
}

/** A live renderer's report that it applied one command (the exec.ack `applied` self-report). */
export interface VisualSynthReceipt {
  id: string;
  renderer: string;
  params: VisualSynthParameters;
  /** document.visibilityState === 'visible' on the page that drew it */
  visible: boolean;
  /** renderer frame counter when the command was applied */
  frame: number;
  at: number;
}

export interface VisualSynthRelay {
  receiveMidi(bytes: readonly number[], id?: string): boolean;
  reset(): void;
  dispose(): void;
}

function receipt(value: Record<string, unknown>): VisualSynthReceipt | undefined {
  const { id, renderer, params, visible, frame, at } = value;
  return typeof id === 'string' && typeof renderer === 'string' && isVisualSynthState(params) && typeof visible === 'boolean'
    && typeof frame === 'number' && Number.isFinite(frame) && typeof at === 'number' && Number.isFinite(at)
    ? { id, renderer, params, visible, frame, at } : undefined;
}

/** Same-origin visual pages and the virtual output share MIDI events, never audio. */
export function createVisualSynthRelay(target: VisualSynthTarget, options: {
  authoritative?: boolean | (() => boolean);
  /** Set by pages that draw: each applied command is answered with a receipt. */
  renderer?: () => { visible: boolean; frame: number };
  /** Set by the port: receipts from drawing pages. */
  onReceipt?: (receipt: VisualSynthReceipt) => void;
} = {}): VisualSynthRelay {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(VISUAL_SYNTH_CHANNEL);
  const rendererId = options.renderer ? globalThis.crypto?.randomUUID?.() ?? `renderer-${Math.random().toString(36).slice(2)}` : '';
  if (channel) {
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== 'object' || data === null || !('type' in data)) return;
      const message = data as Record<string, unknown>;
      if (message.type === 'midi' && Array.isArray(message.bytes) && message.bytes.every((byte) => typeof byte === 'number')) {
        const applied = target.receiveMidi(message.bytes) !== false;
        if (applied && options.renderer && typeof message.id === 'string') {
          channel.postMessage({ type: 'applied', id: message.id, renderer: rendererId, params: target.getState(), ...options.renderer(), at: Date.now() });
        }
      } else if (message.type === 'applied') {
        const report = receipt(message);
        if (report) options.onReceipt?.(report);
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
    receiveMidi(bytes, id) {
      if (!applyVisualSynthMidi(target.getState(), bytes)) return false;
      target.receiveMidi(bytes);
      channel?.postMessage({ type: 'midi', bytes: [...bytes], ...(id ? { id } : {}) });
      return true;
    },
    reset() {
      target.reset();
      channel?.postMessage({ type: 'reset' });
    },
    dispose() { channel?.close(); },
  };
}

export interface VisualSynthPort extends VisualSynthTarget {
  /** Apply, broadcast, and wait (bounded) for the first drawing page to confirm it applied the same command. */
  receiveMidiConfirmed(bytes: readonly number[], timeoutMs?: number): Promise<{ ok: boolean; receipt?: VisualSynthReceipt }>;
  dispose(): void;
}

/** Headless companion port retains state when the visual page opens after setup. */
export function createVisualSynthPort(): VisualSynthPort {
  let parameters = createVisualSynthState();
  const waiting = new Map<string, (receipt: VisualSynthReceipt) => void>();
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
  const relay = createVisualSynthRelay(target, { authoritative: true, onReceipt: (report) => waiting.get(report.id)?.(report) });
  let sequence = 0;
  return {
    ...target,
    receiveMidi: (bytes) => relay.receiveMidi(bytes),
    async receiveMidiConfirmed(bytes, timeoutMs = 150) {
      const id = `cmd-${Date.now().toString(36)}-${(sequence++).toString(36)}`;
      let settle: (receipt?: VisualSynthReceipt) => void = () => {};
      const confirmed = new Promise<VisualSynthReceipt | undefined>((resolve) => { settle = resolve; });
      const timer = setTimeout(() => settle(undefined), timeoutMs);
      waiting.set(id, (report) => settle(report));
      try {
        if (!relay.receiveMidi(bytes, id)) return { ok: false };
        const report = await confirmed;
        return report ? { ok: true, receipt: report } : { ok: true };
      } finally {
        clearTimeout(timer);
        waiting.delete(id);
      }
    },
    reset: relay.reset,
    dispose: relay.dispose,
  };
}
