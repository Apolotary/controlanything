/**
 * A "kit" is everything spec-specific the generator needs: the schemas the model writes (spec and patch),
 * the catalog for the prompt, deterministic verification, patch application, tool calls and fixtures.
 * The pipeline, store, routes and replay are kit-agnostic, so moving from the draft to the shared
 * ce.hackset/1 + ce.gen3d/1 schemas means writing a new kit, not a new pipeline.
 */
import type { z } from 'zod';
import type { DeviceDriver, Issue } from './driver';
import type { ToolDef } from '../stream';

export interface VerifyCtx {
  /** driver of the device the output is for */
  target: DeviceDriver;
  /** every paired device's driver (daemons may reach them), including the target */
  room: DeviceDriver[];
}

export interface AppliedPatch<Spec> {
  spec: Spec;
  /** ids the patch changed */
  touched: string[];
  errors: string[];
}

export interface ToolSession<Spec> {
  apply(name: string, args: string): { ok: boolean; result: string; item?: { kind: string; id: string; value?: unknown } };
  readonly done: boolean;
  /** the spec as built so far (may not validate yet) */
  current(): unknown;
}

export interface GenKit<Spec = unknown, Patch = unknown> {
  /** spec version string, also the prompt cache key */
  version: string;
  /** response_format names (<= 64 chars of [A-Za-z0-9_-]); also the recording keys */
  specName: string;
  patchName: string;
  specSchema: z.ZodType<Spec>;
  patchSchema: z.ZodType<Patch>;
  catalogTable(): string;
  /** deterministic checks after the schema (bindings, geometry, safety); schema issues are the pipeline's */
  verify(spec: Spec, ctx: VerifyCtx): Issue[];
  applyPatch(spec: Spec, patch: Patch): AppliedPatch<Spec>;
  /** every addressable item by id (used to prove untouched items stay byte-identical after a patch) */
  items(spec: Spec): Map<string, unknown>;
  /** stamp server-owned fields (ids, device, version) the model should not be trusted with */
  normalize?(spec: Spec, ctx: VerifyCtx & { cardName: string }): Spec;
  /** tool-call mode (optional) */
  tools?(task: 'generate' | 'edit'): ToolDef[];
  toolSession?(device: { cardId: string; name: string; category?: string }, current?: Spec): ToolSession<Spec>;
}
