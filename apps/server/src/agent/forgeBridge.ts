import type { Forge } from '../gen3d/forge';
import { toAgentStep } from '../gen3d/routes';
import type { Hub } from '../hub';
import { stepGuidance } from './guidance';
import type { TargetStore } from './targets';

/** Forward current controls and progress, including skins that finish after discovery. */
export function subscribeForge(
  forge: Pick<Forge, 'subscribe' | 'specIdFor'>,
  hub: Pick<Hub, 'broadcast'>,
  targets: Pick<TargetStore, 'get'>,
  allowed: (cardId: string) => boolean = () => true,
): () => void {
  return forge.subscribe((event) => {
    if (!allowed(event.type === 'spec' ? event.uiSpec.cardId : event.progress.cardId)) return;
    if (event.type === 'spec') {
      const target = targets.get(event.uiSpec.cardId);
      if (target && (target.state === 'failed' || target.abort?.signal.aborted || target.driver?.driverId !== event.uiSpec.driverId)) return;
      hub.broadcast('ui.spec', event.uiSpec);
      return;
    }

    const progress = event.progress;
    const target = targets.get(progress.cardId);
    if (progress.runId.startsWith('run-') && target && (
      target.runId !== progress.runId || target.abort?.signal.aborted || target.state === 'failed'
    )) return;

    hub.broadcast('agent.step', { ...stepGuidance(progress.phase, progress.status), ...toAgentStep(progress) });
    const item = progress.item;
    if (item) {
      hub.broadcast('ui.partial', {
        specId: forge.specIdFor(progress.cardId), cardId: progress.cardId, runId: progress.runId,
        seq: item.seq, control: item.control, hack: item.hack,
        ...(item.part ? { part: item.part } : {}),
        ...(item.hackItem ? { hackItem: item.hackItem } : {}),
      });
    }
  });
}
