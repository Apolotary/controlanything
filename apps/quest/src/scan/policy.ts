import type { Category } from './yolo/classes';

export const ANNOTATION_RANGE_M = 3;
export const ANNOTATION_MIN_SCORE = 0.5;
export const ANNOTATION_MAX_BOXES = 5;
export const ANNOTATION_FADE_MS = 400;
/** SAM 3.1 refreshes each device prompt about once per scan cycle (1-3 s), so its boxes must outlast one cycle or they flicker. */
export const ANNOTATION_SAM_FADE_MS = 3500;

/** Live YOLO boxes fade after 0.4 s unseen; SAM-only boxes after one scan cycle. */
export function annotationFadeMs(live: boolean): number {
  return live ? ANNOTATION_FADE_MS : ANNOTATION_SAM_FADE_MS;
}

export type AnnotationFilter = 'electronics' | 'lights' | 'everything';
type Point = { x: number; y: number; z: number };
type Position = Point | readonly [number, number, number];

const PEOPLE = /\b(person|people|human|man|woman|men|women|child|kid|face|head|body|hand|arm|finger)s?\b/i;
const LIGHTS = /\b(light|lamp|bulb|lighting|luminaire)s?\b/i;
const ELECTRONICS = /\b(tv|television|screen|monitor|laptop|computer|macbook|mac|cell phone|phone|remote|keyboard|synthesizer|synth|mouse|speaker|electronic device|electronics|cardputer)s?\b/i;
const APPLIANCES = /\b(air conditioner|air conditioning|ac|fan|microwave|oven|toaster|fridge|refrigerator|clock|hair dryer|hair drier|printer|projector)s?\b/i;

/** All devices still means devices: unrelated scenery and people are never annotation targets. */
export function matchesAnnotationFilter(label: string, category: Category = 'everything'): boolean {
  if (PEOPLE.test(label)) return false;
  if (category === 'lights') return LIGHTS.test(label);
  if (category === 'instruments') return /\b(keyboard|synthesizer|synth)s?\b/i.test(label);
  if (category === 'remotes') return /\b(remote|phone|cardputer)s?\b/i.test(label);
  if (category === 'electronics') return !LIGHTS.test(label) && ELECTRONICS.test(label);
  return ELECTRONICS.test(label) || LIGHTS.test(label) || APPLIANCES.test(label);
}

/** Invalid query values use the nearby-device default. */
export function annotationRange(value: string | number | null | undefined): number {
  const range = Number(value);
  return Number.isFinite(range) && range > 0 ? range : ANNOTATION_RANGE_M;
}

export function inAnnotationRange(position: Position, head: Point, range = ANNOTATION_RANGE_M): boolean {
  const dx = ('x' in position ? position.x : position[0]) - head.x;
  const dy = ('y' in position ? position.y : position[1]) - head.y;
  const dz = ('z' in position ? position.z : position[2]) - head.z;
  return dx * dx + dy * dy + dz * dz <= range * range;
}

/** Tagged outlines remain anchored when unseen; transient boxes expire after 400 ms. */
export function annotationVisible(
  target: { label: string; score: number; position: Point; lastSeenAt: number },
  head: Point,
  category: Category,
  now: number,
  range = ANNOTATION_RANGE_M,
  tagged = false,
): boolean {
  if (tagged) return true;
  return target.score >= ANNOTATION_MIN_SCORE && matchesAnnotationFilter(target.label, category)
    && inAnnotationRange(target.position, head, range) && now - target.lastSeenAt < ANNOTATION_FADE_MS;
}
