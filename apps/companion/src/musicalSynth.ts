import type { ExecAckPayload, ExecCommandPayload, Port } from '@ce/protocol';
import { MusicalSynth } from '@ce/vsynth/musical';
import { MUSICAL_SCALE, MUSICAL_SYNTH_NAME, MUSICAL_SYNTH_PORT_ID } from '@ce/vsynth/musical-manifest';
import { checkMidiOp } from './contracts';
import { generatedMidiPacket } from './generatedMidi';
import { showCode } from './ui/wiring-view';
import type { WiringOverlayView } from './visualLauncher';
import type { WiringPhase } from './ui/wiring';
import './musicalSynth.css';

export const isMusicalPort = (port?: string): boolean => port === MUSICAL_SYNTH_PORT_ID || port === MUSICAL_SYNTH_NAME;
const noteName = (midi: number) => `${['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][midi % 12]}${Math.floor(midi / 12) - 1}`;

/** Device readiness is separate from an accepted program; no Mac signal proves the Quest Worker is running. */
export function musicalStageText(soundOn: boolean, phase?: WiringPhase): { status: string; readout: string } {
  if (!soundOn) return { status: 'Sound off · choose Sound on on this Mac to enable device checks. Then ask Muse in Quest.', readout: 'Sound is off' };
  if (phase === 'writing') return { status: 'Muse is writing your requested hand wiring · wait in Quest', readout: 'Muse is writing…' };
  if (phase && ['validating', 'dry-run', 'verifying'].includes(phase)) return { status: 'Checking the requested wiring · wait for the result in Quest', readout: 'Checking your wiring…' };
  if (phase === 'stopped') return { status: 'Wiring stopped · ask Muse again in Quest', readout: 'Stopped · ask Muse again' };
  if (phase === 'failed') return { status: 'Wiring did not finish · retry your request in Quest', readout: 'Try your request again' };
  if (phase === 'ready') return { status: 'Wiring ready · follow Muse’s gesture instructions in Quest', readout: 'Follow your Quest instructions' };
  return { status: 'Sound on · complete device checks in Quest, then ask Muse to wire your hands', readout: 'Ask Muse in Quest' };
}

/** Own browser-only virtual instrument; never forwards a command to Web MIDI. */
export class MusicalSynthPanel {
  private readonly synth: MusicalSynth;
  private panel?: HTMLElement;
  private status?: HTMLElement;
  private sound?: HTMLButtonElement;
  private note?: HTMLElement;
  private keys: HTMLElement[] = [];
  private level?: HTMLMeterElement;
  private codeHead?: HTMLElement;
  private codePre?: HTMLElement;
  private codeView?: WiringOverlayView;
  private shownCode = '';
  private timer?: ReturnType<typeof setInterval>;
  private unlocking = false;
  private error = '';
  private published = false;
  private readonly visibility = () => this.update();
  constructor(private readonly options: { connected(): boolean; changed(): void; muted?: boolean }) {
    this.synth = new MusicalSynth({ muted: options.muted, changed: () => { this.render(); this.notify(); } });
  }
  get opened(): boolean { return !!this.panel; }
  get available(): boolean { return this.opened && this.synth.enabled && !document.hidden && this.options.connected(); }
  port(): Port { return { id: MUSICAL_SYNTH_PORT_ID, name: MUSICAL_SYNTH_NAME, manufacturer: 'ControlAnything', kind: 'midi-out', state: this.available ? 'connected' : 'disconnected' }; }
  open(): void {
    if (this.panel) { this.render(); return; }
    const panel = document.createElement('section'); panel.id = 'musical-launcher'; panel.setAttribute('aria-label', MUSICAL_SYNTH_NAME);
    const header = document.createElement('header'), title = document.createElement('h1'); title.textContent = MUSICAL_SYNTH_NAME;
    const close = document.createElement('button'); close.id = 'musical-close'; close.type = 'button'; close.textContent = 'Back to companion'; close.onclick = () => this.close();
    header.append(title, close);
    const body = document.createElement('div'); body.className = 'musical-body';
    const caption = document.createElement('p'); caption.textContent = 'Ask Muse to write how your hands play this instrument. C minor · two octaves · three sound presets.';
    const sound = this.sound = document.createElement('button'); sound.type = 'button'; sound.id = 'musical-sound-toggle';
    sound.onclick = () => { if (this.synth.enabled) this.panic(); else void this.unlock(); };
    const status = this.status = document.createElement('p'); status.id = 'musical-status'; status.setAttribute('role', 'status');
    const note = this.note = document.createElement('div'); note.id = 'musical-note';
    const level = this.level = document.createElement('meter'); level.min = 0; level.max = 1; level.setAttribute('aria-label', 'Software instrument signal level');
    const keyboard = document.createElement('div'); keyboard.className = 'musical-keys'; this.keys = [];
    for (const midi of MUSICAL_SCALE) { const key = document.createElement('span'); key.textContent = noteName(midi); keyboard.append(key); this.keys.push(key); }
    body.append(caption, sound, status, note, level, keyboard);
    const code = document.createElement('aside'); code.id = 'musical-code';
    this.codeHead = document.createElement('p'); this.codePre = document.createElement('pre'); code.append(this.codeHead, this.codePre);
    panel.append(header, body, code); document.body.append(panel); this.panel = panel;
    document.addEventListener('visibilitychange', this.visibility);
    this.timer = setInterval(() => { this.render(); this.notify(); }, 200);
    this.update();
  }
  private async unlock(): Promise<void> {
    if (this.unlocking || !this.panel || !this.options.connected() || document.hidden) return;
    this.error = ''; this.unlocking = true; this.render();
    try { if (!await this.synth.unlock()) this.error = 'Chrome did not enable audio. Keep this tab visible and choose Sound on again.'; }
    catch { this.synth.lock(); this.error = 'Audio could not start in this browser. Use the paired Chrome tab and try Sound on again.'; }
    finally {
      this.unlocking = false;
      if (!this.panel || document.hidden || !this.options.connected()) this.synth.lock();
      this.render(); this.notify();
    }
  }
  update(): void {
    if (!this.panel) return;
    // Also cancel a pending resume or interrupted context: enabled is false in both states.
    if (document.hidden || !this.options.connected()) this.synth.lock();
    this.render(); this.notify();
  }
  close(): void {
    this.synth.lock(); clearInterval(this.timer); this.timer = undefined;
    if (!this.panel) return;
    document.removeEventListener('visibilitychange', this.visibility);
    this.panel?.remove(); this.panel = undefined; this.status = this.note = undefined; this.sound = undefined;
    this.level = undefined; this.keys = []; this.codeHead = this.codePre = undefined; this.shownCode = '';
    this.notify();
  }
  private notify(): void {
    const available = this.available;
    if (available === this.published) return;
    this.published = available; this.options.changed();
  }
  panic(): void { this.synth.lock(); }
  snapshot() {
    const receipt = this.synth.receipt();
    return { opened: this.opened, available: this.available, enabled: this.synth.enabled, muted: !!this.options.muted,
      ...this.synth.clock,
      masterGain: this.synth.masterGain, state: receipt.params,
      analyser: { rms: receipt.audio.rms, peak: receipt.audio.peak, frequency: receipt.audio.frequency, currentNote: receipt.audio.activeNote }, frame: receipt.frame };
  }
  setWiring(view: WiringOverlayView | undefined): void { this.codeView = view; this.renderCode(); }
  private renderCode(): void {
    if (!this.codeHead || !this.codePre) return;
    const view = this.codeView;
    const heading = view ? `${view.heading} · ${view.phase}` : 'No hand wiring yet · ask Muse in Quest';
    if (this.codeHead.textContent !== heading) this.codeHead.textContent = heading;
    this.shownCode = showCode(this.codePre, this.shownCode, view?.code ?? '');
    this.codePre.hidden = !view?.code;
  }
  private render(): void {
    if (!this.panel || !this.status || !this.sound || !this.note) return;
    const receipt = this.synth.receipt(), enabled = this.synth.enabled;
    const text = (node: HTMLElement, value: string) => { if (node.textContent !== value) node.textContent = value; };
    text(this.sound, this.unlocking ? 'Enabling sound…' : enabled ? 'Sound off' : 'Sound on');
    this.sound.disabled = this.unlocking || !this.options.connected();
    this.sound.setAttribute('aria-pressed', String(enabled));
    const stage = musicalStageText(enabled, this.codeView?.phase);
    const status = this.error || (!this.options.connected() ? 'Reconnect this paired companion before enabling sound.' : stage.status);
    text(this.status, status + (this.options.muted ? ' · Test output is muted' : ''));
    text(this.note, this.unlocking ? 'Starting the instrument…' : enabled && this.codeView?.phase === 'ready' && receipt.audio.activeNote !== undefined
      ? `${noteName(receipt.audio.activeNote)} · ${receipt.audio.frequency.toFixed(0)} Hz` : stage.readout);
    if (this.level) this.level.value = Math.min(1, receipt.audio.rms * 3);
    this.keys.forEach((key, i) => key.classList.toggle('active', receipt.audio.activeNote === MUSICAL_SCALE[i]));
    this.renderCode();
  }
  async execute(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => ({ execId: cmd.execId, ok, sentAt: Date.now(), ...extra });
    if (cmd.op.kind !== 'midi' || !isMusicalPort(cmd.port)) return ack(false, { error: 'no_port' });
    const op = cmd.op, error = checkMidiOp(op);
    if (error || op.channel !== 1) return ack(false, { error: 'bad_args', detail: error ?? 'Musical synth listens on channel 1' });
    const generated = generatedMidiPacket(cmd, MUSICAL_SYNTH_PORT_ID);
    if (generated && !generated.ok) return ack(false, { error: 'refused', detail: generated.error });
    if (cmd.dryRun) return ack(true, { detail: 'dry run; no sound or state change' });
    if (op.msg === 'panic') { this.panic(); return ack(true); }
    if (!this.available) return ack(false, { error: 'no_port', detail: 'Open Musical synth and choose Sound on in this paired Mac companion.' });
    if (op.msg === 'sysex-identity') return ack(true, { reply: [0xf0, 0x7e, 0, 6, 2, 0x7d, 0, 2, 0, 0, 1, 0, 0, 0, 0xf7] });
    if (op.msg !== 'cc' && op.msg !== 'pc') return ack(false, { error: 'unsupported', detail: 'Use the declared scale-note and gate CC actions.' });
    const bytes = generated?.ok ? generated.bytes : op.msg === 'cc' ? [0xb0, op.number!, op.value as number] : [0xc0, op.number!];
    if (!this.synth.receiveMidi(bytes)) return ack(false, { error: 'bad_args', detail: 'Unknown musical parameter or value' });
    // Initial attack/pitch changes need an actual audio quantum before a receipt.
    if (bytes[0] === 0xb0 && [16, 17].includes(bytes[1]!)) await new Promise(resolve => setTimeout(resolve, 70));
    const receipt = this.synth.receipt();
    return ack(true, { detail: 'Applied by browser software instrument; analyser measures the graph before output mute' + (generated?.ok ? ` · ${generated.receipt}` : ''),
      applied: { source: 'musical-synth', params: receipt.params, audio: receipt.audio, visible: !document.hidden, frame: receipt.frame, at: receipt.at } });
  }
}
