/**
 * Push-to-talk: while held, PCM16 chunks stream to the server as `voice.audio` (to: "server"); the server
 * transcribes with muse-voice-transcribe-1.0 and answers `voice.text`. If no transcript arrives within a few
 * seconds of release, fall back to POST /api/transcribe with the whole utterance as a WAV and send the text
 * as a typed `voice.text {final: true}`.
 */
import { newId } from '@ce/protocol';
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
  text: { utteranceId?: string; text: string; final: boolean; modelId?: string; via: 'ws' | 'http' };
  error: string;
}

export class PushToTalk extends Emitter<PttEvents> {
  private current?: { id: string; seq: number; chunks: Int16Array[]; startedAt: number };
  private awaiting = new Map<string, { chunks: Int16Array[]; timer: ReturnType<typeof setTimeout> }>();
  /** wait this long after release for a WS transcript before using the HTTP fallback */
  fallbackMs = 6000;
  context: { cardId?: string; specId?: string } = {};

  constructor(
    private readonly mic: Mic,
    private readonly ws: WsClient,
    private readonly token: () => string | undefined,
  ) {
    super();
    mic.on('level', (l) => this.emit('level', l));
    mic.on('chunk', ({ pcm, final }) => this.onChunk(pcm, final));
    ws.on('voice.text', (m) => this.onText(m.payload as VoiceTextPayload));
  }

  get listening(): boolean {
    return Boolean(this.current);
  }

  async press(): Promise<void> {
    if (this.current) return;
    try {
      await this.mic.prepare();
    } catch (e) {
      this.emit('error', `microphone: ${(e as Error).message}`);
      return;
    }
    this.current = { id: newId('u'), seq: 0, chunks: [], startedAt: performance.now() };
    this.mic.start();
    this.emit('listening', { listening: true, utteranceId: this.current.id });
  }

  release(): void {
    if (!this.current) return;
    this.mic.stop(); // the worklet flushes a final chunk
  }

  private onChunk(pcm: Int16Array, final: boolean): void {
    const u = this.current;
    if (!u) return;
    u.chunks.push(pcm);
    const payload: Record<string, unknown> = { utteranceId: u.id, seq: u.seq++, sampleRate: TARGET_RATE, pcm16: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) };
    if (final) payload.final = true;
    if (this.context.cardId) payload.cardId = this.context.cardId;
    if (this.context.specId) payload.specId = this.context.specId;
    this.ws.send('voice.audio', payload, { to: 'server' });
    if (final) {
      this.current = undefined;
      this.emit('listening', { listening: false, utteranceId: u.id });
      const samples = u.chunks.reduce((a, c) => a + c.length, 0);
      if (samples < TARGET_RATE * 0.25) {
        this.emit('error', 'too short; hold the mic key while you speak');
        return;
      }
      const timer = setTimeout(() => void this.fallback(u.id), this.fallbackMs);
      this.awaiting.set(u.id, { chunks: u.chunks, timer });
    }
  }

  private onText(p: VoiceTextPayload): void {
    if (p.utteranceId && this.awaiting.has(p.utteranceId) && p.final) {
      clearTimeout(this.awaiting.get(p.utteranceId)!.timer);
      this.awaiting.delete(p.utteranceId);
    }
    this.emit('text', { utteranceId: p.utteranceId, text: p.text, final: p.final, modelId: p.modelId, via: 'ws' });
  }

  private async fallback(utteranceId: string): Promise<void> {
    const a = this.awaiting.get(utteranceId);
    if (!a) return;
    this.awaiting.delete(utteranceId);
    try {
      const wav = pcm16ToWav(concatPcm(a.chunks), TARGET_RATE);
      const r = await api.transcribe(wav, this.token());
      const text = r.text?.trim() ?? '';
      this.emit('text', { utteranceId, text, final: true, modelId: r.model, via: 'http' });
      if (text) {
        const payload: Record<string, unknown> = { utteranceId, text, final: true };
        if (this.context.cardId) payload.cardId = this.context.cardId;
        if (this.context.specId) payload.specId = this.context.specId;
        this.ws.send('voice.text', payload, { to: 'server' });
      }
    } catch (e) {
      this.emit('error', `transcribe: ${(e as Error).message}`);
    }
  }
}
