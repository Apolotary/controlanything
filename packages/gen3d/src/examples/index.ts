import type { Gen3dSpec } from '../schema';
import { agentWorklog } from './agent-worklog';
import { ceilingDimmer } from './ceiling-dimmer';
import { deck } from './deck';
import { irLink } from './ir-link';
import { op1Knobs } from './op1-knobs';
import { resonanceLever } from './resonance-lever';
import { scanScene } from './scan-scene';

export { agentWorklog, ceilingDimmer, deck, irLink, op1Knobs, resonanceLever, scanScene };

/** Every example spec, keyed by a short name (used by the Quest gallery and the JSON Schema export). */
export const EXAMPLES: Record<string, Gen3dSpec> = {
  'op1-knobs': op1Knobs,
  'ceiling-dimmer': ceilingDimmer,
  'resonance-lever': resonanceLever,
  'ir-link': irLink,
  'scan-scene': scanScene,
  'agent-worklog': agentWorklog,
  deck,
};
