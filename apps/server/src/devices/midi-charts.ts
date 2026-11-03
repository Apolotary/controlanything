/** Explicitly reviewed, cited CC permissions. Web-search prose never enters this store automatically. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { DeviceCardPayload } from '@ce/protocol';
import type { MidiProfile } from './profiles';

const ShortText = z.string().trim().min(1).max(120);
const SourceUrl = z.string().trim().url().max(500).refine((value) => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}, 'Use a public HTTPS manual URL without credentials.');
const Parameter = z.object({
  cc: z.number().int().min(1).max(119).refine((cc) => cc !== 32, 'Bank select is outside this CC-only import.'),
  name: ShortText, min: z.number().int().min(0).max(127), max: z.number().int().min(0).max(127),
}).strict().refine((p) => p.max > p.min, 'Maximum must exceed minimum.');
export const MidiChartInput = z.object({
  maker: ShortText, model: ShortText,
  source: z.object({ title: ShortText, url: SourceUrl, section: z.string().trim().min(1).max(240) }).strict(),
  channel: z.number().int().min(1).max(16),
  parameters: z.array(Parameter).min(1).max(12).refine((values) => new Set(values.map((p) => p.cc)).size === values.length, 'Each CC must appear once.'),
}).strict();
export type MidiChartInput = z.infer<typeof MidiChartInput>;
export const MidiChartRequest = z.object({
  cardId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative(), reviewed: z.literal(true), chart: MidiChartInput,
}).strict();
export const ReviewedMidiChart = z.object({
  cardId: z.string().min(1).max(128), revision: z.number().int().min(1), reviewedAt: z.number().int().nonnegative(),
  reviewedBy: z.string().min(1).max(120), chart: MidiChartInput,
}).strict();
export type ReviewedMidiChart = z.infer<typeof ReviewedMidiChart>;
const FileData = z.object({ version: z.literal(1), charts: z.array(ReviewedMidiChart).max(64) }).strict();
const normalized = (s: string) => s.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
const identityMatches = (card: Pick<DeviceCardPayload, 'maker' | 'model'>, chart: MidiChartInput) => normalized(card.maker) === normalized(chart.maker) && normalized(card.model) === normalized(chart.model);

export class MidiChartConflict extends Error {}

export class MidiChartStore {
  private charts = new Map<string, ReviewedMidiChart>();
  readonly warnings: string[] = [];
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = readFileSync(file, 'utf8');
      if (raw.length > 512 * 1024) throw new Error('chart store exceeds its size limit');
      const parsed = FileData.parse(JSON.parse(raw));
      if (new Set(parsed.charts.map((c) => c.cardId)).size !== parsed.charts.length) throw new Error('duplicate chart identities');
      this.charts = new Map(parsed.charts.map((record) => [record.cardId, record]));
    } catch { this.warnings.push('The reviewed MIDI chart store could not be read; no imported permissions were loaded.'); }
  }
  /** Revision remains visible if identification changed, but that chart is never used for the new identity. */
  get(cardId: string): ReviewedMidiChart | undefined {
    const record = this.charts.get(cardId); return record ? structuredClone(record) : undefined;
  }
  /** Saved permissions cannot outlive a revision, an identity change, or a missing/corrupt store. */
  isCurrent(cardId: string, card: DeviceCardPayload | undefined, profile: MidiProfile | undefined): boolean {
    const current = this.charts.get(cardId), reviewed = profile?.reviewedChart;
    if (!current && !reviewed) return true;
    return Boolean(current && reviewed && card && card.cardId === cardId && identityMatches(card, current.chart)
      && reviewed.cardId === cardId && reviewed.revision === current.revision && reviewed.reviewedAt === current.reviewedAt);
  }
  review(card: DeviceCardPayload, input: MidiChartInput, expectedRevision: number, by: string): ReviewedMidiChart {
    const chart = MidiChartInput.parse(input);
    if (!card.requires?.includes('midi') && !card.protocols.includes('midi')) throw new Error('This target is not an identified MIDI device.');
    if (!identityMatches(card, chart) || /\b(unknown|unsure)\b/i.test(`${chart.maker} ${chart.model}`) || /^(device|synth|synthesizer)$/i.test(chart.model) || /^(device|maker|manufacturer)$/i.test(chart.maker)) {
      throw new Error('Confirm the exact maker and model on the selected device before reviewing its MIDI chart.');
    }
    const previous = this.charts.get(card.cardId);
    if ((previous?.revision ?? 0) !== expectedRevision) throw new MidiChartConflict('The chart changed. Reload it before saving another revision.');
    if (!previous && this.charts.size >= 64) throw new MidiChartConflict('The local chart store has reached its 64-device limit.');
    const record = ReviewedMidiChart.parse({ cardId: card.cardId, revision: expectedRevision + 1, reviewedAt: Date.now(), reviewedBy: by.slice(0, 120) || 'Reviewer', chart });
    const next = new Map(this.charts); next.set(card.cardId, record);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, charts: [...next.values()] }, null, 2) + '\n', { mode: 0o600 });
      renameSync(temp, this.file);
    }
    this.charts = next;
    return structuredClone(record);
  }
  profile(card: DeviceCardPayload): MidiProfile | undefined {
    const record = this.charts.get(card.cardId);
    if (!record || !identityMatches(card, record.chart)) return;
    const { chart } = record;
    return {
      id: `reviewed-${createHash('sha256').update(card.cardId).digest('hex').slice(0, 16)}-r${record.revision}`,
      device: `${chart.maker} ${chart.model}`, manufacturer: chart.maker,
      firmwareNotes: `User-reviewed CC subset, revision ${record.revision}. Source section: ${chart.source.section}. Incoming CC only; no note/program permissions.`,
      sources: [{ title: chart.source.title, url: chart.source.url, confidence: 'user-reviewed; effect not yet verified' }],
      channels: { receive: String(chart.channel) }, sense: 'audio',
      parameters: chart.parameters.map((p) => ({ name: p.name, cc: p.cc, range: [p.min, p.max] as [number, number], channel: String(chart.channel) })),
      demo: { bestParameters: chart.parameters.map((p) => `CC ${p.cc}: ${p.name}`), setup: ['Play a sustained sound yourself for audio verification; this chart does not permit generated notes.'] },
      reviewedChart: { cardId: card.cardId, revision: record.revision, channel: chart.channel, reviewedAt: record.reviewedAt, reviewedBy: record.reviewedBy },
    };
  }
}
