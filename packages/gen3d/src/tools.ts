/**
 * Two ways for a Meta model to produce a spec:
 *   1. one `response_format: json_schema` call for the whole Gen3dSpec (fast: ~8 s for a 2k-token spec,
 *      streams token by token; the client assembles the object as array items complete, see stream.ts);
 *   2. constrained tool calls (`add_control`, `add_part`, ...) when the object should be built in a loop
 *      with checks between steps (slower: one turn per batch of calls).
 * Both target the same schema, so `applyToolCall` is just an upsert into a spec under construction.
 */
import { z } from 'zod';
import { Anchor, ArmState, Behavior, Collection, Control, DeviceRef, Feedback, GEN3D_SPEC_VERSION, Gen3dSpec, Id, Part, Patch } from './schema';
import { assertMuseCompatible, toJsonSchema, type JsonSchema } from './jsonSchema';
import { applyOp } from './patch';

export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema; strict?: boolean };
}

const SetMetaArgs = z.object({
  title: z.string().min(1).max(40).optional(),
  device: DeviceRef.optional(),
  anchor: Anchor.optional(),
  state: ArmState.optional(),
  notes: z.string().max(400).optional(),
});
const RemoveArgs = z.object({ collection: Collection, id: Id });
const FinishArgs = z.object({ summary: z.string().max(200).optional() });

const TOOL_SCHEMAS = {
  set_meta: { schema: SetMetaArgs, description: 'Set the object title, the physical device it controls, where it is anchored (device/floating/surface/hand/world) and whether it is armed. Call first.' },
  add_control: { schema: Control, description: 'Add or replace one semantic control: kind (continuous/stepped/toggle/trigger/xy), label, range, default and the driver binding (midi.cc, ir.send, sim.*, or a generated driver action). Every control needs an archetype part or a behaviour that operates it.' },
  add_part: { schema: Part, description: 'Add or replace one 3D part. Prefer kind "archetype" (knob, fader, lever, button, toggle, dimmer-ring, pull-cord, xy-orb, pads, keys, wheel, hack-list, tag, outline, brackets, ping-line, link-matrix, upload-bar, daemon-link, worklog, model-chips...) with controlId and params; use kind "primitive"/"text"/"path" with parentId to compose novel objects. Positions in metres, +x right, +y up, +z toward the user.' },
  add_behavior: { schema: Behavior, description: 'Attach an affordance to a composed part: rotate/slide/press/toggle/pull/xy/grab, with axis, sweepDeg or travel, gestures and detents. Archetypes already include their behaviours.' },
  add_feedback: { schema: Feedback, description: 'Attach feedback to a control: glow, arc-fill, readout, tick (sound), particles, beam-pulse, scale-pop, color-shift, glitch; optionally on a specific part.' },
  remove_item: { schema: RemoveArgs, description: 'Remove a control, part (with its subtree), behaviour or feedback by id.' },
  finish: { schema: FinishArgs, description: 'Declare the object complete. The server validates it and renders it.' },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/** OpenAI-style function tools for chat/completions `tools` (strict false: optional fields allowed). */
export function gen3dTools(): FunctionTool[] {
  return (Object.keys(TOOL_SCHEMAS) as ToolName[]).map((name) => {
    const parameters = toJsonSchema(TOOL_SCHEMAS[name].schema);
    assertMuseCompatible(name, parameters);
    return { type: 'function', function: { name, description: TOOL_SCHEMAS[name].description, parameters, strict: false } };
  });
}

/** A fresh spec to build into with tool calls. */
export function emptySpec(specId: string, title = 'untitled', anchor: Anchor = { mode: 'floating', distance: 0.6, pitchDeg: -12 }): Gen3dSpec {
  return { spec: GEN3D_SPEC_VERSION, specId, rev: 1, title, anchor, controls: [], parts: [], behaviors: [], feedback: [] };
}

export type ToolCallResult = { ok: true; spec: Gen3dSpec; finished: boolean } | { ok: false; error: string; issues?: string[] };

/** Apply one tool call (name + parsed JSON args) to a spec under construction. Does not validate the whole spec. */
export function applyToolCall(spec: Gen3dSpec, name: string, args: unknown): ToolCallResult {
  if (!(name in TOOL_SCHEMAS)) return { ok: false, error: `unknown tool ${name}` };
  const tool = TOOL_SCHEMAS[name as ToolName];
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) return { ok: false, error: `invalid arguments for ${name}`, issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) };
  const next = structuredClone(spec);
  const a = parsed.data;
  switch (name as ToolName) {
    case 'set_meta': {
      const m = a as z.infer<typeof SetMetaArgs>;
      if (m.title) next.title = m.title;
      if (m.device) next.device = m.device;
      if (m.anchor) next.anchor = m.anchor;
      if (m.state) next.state = m.state;
      if (m.notes !== undefined) next.notes = m.notes;
      return { ok: true, spec: next, finished: false };
    }
    case 'add_control':
      applyOp(next, { op: 'upsert', control: a as Control });
      return { ok: true, spec: next, finished: false };
    case 'add_part':
      applyOp(next, { op: 'upsert', part: a as Part });
      return { ok: true, spec: next, finished: false };
    case 'add_behavior':
      applyOp(next, { op: 'upsert', behavior: a as Behavior });
      return { ok: true, spec: next, finished: false };
    case 'add_feedback':
      applyOp(next, { op: 'upsert', feedback: a as Feedback });
      return { ok: true, spec: next, finished: false };
    case 'remove_item': {
      const r = a as z.infer<typeof RemoveArgs>;
      const e = applyOp(next, { op: 'remove', collection: r.collection, id: r.id });
      return e ? { ok: false, error: e } : { ok: true, spec: next, finished: false };
    }
    case 'finish':
      return { ok: true, spec: next, finished: true };
  }
  return { ok: false, error: `unhandled tool ${name}` };
}

/** `response_format` for a whole-spec generation call. */
export function specResponseFormat(name = 'gen3d_spec') {
  const schema = toJsonSchema(Gen3dSpec);
  assertMuseCompatible(name, schema);
  return { type: 'json_schema' as const, json_schema: { name, schema, strict: false, description: 'A ce.gen3d/1 generated 3D control object. Give every control an archetype part (controlId) and keep ids short.' } };
}

/** `response_format` for an edit call that returns a Patch against the current spec. */
export function patchResponseFormat(name = 'gen3d_patch') {
  const schema = toJsonSchema(Patch);
  assertMuseCompatible(name, schema);
  return { type: 'json_schema' as const, json_schema: { name, schema, strict: false, description: 'A ce.gen3d/1 patch: upsert/remove items by id, or set title/anchor/state. baseRev must equal the current rev.' } };
}
