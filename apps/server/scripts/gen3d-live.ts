/**
 * Opt-in LIVE test of the gen3d forge (real Meta Model API calls, a few cents; hard cap $0.60):
 *   npx tsx apps/server/scripts/gen3d-live.ts [--only light|op1|edit] [--record] [--out DIR]
 * Forges hack sets for the ceiling light and the OP-1 Field from the sample verified drivers, then edits the
 * OP-1 spec ("make the resonance control a big red lever"). Prints every progress step with model id, effort
 * and latency, the check report, and saves each ui.spec as JSON. --record also saves the runs as replay
 * fixtures (apps/server/fixtures/recorded/gen3d/), which FIXTURE mode plays back without a key.
 * Reads MODEL_API_KEY from the repo-root .env; never prints it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SERVER_ROOT, loadDotEnv } from '../src/config';
import { CallLog, resolveMuseConfig } from '../src/muse';
import { createForge, type ForgeProgress, type ForgeResult } from '../src/gen3d/forge';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DEVICE, FORGE_OP1_DRIVER, FORGE_OP1_VERIFIED } from '../src/gen3d/sampleDevices';

loadDotEnv();
const cfg = resolveMuseConfig(process.env);
if (cfg.mode !== 'live') {
  console.log('FIXTURE mode (no MODEL_API_KEY): this script makes live calls only. Skipping.');
  process.exit(0);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? '') : undefined;
};
const only = arg('only');
const record = process.argv.includes('--record');
const out = arg('out') || join(REPO_ROOT, 'research/gen3d-live');
const CAP_USD = 0.6;
mkdirSync(out, { recursive: true });

const calls = new CallLog((l) => console.log(`  ${l}`));
const forge = createForge({ muse: cfg, callLog: calls, log: (l) => console.log(l), recordDir: record ? join(SERVER_ROOT, 'fixtures/recorded/gen3d') : undefined });
let spent = 0;

const show = (p: ForgeProgress) => {
  const meta = [p.model, p.effort, p.latencyMs !== undefined ? `${(p.latencyMs / 1000).toFixed(1)}s` : undefined, p.source === 'fixture' ? `FIXTURE(${p.recordedFrom})` : undefined].filter(Boolean).join(' · ');
  console.log(`  [${p.phase}:${p.status}] ${p.title}${p.detail ? ` — ${p.detail.slice(0, 160)}` : ''}  (${meta})`);
};

function summarize(name: string, r: ForgeResult) {
  spent += r.costUsd;
  console.log(`== ${name}: ok=${r.ok} ${(r.latencyMs / 1000).toFixed(1)}s attempts=${r.report.attempts} $${r.costUsd.toFixed(4)} (total $${spent.toFixed(3)}) model=${r.model} effort=${r.effort}`);
  if (r.report.errors.length) console.log('   errors:', r.report.errors.slice(0, 8).map((e) => `${e.code} ${e.path}: ${e.message}`));
  if (r.report.fixes.length) console.log('   fixes:', r.report.fixes.slice(0, 6));
  for (const h of r.report.history) console.log(`   attempt ${h.attempt} (${h.effort}, ${(h.latencyMs / 1000).toFixed(1)}s): ${h.errors} errors ${h.codes.join(',')}`);
  if (r.uiSpec) {
    const args = new Map(r.uiSpec.gen3d.controls.map((c) => [c.id, c]));
    for (const h of r.uiSpec.hackset.hacks) {
      const c = args.get(h.id);
      console.log(`   ${h.kind === 'control' ? 'C' : 'A'} ${h.name.padEnd(14)} ${h.control ? `[${h.control.archetype}/${h.control.size}${c?.binding.args?.drive === 'stepper' ? '/stepper' : ''}] ` : ''}${h.commands.map((x) => x.action).join('>')} ${h.oracle.type}:${h.oracle.expect} status=${h.status} armed=${c?.armed}`);
    }
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify(r.uiSpec, null, 2)}\n`);
    console.log(`   saved ${join(out, `${name}.json`)}`);
  }
  if (spent > CAP_USD) {
    console.log(`cost cap $${CAP_USD} reached; stopping`);
    process.exit(1);
  }
}

if (!only || only === 'light') {
  console.log('-- forge: ceiling light (learned IR codes, warmth not yet verified)');
  summarize('ceiling-light.hackset', await forge.forge({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, request: 'a dimmer for the IR ceiling light with on/off and night light, plus the rest of its hack set', onProgress: show }));
}
if (!only || only === 'op1' || only === 'edit') {
  console.log('-- forge: OP-1 Field');
  const r = await forge.forge({ device: FORGE_OP1_DEVICE, driver: FORGE_OP1_DRIVER, verification: FORGE_OP1_VERIFIED, request: "four knobs matching the OP-1 Field's encoders for its synth parameters, plus a few one-shot hacks", onProgress: show });
  summarize('op1-field.hackset', r);
  if (r.ok && r.uiSpec && only !== 'op1') {
    console.log('-- edit: make the resonance control a big red lever');
    const e = await forge.edit({ specId: r.uiSpec.specId, instruction: 'make the resonance control a big red lever', onProgress: show });
    summarize('op1-field.resonance-lever', e);
    console.log(`   touched=${e.touched.join(', ')} untouchedIdentical=${e.untouchedIdentical}`);
    const u = forge.undo(r.uiSpec.specId);
    console.log(`-- undo: ok=${u.ok} rev=${u.uiSpec?.rev} (same content as rev ${r.uiSpec.rev}: ${JSON.stringify(u.uiSpec?.gen3d.parts) === JSON.stringify(r.uiSpec.gen3d.parts)})`);
  }
}
console.log('calls:', calls.totals());
