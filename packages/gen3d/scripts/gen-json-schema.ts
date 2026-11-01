/**
 * Writes packages/gen3d/json-schema/*.json: the spec, the patch, the control event, the function tools and
 * the example specs, for the server (Muse response_format / tools) and for non-TS clients.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlEvent, EXAMPLES, Gen3dSpec, Patch, assertMuseCompatible, gen3dTools, jsonSchemaDepth, toJsonSchema } from '../src/index';

const outDir = fileURLToPath(new URL('../json-schema/', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.json')) rmSync(join(outDir, f));

const files: Record<string, unknown> = {};
const spec = toJsonSchema(Gen3dSpec);
assertMuseCompatible('gen3d_spec', spec);
files['gen3d-spec.json'] = { title: 'ce.gen3d/1', ...spec };
const patch = toJsonSchema(Patch);
assertMuseCompatible('gen3d_patch', patch);
files['gen3d-patch.json'] = { title: 'ce.gen3d/1 patch', ...patch };
files['control-event.json'] = { title: 'ce.gen3d/1 control event', ...toJsonSchema(ControlEvent) };
files['tools.json'] = gen3dTools();
for (const [name, ex] of Object.entries(EXAMPLES)) files[`example-${name}.json`] = ex;

for (const [file, json] of Object.entries(files)) writeFileSync(join(outDir, file), `${JSON.stringify(json, null, 2)}\n`);
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ spec: 'ce.gen3d/1', files: Object.keys(files), specDepth: jsonSchemaDepth(spec) }, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length + 1} files to ${outDir} (spec depth ${jsonSchemaDepth(spec)})`);
