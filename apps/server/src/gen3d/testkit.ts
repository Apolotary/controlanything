/**
 * Test helpers for gen3d (mocked Meta SSE responses and fixtures). Not used at runtime.
 */
import type { ForgeDraft } from './hackset';

/** A text/event-stream Response, split into small byte chunks to exercise the SSE decoder. */
export function sseResponse(events: unknown[], split = 37): Response {
  const text = `${events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join('')}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const USAGE = { prompt_tokens: 3000, completion_tokens: 2000, total_tokens: 5000, completion_tokens_details: { reasoning_tokens: 900 }, prompt_tokens_details: { cached_tokens: 2800 } };

/** Stream `text` as content deltas, then a finish chunk with usage. */
export function contentEvents(text: string, pieces = 6, model = 'muse-spark-1.3'): unknown[] {
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += size) out.push({ model, choices: [{ index: 0, delta: { content: text.slice(i, i + size) }, finish_reason: null }] });
  out.push({ model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE });
  return out;
}

export interface MockCall {
  url: string;
  body: any;
}

/** fetch that answers each request with the next factory's Response, recording request bodies. */
export function mockFetch(factories: (() => Response)[]) {
  const calls: MockCall[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const f = factories[Math.min(calls.length - 1, factories.length - 1)];
    return f();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A valid hack set for FORGE_LIGHT_DRIVER (learned IR triggers only: stepper controls). */
export const LIGHT_DRAFT: ForgeDraft = {
  title: 'Ceiling light',
  hacks: [
    {
      blurb: "brightness in the remote's steps",
      commands: [
        { action: 'ir.brighter', delayMs: 0, param: '', value: 0 },
        { action: 'ir.darker', delayMs: 0, param: '', value: 0 },
      ],
      confirm: 'none',
      control: { accent: '', archetype: 'ring', param: 'p_lvl', size: 'm' },
      id: 'h_dim',
      inverse: { commands: [], restore: 'p_lvl' },
      kind: 'control',
      max_rate_hz: 2,
      name: 'Dim room',
      oracle: { expect: 'luminance_tracks_param', reason: '', type: 'camera' },
      params: [{ default: 70, id: 'p_lvl', max: 100, min: 0, name: 'Level', step: 10, unit: '%' }],
      reversible: true,
    },
    {
      blurb: 'colour temperature, 5 steps',
      commands: [
        { action: 'ir.warmer', delayMs: 0, param: '', value: 0 },
        { action: 'ir.cooler', delayMs: 0, param: '', value: 0 },
      ],
      confirm: 'none',
      control: { accent: '', archetype: 'slider', param: 'p_cct', size: 'm' },
      id: 'h_warm',
      inverse: { commands: [], restore: 'p_cct' },
      kind: 'control',
      max_rate_hz: 2,
      name: 'Warm light',
      oracle: { expect: 'colour_shift', reason: '', type: 'camera' },
      params: [{ default: 2, id: 'p_cct', max: 4, min: 0, name: 'Warmth', step: 1, unit: '' }],
      reversible: true,
    },
    {
      blurb: 'amber night light',
      commands: [{ action: 'ir.night', delayMs: 0, param: '', value: 0 }],
      confirm: 'none',
      control: { accent: '', archetype: 'none', param: '', size: 'm' },
      id: 'h_night',
      inverse: { commands: [{ action: 'ir.full', delayMs: 0, param: '', value: 0 }], restore: '' },
      kind: 'action',
      max_rate_hz: 1,
      name: 'Night light',
      oracle: { expect: 'dimmer', reason: '', type: 'camera' },
      params: [],
      reversible: true,
    },
    {
      blurb: 'switch the light off',
      commands: [{ action: 'ir.off', delayMs: 0, param: '', value: 0 }],
      confirm: 'none',
      control: { accent: '', archetype: 'none', param: '', size: 'm' },
      id: 'h_off',
      inverse: { commands: [{ action: 'ir.full', delayMs: 0, param: '', value: 0 }], restore: '' },
      kind: 'action',
      max_rate_hz: 1,
      name: 'Lights off',
      oracle: { expect: 'off', reason: '', type: 'camera' },
      params: [],
      reversible: true,
    },
    {
      blurb: 'full brightness',
      commands: [{ action: 'ir.full', delayMs: 0, param: '', value: 0 }],
      confirm: 'none',
      control: { accent: '', archetype: 'none', param: '', size: 'm' },
      id: 'h_full',
      inverse: { commands: [{ action: 'ir.off', delayMs: 0, param: '', value: 0 }], restore: '' },
      kind: 'action',
      max_rate_hz: 1,
      name: 'Full light',
      oracle: { expect: 'on', reason: '', type: 'camera' },
      params: [],
      reversible: true,
    },
  ],
};
