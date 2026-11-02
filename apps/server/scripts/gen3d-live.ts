/**
 * Opt-in LIVE test of the gen3d forge (real Meta Model API calls, a few cents; hard cap $0.60):
 *   npx tsx apps/server/scripts/gen3d-live.ts [--only light|op1|edit|loop] [--record] [--out DIR]
 * --only skins --crops DIR paints a muse-image-1.0 panel skin per loop device from DIR/{light,op1,mac}.jpg
 * (recorded under fixtures/recorded/gen3d/skins/ with --record; copies land in research/gen3d-live/skins/).
 * --only loop [--device light|op1|mac|devterm] forges the loop-shaped template drivers (light, OP-1 Field, this Mac) with the loop's
 * default request plus the resonance edit, so a recording exists per device category for the judge path.
 * Forges hack sets for the ceiling light and the OP-1 Field from the sample verified drivers, then edits the
 * OP-1 spec ("make the resonance control a big red lever"). Prints every progress step with model id, effort
 * and latency, the check report, and saves each ui.spec as JSON. --record also saves the runs as replay
 * fixtures (apps/server/fixtures/recorded/gen3d/), which FIXTURE mode plays back without a key.
 * Reads MODEL_API_KEY from the repo-root .env; never prints it.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SERVER_ROOT, loadDotEnv } from '../src/config';
import { CallLog, resolveMuseConfig } from '../src/muse';
import { createForge, type ForgeProgress, type ForgeResult } from '../src/gen3d/forge';
import { LiveSkinPainter, SkinStore } from '../src/gen3d/skin';
import { allPass, FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DEVICE, FORGE_OP1_DRIVER, FORGE_OP1_VERIFIED, LOOP_DEVTERM_DEVICE, LOOP_DEVTERM_DRIVER, LOOP_LIGHT_DEVICE, LOOP_LIGHT_DRIVER, LOOP_MAC_DEVICE, LOOP_MAC_DRIVER, LOOP_OP1_DEVICE, LOOP_OP1_DRIVER } from '../src/gen3d/sampleDevices';

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
if (only === 'skins') {
  const crops = arg('crops');
  const store = new SkinStore();
  const painter = new LiveSkinPainter({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, store, recordDir: record ? join(SERVER_ROOT, 'fixtures/recorded/gen3d/skins') : undefined, log: (l) => console.log(l) });
  mkdirSync(join(out, 'skins'), { recursive: true });
  const pick = arg('skin');
  for (const [name, device, driver] of [['light', LOOP_LIGHT_DEVICE, LOOP_LIGHT_DRIVER], ['op1', LOOP_OP1_DEVICE, LOOP_OP1_DRIVER], ['mac', LOOP_MAC_DEVICE, LOOP_MAC_DRIVER]] as const) {
    if (pick && pick !== name) continue;
    const crop = crops ? { jpegBase64: readFileSync(join(crops, `${name}.jpg`)).toString('base64') } : undefined;
    const r = await painter.paint({ device, transport: driver.transport, crop });
    spent += r.ok ? 0.01 : 0;
    console.log(`== skin ${name}: ok=${r.ok} ${r.mode} ${(r.latencyMs / 1000).toFixed(1)}s ${r.width}x${r.height} ${Math.round((r.bytes ?? 0) / 1024)}KB${r.error ? ` ERROR ${r.error}` : ''} (total $${spent.toFixed(2)})`);
    if (r.ok && r.skinId) writeFileSync(join(out, 'skins', `${name}.webp`), store.get(r.skinId)!.bytes);
  }
}
void copyFileSync;
if (only === 'loop') {
  const pickDevice = arg('device');
  for (const [name, device, driver] of [['loop.light', LOOP_LIGHT_DEVICE, LOOP_LIGHT_DRIVER], ['loop.op1', LOOP_OP1_DEVICE, LOOP_OP1_DRIVER], ['loop.mac', LOOP_MAC_DEVICE, LOOP_MAC_DRIVER], ['loop.devterm', LOOP_DEVTERM_DEVICE, LOOP_DEVTERM_DRIVER]] as const) {
    if (pickDevice ? name !== `loop.${pickDevice}` : name === 'loop.devterm') continue;
    console.log(`-- forge (loop template ids): ${device.name}`);
    const r = await forge.generate({ device, driver, verification: allPass(driver), onProgress: show });
    summarize(`${name}.hackset`, r);
    if (name === 'loop.op1' && r.ok && r.uiSpec) {
      const e = await forge.edit({ specId: r.uiSpec.specId, instruction: 'make the resonance control a big red lever', onProgress: show });
      summarize(`${name}.resonance-lever`, e);
    }
  }
}
console.log('calls:', calls.totals());
