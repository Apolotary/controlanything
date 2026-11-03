import type { WorkspaceContext } from '@ce/protocol';
import type { AssistantView, MappingOutcome } from '../hud/contract';

/** Presentation only. Server-owned setup, verification and control authority are never derived here. */
export interface WorkspaceInputs {
  scope: 'general' | 'device';
  targetId?: string;
  presentation?: Pick<WorkspaceContext, 'surface' | 'stage'>;
  assistant?: AssistantView;
  setupWorking?: boolean;
  controlsReady?: boolean;
  mappingOutcome?: MappingOutcome;
  performance?: { enabled: boolean; live: boolean; trackingLost: boolean };
}

/** Freeze the task the wearer was looking at when they began a Muse request. */
export function workspaceContext(input: WorkspaceInputs): WorkspaceContext {
  if (input.scope === 'general') return {
    version: 1, scope: 'general', surface: 'menu', stage: 'choose', performance: 'off',
  };
  const assistant = input.assistant?.targetId === input.targetId ? input.assistant : undefined;
  const performing = input.performance?.enabled === true;
  const assistantVisible = !input.presentation || ['assistant', 'inspect'].includes(input.presentation.surface);
  const reviewing = assistantVisible && assistant?.state === 'proposal';
  const working = input.setupWorking || assistantVisible && assistant?.state === 'thinking';
  const stage = input.presentation?.surface === 'menu' ? 'choose' : performing ? 'perform' : reviewing ? 'review' : working ? 'building'
    : input.controlsReady ? 'ready' : input.presentation?.stage ?? 'prepare';
  const surface = input.presentation?.surface ?? (assistant ? assistant.objectInfo ? 'inspect' : 'assistant' : 'device');
  const pending: WorkspaceContext['pending'] = assistant?.state === 'proposal' ? {
    kind: assistant.proposalKind ?? 'gesture', state: 'review',
  } : input.setupWorking ? { kind: 'setup', state: 'working' } : undefined;
  return {
    version: 1, scope: 'device', surface, stage,
    performance: !performing ? 'off' : input.performance!.trackingLost ? 'tracking-lost' : input.performance!.live ? 'live' : 'paused',
    ...(pending ? { pending } : {}), ...(input.mappingOutcome ? { mappingOutcome: input.mappingOutcome } : {}),
  };
}
