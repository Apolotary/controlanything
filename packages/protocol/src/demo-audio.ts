import { z } from 'zod';

/** One room-wide master setting. Receiving it never grants browser autoplay permission. */
export const AudioMasterPayload = z.object({ volume: z.number().min(0).max(1), muted: z.boolean() });
export type AudioMasterPayload = z.infer<typeof AudioMasterPayload>;
/** OS speech fallback for browsers without speechSynthesis (including Quest Browser). */
export const AudioSpeakPayload = z.object({ text: z.string().trim().min(1).max(450) });
export const DEFAULT_AUDIO_MASTER: Readonly<AudioMasterPayload> = Object.freeze({ volume: .35, muted: false });

/** Pure state adapter shared by the Quest and Mac; each sound engine owns its browser AudioContext. */
export class DemoAudioMaster {
  private value: AudioMasterPayload = { ...DEFAULT_AUDIO_MASTER };
  private testMuted = false;
  private gesture = false;
  private send?: (state: AudioMasterPayload) => void;
  private readonly listeners = new Set<(state: AudioMasterPayload, effectiveVolume: number) => void>();
  private readonly outputs = new Set<(effectiveVolume: number) => void>();
  private readonly unlockers = new Set<() => void>();
  private channel?: BroadcastChannel;
  constructor() {
    // Each browser page has its own autoplay permission, but shares the room's
    // volume. Force-mute is deliberately local and never travels on this channel.
    if ('window' in globalThis && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('ce-demo-audio-v1');
      (this.channel as unknown as { unref?(): void }).unref?.();
      this.channel.onmessage = event => {
        if (event.data?.kind === 'request') this.channel?.postMessage({ kind: 'state', state: this.state });
        else if (event.data?.kind === 'state') {
          const parsed = AudioMasterPayload.safeParse(event.data.state);
          if (parsed.success) { this.value = parsed.data; this.publish(); }
        }
      };
      this.channel.postMessage({ kind: 'request' });
    }
  }
  get state(): AudioMasterPayload { return { ...this.value }; }
  get effectiveVolume(): number { return this.testMuted || this.value.muted ? 0 : this.value.volume; }
  get unlocked(): boolean { return this.gesture; }
  bind(send: (state: AudioMasterPayload) => void): void { this.send = send; }
  receive(state: AudioMasterPayload): void {
    const parsed = AudioMasterPayload.safeParse(state); if (!parsed.success) return;
    this.value = parsed.data; this.publish(); this.channel?.postMessage({ kind: 'state', state: this.state });
  }
  set(volume: number, muted = this.value.muted): void {
    if (!Number.isFinite(volume)) return;
    this.receive({ volume: Math.max(0, Math.min(1, volume)), muted });
    this.send?.(this.state);
  }
  forceMute(muted: boolean): void { this.testMuted = muted; this.publish(); }
  subscribe(fn: (state: AudioMasterPayload, effectiveVolume: number) => void): () => void {
    this.listeners.add(fn); fn(this.state, this.effectiveVolume); return () => { this.listeners.delete(fn); };
  }
  registerOutput(fn: (effectiveVolume: number) => void): () => void {
    this.outputs.add(fn); fn(this.effectiveVolume); return () => { this.outputs.delete(fn); };
  }
  /** Call synchronously from Enter AR, pinch, click or another real user gesture. */
  unlock(): void { this.gesture = true; for (const fn of this.unlockers) fn(); }
  onUnlock(fn: () => void): () => void {
    this.unlockers.add(fn); if (this.gesture) fn(); return () => { this.unlockers.delete(fn); };
  }
  private publish(): void {
    for (const fn of this.outputs) fn(this.effectiveVolume);
    for (const fn of this.listeners) fn(this.state, this.effectiveVolume);
  }
}
export const demoAudioMaster = new DemoAudioMaster();
