/**
 * Everyday objects that can become a controller. `cls` is only a stable kind id (the old COCO numbers); names come
 * from SAM 3.1 prompts or Muse. A "family" groups kinds that behave alike (a flat book is held with open fingers).
 */
export interface TangibleKind {
  cls: number;
  label: string;
  family: 'vessel' | 'flat' | 'handheld' | 'round';
  /** typical largest dimension, metres (depth from box size) */
  sizeM: number;
}

export const TANGIBLE_KINDS: TangibleKind[] = [
  { cls: 41, label: 'Cup', family: 'vessel', sizeM: 0.11 },
  { cls: 39, label: 'Bottle', family: 'vessel', sizeM: 0.24 },
  { cls: 73, label: 'Book', family: 'flat', sizeM: 0.24 },
  { cls: 67, label: 'Phone', family: 'handheld', sizeM: 0.15 },
  { cls: 65, label: 'Remote', family: 'handheld', sizeM: 0.17 },
  { cls: 64, label: 'Mouse', family: 'handheld', sizeM: 0.11 },
  { cls: 32, label: 'Ball', family: 'round', sizeM: 0.2 },
];

const BY_CLS = new Map(TANGIBLE_KINDS.map((k) => [k.cls, k]));
export const TANGIBLE_CLASSES: number[] = TANGIBLE_KINDS.map((k) => k.cls);

export function tangibleKind(cls: number): TangibleKind | undefined { return BY_CLS.get(cls); }

export function sameFamily(a: number, b: number): boolean {
  if (a === b) return true;
  const ka = BY_CLS.get(a), kb = BY_CLS.get(b);
  return !!ka && !!kb && ka.family === kb.family;
}

const LABELS = /\b(cup|mug|bottle|glass|book|notebook|phone|smartphone|remote|mouse|ball|can|tumbler)s?\b/i;
/** A label (detector or Muse name) that names an everyday object we can track. */
export function isTangibleLabel(label: string | undefined): boolean { return !!label && LABELS.test(label); }

/** Best COCO class for a label, so a tagged "Coffee mug" is tracked as a cup. */
export function clsForLabel(label: string): number | undefined {
  const l = label.toLowerCase();
  if (/\b(cup|mug|tumbler|glass)\b/.test(l)) return 41;
  if (/\b(bottle|can)\b/.test(l)) return 39;
  if (/\b(book|notebook)\b/.test(l)) return 73;
  if (/\b(phone|smartphone)\b/.test(l)) return 67;
  if (/\bremote\b/.test(l)) return 65;
  if (/\bmouse\b/.test(l)) return 64;
  if (/\bball\b/.test(l)) return 32;
  return undefined;
}
