/**
 * zod -> JSON Schema for Muse `response_format` / tool `parameters` and for non-TS clients.
 * Meta Model API limits (dev.meta.ai/docs/structured-output): no recursion, depth <= 10, <= 5000 properties.
 */
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;
export const MAX_SCHEMA_DEPTH = 10;

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    cycles: 'throw',
    reused: 'inline',
    unrepresentable: 'throw',
  }) as JsonSchema;
  const { $schema: _drop, ...rest } = normalize(out) as JsonSchema;
  return rest;
}

/** Drop `propertyNames: {type: "string"}` (always true for JSON). */
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

/** Nesting depth in object/array levels (root object = 1); union branches add no level. */
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

export function hasRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRef);
  if (!node || typeof node !== 'object') return false;
  return Object.entries(node as JsonSchema).some(([k, v]) => k === '$ref' || hasRef(v));
}

/** Count `properties` entries across the whole schema (Meta caps the total at 5000). */
export function countProperties(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n, v) => n + countProperties(v), 0);
  if (!node || typeof node !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(node as JsonSchema)) {
    if (k === 'properties' && v && typeof v === 'object') n += Object.keys(v as object).length;
    n += countProperties(v);
  }
  return n;
}

/** Throws when a schema would be rejected by the Meta Model API. */
export function assertMuseCompatible(name: string, json: JsonSchema): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`schema name "${name}" must be 1-64 chars of [A-Za-z0-9_-]`);
  if (hasRef(json)) throw new Error(`schema "${name}" contains $ref; inline it (no recursion allowed)`);
  const depth = jsonSchemaDepth(json);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`schema "${name}" nests ${depth} levels; the Meta API allows ${MAX_SCHEMA_DEPTH}`);
  const props = countProperties(json);
  if (props > 5000) throw new Error(`schema "${name}" has ${props} properties; the Meta API allows 5000`);
}

export interface ResponseFormatJsonSchema {
  type: 'json_schema';
  json_schema: { name: string; schema: JsonSchema; description?: string; strict?: boolean };
}

/** Build a chat/completions `response_format` for a whole-spec or patch generation call. */
export function museResponseFormat(name: string, schema: z.ZodType, description?: string): ResponseFormatJsonSchema {
  const json = toJsonSchema(schema);
  assertMuseCompatible(name, json);
  const json_schema: ResponseFormatJsonSchema['json_schema'] = { name, schema: json, strict: false };
  if (description) json_schema.description = description;
  return { type: 'json_schema', json_schema };
}
