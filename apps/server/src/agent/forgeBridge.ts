import type { Forge, ForgeSnapshot, UiSpec } from '../gen3d/forge';
import { toAgentStep } from '../gen3d/routes';
import type { Hub } from '../hub';
import { stepGuidance } from './guidance';
import type { TargetStore } from './targets';
import { currentControlSpec, hackVerified } from './control-readiness';

/** Forward current controls and progress, including skins that finish after discovery. */
export function subscribeForge(
  forge: Pick<Forge, 'subscribe' | 'specIdFor' | 'snapshot'>,
  hub: Pick<Hub, 'broadcast'>,
  targets: Pick<TargetStore, 'get'>,
  allowed: (cardId: string) => boolean = () => true,
  onSpec?: (spec: UiSpec, context: ForgeSnapshot | undefined) => void,
): () => void {
  return forge.subscribe((event) => {
    if (event.type === 'spec') {
      const target = targets.get(event.uiSpec.cardId);
      if (target && (target.state === 'failed' || target.abort?.signal.aborted || target.driver?.driverId !== event.uiSpec.driverId)) return;
      const spec = target ? currentControlSpec(event.uiSpec, target) : event.uiSpec;
      onSpec?.(spec, forge.snapshot?.(event.uiSpec.specId));
      if (!allowed(event.uiSpec.cardId)) return;
      hub.broadcast('ui.spec', spec);
      return;
    }

    const progress = event.progress;
    if (!allowed(progress.cardId)) return;
    const target = targets.get(progress.cardId);
    if (progress.runId.startsWith('run-') && target && (
      target.runId !== progress.runId || target.abort?.signal.aborted || target.state === 'failed'
    )) return;

    hub.broadcast('agent.step', { ...stepGuidance(progress.phase, progress.status), ...toAgentStep(progress) });
    const item = progress.item;
    if (item) {
      const verified = target ? hackVerified(target, item.hack) : undefined;
      hub.broadcast('ui.partial', {
        specId: forge.specIdFor(progress.cardId), cardId: progress.cardId, runId: progress.runId,
        seq: item.seq, control: verified === undefined ? item.control : { ...item.control, armed: verified },
        hack: verified === undefined ? item.hack : { ...item.hack, status: verified ? 'verified' : 'locked' },
        ...(item.part ? { part: item.part } : {}),
        ...(item.hackItem ? { hackItem: verified === undefined ? item.hackItem : { ...item.hackItem, status: verified ? 'verified' : 'locked' } } : {}),
      });
    }
  });
}
