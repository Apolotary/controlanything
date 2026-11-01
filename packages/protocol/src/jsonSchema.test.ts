import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  formatCode,
  hasRef,
  isValidCode,
  jsonSchemaDepth,
  MAX_SCHEMA_DEPTH,
  Message,
  MESSAGE_TYPES,
  MessageSchemas,
  museResponseFormat,
  normalizeCode,
  PayloadSchemas,
  toJsonSchema,
} from './index';

describe('JSON Schema export', () => {
  it.each(MESSAGE_TYPES)('%s converts without $ref and within the depth limit', (type) => {
    const payload = toJsonSchema(PayloadSchemas[type]);
    const full = toJsonSchema(MessageSchemas[type]);
    expect(hasRef(full)).toBe(false);
    expect(jsonSchemaDepth(full)).toBeLessThanOrEqual(MAX_SCHEMA_DEPTH);
    expect(jsonSchemaDepth(payload)).toBeLessThanOrEqual(MAX_SCHEMA_DEPTH - 1);
    expect(JSON.stringify(full)).not.toContain('propertyNames');
  });

  it('converts the whole message union', () => {
    const s = toJsonSchema(Message);
    expect(Array.isArray(s.oneOf) || Array.isArray(s.anyOf)).toBe(true);
    expect(hasRef(s)).toBe(false);
  });

  it('builds a Muse response_format for model-generated payloads', () => {
    for (const [name, schema] of [
      ['device_card', PayloadSchemas['device.card']],
      ['ui_spec', PayloadSchemas['ui.spec']],
      ['driver_spec', PayloadSchemas['driver.spec']],
      ['driver_deploy', PayloadSchemas['driver.deploy']],
      ['agent_step', PayloadSchemas['agent.step']],
    ] as const) {
      const rf = museResponseFormat(name, schema);
      expect(rf.type).toBe('json_schema');
      expect(rf.json_schema.name).toBe(name);
      expect(rf.json_schema.strict).toBe(false);
      expect(rf.json_schema.schema.$schema).toBeUndefined();
      expect(rf.json_schema.schema.type).toBe('object');
    }
  });

  it('rejects bad names and over-deep schemas', () => {
    expect(() => museResponseFormat('has space', z.object({}))).toThrow(/name/);
    let deep: z.ZodType = z.object({ leaf: z.string() });
    for (let i = 0; i < 11; i++) deep = z.object({ next: deep });
    expect(() => museResponseFormat('deep', deep)).toThrow(/nests/);
  });

  it('counts depth in object/array levels', () => {
    expect(jsonSchemaDepth({ type: 'string' })).toBe(0);
    expect(jsonSchemaDepth({ type: 'object', properties: { a: { type: 'string' } } })).toBe(1);
    expect(jsonSchemaDepth({ type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: {} } } } })).toBe(3);
    expect(jsonSchemaDepth({ anyOf: [{ type: 'object', properties: {} }, { type: 'number' }] })).toBe(1);
  });
});

describe('pairing codes', () => {
  it('normalises and formats', () => {
    expect(normalizeCode('k7q-4m2')).toBe('K7Q4M2');
    expect(normalizeCode(' K7Q 4M2 ')).toBe('K7Q4M2');
    expect(formatCode('K7Q4M2')).toBe('K7Q-4M2');
    expect(isValidCode('K7Q-4M2')).toBe(true);
    expect(isValidCode('K7Q-4M')).toBe(false);
    expect(isValidCode('K0Q-4M2')).toBe(false); // 0 is not in the alphabet
  });
});
