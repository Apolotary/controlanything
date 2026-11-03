import type { Det } from '../io/v1';
import { isGenericLabel } from './targets';
import { containment, iou } from './yolo/post';

/** Suppress redundant boxes within one capture, before uncertain depth estimates can separate them. */
export function deduplicateDetections(detections: readonly Det[]): { kept: Det[]; suppressed: Det[] } {
  const kept: Det[] = [], suppressed: Det[] = [];
  // A known class is more useful than another generic box over the same image region.
  const ordered = [...detections].sort((a, b) => Number(isGenericLabel(a.label)) - Number(isGenericLabel(b.label)) || b.score - a.score);
  for (const candidate of ordered) {
    const duplicate = kept.some((other) => {
      if (candidate.cardId && other.cardId && candidate.cardId !== other.cardId) return false;
      if (candidate.deviceId && other.deviceId && candidate.deviceId !== other.deviceId) return false;
      const generic = isGenericLabel(candidate.label), otherGeneric = isGenericLabel(other.label);
      const sameClass = candidate.label.trim().toLowerCase() === other.label.trim().toLowerCase() || generic && otherGeneric;
      if (sameClass) return iou(candidate.box, other.box) >= 0.55;
      if (!generic || otherGeneric) return false;
      // A generic screen/palm-rest crop inside a laptop is not another identified device. Conversely,
      // preserve a large generic region containing only a small named object and nearby separate boxes.
      return containment(candidate.box, other.box) >= 0.85 || iou(candidate.box, other.box) >= 0.55;
    });
    (duplicate ? suppressed : kept).push(candidate);
  }
  return { kept, suppressed };
}
