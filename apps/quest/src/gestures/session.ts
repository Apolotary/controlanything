import type { ControlEventPayload, GestureMap, UiSpecPayload } from '@ce/protocol';
import type { ControlEvent } from '@ce/gen3d';
import { GestureEngine } from './engine';

/** Match only a single-action control; compound generated controls are not performance parameters. */
function controlForAction(spec: UiSpecPayload, actionId: string): string | undefined {
  const hack = spec.hackset?.hacks.find((h) => h.kind === 'control' && h.commands.length === 1
    && h.commands[0]?.action === actionId && h.commands[0]?.param !== undefined);
  if (!hack) return;
  return spec.gen3d?.controls.find((c) => c.armed !== false && (c.id === hack.id || c.binding.args?.hack === hack.id))?.id;
}

/** One explicitly enabled device. The engine owns rate limiting, so release leaves no queued sends. */
export class GestureSession {
  readonly engine: GestureEngine;
  readonly specId: string;
  readonly map: GestureMap;

  constructor(
    spec: UiSpecPayload & { gestureMap: GestureMap },
    current: ReadonlyMap<string, ControlEvent['value']>,
    send: (event: ControlEventPayload) => void,
    mirror: (specId: string, controlId: string, value: number | boolean) => void,
  ) {
    this.specId = spec.specId;
    this.map = spec.gestureMap;
    const controls = new Map<string, string>();
    const initial = new Map<string, number>();
    for (const binding of this.map.axes) {
      const previous = current.get(`${spec.specId}:gesture:${binding.axis}`);
      if (typeof previous === 'number' && Number.isFinite(previous)) initial.set(binding.actionId, previous);
      const controlId = controlForAction(spec, binding.actionId);
      if (!controlId || !spec.gen3d) continue;
      controls.set(binding.actionId, controlId);
      const control = spec.gen3d.controls.find((c) => c.id === controlId)!;
      const value = current.get(`${spec.gen3d.specId}:${controlId}`) ?? control.default;
      if (!initial.has(binding.actionId) && typeof value === 'number' && Number.isFinite(value)) initial.set(binding.actionId, value);
    }
    this.engine = new GestureEngine(this.map, (actionId, value, phase, gesture) => {
      const widgetId = `gesture:${gesture}`;
      send({ specId: this.specId, widgetId, value, phase: phase === 'move' ? 'move' : 'end', ts: Date.now() });
      const controlId = controls.get(actionId);
      if (spec.gen3d && controlId) mirror(spec.gen3d.specId, controlId, value);
    }, initial);
  }
}
