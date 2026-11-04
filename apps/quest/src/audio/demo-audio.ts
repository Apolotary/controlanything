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
  /** OS speech rendered on the Mac (macOS say) and played here, for browsers without speechSynthesis (Quest Browser). */
  private speechSource?: AudioBufferSourceNode;
  private speechGain?: GainNode;
  private speechSeq = 0;
  private readonly quiet: boolean;
  private readonly removeOutput: () => void;
  private readonly removeUnlock: () => void;
  readonly stats = { cues: 0, speech: 0, speechStarted: 0, speechFinished: 0, speechErrors: 0,
    macSpeechQueued: 0, speechProvider: 'none' as 'none' | 'browser-os' | 'mac-os' | 'mac-os-on-headset',
    thinking: false, unlocked: false, speechAvailable: typeof speechSynthesis !== 'undefined' };

  /** `speechToken`: the paired device token for /api/speech when the page is not on localhost (Quest over the LAN). */
  constructor(params: URLSearchParams, private readonly speechFallback?: (text: string) => boolean | void, private readonly speechToken?: () => string | undefined) {
    this.quiet = params.get('mute') === '1';
    if (this.quiet) demoAudioMaster.forceMute(true);
    this.removeOutput = demoAudioMaster.registerOutput(volume => {
      const changed = volume !== this.volume;
      this.volume = volume;
      if (this.bus && this.context) this.bus.gain.setTargetAtTime(volume * 0.28, this.context.currentTime, 0.025);
      if (this.speechGain && this.context) this.speechGain.gain.setTargetAtTime(volume, this.context.currentTime, 0.025);
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
        this.speechGain = this.context.createGain();
        this.speechGain.gain.value = this.volume;
        this.speechGain.connect(this.context.destination);
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
    if (!this.maySpeak() || !text.trim()) return;
    const words = text.slice(0, 450);
    this.cancelSpeech();
    if (!this.stats.speechAvailable) { void this.headsetOsSpeech(words); return; }
    const utterance = this.utterance = new SpeechSynthesisUtterance(words);
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.localService && /^en/i.test(v.lang)) ?? voices.find(v => /^en/i.test(v.lang));
    if (voice) utterance.voice = voice;
    utterance.volume = this.volume; utterance.rate = 1.06; utterance.pitch = 1.15;
    utterance.onstart = () => { this.stats.speechStarted++; };
    utterance.onend = () => { this.stats.speechFinished++; if (this.utterance === utterance) this.utterance = undefined; };
    let fallbackAttempted = false;
    utterance.onerror = event => {
      this.stats.speechErrors++;
      const current = this.utterance === utterance;
      if (current) this.utterance = undefined;
      if (current && !fallbackAttempted && !['canceled', 'interrupted'].includes(event.error)) {
        fallbackAttempted = true; this.macSpeech(words);
      }
    };
    this.stats.speech++;
    this.stats.speechProvider = 'browser-os';
    try { speechSynthesis.speak(utterance); }
    catch {
      this.stats.speechErrors++; this.utterance = undefined;
      if (!fallbackAttempted) { fallbackAttempted = true; this.macSpeech(words); }
    }
  }

  private maySpeak(): boolean { return (typeof document === 'undefined' || !document.hidden) && !this.quiet && !(globalThis as { __ceMute?: boolean }).__ceMute && this.volume > 0 && demoAudioMaster.unlocked; }
  private macSpeech(text: string): void {
    if (!this.maySpeak() || !this.speechFallback) return;
    try {
      if (this.speechFallback(text) === false) return;
      // A request queued on the socket is not proof that a Mac speaker was heard.
      this.stats.macSpeechQueued++; this.stats.speechProvider = 'mac-os';
    } catch { /* Offline bridge: the Buddy's visible reaction still remains. */ }
  }

  private cancelSpeech(): void {
    const current = this.utterance;
    this.utterance = undefined;
    if (current && this.stats.speechAvailable) speechSynthesis.cancel();
    this.speechSeq++;
    const source = this.speechSource;
    this.speechSource = undefined;
    try { source?.stop(); } catch { /* already ended */ }
  }

  /** Ask the Mac to render the line with macOS `say`, then play it from the headset at the master volume. */
  private async headsetOsSpeech(text: string): Promise<void> {
    const ctx = this.context, out = this.speechGain;
    const seq = ++this.speechSeq;
    if (!ctx || !out || ctx.state !== 'running') { this.macSpeech(text); return; }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = this.speechToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch('/api/speech', { method: 'POST', headers, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      if (seq !== this.speechSeq || !this.maySpeak()) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      source.onended = () => { if (this.speechSource === source) this.speechSource = undefined; this.stats.speechFinished++; };
      this.speechSource = source;
      this.stats.speech++; this.stats.speechStarted++;
      this.stats.speechProvider = 'mac-os-on-headset';
      source.start();
    } catch {
      this.stats.speechErrors++;
      if (seq === this.speechSeq) this.macSpeech(text);
    }
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
