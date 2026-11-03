import { describe, expect, it } from 'vitest';
import { ProjectDocument, ProjectPresetPayload, ProjectSpec, ProjectValues } from './projects';
import { makeMessage, parseMessage } from './messages';
import { toJsonSchema } from './jsonSchema';

describe('project input values', () => {
  it('keeps action names and size bounded without unsupported JSON Schema keywords', () => {
    expect(ProjectValues.parse({ amount: 0.5, shuffle: 2 })).toEqual({ amount: 0.5, shuffle: 2 });
    expect(ProjectValues.safeParse({ constructor: 1 }).success).toBe(false);
    expect(ProjectValues.safeParse({ 'bad-name': 1 }).success).toBe(false);
    expect(ProjectValues.safeParse(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`input${i}`, i]))).success).toBe(false);
    expect(ProjectValues.safeParse({ amount: Infinity }).success).toBe(false);
    expect(JSON.stringify(toJsonSchema(ProjectValues))).not.toContain('propertyNames');
  });
});

describe('authored project starters', () => {
  it('accepts only an explicit known starter request with no client-supplied code', () => {
    const payload = { requestId: 'preset-request', presetId: 'chord-garden-v1' as const };
    const parsed = parseMessage(makeMessage('project.preset', payload));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message.payload).toEqual(payload);
    expect(ProjectPresetPayload.safeParse({ ...payload, presetId: 'arbitrary-code' }).success).toBe(false);
    expect(ProjectPresetPayload.safeParse({ ...payload, js: 'doSomething()' }).success).toBe(false);
  });
  it('keeps preset provenance local to project documents and rejects mixed identities', () => {
    const document = { projectId: 'chord-project', revision: 1, prompt: 'Built-in chords', createdAt: 1,
      spec: { title: 'Chords', description: '', html: '', css: '', js: '', actions: [] },
      source: 'preset', presetId: 'chord-garden-v1' };
    expect(ProjectDocument.safeParse(document).success).toBe(true);
    expect(ProjectDocument.safeParse({ ...document, source: 'live' }).success).toBe(false);
    expect(ProjectDocument.safeParse({ ...document, source: 'fixture' }).success).toBe(false);
    expect(ProjectDocument.safeParse({ ...document, presetId: undefined }).success).toBe(false);
    expect(ProjectDocument.safeParse({ ...document, source: 'live', presetId: undefined }).success).toBe(true);
    expect(() => toJsonSchema(ProjectDocument)).not.toThrow();
  });
});


describe('bounded generated AR scenes', () => {
  const spec = { title: 'Ripple rings', description: 'Height controls concentric ring size', html: '<main>Rings</main>', css: '', js: '',
    actions: [{ id: 'amount', label: 'Ring size', kind: 'number', min: 0, max: 1, initial: .5 }],
    spatial: { kind: 'ripples', color: '#40ccff', actionId: 'amount' } };
  it('accepts the two supported recipes with a declared numeric binding and exports a model schema', () => {
    expect(ProjectSpec.parse(spec).spatial).toEqual(spec.spatial);
    expect(ProjectSpec.parse({ ...spec, spatial: { ...spec.spatial, kind: 'orb' } }).spatial?.kind).toBe('orb');
    expect(() => toJsonSchema(ProjectSpec)).not.toThrow();
  });
  it('rejects unknown geometry, code, URLs, unbounded colors and missing/trigger bindings', () => {
    for (const spatial of [
      { ...spec.spatial, kind: 'shader' }, { ...spec.spatial, js: 'execute()' }, { ...spec.spatial, url: 'https://model.test/shape.glb' },
      { ...spec.spatial, color: 'url(evil)' }, { ...spec.spatial, actionId: 'missing' },
    ]) expect(ProjectSpec.safeParse({ ...spec, spatial }).success).toBe(false);
    expect(ProjectSpec.safeParse({ ...spec, actions: [{ id: 'amount', label: 'Trigger', kind: 'trigger' }] }).success).toBe(false);
  });
});
