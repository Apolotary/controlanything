/**
 * zod -> JSON Schema, for non-TS clients (Unity, ESP32, Python) and for Muse `response_format`.
 *
 * Meta Model API json_schema limits (dev.meta.ai/docs/structured-output): no recursion / $ref cycles,
 * nesting depth <= 10, <= 5000 properties, <= 1000 enum values; name <= 64 chars [A-Za-z0-9_-].
 * `strict: true` only adds OpenAI-style strict-subset validation (every key required, no oneOf),
 * which our optional fields would fail, so it defaults to false; decoding is constrained either way.
 */
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export const MAX_SCHEMA_DEPTH = 10;

export interface ToJsonSchemaOptions {
  target?: 'draft-2020-12' | 'draft-7';
  /** "output" (default) marks fields with defaults as required; "input" describes what a sender may omit */
  io?: 'input' | 'output';
}

/** Convert a zod schema; inlines shared sub-schemas and throws on cycles or unrepresentable types. */
export function toJsonSchema(schema: z.ZodType, opts: ToJsonSchemaOptions = {}): JsonSchema {
  const out = z.toJSONSchema(schema, {
    target: opts.target ?? 'draft-2020-12',
    io: opts.io ?? 'output',
    cycles: 'throw',
    reused: 'inline',
    unrepresentable: 'throw',
  }) as JsonSchema;
  return normalize(out) as JsonSchema;
}

/** Drop `propertyNames: {type: "string"}` (always true for JSON) to keep schemas small and portable. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'propertyNames' && v && typeof v === 'object' && (v as JsonSchema).type === 'string' && Object.keys(v).length === 1) continue;
    out[k] = normalize(v);
  }
  return out;
}

const CHILD_MAPS = ['properties', '$defs', 'definitions', 'patternProperties'] as const;
const CHILD_NODES = ['items', 'additionalProperties', 'contains', 'not'] as const;
const CHILD_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;

/** Nesting depth counted in object/array levels (the root object is 1). Union branches add no level. */
export function jsonSchemaDepth(node: unknown): number {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  const s = node as JsonSchema;
  let child = 0;
  for (const key of CHILD_MAPS) {
    const map = s[key];
    if (map && typeof map === 'object') for (const v of Object.values(map)) child = Math.max(child, jsonSchemaDepth(v));
  }
  for (const key of CHILD_NODES) child = Math.max(child, jsonSchemaDepth(s[key]));
  for (const key of CHILD_LISTS) {
    const list = s[key];
    if (Array.isArray(list)) for (const v of list) child = Math.max(child, jsonSchemaDepth(v));
  }
  const isContainer = s.type === 'object' || s.type === 'array' || 'properties' in s || 'items' in s;
  return (isContainer ? 1 : 0) + child;
}

/** True when the schema contains a $ref anywhere (we never want one: Meta rejects cycles). */
export function hasRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRef);
  if (!node || typeof node !== 'object') return false;
  return Object.entries(node as JsonSchema).some(([k, v]) => k === '$ref' || hasRef(v));
}

export interface ResponseFormatJsonSchema {
  type: 'json_schema';
  json_schema: { name: string; schema: JsonSchema; description?: string; strict?: boolean };
}

/**
 * Build a Muse chat/completions `response_format` from a zod schema.
 * Throws if the name or the schema breaks the documented limits.
 */
export function museResponseFormat(
  name: string,
  schema: z.ZodType,
  opts: { description?: string; strict?: boolean } = {},
): ResponseFormatJsonSchema {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`response_format name "${name}" must be 1-64 chars of [A-Za-z0-9_-]`);
  const { $schema: _drop, ...json } = toJsonSchema(schema);
  if (hasRef(json)) throw new Error(`schema "${name}" contains $ref; inline it (no recursion allowed)`);
  const depth = jsonSchemaDepth(json);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`schema "${name}" nests ${depth} levels; the Meta API allows ${MAX_SCHEMA_DEPTH}`);
  const json_schema: ResponseFormatJsonSchema['json_schema'] = { name, schema: json, strict: opts.strict ?? false };
  if (opts.description) json_schema.description = opts.description;
  return { type: 'json_schema', json_schema };
}
