import { WorkspaceContext, type VoiceTextPayload } from '@ce/protocol';
import type { AssistantDevice } from './assistant';

const GENERAL_CARD = 'muse-general';
const mismatch = 'The visible workspace no longer matches this request. Select the intended device and ask again. No controls were changed.';

/** Used before both model planning and legacy shortcuts. Emergency Stop remains global. */
export function workspaceScopeIssue(input: Pick<VoiceTextPayload, 'cardId' | 'specId' | 'workspace'>): string | undefined {
  if (!input.workspace) return;
  const parsed = WorkspaceContext.safeParse(input.workspace);
  if (!parsed.success) return mismatch;
  const workspace = parsed.data;
  if (input.cardId === GENERAL_CARD) {
    if (workspace.scope !== 'general' || workspace.selected || workspace.pending || workspace.mappingOutcome
      || workspace.performance !== 'off' || input.specId) return mismatch;
  } else if (workspace.scope !== 'device' || !input.cardId || workspace.selected?.cardId !== input.cardId
    || workspace.selected?.specId !== input.specId) return mismatch;
}

export function workspaceRevisionIssue(input: VoiceTextPayload, device: AssistantDevice): string | undefined {
  const selected = input.workspace?.selected;
  if (!selected) return;
  if (selected.identityRevision !== undefined && selected.identityRevision !== (device.identityRevision ?? 0)) {
    return 'This object’s identity changed after the request started. Select it again and retry. No controls were changed.';
  }
  if (selected.specId !== undefined && selected.specId !== device.spec?.specId
    || selected.specRevision !== undefined && (!device.spec || selected.specRevision !== (device.spec.rev ?? 1))) {
    return 'The device controls changed after the request started. Review the current controls and ask again. No controls were changed.';
  }
}

/** Separate browser observations from current server facts; neither implies a new action occurred. */
export function assistantWorkspaceFacts(input: VoiceTextPayload, device?: AssistantDevice) {
  if (!input.workspace) return undefined;
  return {
    observedAtRequestStart: {
      source: 'requesting-client' as const,
      surface: input.workspace.surface,
      stage: input.workspace.stage,
      performance: input.workspace.performance,
      pending: input.workspace.pending,
      mappingOutcome: input.workspace.mappingOutcome,
    },
    selectedDevice: device ? { source: 'server' as const, cardId: device.cardId, name: device.name,
      identityRevision: device.identityRevision ?? 0 } : null,
    currentControls: device?.spec ? { source: 'server' as const, specId: device.spec.specId, revision: device.spec.rev ?? 1,
      gestureMap: device.spec.gestureMap ?? null,
      verifiedActionIds: Object.entries(device.verification).filter(([, result]) => result === 'pass').map(([id]) => id),
      armed: device.armed } : null,
  };
}
