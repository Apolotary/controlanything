import { z } from 'zod';
import { Id, ModelSource } from './primitives';

/** Generated software has a named, bounded state interface, never a device capability. */
export const ProjectActionId = z.string().min(1).max(48).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .refine((id) => !['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'].includes(id), 'Reserved action name');
export const ProjectAction = z.object({
  id: ProjectActionId, label: z.string().min(1).max(64), kind: z.enum(['number', 'trigger']),
  min: z.number().finite().min(-1e6).max(1e6).optional(), max: z.number().finite().min(-1e6).max(1e6).optional(),
  initial: z.number().finite().min(-1e6).max(1e6).optional(),
}).strict().superRefine((a, ctx) => {
  if (a.kind === 'number' && (a.min === undefined || a.max === undefined || a.initial === undefined || a.min >= a.max || a.initial < a.min || a.initial > a.max))
    ctx.addIssue({ code: 'custom', message: 'Numeric actions require min < max and an initial value inside that range.' });
  if (a.kind === 'trigger' && [a.min, a.max, a.initial].some((v) => v !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Triggers have no numeric range.' });
});
export type ProjectAction = z.infer<typeof ProjectAction>;
/** Trusted AR renderer recipes. No shader/source/model URL or device capability is accepted. */
export const ProjectSpatialScene = z.object({
  kind: z.enum(['orb', 'ripples']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  actionId: ProjectActionId,
}).strict();
export type ProjectSpatialScene = z.infer<typeof ProjectSpatialScene>;

export const ProjectSpec = z.object({
  title: z.string().min(1).max(80), description: z.string().max(400),
  html: z.string().max(60000), css: z.string().max(30000), js: z.string().max(60000),
  actions: z.array(ProjectAction).max(8),
  spatial: ProjectSpatialScene.optional(),
}).strict().superRefine((spec, ctx) => {
  if (new Set(spec.actions.map((a) => a.id)).size !== spec.actions.length) ctx.addIssue({ code: 'custom', message: 'Action names must be unique.' });
  if (spec.spatial && !spec.actions.some(action => action.id === spec.spatial!.actionId && action.kind === 'number'))
    ctx.addIssue({ code: 'custom', path: ['spatial', 'actionId'], message: 'An AR scene must bind to a declared numeric action.' });
});
export type ProjectSpec = z.infer<typeof ProjectSpec>;
/** Checked-in software demos have distinct provenance from model-generated documents. */
export const ProjectPresetId = z.literal('chord-garden-v1');
export type ProjectPresetId = z.infer<typeof ProjectPresetId>;
export const ProjectDocument = z.object({
  projectId: Id, revision: z.number().int().positive(), cardId: Id.optional(), prompt: z.string().min(1).max(4000),
  spec: ProjectSpec, source: ModelSource.or(z.literal('preset')), presetId: ProjectPresetId.optional(),
  modelId: z.string().max(120).optional(), createdAt: z.number().finite(),
}).strict().superRefine((document, ctx) => {
  if ((document.source === 'preset') !== (document.presetId !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Preset identity requires preset provenance, and generated projects cannot claim a preset identity.' });
});
export type ProjectDocument = z.infer<typeof ProjectDocument>;
// Keep key constraints in runtime validation: constrained record keys emit propertyNames,
// which the model-facing JSON Schema subset does not support.
export const ProjectValues = z.record(z.string(), z.number().finite()).superRefine((values, ctx) => {
  const keys = Object.keys(values);
  if (keys.length > 8) ctx.addIssue({ code: 'custom', message: 'At most eight project input values are allowed.' });
  for (const key of keys) if (!ProjectActionId.safeParse(key).success)
    ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid or reserved project action name.' });
});
export const ProjectStatePayload = z.object({
  projectId: Id, status: z.enum(['generating', 'ready', 'error']), document: ProjectDocument.optional(),
  values: ProjectValues.optional(), revision: z.number().int().positive().optional(), sequence: z.number().int().nonnegative().optional(),
  message: z.string().max(600).optional(), requestId: Id.optional(),
  preview: z.object({ count: z.number().int().min(0).max(64) }).optional(),
});
export type ProjectStatePayload = z.infer<typeof ProjectStatePayload>;
export const ProjectCatalogPayload = z.object({ projects: z.array(z.object({ projectId: Id, title: z.string().max(80), revision: z.number().int().positive(), cardId: Id.optional() })).max(32) });
export type ProjectCatalogPayload = z.infer<typeof ProjectCatalogPayload>;
export const ProjectListPayload = z.object({}).strict();
export const ProjectGetPayload = z.object({ projectId: Id }).strict();
export const ProjectRequestPayload = z.object({ requestId: Id, projectId: Id.optional(), baseRevision: z.number().int().positive().optional(), cardId: Id.optional(), prompt: z.string().min(1).max(4000) }).strict();
export type ProjectRequestPayload = z.infer<typeof ProjectRequestPayload>;
export const ProjectPresetPayload = z.object({ requestId: Id, presetId: ProjectPresetId }).strict();
export type ProjectPresetPayload = z.infer<typeof ProjectPresetPayload>;
export const ProjectActionPayload = z.object({ requestId: Id, projectId: Id, revision: z.number().int().positive(), actionId: ProjectActionId, value: z.number().finite().optional(), requirePreview: z.boolean().optional() }).strict();
export type ProjectActionPayload = z.infer<typeof ProjectActionPayload>;
export const ProjectCancelPayload = z.object({ requestId: Id, projectId: Id }).strict();
/** Trusted studio reports a started sandbox; the server binds its lease to the socket. */
export const ProjectPreviewPayload = z.object({ projectId: Id, revision: z.number().int().positive(), active: z.boolean() }).strict();
export type ProjectPreviewPayload = z.infer<typeof ProjectPreviewPayload>;
