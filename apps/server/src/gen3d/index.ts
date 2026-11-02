/**
 * gen3d-forge: verified Driver -> hack set + ce.gen3d/1 controls (Muse Spark), voice/typed edits as patches,
 * undo/redo, rearm on new evidence, record/replay. See forge.ts for the pipeline, research/12 for the numbers.
 *
 *   import { getForge } from './gen3d';
 *   const forge = getForge(ctx);                       // shared per server; broadcasts agent.step + ui.spec
 *   const r = await forge.generate({ device, driver, verification, onProgress });
 *   const e = await forge.edit({ specId: r.uiSpec!.specId, instruction: 'make the resonance control a big red lever' });
 *   forge.rearm(specId, { 'ir.warmer': 'pass' });
 */
export { compileHackset, previewHack, rearmSpec } from './compile';
export { applyEdit, EditSet, syncHackset } from './editPatch';
export {
  type CheckReport,
  createForge,
  DEFAULT_EFFORT,
  DEFAULT_FORGE_MODEL,
  type EditRequest,
  type EditResult,
  type Forge,
  type ForgeDeps,
  type ForgeEvent,
  ForgeInputError,
  type ForgeProgress,
  type ForgeRequest,
  type ForgeResult,
  ForgeSnapshot,
  MAX_REPAIRS,
  REPAIR_EFFORT,
  type UiSpec,
} from './forge';
export { ForgeAction, ForgeDevice, ForgeDriver, verificationOf, VerifyState } from './forgeTypes';
export { draftIssues } from './forgeVerify';
export { ForgeDraft, HackDraft } from './hackset';
export { gen3dRouter, getForge, RECORDED_GEN3D_DIR, skinsRouter, toAgentStep, useForge } from './routes';
export { LiveSkinPainter, ReplaySkinPainter, SKIN_MODEL, type SkinCrop, type SkinPainter, type SkinResult, SkinStore, skinPrompt } from './skin';
export { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DEVICE, FORGE_OP1_DRIVER, FORGE_OP1_VERIFIED } from './sampleDevices';
export { LiveTransport, loadRecordedRuns, type ModelTransport, ReplayTransport } from './transport';
