/** Browser/OS demo feedback. No inference, samples, or independent volume control. */
import { demoAudioMaster } from '@ce/protocol';

export type DemoCue = 'tap' | 'ready' | 'stop' | 'curious' | 'giggle' | 'celebrate';

export class QuestDemoAudio {
  private context?: AudioContext;
  private bus?: GainNode;
  private volume = 0;
  private readonly thinking = new Set<string>();
  private thinkingTimer?: ReturnType<typeof setInterval>;
  private lastTap = -Infinity;
  private utterance?: SpeechSynthesisUtterance;
  private readonly quiet: boolean;
  private readonly removeOutput: () => void;
  private readonly removeUnlock: () => void;
  readonly stats = { cues: 0, speech: 0, speechStarted: 0, speechFinished: 0, speechErrors: 0,
    thinking: false, unlocked: false, speechAvailable: typeof speechSynthesis !== 'undefined' };

  constructor(params: URLSearchParams) {
    this.quiet = params.get('mute') === '1';
    if (this.quiet) demoAudioMaster.forceMute(true);
    this.removeOutput = demoAudioMaster.registerOutput(volume => {
      const changed = volume !== this.volume;
      this.volume = volume;
      if (this.bus && this.context) this.bus.gain.setTargetAtTime(volume * 0.28, this.context.currentTime, 0.025);
      // Browsers can snapshot utterance volume at speak(); cancel it on a master
      // change rather than let old speech ignore the shared mute/volume control.
      if (volume === 0 || changed) this.cancelSpeech();
    });
    this.removeUnlock = demoAudioMaster.onUnlock(() => this.unlock());
  }

  /** Must run synchronously from Enter AR, a pointer press, or an XR select gesture. */
  unlock(): void {
    if (this.quiet || (globalThis as { __ceMute?: boolean }).__ceMute) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.context.onstatechange = () => { this.stats.unlocked = this.context?.state === 'running'; };
        this.bus = this.context.createGain();
        this.bus.gain.value = this.volume * 0.28;
        this.bus.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
      this.stats.unlocked = this.context.state === 'running';
    } catch { /* Browser audio can be unavailable; visual feedback continues. */ }
  }

  play(cue: DemoCue): void {
    const ctx = this.context;
    if (this.quiet || (globalThis as { __ceMute?: boolean }).__ceMute || !ctx || !this.bus || this.volume <= 0 || ctx.state !== 'running') return;
    if (cue === 'tap') {
      const now = performance.now();
      if (now - this.lastTap < 75) return;
      this.lastTap = now;
    }
    this.stats.cues++;
    const notes: Record<DemoCue, [number, number, number][]> = {
      tap: [[1100, 0, .035]], ready: [[660, 0, .12], [880, .09, .15], [1108, .18, .22]],
      stop: [[440, 0, .09], [294, .075, .16]], curious: [[520, 0, .10], [780, .10, .15]],
      giggle: [[740, 0, .07], [880, .09, .06], [740, .18, .08]],
      celebrate: [[523, 0, .13], [659, .11, .13], [784, .22, .13], [1047, .33, .27]],
    };
    for (const [hz, delay, duration] of notes[cue]) this.tone(hz, delay, duration, cue === 'tap' ? .14 : .22);
  }

  private tone(hz: number, delay: number, duration: number, amount: number): void {
    const ctx = this.context, bus = this.bus;
    if (!ctx || !bus) return;
    const oscillator = ctx.createOscillator(), gain = ctx.createGain(), start = ctx.currentTime + delay;
    oscillator.type = 'sine'; oscillator.frequency.value = hz;
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(amount, start + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(bus);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(start + duration + .02);
  }

  setThinking(source: string, active: boolean): void {
    if (active) this.thinking.add(source); else this.thinking.delete(source);
    this.stats.thinking = this.thinking.size > 0;
    if (!this.stats.thinking) { clearInterval(this.thinkingTimer); this.thinkingTimer = undefined; return; }
    if (this.thinkingTimer || this.quiet) return;
    const pulse = () => {
      if (this.volume > 0 && this.context?.state === 'running') {
        this.tone(392, 0, .27, .055); this.tone(588, .16, .3, .035);
      }
    };
    pulse(); this.thinkingTimer = setInterval(pulse, 1800);
  }

  /** speechSynthesis is browser/OS speech, never a remote AI voice model. */
  speak(text: string): void {
    if (this.quiet || (globalThis as { __ceMute?: boolean }).__ceMute || this.volume <= 0 || !demoAudioMaster.unlocked || !this.stats.speechAvailable || !text.trim()) return;
    this.cancelSpeech();
    const utterance = this.utterance = new SpeechSynthesisUtterance(text.slice(0, 450));
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.localService && /^en/i.test(v.lang)) ?? voices.find(v => /^en/i.test(v.lang));
    if (voice) utterance.voice = voice;
    utterance.volume = this.volume; utterance.rate = 1.06; utterance.pitch = 1.15;
    utterance.onstart = () => { this.stats.speechStarted++; };
    utterance.onend = () => { this.stats.speechFinished++; if (this.utterance === utterance) this.utterance = undefined; };
    utterance.onerror = () => { this.stats.speechErrors++; if (this.utterance === utterance) this.utterance = undefined; };
    this.stats.speech++;
    speechSynthesis.speak(utterance);
  }

  private cancelSpeech(): void {
    if (this.utterance && this.stats.speechAvailable) speechSynthesis.cancel();
    this.utterance = undefined;
  }
  suspend(): void {
    this.thinking.clear(); this.stats.thinking = false;
    clearInterval(this.thinkingTimer); this.thinkingTimer = undefined;
    this.cancelSpeech();
  }
  snapshot() { return { master: demoAudioMaster.state, effectiveVolume: this.volume, unlocked: demoAudioMaster.unlocked,
    contextState: this.context?.state ?? 'not-created', stats: { ...this.stats } }; }
  dispose(): void { this.suspend(); this.removeOutput(); this.removeUnlock(); void this.context?.close().catch(() => {}); }
}
