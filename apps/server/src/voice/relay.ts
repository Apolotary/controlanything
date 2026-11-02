/**
 * Voice: PCM16 chunks from a client (voice.audio, push-to-talk) are assembled into a WAV and transcribed by
 * Muse Voice Transcribe on the server (the key never leaves it); the transcript goes back as voice.text and
 * is routed: panic / undo / scan / a hack by name / an edit of the current spec ("make resonance a big red lever").
 * Typed voice.text from a client takes the same route.
 */
import { newId, type VoiceAudioPayload, type VoiceTextPayload } from '@ce/protocol';
import type { Hub } from '../hub';
import type { Transcriber } from '../muse/transcribe';

export type Intent = NonNullable<VoiceTextPayload['intent']>;

export interface VoiceActions {
  panic(reason: string): void;
  undo(cardId?: string): boolean;
  /** run a hack by name on the most relevant target; true when one matched */
  hack(text: string, cardId?: string): boolean;
  edit(instruction: string, specId?: string, cardId?: string): Promise<boolean>;
  scan(): void;
  /** the spec a cardId maps to, or the most recent one */
  specFor(cardId?: string): string | undefined;
}

export interface VoiceDeps {
  hub: Pick<Hub, 'broadcast'>;
  transcriber: Transcriber;
  actions: VoiceActions;
  log?: (line: string) => void;
  maxUtteranceBytes?: number;
}

/** Mono 16-bit PCM WAV from raw PCM16LE bytes. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + pcm.length, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(pcm.length, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(b, 44);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/** "cut off" -> "cutoff", "seventy percent" -> 70 etc. are left to the forge; here only the intent words. */
export function classify(text: string): Intent {
  const t = text.toLowerCase().trim();
  if (/\b(stop everything|panic|emergency stop|kill it)\b/.test(t)) return 'panic';
  if (/^(undo|revert|go back)\b/.test(t) || /\bundo\b/.test(t)) return 'undo';
  if (/^(scan|look around|rescan)\b/.test(t)) return 'scan';
  if (/\b(what|which|how|why|is it|does it|can you)\b.*\?$/.test(t) || /^(what|which|how|why)\b/.test(t)) return 'question';
  if (/\b(make|change|turn .* into|bigger|smaller|larger|red|blue|green|lever|knob|slider|ring|move|rename|add|remove|replace|swap)\b/.test(t)) return 'edit';
  return 'hack';
}

interface Utterance {
  chunks: Map<number, Uint8Array>;
  sampleRate: number;
  bytes: number;
  cardId?: string;
  specId?: string;
  startedAt: number;
}

export class VoiceRelay {
  private readonly utterances = new Map<string, Utterance>();
  private readonly transcribing = new Set<string>();
  private readonly completed = new Map<string, { at: number; result: VoiceTextPayload }>();
  private readonly log: (line: string) => void;

  constructor(private readonly d: VoiceDeps) {
    this.log = d.log ?? (() => {});
  }

  async onAudio(p: VoiceAudioPayload, sender: string): Promise<VoiceTextPayload | undefined> {
    const key = this.key(sender, p.utteranceId);
    const completed = this.completed.get(key);
    if (completed || this.transcribing.has(key)) return completed?.result;
    let u = this.utterances.get(key);
    if (!u) {
      u = { chunks: new Map(), sampleRate: p.sampleRate, bytes: 0, cardId: p.cardId, specId: p.specId, startedAt: Date.now() };
      this.utterances.set(key, u);
      if (this.utterances.size > 8) this.utterances.delete(this.utterances.keys().next().value!);
    }
    const bytes = Buffer.from(p.pcm16, 'base64');
    if (u.bytes + bytes.length <= (this.d.maxUtteranceBytes ?? 4_000_000)) {
      u.chunks.set(p.seq, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      u.bytes += bytes.length;
    }
    if (!p.final) return undefined;
    this.utterances.delete(key);
    this.transcribing.add(key);
    const ordered = [...u.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const pcm = Buffer.concat(ordered);
    const started = Date.now();
    try {
      const r = await this.d.transcriber.transcribe(wavFromPcm16(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), u.sampleRate));
      const out: VoiceTextPayload = { utteranceId: p.utteranceId, text: r.text, final: true, source: r.source, modelId: r.model, latencyMs: Date.now() - started, cardId: u.cardId, specId: u.specId };
      return this.route(out, key);
    } catch (e) {
      const completed = this.completed.get(key);
      if (completed) return completed.result;
      const out: VoiceTextPayload = { utteranceId: p.utteranceId, text: '', final: true, intent: 'none', latencyMs: Date.now() - started };
      this.log(`[voice] transcription failed: ${(e as Error).message}`);
      this.d.hub.broadcast('voice.text', out);
      return out;
    } finally {
      this.transcribing.delete(key);
    }
  }

  /** A typed command (or the transcript): decide what it means and do it. */
  async onText(p: VoiceTextPayload, sender: string): Promise<VoiceTextPayload> {
    if (!p.final) {
      this.d.hub.broadcast('voice.text', p);
      return p;
    }
    return this.route({ ...p }, this.key(sender, p.utteranceId));
  }

  private key(sender: string, utteranceId?: string): string {
    const now = Date.now();
    for (const [key, value] of this.completed) if (now - value.at > 10 * 60_000) this.completed.delete(key);
    return JSON.stringify([sender, utteranceId ?? newId('voice-')]);
  }

  private async route(out: VoiceTextPayload, key: string): Promise<VoiceTextPayload> {
    const previous = this.completed.get(key);
    if (previous) return previous.result;
    // Claim before any action: HTTP fallback and socket transcription race on this key.
    this.completed.set(key, { at: Date.now(), result: out });
    if (this.completed.size > 1024) this.completed.delete(this.completed.keys().next().value!);
    const text = out.text.trim();
    let intent: Intent = text ? classify(text) : 'none';
    const a = this.d.actions;
    if (intent === 'panic') a.panic(`voice: "${text}"`);
    else if (intent === 'undo') {
      if (!a.undo(out.cardId)) intent = 'none';
    } else if (intent === 'scan') a.scan();
    else if (intent === 'hack') {
      if (!a.hack(text, out.cardId)) intent = a.specFor(out.cardId) ? 'edit' : 'none';
    }
    if (intent === 'edit') {
      const specId = out.specId ?? a.specFor(out.cardId);
      if (!specId) intent = 'none';
      else {
        out.specId = specId;
        void a.edit(text, specId, out.cardId).catch((e) => this.log(`[voice] edit failed: ${(e as Error).message}`));
      }
    }
    out.intent = intent;
    this.d.hub.broadcast('voice.text', out);
    return out;
  }
}
