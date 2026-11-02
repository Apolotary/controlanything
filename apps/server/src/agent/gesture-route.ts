import type { Driver, Hack, UiSpecPayload, VerifyState } from '@ce/protocol';
import { validateGestureMap } from '../devices/gestures';

/** Gesture IDs address the published map, never an arbitrary driver action or MIDI number. */
export function gestureHack(
  widgetId: string, spec: UiSpecPayload, driver: Driver, verification: Readonly<Record<string, VerifyState>>,
): Hack | undefined {
  if (!widgetId.startsWith('gesture:') || !spec.gestureMap || spec.driverId !== driver.driverId || spec.cardId !== driver.cardId) return;
  let map;
  try { map = validateGestureMap(spec.gestureMap, driver, verification); }
  catch { return; }
  const name = widgetId.slice('gesture:'.length);
  const axis = map.axes.find((binding) => binding.axis === name);
  const posture = map.postures.find((binding) => binding.posture === name);
  const binding = axis ?? posture;
  if (!binding) return;
  const param = widgetId;
  return {
    id: widgetId, name: binding.label.slice(0, 24), kind: axis ? 'control' : 'action',
    commands: [{ action: binding.actionId, ...(axis ? { param } : posture?.value !== undefined ? { value: Number(posture.value) } : {}) }],
    ...(axis ? { params: [{ id: param, name: axis.label.slice(0, 24), min: axis.outMin, max: axis.outMax, step: axis.quantizeStep }],
      control: { archetype: 'slider' as const, param } } : {}),
    max_rate_hz: binding.maxRateHz,
    oracle: { type: 'wire', expect: 'serial_ack' }, status: 'verified',
  };
}
