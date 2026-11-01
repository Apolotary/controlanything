/**
 * IDENTIFY: Muse Spark reads the SAM crop (detail high) with the whole frame for context (detail low) and
 * fills a DeviceCard with json_schema at effort >= low (minimal hallucinated a product on an unbranded synth,
 * research/03 §4.1). The identification is a hypothesis until a port name, an identity reply or a verified
 * code agrees with it.
 */
import { type DeviceCardPayload, DeviceCardPayload as DeviceCardSchema, newId } from '@ce/protocol';
import { z } from 'zod';
import { type ChatMessage, imagePart, type MuseChat } from '../muse/adapter';
import { type DecodedImage, encodeJpeg } from '../oracle/image';
import type { TargetDetection } from './types';

/** What the model writes (ids and frame references are the server's). */
export const DeviceCardDraft = DeviceCardSchema.omit({ cardId: true, snapshotId: true, frameId: true, detId: true, bbox: true, source: true, modelId: true });
export type DeviceCardDraft = z.infer<typeof DeviceCardDraft>;

export const IDENTIFY_SYSTEM =
  'You identify ONE physical device for an agent that will control it. The first image is a tight crop of the device; the second is the whole scene for context. ' +
  'Fill the DeviceCard: maker and model only when legible text or an unmistakable design supports them (quote the text in evidence), otherwise write "unknown" and keep confidence low. ' +
  'Never identify, describe or mention people. `requires` lists the client capabilities needed to control it: ["midi"] for a USB-MIDI instrument, ["ir"] for anything driven by an infrared remote (ceiling lights, air conditioners, TVs), ["local"] for a computer or phone. ' +
  'alternatives: other plausible identifications. followUp: what to photograph to be sure (a label, the ports).';

/** Crop with ~2% padding, as JPEG base64. */
export function cropJpeg(img: DecodedImage, box: readonly number[], pad = 0.02): string {
  const px = Math.round(box[2] * pad);
  const py = Math.round(box[3] * pad);
  const x0 = Math.max(0, Math.floor(box[0] - px));
  const y0 = Math.max(0, Math.floor(box[1] - py));
  const x1 = Math.min(img.width, Math.ceil(box[0] + box[2] + px));
  const y1 = Math.min(img.height, Math.ceil(box[1] + box[3] + py));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return Buffer.from(encodeJpeg({ width: w, height: h, data }, 88)).toString('base64');
}

export interface SkinCropImage {
  /** base64 JPEG, no data: prefix */
  jpegBase64: string;
  width: number;
  height: number;
}

/**
 * The crop Muse Image paints a panel skin from (FORGE): the SAM box padded ~10 %, clamped to the frame and
 * box-filtered down so the long edge is at most 1024 px. Pure; the frame stays untouched.
 */
export function cropForSkin(img: DecodedImage, box: readonly number[], opts: { pad?: number; maxEdge?: number; quality?: number } = {}): SkinCropImage {
  const pad = opts.pad ?? 0.1;
  const maxEdge = opts.maxEdge ?? 1024;
  const px = Math.round(box[2] * pad);
  const py = Math.round(box[3] * pad);
  const x0 = Math.max(0, Math.floor(box[0] - px));
  const y0 = Math.max(0, Math.floor(box[1] - py));
  const x1 = Math.min(img.width, Math.ceil(box[0] + box[2] + px));
  const y1 = Math.min(img.height, Math.ceil(box[1] + box[3] + py));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const data = new Uint8Array(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    const sy0 = y0 + Math.floor((oy / oh) * h);
    const sy1 = Math.min(y0 + h, Math.max(sy0 + 1, y0 + Math.floor(((oy + 1) / oh) * h)));
    for (let ox = 0; ox < ow; ox++) {
      const sx0 = x0 + Math.floor((ox / ow) * w);
      const sx1 = Math.min(x0 + w, Math.max(sx0 + 1, x0 + Math.floor(((ox + 1) / ow) * w)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        let i = (y * img.width + sx0) * 4;
        for (let x = sx0; x < sx1; x++, i += 4) {
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
      data[o + 3] = 255;
    }
  }
  return { jpegBase64: Buffer.from(encodeJpeg({ width: ow, height: oh, data }, opts.quality ?? 88)).toString('base64'), width: ow, height: oh };
}

export function identifyMessages(det: Pick<TargetDetection, 'label' | 'prompt' | 'score' | 'width' | 'height' | 'box'>, cropB64: string, frameB64: string, userText?: string): ChatMessage[] {
  const context = [
    `SAM 3.1 found this object with the concept "${det.prompt}" (label "${det.label}", confidence ${det.score.toFixed(2)}) in a ${det.width}x${det.height} passthrough frame; box ${det.box.map(Math.round).join(',')} (x,y,w,h).`,
    userText ? `The user said: "${userText}".` : '',
    'Identify it and fill the DeviceCard.',
  ]
    .filter(Boolean)
    .join(' ');
  return [
    { role: 'system', content: IDENTIFY_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: context }, imagePart(cropB64, 'high'), imagePart(frameB64, 'low')] },
  ];
}

export interface IdentifyResult {
  card: DeviceCardPayload;
  model: string;
  effort: string;
  latencyMs: number;
  source: 'live' | 'fixture';
  recordedFrom?: string;
}

export async function identify(
  muse: MuseChat,
  det: TargetDetection,
  crop: string,
  frame: string,
  opts: { cardId: string; userText?: string; signal?: AbortSignal; effort?: 'low' | 'medium' } = { cardId: 'card' },
): Promise<IdentifyResult> {
  const effort = opts.effort ?? 'low';
  const res = await muse.chatJson(identifyMessages(det, crop, frame, opts.userText), DeviceCardDraft, {
    name: 'device_card',
    description: 'Identification of one physical device from a camera crop',
    reasoningEffort: effort,
    maxTokens: 2500,
    label: 'identify',
    // recordings are per SAM label ("device_card:ceiling-light"), so a recorded synth never answers for a lamp
    fixture: `device_card:${det.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    signal: opts.signal,
  });
  const card: DeviceCardPayload = {
    ...res.data,
    cardId: opts.cardId,
    frameId: det.frameId,
    detId: det.detId,
    bbox: { x: det.box[0] / det.width, y: det.box[1] / det.height, w: det.box[2] / det.width, h: det.box[3] / det.height },
    source: res.source,
    modelId: res.recordedFrom ?? res.model,
  };
  if (!card.requires?.length) card.requires = defaultRequires(card);
  return { card, model: res.recordedFrom ?? res.model, effort, latencyMs: res.latencyMs, source: res.source, recordedFrom: res.recordedFrom };
}

/** When the model leaves `requires` empty, derive it from the category. */
export function defaultRequires(card: Pick<DeviceCardPayload, 'category' | 'protocols'>): DeviceCardPayload['requires'] {
  if (card.protocols.includes('midi')) return ['midi'];
  if (card.protocols.includes('ir')) return ['ir'];
  switch (card.category) {
    case 'synthesizer':
    case 'drum-machine':
    case 'sampler':
    case 'groovebox':
    case 'midi-controller':
      return ['midi'];
    case 'lighting':
    case 'appliance':
    case 'remote-control':
      return ['ir'];
    case 'computer':
    case 'phone':
      return ['local'];
    default:
      return [];
  }
}

/**
 * FIXTURE identification keyed on the SAM label in the prompt text, so the loop runs offline:
 * "ceiling light" -> an unbranded ceiling light (IR), synth-like -> an OP-1 Field (MIDI), else unknown.
 */
export function fixtureDeviceCard(messages: ChatMessage[]): DeviceCardDraft {
  const text = messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ')))
    .join(' ')
    .toLowerCase();
  if (/ceiling light|lamp|light/.test(text)) {
    return { name: 'FIXTURE ceiling light', maker: 'unknown', model: 'unknown', category: 'lighting', confidence: 0.55, protocols: ['ir'], evidence: ['FIXTURE: canned identification, no Meta model was called', 'round LED ceiling fixture'], companion: 'ir_blaster', requires: ['ir'], followUp: ['photograph the remote control'] };
  }
  if (/synth|keyboard|op-1|electronic device/.test(text)) {
    return { name: 'FIXTURE OP-1 Field', maker: 'teenage engineering', model: 'OP-1 Field', category: 'synthesizer', confidence: 0.6, protocols: ['midi'], evidence: ['FIXTURE: canned identification, no Meta model was called', 'grey portable synth with four colour encoders'], companion: 'computer_usb', requires: ['midi'], visibleText: ['OP-1'] };
  }
  return { name: 'FIXTURE unknown device', maker: 'unknown', model: 'unknown', category: 'other', confidence: 0.2, protocols: ['other'], evidence: ['FIXTURE: canned identification, no Meta model was called'], companion: 'none', requires: [] };
}

export const FIXTURE_CARD_KEY = 'device_card';
export { newId as newCardId };
