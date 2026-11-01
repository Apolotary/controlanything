import { describe, expect, it } from 'vitest';
import {
  EXAMPLES,
  Gen3dSpec,
  LIMITS,
  Patch,
  SpecHistory,
  applyPatch,
  applyToolCall,
  assertMuseCompatible,
  completeArrayItems,
  countProperties,
  emptySpec,
  expandSpec,
  gen3dTools,
  hasRef,
  jsonSchemaDepth,
  op1Knobs,
  patchResponseFormat,
  repairSpec,
  scanPartialSpec,
  specResponseFormat,
  toJsonSchema,
  validateSpec,
  type Gen3dSpec as Spec,
} from './index';

describe('examples', () => {
  for (const [name, spec] of Object.entries(EXAMPLES)) {
    it(`${name} validates with no errors and stays within budget`, () => {
      const r = validateSpec(spec);
      if (!r.ok) console.error(name, r.errors);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.stats.triangles).toBeLessThanOrEqual(LIMITS.triangles);
        expect(r.stats.expandedParts).toBeLessThanOrEqual(LIMITS.expandedParts);
        // only "unhandled" and size warnings are tolerated in examples
        for (const w of r.warnings) expect(['control.unhandled', 'size.target', 'archetype.contour', 'budget.extent']).toContain(w.code);
      }
    });
  }

  it('survives a JSON round trip', () => {
    const r = validateSpec(JSON.parse(JSON.stringify(op1Knobs)));
    expect(r.ok).toBe(true);
  });
});

describe('JSON Schema export', () => {
  it('whole spec schema is Muse-compatible (depth <= 10, no $ref, < 5000 properties)', () => {
    const json = toJsonSchema(Gen3dSpec);
    expect(hasRef(json)).toBe(false);
    expect(jsonSchemaDepth(json)).toBeLessThanOrEqual(10);
    expect(countProperties(json)).toBeLessThan(5000);
    expect(() => assertMuseCompatible('gen3d_spec', json)).not.toThrow();
    expect(specResponseFormat().json_schema.name).toBe('gen3d_spec');
    expect(patchResponseFormat().json_schema.schema).toBeTruthy();
  });

  it('patch schema is Muse-compatible', () => {
    const json = toJsonSchema(Patch);
    expect(hasRef(json)).toBe(false);
    expect(jsonSchemaDepth(json)).toBeLessThanOrEqual(10);
  });

  it('every tool has a compatible parameters schema', () => {
    const tools = gen3dTools();
    expect(tools.map((t) => t.function.name)).toEqual(['set_meta', 'add_control', 'add_part', 'add_behavior', 'add_feedback', 'remove_item', 'finish']);
    for (const t of tools) expect(jsonSchemaDepth(t.function.parameters)).toBeLessThanOrEqual(10);
  });
});

describe('archetype expansion', () => {
  it('a knob expands into a rotating cap with an arc, a readout and a tick', () => {
    const ex = expandSpec(op1Knobs);
    const rotate = ex.behaviors.find((b) => b.id === 'k1.rotate');
    expect(rotate).toMatchObject({ partId: 'k1.cap', controlId: 'blue', type: 'rotate', axis: 'z' });
    expect(ex.feedback.some((f) => f.type === 'arc-fill' && f.partId === 'k1.arc')).toBe(true);
    expect(ex.feedback.some((f) => f.type === 'readout' && f.partId === 'k1.value')).toBe(true);
    expect(ex.parts.find((p) => p.id === 'k1')?.kind).toBe('group');
    expect(ex.origin.get('k1.cap')).toBe('k1');
    // a grab handle is added for grabbable anchors
    expect(ex.behaviors.some((b) => b.type === 'grab')).toBe(true);
  });

  it('hack-list rows press their item controls', () => {
    const ex = expandSpec(EXAMPLES['ceiling-dimmer']!);
    const presses = ex.behaviors.filter((b) => b.partId.startsWith('hacks.row'));
    expect(presses.map((b) => b.controlId)).toEqual(['full', 'night', 'off']);
  });
});

describe('validation', () => {
  const base = (): Spec => structuredClone(op1Knobs);

  it('rejects dangling references and incompatible kinds', () => {
    const s = base();
    s.parts.push({ id: 'bad', kind: 'archetype', archetype: 'knob', controlId: 'nope' });
    s.parts.push({ id: 'bad2', kind: 'archetype', archetype: 'button', controlId: 'blue' });
    (s.behaviors ??= []).push({ id: 'b', partId: 'missing', controlId: 'blue', type: 'slide' });
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('ref.control');
    expect(codes).toContain('archetype.kind');
    expect(codes).toContain('ref.part');
  });

  it('rejects parent cycles and over-deep trees', () => {
    const s = base();
    s.parts.push({ id: 'a', parentId: 'b', kind: 'group' }, { id: 'b', parentId: 'a', kind: 'group' });
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'part.cycle')).toBe(true);
    const deep = base();
    let parent: string | undefined;
    for (let i = 0; i < 10; i++) {
      deep.parts.push({ id: `d${i}`, kind: 'group', ...(parent ? { parentId: parent } : {}) });
      parent = `d${i}`;
    }
    const r2 = validateSpec(deep);
    expect(r2.ok).toBe(false);
    expect(r2.errors.some((e) => e.code === 'part.depth')).toBe(true);
  });

  it('warns about controls nothing operates and undersized targets', () => {
    const s = base();
    s.controls.push({ id: 'lonely', kind: 'continuous', label: 'LONELY', binding: { action: 'midi.cc', cc: 9 } });
    s.parts[2]!.params = { size: 0.02 };
    const r = validateSpec(s);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['control.unhandled', 'size.target']));
  });

  it('repairSpec drops dangling ids, clamps defaults and enlarges tiny targets', () => {
    const s = base() as unknown as Record<string, unknown>;
    (s.parts as Record<string, unknown>[]).push({ id: 'x', kind: 'archetype', archetype: 'knob', controlId: 'ghost', parentId: 'nowhere', params: { size: 0.01 } });
    (s.controls as Record<string, unknown>[])[0]!.default = 999;
    (s.behaviors as unknown[] | undefined) ?? (s.behaviors = []);
    (s.behaviors as Record<string, unknown>[]).push({ id: 'z', partId: 'nowhere', controlId: 'blue', type: 'slide' });
    const { spec, fixes } = repairSpec(s);
    expect(fixes.length).toBeGreaterThanOrEqual(4);
    const x = (spec as Spec).parts.find((p) => p.id === 'x')!;
    expect(x.parentId).toBeUndefined();
    expect(x.controlId).toBeUndefined();
    expect(x.params?.size).toBe(LIMITS.minTargetM);
    expect((spec as Spec).controls[0]!.default).toBe(127);
    expect((spec as Spec).behaviors).toHaveLength(0);
  });
});

describe('patches and history', () => {
  it('upsert bumps the revision and leaves untouched items identical', () => {
    const r = applyPatch(op1Knobs, { specId: op1Knobs.specId, baseRev: 1, ops: [{ op: 'upsert', part: { id: 'k1', kind: 'archetype', archetype: 'knob', controlId: 'blue', params: { size: 0.09 }, transform: { position: [-0.14, 0, 0] } } }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.rev).toBe(2);
      expect(r.spec.parts.find((p) => p.id === 'k1')?.params?.size).toBe(0.09);
      expect(r.spec.parts.find((p) => p.id === 'k2')).toEqual(op1Knobs.parts.find((p) => p.id === 'k2'));
    }
  });

  it('refuses a stale baseRev', () => {
    const r = applyPatch(op1Knobs, { specId: op1Knobs.specId, baseRev: 7, ops: [{ op: 'set', title: 'x' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('patch.conflict');
  });

  it('removing a part removes its subtree and dependent behaviours', () => {
    const lever = EXAMPLES['resonance-lever']!;
    const r = applyPatch(lever, { specId: lever.specId, baseRev: 1, ops: [{ op: 'remove', collection: 'parts', id: 'arm' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.parts.some((p) => p.id === 'rod' || p.id === 'ball')).toBe(false);
      expect(r.spec.behaviors ?? []).toHaveLength(0);
      expect(r.spec.feedback?.some((f) => f.partId === 'ball')).toBe(false);
    }
  });

  it('history undoes non-destructively (undo publishes a new rev)', () => {
    const h = new SpecHistory(op1Knobs);
    const r = h.apply({ specId: op1Knobs.specId, baseRev: 1, ops: [{ op: 'set', title: 'Bigger' }] });
    expect(r.ok).toBe(true);
    expect(h.current?.title).toBe('Bigger');
    const back = h.undo();
    expect(back?.title).toBe(op1Knobs.title);
    expect(back?.rev).toBe(3);
    expect(h.canRedo).toBe(true);
    expect(h.redo()?.title).toBe('Bigger');
  });
});

describe('tool calls', () => {
  it('builds a valid spec from a sequence of tool calls', () => {
    let spec = emptySpec('t1');
    const steps: [string, unknown][] = [
      ['set_meta', { title: 'Lamp', anchor: { mode: 'floating', distance: 0.6 }, device: { name: 'Lamp', transport: 'ir' } }],
      ['add_control', { id: 'dim', kind: 'continuous', label: 'DIM', range: { min: 0, max: 100, step: 5 }, default: 50, unit: '%', binding: { action: 'ir.send' } }],
      ['add_part', { id: 'ring', kind: 'archetype', archetype: 'dimmer-ring', controlId: 'dim' }],
      ['finish', {}],
    ];
    let finished = false;
    for (const [name, args] of steps) {
      const r = applyToolCall(spec, name, args);
      expect(r.ok).toBe(true);
      if (r.ok) {
        spec = r.spec;
        finished = r.finished;
      }
    }
    expect(finished).toBe(true);
    const v = validateSpec(spec);
    expect(v.ok).toBe(true);
  });

  it('rejects bad arguments with issues', () => {
    const r = applyToolCall(emptySpec('t2'), 'add_control', { id: 'x', kind: 'nope' });
    expect(r.ok).toBe(false);
  });
});

describe('streaming assembly', () => {
  it('extracts complete array items from truncated JSON (alphabetical key order)', () => {
    const full = JSON.stringify(op1Knobs);
    const cut = full.slice(0, Math.floor(full.length * 0.6));
    const items = completeArrayItems(full, 'parts');
    expect(items).toHaveLength(op1Knobs.parts.length);
    const partial = scanPartialSpec(cut);
    expect(partial.controls.length).toBeGreaterThan(0);
    expect(partial.parts.length).toBeLessThanOrEqual(op1Knobs.parts.length);
    expect(partial.title).toBe(op1Knobs.title);
    expect(partial.rejected).toBe(0);
  });

  it('ignores braces inside strings', () => {
    const text = '{"parts":[{"id":"a","kind":"group","name":"} tricky {"},{"id":"b","kind":"gro';
    expect(completeArrayItems(text, 'parts')).toHaveLength(1);
  });
});
