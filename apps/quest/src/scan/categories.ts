/**
 * The annotation filter (wrist palette: Electronics · Objects · All). Each one maps to the SAM 3.1 text prompts
 * the server runs on a scan frame (apps/server/src/agent/scan.ts `promptsForFilter`), and the client keeps only the
 * labels that match it (policy.ts `matchesAnnotationFilter`).
 */
export type Category = 'everything' | 'electronics' | 'objects' | 'instruments' | 'lights' | 'remotes';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'electronics', label: 'Electronics' },
  { id: 'objects', label: 'Objects' },
  { id: 'everything', label: 'All' },
];

/** The scan.frame `filter` the server understands (narrower chips fall back to All). */
export function scanFilter(category: Category): 'electronics' | 'objects' | 'everything' {
  return category === 'electronics' || category === 'objects' ? category : 'everything';
}

export function isCategory(v: string | null | undefined): v is Category {
  return CATEGORIES.some((c) => c.id === v);
}
