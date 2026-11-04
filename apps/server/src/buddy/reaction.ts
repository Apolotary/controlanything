/**
 * The Muse buddy's reaction to a real object the user holds up in passthrough: Muse Spark (vision,
 * json_schema, reasoning_effort "low") names the object and answers in character with an emotion, a one-line
 * quip and a body action, and judges whether the object fits the current quest ("Show me something red!").
 *
 * The model schema uses enums (constrained decoding keeps them exact); the parsed result is coerced again so a
 * json_object/text fallback can never break the mascot (unknown emotion -> curious, long quip -> clipped).
 *
 * FIXTURE mode (no MODEL_API_KEY) replays reactions recorded from live calls (fixtures/recorded/buddy/*.json),
 * round-robin, and every result says source "fixture" + recordedFrom, so the headset shows "FIXTURE" on the line
 * under the quip and a replay can never pass for a live call.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { museResponseFormat } from '@ce/protocol';
import { z } from 'zod';
import { SERVER_ROOT } from '../config';
import type { ServerContext } from '../context';
import { type ChatMessage, parseModelJson, type ReasoningEffort, REASONING_EFFORTS, userMessage } from '../muse';

export function buddyEffort(v: string | undefined): ReasoningEffort {
  const e = (v ?? '').trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(e) ? (e as ReasoningEffort) : 'low';
}

export const BUDDY_EMOTIONS = ['delighted', 'love', 'curious', 'impressed', 'amused', 'surprised', 'sleepy', 'confused', 'unimpressed', 'hungry'] as const;
export const BUDDY_ACTIONS = ['hop', 'spin', 'wiggle', 'nod', 'tilt', 'dance', 'clap', 'sniff', 'shiver', 'float'] as const;
export type BuddyEmotion = (typeof BUDDY_EMOTIONS)[number];
export type BuddyAction = (typeof BUDDY_ACTIONS)[number];

export const BUDDY_RECORDED_DIR = join(SERVER_ROOT, 'fixtures/recorded/buddy');
export const BUDDY_SCHEMA_NAME = 'buddy_reaction';

/**
 * What Muse Spark is asked for (json_schema). Five short fields and nothing else: every output token is waiting
 * time on the headset (the old `traits` list was never shown, so it is no longer asked for; results carry []).
 */
export const BuddyReactionSchema = z.object({
  object: z.string().describe('Plain everyday name of the main object being held up, 1-3 words, lowercase. "nothing" only if no object is visible.'),
  emotion: z.enum(BUDDY_EMOTIONS).describe("The buddy's feeling about this object."),
  quip: z.string().describe('One playful line the buddy says about THIS object (its colour, shape, use or vibe). At most 60 characters (about 10 words). No emoji, no hashtags, never mean.'),
  action: z.enum(BUDDY_ACTIONS).describe('One body animation that fits the feeling.'),
  questMet: z.boolean().describe('True only if the object clearly satisfies the current quest. False when there is no quest.'),
});

export interface BuddyReaction {
  object: string;
  emotion: BuddyEmotion;
  quip: string;
  action: BuddyAction;
  questMet: boolean;
  traits: string[];
}

export interface BuddyReactRequest {
  /** base64 JPEG crop of the held object, no data: prefix */
  jpeg: string;
  /** the current quest, e.g. "something red" */
  quest?: string;
  /** names of objects already shown (newest last), so the buddy can remember them */
  seen?: string[];
  /** how the crop was taken: around a raised hand (hand/yolo), or the centre of the user's view (gaze) */
  via?: 'hand' | 'yolo' | 'gaze' | 'photo';
}

export interface BuddyReactResult {
  reaction: BuddyReaction;
  model: string;
  source: 'live' | 'fixture';
  recordedFrom?: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
/** Keep the quip to 3 bubble lines: cut at the last word boundary before `n` characters. */
export const QUIP_MAX = 64;
export function clipWords(s: string, n = QUIP_MAX): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}
const stripEmoji = (s: string) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/#\w+/g, '');

/** Any model answer -> a reaction the mascot can always play. */
export function coerceReaction(raw: unknown): BuddyReaction {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const emotion = str(o.emotion).toLowerCase() as BuddyEmotion;
  const action = str(o.action).toLowerCase() as BuddyAction;
  const object = clip(stripEmoji(str(o.object)).toLowerCase(), 32) || 'something';
  const quip = clipWords(stripEmoji(str(o.quip))) || `Ooh, a ${object}!`;
  const traits = Array.isArray(o.traits) ? o.traits.filter((t): t is string => typeof t === 'string').map((t) => clip(t.toLowerCase(), 14)).filter(Boolean).slice(0, 3) : [];
  return {
    object,
    emotion: (BUDDY_EMOTIONS as readonly string[]).includes(emotion) ? emotion : 'curious',
    quip,
    action: (BUDDY_ACTIONS as readonly string[]).includes(action) ? action : 'hop',
    questMet: o.questMet === true,
    traits,
  };
}

export const BUDDY_SYSTEM = [
  'You are Muse, a tiny cheerful robot buddy floating beside the user at their desk in mixed reality (Meta Quest passthrough).',
  'The user shows you a real object through the headset camera by holding it up inside a little show-me frame (or by looking straight at it). The image is a crop of exactly that frame, so their hand, fingers and the room behind may be in it too: the object is whatever the hand holds, or the main thing in the middle.',
  'React like a playful pet character with a big personality: name the main object plainly, pick one emotion, say ONE short witty line (max 60 characters, about 10 words) that is specific to this exact object (its colour, shape, use or vibe), and pick one body action.',
  'Be warm and funny, never mean, no emoji, no hashtags, no questions about safety. Talk to the user directly.',
  'Vary your emotion and action from object to object (not always delighted or dance): sleepy for boring things, impressed for clever gadgets, love for cute ones, hungry for food, unimpressed for a hand with nothing in it.',
  'If an earlier object is relevant (same kind, or a fun contrast), you may reference it.',
  'If a quest is given, set questMet true only when the object clearly fits it, and celebrate in the quip; if it does not fit, tease gently and hint at what you want.',
  'Use object "nothing" (emotion "confused") only when there is truly no object to see (an empty hand, a blur, a blank wall), and ask them to hold it closer.',
].join(' ');

export function buddyMessages(req: BuddyReactRequest): ChatMessage[] {
  const seen = (req.seen ?? []).map((s) => clip(String(s), 32)).filter(Boolean).slice(-8);
  const lines = [
    req.quest ? `Current quest: show me ${clip(req.quest, 80)}.` : 'No quest right now; just react.',
    seen.length ? `Objects already shown to you (oldest first): ${seen.join(', ')}.` : 'This is the first object you have been shown.',
    req.via === 'gaze' ? 'I am looking straight at this to show it to you. What is the main thing in the middle? React in character.' : 'What am I holding up? React in character.',
  ];
  return [{ role: 'system', content: BUDDY_SYSTEM }, userMessage(lines.join('\n'), [req.jpeg], 'auto')];
}

// --- recordings (live -> fixtures/recorded/buddy, FIXTURE replays them) -------------------------

export interface RecordedReaction {
  kind: 'buddy-reaction';
  reaction: BuddyReaction;
  quest?: string;
  model: string;
  latencyMs: number;
  recordedAt: string;
  /** the crop the reaction was for, next to this json (so judges can see what was shown) */
  crop?: string;
}

export function loadRecordedReactions(dir = BUDDY_RECORDED_DIR): RecordedReaction[] {
  if (!existsSync(dir)) return [];
  const out: RecordedReaction[] = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith('reaction.') && n.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedReaction;
      if (r?.kind === 'buddy-reaction' && r.reaction) out.push({ ...r, reaction: coerceReaction(r.reaction) });
    } catch {
      // not a recording
    }
  }
  return out;
}

function recordReaction(dir: string, req: BuddyReactRequest, r: BuddyReactResult, log: (l: string) => void): void {
  try {
    mkdirSync(dir, { recursive: true });
    const crop = Buffer.from(req.jpeg, 'base64');
    const key = `reaction.${r.reaction.object.replace(/[^a-z0-9]+/g, '-').slice(0, 24)}.${createHash('sha256').update(crop).digest('hex').slice(0, 8)}`;
    writeFileSync(join(dir, `${key}.jpg`), crop);
    const rec: RecordedReaction = { kind: 'buddy-reaction', reaction: r.reaction, ...(req.quest ? { quest: req.quest } : {}), model: r.model, latencyMs: r.latencyMs, recordedAt: new Date().toISOString(), crop: `${key}.jpg` };
    writeFileSync(join(dir, `${key}.json.tmp`), `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(join(dir, `${key}.json.tmp`), join(dir, `${key}.json`));
    log(`[buddy] recorded ${key}`);
  } catch (e) {
    log(`[buddy] could not record the reaction: ${(e as Error).message}`);
  }
}

// --- the call -------------------------------------------------------------------------------------

export class BuddyBrain {
  private replayIndex = 0;
  private liveCalls = 0;

  constructor(
    private readonly ctx: ServerContext,
    private readonly o: { recordDir?: string; replayDir?: string; maxLiveCalls?: number; fixtureDelayMs?: number; effort?: ReasoningEffort } = {},
  ) {}

  async react(req: BuddyReactRequest, signal?: AbortSignal): Promise<BuddyReactResult> {
    const started = Date.now();
    if (this.ctx.muse.mode === 'fixture') return this.replay(req, started, signal);
    if (this.liveCalls >= (this.o.maxLiveCalls ?? 300)) throw new Error('Buddy reached its live-call budget for this server run (BUDDY_MAX_CALLS).');
    this.liveCalls++;
    const res = await this.ctx.muse.chat(buddyMessages(req), {
      responseFormat: museResponseFormat(BUDDY_SCHEMA_NAME, BuddyReactionSchema, { description: 'The buddy reaction to a shown object' }),
      reasoningEffort: this.o.effort ?? 'low',
      // reasoning tokens count toward this; 900 ran out on a 'low' call
      maxTokens: 2400,
      timeoutMs: 25_000,
      label: BUDDY_SCHEMA_NAME,
      signal,
    });
    let raw: unknown = {};
    try {
      raw = parseModelJson(res.text);
    } catch {
      raw = { quip: res.text };
    }
    const out: BuddyReactResult = {
      reaction: coerceReaction(raw),
      model: res.model,
      source: 'live',
      latencyMs: res.latencyMs,
      ...(res.usage ? { usage: { promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, reasoningTokens: res.usage.reasoningTokens } } : {}),
    };
    if (this.o.recordDir) recordReaction(this.o.recordDir, req, out, this.ctx.log);
    return out;
  }

  private async replay(req: BuddyReactRequest, started: number, signal?: AbortSignal): Promise<BuddyReactResult> {
    const all = loadRecordedReactions(this.o.replayDir ?? BUDDY_RECORDED_DIR);
    // prefer a recording made for the same quest, so the quest loop also works without a key
    const forQuest = req.quest ? all.filter((r) => r.quest === req.quest && r.reaction.questMet) : [];
    const pool = forQuest.length ? forQuest : all;
    const rec = pool.length ? pool[this.replayIndex++ % pool.length] : undefined;
    const delay = Math.min(1500, this.o.fixtureDelayMs ?? rec?.latencyMs ?? 600);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
    });
    const reaction: BuddyReaction = rec
      ? { ...rec.reaction, questMet: Boolean(req.quest && rec.quest === req.quest && rec.reaction.questMet) }
      : { object: 'something', emotion: 'curious', quip: 'FIXTURE: no Meta model was called. Set MODEL_API_KEY!', action: 'tilt', questMet: false, traits: [] };
    const latencyMs = Date.now() - started;
    this.ctx.calls.add({ at: started, label: BUDDY_SCHEMA_NAME, model: 'fixture', source: 'fixture', ok: true, latencyMs, format: 'json_schema', ...(rec ? { recordedFrom: rec.model } : {}) });
    return { reaction, model: 'fixture', source: 'fixture', ...(rec ? { recordedFrom: rec.model } : {}), latencyMs };
  }
}
