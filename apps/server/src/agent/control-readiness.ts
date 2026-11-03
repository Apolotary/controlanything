import type { Hack, UiSpecPayload } from '@ce/protocol';
import type { Target } from './types';

/** Displayed availability comes from current action evidence, never a saved UI's status claims. */
export function hackVerified(target: Target, hack?: Hack): boolean {
  return !!hack?.commands.length && hack.commands.every((command) => (!command.cardId || command.cardId === target.cardId)
    && target.driver?.actions.some((action) => action.actionId === command.action)
    && target.verification[command.action] === 'pass');
}

function controlVerified(target: Target, spec: UiSpecPayload, control: { id: string; binding?: { action: string; args?: Record<string, unknown> }; yBinding?: { action: string } }): boolean {
  const hackId = String(control.binding?.args?.hack ?? control.id);
  const hack = spec.hackset?.hacks.find((candidate) => candidate.id === hackId);
  if (hack) return hackVerified(target, hack);
  // Legacy controls can bind a driver action directly.
  const actions = [control.binding?.action, ...(control.yBinding ? [control.yBinding.action] : [])];
  return actions.every((id) => !!id && target.driver?.actions.some((action) => action.actionId === id) && target.verification[id] === 'pass');
}

export function verifiedControlCount(spec: UiSpecPayload | undefined, target: Target): number {
  if (!spec) return 0;
  if (spec.gen3d?.controls.length) return spec.gen3d.controls.filter((control) => controlVerified(target, spec, control)).length;
  if (spec.widgets?.length) return spec.widgets.filter((control) => controlVerified(target, spec, control)).length;
  return spec.hackset?.hacks.filter((hack) => hackVerified(target, hack)).length ?? 0;
}

/** Read projection only: preserve saved layout/history while replacing stale availability flags. */
export function currentControlSpec<T extends UiSpecPayload>(spec: T, target: Target): T {
  const next = structuredClone(spec);
  const verified = new Map((next.gen3d?.controls ?? []).map((control) => [control.id, controlVerified(target, next, control)]));
  if (next.hackset) next.hackset.hacks = next.hackset.hacks.map((hack) => ({ ...hack, status: hackVerified(target, hack) ? 'verified' : 'locked' }));
  if (next.gen3d) {
    for (const control of next.gen3d.controls) control.armed = verified.get(control.id) === true;
    for (const part of next.gen3d.parts) if (part.params?.items) {
      part.params.items = part.params.items.map((item) => ({ ...item,
        status: (item.controlId && (verified.get(item.controlId) === true
          || hackVerified(target, next.hackset?.hacks.find((hack) => hack.id === item.controlId)))) ? 'verified' : 'locked' }));
    }
    const count = [...verified.values()].filter(Boolean).length;
    next.gen3d.state = { ...next.gen3d.state, armed: count > 0,
      reason: count ? `${count}/${next.gen3d.controls.length} displayed controls verified` : 'Displayed controls have not passed verification' };
  }
  return next;
}
