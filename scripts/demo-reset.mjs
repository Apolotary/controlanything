#!/usr/bin/env node
/**
 * demo-reset: put the server's saved state back to a clean golden-path start, without re-pairing.
 *
 *   node scripts/demo-reset.mjs [--data <dir>] [--keep-visual] [--prune-devices] [--dry-run] [--force]
 *
 * Run it while the server is STOPPED (the server rewrites library.json from memory). Pending pairing requests live
 * only in the server's memory, so restarting the server clears them. What it does:
 *   1. backs up the whole data dir to <data>/backups/<timestamp>/ (nothing is deleted without a copy);
 *   2. library.json: removes every visual-synth card (the stable visual-synth-mac and the old per-executor
 *      visual-synth-<hash> ones), so the next pinch runs the full, live setup again; --keep-visual keeps visual-synth-mac
 *      (setup is skipped and its controls come back straight away);
 *   3. hides every other tagged object (tagged laptop, bottle, book…): the room starts quiet, history is kept;
 *   4. space.json: keeps every paired device (the headset is the room owner; the Mac keeps its token). --prune-devices
 *      keeps only the headsets and the most recently seen Mac companion and revokes the rest (sims, old Mac tabs).
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}
const dataDir = resolve(option('--data') ?? process.env.CE_DATA_DIR ?? join(ROOT, 'apps/server/.data'));
const dry = flag('--dry-run');
const port = Number(option('--port') ?? process.env.HTTP_PORT ?? 8787);

if (!existsSync(dataDir)) { console.error(`demo-reset: no data dir at ${dataDir}`); process.exit(1); }
if (!flag('--force') && !dry) {
  const running = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (running) {
    console.error(`demo-reset: a server answers on :${port}. Stop it first (it would overwrite the reset from memory), or pass --force / --port.`);
    process.exit(1);
  }
}

const readJson = (file) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
const writeJson = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};
const isVisual = (record) => /^visual-synth-/.test(record.cardId) || String(record.card?.notes ?? '').startsWith('virtual:visual-synth:');

const report = [];
// 1. backup
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// Inside the data dir (gitignored with it); earlier backups are not copied again.
const backup = join(dataDir, 'backups', stamp);
if (!dry) for (const entry of readdirSync(dataDir)) if (entry !== 'backups') cpSync(join(dataDir, entry), join(backup, entry), { recursive: true });
report.push(`${dry ? 'would back up' : 'backed up'} ${dataDir} → ${backup}`);

// 2–3. library
const libraryFile = join(dataDir, 'library.json');
const library = readJson(libraryFile);
if (library?.records) {
  const keepVisual = flag('--keep-visual');
  const before = library.records.length;
  const removed = [], hidden = [];
  library.records = library.records.filter((record) => {
    if (!isVisual(record)) return true;
    if (keepVisual && record.cardId === 'visual-synth-mac') return true;
    removed.push(record.cardId);
    return false;
  });
  for (const record of library.records) {
    if (isVisual(record) || record.hidden) continue;
    record.hidden = true;
    record.enabled = false;
    hidden.push(`${record.cardId} (${record.displayName ?? record.identity?.label ?? '?'})`);
  }
  report.push(`library: ${before} → ${library.records.length} records; removed ${removed.length ? removed.join(', ') : 'none'}; hid ${hidden.length ? hidden.join(', ') : 'none'}`);
  if (!dry) {
    writeJson(libraryFile, library);
    // Keep the recovery snapshot consistent so a later read cannot resurrect the old cards.
    writeJson(`${libraryFile}.last-good`, library);
  }
} else report.push('library: none');

// 4. paired devices
const spaceFile = join(dataDir, 'space.json');
const space = readJson(spaceFile);
if (space?.devices) {
  const owners = space.devices.filter((device) => device.kind === 'quest' && device.canApprove);
  report.push(`room owner(s) kept: ${owners.map((d) => `${d.name} ${d.deviceId}`).join(', ') || 'NONE (pair the headset first)'}`);
  if (flag('--prune-devices')) {
    const mac = space.devices.filter((device) => device.kind === 'mac').sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0];
    const keep = space.devices.filter((device) => device.kind === 'quest' || device === mac);
    const dropped = space.devices.filter((device) => !keep.includes(device));
    space.devices = keep;
    report.push(`devices: kept ${keep.map((d) => `${d.name} ${d.deviceId}`).join(', ')}; revoked ${dropped.map((d) => `${d.name} ${d.deviceId}`).join(', ') || 'none'}`);
    if (!dry) writeJson(spaceFile, space);
  } else report.push(`devices: ${space.devices.length} paired, unchanged (--prune-devices keeps headsets + the newest Mac)`);
}
report.push('pending pairing requests are in server memory: restarting the server clears them');
console.log(report.map((line) => `demo-reset: ${line}`).join('\n'));
