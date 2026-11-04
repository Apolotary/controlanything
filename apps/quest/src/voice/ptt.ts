/**
 * Push-to-talk: while held, PCM16 chunks stream to the server as `voice.audio` (to: "server"); the server
 * transcribes with muse-voice-transcribe-1.0 and answers `voice.text`. If no transcript arrives within a few
 * seconds of release, fall back to POST /api/transcribe with the whole utterance as a WAV and send the text
 * as a typed `voice.text {final: true}`.
 */
import { newId, SERVER_ID, type WorkspaceContext } from '@ce/protocol';
import { Emitter } from '../app/emitter';
import { api } from '../io/api';
import type { VoiceTextPayload } from '../io/v1';
import type { WsClient } from '../io/ws';
import { toBase64 } from '../scan/base64';
import { type Mic, TARGET_RATE } from './mic';
import { concatPcm, pcm16ToWav } from './wav';

export interface PttEvents extends Record<string, unknown> {
  listening: { listening: boolean; utteranceId?: string };
  level: number;
  text: VoiceTextPayload & { via: 'ws' | 'http' };
  error: string;
}

/** `local`: transcribe over HTTP only and hand the text to the listener; nothing is routed by the server (wiring requests). */
type VoiceContext = { cardId?: string; specId?: string; workspace?: WorkspaceContext; local?: boolean };

export class PushToTalk extends Emitter<PttEvents> {
  private current?: { id: string; seq: number; chunks: Int16Array[]; startedAt: number; context: VoiceContext };
  private awaiting = new Map<string, { chunks: Int16Array[]; timer: ReturnType<typeof setTimeout>; context: VoiceContext }>();
  private pressGeneration = 0;
  private preparing = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** wait this long after release for a WS transcript before using the HTTP fallback */
  fallbackMs = 6000;
  context: VoiceContext = {};

  constructor(
    private readonly mic: Mic,
    private readonly ws: WsClient,
    private readonly token: () => string | undefined,
    private readonly selectedContext: () => VoiceContext = () => this.context,
  ) {
    super();
    mic.on('level', (l) => this.emit('level', l));
    mic.on('chunk', ({ pcm, final, captureId }) => this.onChunk(pcm, final, captureId));
    mic.on('stopped', ({ reason }) => {
      if (!this.current && !this.preparing) return;
      this.cancel();
      this.emit('error', reason);
    });
    ws.on('voice.text', (m) => { if (m.from === SERVER_ID) this.onText(m.payload as VoiceTextPayload); });
  }

  get listening(): boolean {
    return Boolean(this.current);
  }

  get opening(): boolean { return this.preparing; }

  /** Abandon this utterance without sending a final chunk or a late HTTP fallback. */
  cancel(): void {
    clearTimeout(this.flushTimer);
    this.pressGeneration++;
    this.preparing = false;
    const current = this.current;
    this.current = undefined;
    if (current) this.mic.stop();
    for (const pending of this.awaiting.values()) clearTimeout(pending.timer);
    this.awaiting.clear();
  }

  async press(overrideContext?: VoiceContext): Promise<void> {
    if (this.current || this.preparing) return;
    const generation = ++this.pressGeneration;
    const context = structuredClone(overrideContext ?? this.selectedContext());
    this.preparing = true;
    try {
      await this.mic.prepare();
    } catch (e) {
      if (generation === this.pressGeneration) this.emit('error', `microphone: ${(e as Error).message}`);
      return;
    } finally {
      if (generation === this.pressGeneration) this.preparing = false;
    }
    if (generation !== this.pressGeneration) return;
    this.current = { id: newId('u'), seq: 0, chunks: [], startedAt: performance.now(), context };
    this.mic.start(this.current.id);
    this.emit('listening', { listening: true, utteranceId: this.current.id });
  }

  release(): void {
    this.pressGeneration++;
    this.preparing = false;
    if (!this.current) return;
    const id = this.current.id;
    this.mic.stop(); // the worklet flushes a final chunk
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (this.current?.id !== id) return;
      this.cancel();
      this.emit('error', 'Microphone did not finish recording. Enable Camera + mic and try again.');
    }, 1500);
  }

  private onChunk(pcm: Int16Array, final: boolean, captureId?: string): void {
    const u = this.current;
    if (!u || captureId && captureId !== u.id) return;
    if (final) clearTimeout(this.flushTimer);
    u.chunks.push(pcm);
    if (final && u.chunks.reduce((a, c) => a + c.length, 0) < TARGET_RATE * 0.25) {
      this.current = undefined;
      this.emit('listening', { listening: false, utteranceId: u.id });
      this.emit('error', 'Too short. Tap Ask Muse, speak, then tap Send.');
      return;
    }
    if (!u.context.local) {
      const payload: Record<string, unknown> = { utteranceId: u.id, seq: u.seq++, sampleRate: TARGET_RATE, pcm16: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) };
      if (final) payload.final = true;
      if (u.context.cardId) payload.cardId = u.context.cardId;
      if (u.context.specId) payload.specId = u.context.specId;
      if (u.context.workspace) payload.workspace = u.context.workspace;
      this.ws.send('voice.audio', payload, { to: 'server' });
    }
    if (final) {
      this.current = undefined;
      this.emit('listening', { listening: false, utteranceId: u.id });
      const timer = setTimeout(() => void this.fallback(u.id), u.context.local ? 0 : this.fallbackMs);
      this.awaiting.set(u.id, { chunks: u.chunks, timer, context: u.context });
    }
  }

  private onText(p: VoiceTextPayload): void {
    if (p.utteranceId && this.awaiting.has(p.utteranceId) && p.final) {
      clearTimeout(this.awaiting.get(p.utteranceId)!.timer);
      this.awaiting.delete(p.utteranceId);
    }
    this.emit('text', { ...p, via: 'ws' });
  }

  private async fallback(utteranceId: string): Promise<void> {
    const a = this.awaiting.get(utteranceId);
    if (!a) return;
    try {
      const wav = pcm16ToWav(concatPcm(a.chunks), TARGET_RATE);
      const r = await api.transcribe(wav, this.token());
      if (this.awaiting.get(utteranceId) !== a) return;
      this.awaiting.delete(utteranceId);
      const text = r.text?.trim() ?? '';
      if (!text) {
        this.emit('error', 'No speech heard. Tap Ask Muse and try again.');
        return;
      }
      this.emit('text', { utteranceId, text, final: true, modelId: r.model, ...a.context, via: 'http' });
      if (text && !a.context.local) {
        const payload: Record<string, unknown> = { utteranceId, text, final: true };
        if (a.context.cardId) payload.cardId = a.context.cardId;
        if (a.context.specId) payload.specId = a.context.specId;
        if (a.context.workspace) payload.workspace = a.context.workspace;
        this.ws.send('voice.text', payload, { to: 'server' });
      }
    } catch (e) {
      if (this.awaiting.get(utteranceId) !== a) return;
      this.awaiting.delete(utteranceId);
      this.emit('error', `transcribe: ${(e as Error).message}`);
    }
  }
}
