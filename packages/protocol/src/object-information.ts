import { z } from 'zod';

/** A missing value remains unknown; each asserted value names supporting sources. */
export const ObjectFact = z.object({
  value: z.string().min(1).max(500).nullable(),
  sourceIds: z.array(z.string().min(1).max(16)).max(3),
});

/** Read-only object research. This grants no device identity or control authority. */
export const ObjectInformation = z.object({
  title: z.string().min(1).max(200),
  identityStatus: z.enum(['matched', 'uncertain']),
  identityNote: z.string().max(400),
  description: ObjectFact,
  dimensions: ObjectFact,
  weight: ObjectFact,
  price: z.object({
    amount: z.string().min(1).max(60),
    currency: z.string().regex(/^[A-Z]{3}$/),
    retailer: z.string().min(1).max(160),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    condition: z.string().max(160),
    sourceIds: z.array(z.string().min(1).max(16)).min(1).max(3),
  }).nullable(),
  sources: z.array(z.object({
    id: z.string().min(1).max(16),
    title: z.string().max(180),
    url: z.string().url().max(1000).regex(/^https?:\/\//i),
    excerpt: z.string().max(1000).optional(),
  })).max(6),
  researchedAt: z.number().int().nonnegative(),
  cached: z.boolean(),
  source: z.enum(['live', 'fixture']),
  modelId: z.string().max(120).optional(),
}).superRefine((info, ctx) => {
  const ids = new Set(info.sources.map((source) => source.id));
  if (ids.size !== info.sources.length) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Source IDs must be unique' });
  for (const field of ['description', 'dimensions', 'weight', 'price'] as const) {
    const fact = info[field];
    if (!fact) continue;
    const known = field === 'price' || 'value' in fact && fact.value !== null;
    if (known && !fact.sourceIds.length) ctx.addIssue({ code: 'custom', path: [field, 'sourceIds'], message: 'Known facts require a source' });
    if (!known && fact.sourceIds.length) ctx.addIssue({ code: 'custom', path: [field, 'sourceIds'], message: 'Unknown facts have no supporting claim' });
    if (fact.sourceIds.some((id) => !ids.has(id))) ctx.addIssue({ code: 'custom', path: [field, 'sourceIds'], message: 'Fact references an absent source' });
  }
});
export type ObjectInformation = z.infer<typeof ObjectInformation>;
