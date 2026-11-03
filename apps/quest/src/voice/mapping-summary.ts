import type { UiSpecPayload } from '@ce/protocol';

/** Describe the actual published map, never the text of a requested edit. */
export function mappingSummary(spec: UiSpecPayload | undefined): string | undefined {
  const map = spec?.gestureMap;
  if (!map || !map.axes.length && !map.postures.length) return;
  const names: Record<string, string> = { right_height: 'Height', right_depth: 'Push/pull', right_roll: 'Wrist roll', right_pinch_aperture: 'Pinch opening', two_hand_distance: 'Hand distance',
    R_FIST: 'Right fist', R_OPEN_PALM: 'Right palm', R_POINT: 'Right point', R_PINCH: 'Right pinch' };
  const firstAxis = map.axes.length ? map.axes[0] : undefined;
  const firstPosture = map.postures[0];
  const input = firstAxis ? firstAxis.axis : firstPosture!.posture;
  const label = firstAxis?.label ?? firstPosture!.label;
  const count = map.axes.length + map.postures.length;
  return `${spec?.rev === undefined ? 'Saved map' : `Map r${spec.rev}`} · ${names[input] ?? input} to ${label.slice(0, 18)}${count > 1 ? ` +${count - 1}` : ''}`;
}
