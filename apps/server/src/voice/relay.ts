import { workspaceScopeIssue } from './workspace-context';
/**
 * Voice: PCM16 chunks from a client (voice.audio, push-to-talk) are assembled into a WAV and transcribed by
 * Muse Voice Transcribe on the server (the key never leaves it); the transcript goes back as voice.text and
 * is routed: panic / undo / scan / a hack by name / an edit of the current spec ("make resonance a big red lever").
 * Typed voice.text from a client takes the same route.
 */
import { newId, type VoiceAudioPayload, type VoiceTextPayload, type WorkspaceContext } from '@ce/protocol';
import type { Hub } from '../hub';
import type { Transcriber } from '../muse/transcribe';
import { GENERAL_ASSISTANT_CARD } from '../agent/connected-peripheral';

export type Intent = NonNullable<VoiceTextPayload['intent']>;

export interface VoiceActions {
  panic(reason: string): void;
  undo(cardId?: string): boolean;
  /** run a hack by name on the most relevant target; true when one matched */
  hack(text: string, cardId?: string): boolean;
  edit(instruction: string, specId?: string, cardId?: string, signal?: AbortSignal): Promise<boolean>;
  scan(): void;
  /** the spec a cardId maps to, or the most recent one */
  specFor(cardId?: string): string | undefined;
  /** A selected software canvas makes undo a preview/history request, never a physical command. */
  canvasFor?(cardId?: string): boolean;
  /** Current server identity/spec revision check, including shortcuts. Never blocks emergency Stop. */
  workspaceIssue?(input: VoiceTextPayload): string | undefined;
  /** Selected-device conversation; absent only in legacy/simple harnesses. */
  assist?(input: VoiceTextPayload, sender: string): Promise<VoiceTextPayload>;
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
  // These shortcuts execute before Muse interprets the request. Match complete commands,
  // never quoted keywords or factual questions such as "How does undo work?".
  const command = t.replace(/[.!]+$/, '');
  if (/^(?:please\s+)?(?:stop everything|stop all (?:device )?controls|panic|emergency stop|kill it)(?:\s+(?:now|please))?$/.test(command)) return 'panic';
  if (/^(?:please\s+)?(?:(?:undo|revert)(?:\s+(?:it|that|this|(?:the\s+)?last\s+(?:action|change|command)))?|go back)(?:\s+(?:now|please))?$/.test(command)) return 'undo';
  if (/^(?:please\s+)?(?:scan|look around|rescan)(?:\s+(?:the room|again|now|please))?$/.test(command)) return 'scan';
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
  workspace?: WorkspaceContext;
  startedAt: number;
  epoch: number;
}

export class VoiceRelay {
  private readonly utterances = new Map<string, Utterance>();
  private readonly transcribing = new Set<string>();
  private readonly inFlight = new Map<string, {cardId?: string}>();
  private readonly cancelled = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private readonly completed = new Map<string, { at: number; result: VoiceTextPayload }>();
  private readonly log: (line: string) => void;

  constructor(private readonly d: VoiceDeps) {
    this.log = d.log ?? (() => {});
  }

  async onAudio(p: VoiceAudioPayload, sender: string): Promise<VoiceTextPayload | undefined> {
    const key = this.key(sender, p.utteranceId);
    const completed = this.completed.get(key);
    if (completed || this.transcribing.has(key) || this.cancelled.has(key)) return completed?.result;
    let u = this.utterances.get(key);
    if (!u) {
      u = { chunks: new Map(), sampleRate: p.sampleRate, bytes: 0, cardId: p.cardId, specId: p.specId, ...(p.workspace ? { workspace: structuredClone(p.workspace) } : {}), startedAt: Date.now(), epoch: this.epoch(sender, p.cardId) };
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
    this.inFlight.set(key, { cardId: u.cardId });
    const ordered = [...u.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const pcm = Buffer.concat(ordered);
    const started = Date.now();
    try {
      const r = await this.d.transcriber.transcribe(wavFromPcm16(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), u.sampleRate));
      const out: VoiceTextPayload = { utteranceId: p.utteranceId, text: r.text, final: true, source: r.source, modelId: r.model, latencyMs: Date.now() - started, cardId: u.cardId, specId: u.specId, ...(u.workspace ? { workspace: u.workspace } : {}) };
      if (u.epoch !== this.epoch(sender, u.cardId) || this.cancelled.has(key)) return undefined;
      return this.route(out, key, sender);
    } catch (e) {
      if (u.epoch !== this.epoch(sender, u.cardId) || this.cancelled.has(key)) return undefined;
      const completed = this.completed.get(key);
      if (completed) return completed.result;
      const out: VoiceTextPayload = { utteranceId: p.utteranceId, cardId: u.cardId, specId: u.specId, text: '', final: true, recipientId: sender, assistant: {state: 'error', text: 'Transcription failed. Try again or type your request.'}, intent: 'none', latencyMs: Date.now() - started };
      this.log(`[voice] transcription failed: ${(e as Error).message}`);
      this.d.hub.broadcast('voice.text', out);
      return out;
    } finally {
      this.transcribing.delete(key);
      this.inFlight.delete(key);
    }
  }

  /** A typed command (or the transcript): decide what it means and do it. */
  async onText(p: VoiceTextPayload, sender: string): Promise<VoiceTextPayload> {
    // Assistant state, routing and provenance belong to the server, never to a client claim.
    const clean: VoiceTextPayload = { utteranceId: p.utteranceId, text: p.text, final: p.final, cardId: p.cardId, specId: p.specId, ...(p.workspace ? { workspace: structuredClone(p.workspace) } : {}) };
    if (!p.final) {
      this.d.hub.broadcast('voice.text', { ...clean, recipientId: sender });
      return clean;
    }
    return this.route(clean, this.key(sender, p.utteranceId), sender);
  }

  private epoch(sender: string, cardId?: string): number { return this.epochs.get(JSON.stringify([sender, cardId])) ?? 0; }
  cancel(sender: string, cardId: string, utteranceId?: string): void {
    if (utteranceId) this.cancelled.add(this.key(sender, utteranceId));
    else {
      const k = JSON.stringify([sender, cardId]);
      this.epochs.set(k, this.epoch(sender, cardId) + 1);
    }
    for (const [k, u] of this.utterances) if (JSON.parse(k)[0] === sender && u.cardId === cardId && (!utteranceId || JSON.parse(k)[1] === utteranceId)) {
      this.cancelled.add(k); this.utterances.delete(k);
    }
    this.pruneCancelled();
  }

  private pruneCancelled(): void {
    while (this.cancelled.size > 1024) this.cancelled.delete(this.cancelled.values().next().value!);
  }

  disconnect(sender: string): void {
    for (const [k] of [...this.utterances, ...this.inFlight]) if (JSON.parse(k)[0] === sender) {
      this.cancelled.add(k); this.utterances.delete(k);
    }
    this.pruneCancelled();
  }

  invalidate(cardId?: string): void {
    for (const [k, u] of [...this.utterances, ...this.inFlight]) if (!cardId || u.cardId === cardId) {
      this.cancelled.add(k); this.utterances.delete(k);
    }
    this.pruneCancelled();
  }

  private key(sender: string, utteranceId?: string): string {
    const now = Date.now();
    for (const [key, value] of this.completed) if (now - value.at > 10 * 60_000) this.completed.delete(key);
    return JSON.stringify([sender, utteranceId ?? newId('voice-')]);
  }

  private async route(out: VoiceTextPayload, key: string, sender: string): Promise<VoiceTextPayload> {
    if (this.cancelled.has(key)) return out;
    const previous = this.completed.get(key);
    if (previous) return previous.result;
    // Claim before any action: HTTP fallback and socket transcription race on this key.
    this.completed.set(key, { at: Date.now(), result: out });
    if (this.completed.size > 1024) this.completed.delete(this.completed.keys().next().value!);
    const text = out.text.trim();
    let intent: Intent = text ? classify(text) : 'none';
    const scopeIssue = workspaceScopeIssue(out) ?? this.d.actions.workspaceIssue?.(out);
    if (scopeIssue && intent !== 'panic') {
      out.intent = 'none'; out.recipientId = sender; out.assistant = { state: 'error', text: scopeIssue };
      this.d.hub.broadcast('voice.text', out);
      return out;
    }
    // General chat has no selected target. In particular, a synthetic general card
    // must never reach legacy undo's fallback to the most recent room action.
    if (out.cardId === GENERAL_ASSISTANT_CARD && intent !== 'panic') intent = 'question';
    const a = this.d.actions;
    if (this.d.actions.assist && intent !== 'panic' && intent !== 'scan' && (intent !== 'undo' || a.canvasFor?.(out.cardId))) {
      const result = await this.d.actions.assist(out, sender);
      this.completed.set(key, { at: Date.now(), result });
      return result;
    }
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
    if (this.d.actions.assist) {
      out.recipientId = sender;
      out.assistant = { state: 'reply', text: intent === 'panic' ? 'Stopped device controls.' : intent === 'undo' ? 'Undid the last action.' : intent === 'scan' ? 'Scan requested.' : 'There is nothing to undo for this device.' };
    }
    this.d.hub.broadcast('voice.text', out);
    return out;
  }
}
