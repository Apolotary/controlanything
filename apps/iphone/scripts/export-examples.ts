/**
 * Export the hand-written ce.gen3d/1 example specs (packages/gen3d) that have controls as JSON files the
 * iPhone app bundles as offline "demo surfaces" (labelled DEMO in the app; they never send anything).
 *
 *   npx tsx apps/iphone/scripts/export-examples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES } from '../../../packages/gen3d/src/index';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../ControlEverything/Resources/Examples');
mkdirSync(out, { recursive: true });

let n = 0;
// HUD-only examples (the palm deck, the work log, the scan scene) are not device surfaces
const SKIP = new Set(['deck', 'agent-worklog', 'scan-scene']);
for (const [name, spec] of Object.entries(EXAMPLES)) {
  if (SKIP.has(name) || !spec.controls?.length) continue;
  writeFileSync(join(out, `example-${name}.json`), JSON.stringify(spec, null, 2) + '\n');
  n++;
  console.log(`wrote example-${name}.json (${spec.controls.length} controls)`);
}
console.log(`${n} example(s) -> ${out}`);
