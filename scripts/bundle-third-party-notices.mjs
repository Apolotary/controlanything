#!/usr/bin/env node
/** Exact local licence/notice copies. No network, package install, app code, or deletion.
 * node scripts/bundle-third-party-notices.mjs
 * node scripts/bundle-third-party-notices.mjs --check
 * node scripts/bundle-third-party-notices.mjs --check --dist=companion=/tmp/ce-notices-build
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = 'scripts/third-party-notices.manifest.json';
const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
const check = process.argv.includes('--check');
const distChecks = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--check') continue;
  const match = /^--dist=(quest|companion|sim)=(.+)$/.exec(arg);
  if (!match) throw new Error(`Unknown option: ${arg}`);
  distChecks.push({ app: match[1], path: resolve(match[2]) });
}
if (distChecks.length && !check) throw new Error('--dist requires --check (no build or deployment is performed here)');
if (manifest.schemaVersion !== 1) throw new Error('Unsupported notice manifest version');

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const posix = (path) => path.replaceAll('\\', '/');
const rel = (path) => posix(relative(root, path));
const slug = (text) => text.replace(/^@/, '').replaceAll('/', '--').replace(/[^A-Za-z0-9_.@-]/g, '_');
const html = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const lock = json(join(root, 'package-lock.json')).packages;
const workspaces = new Map(manifest.workspacePackages.map((file) => {
  const path = join(root, file); return [json(path).name, path];
}));

function packageFile(name, from) {
  if (workspaces.has(name)) return workspaces.get(name);
  for (let current = from; ; current = dirname(current)) {
    const path = join(current, 'node_modules', name, 'package.json');
    if (existsSync(path)) return realpathSync(path);
    if (dirname(current) === current) return undefined;
  }
}

const visited = new Map();
const absentOptional = new Set();
function visit(path, via) {
  if (visited.has(path)) { visited.get(path).via.add(via); return; }
  const data = json(path);
  const pkg = { path, data, via: new Set([via]) };
  visited.set(path, pkg);
  const edges = { ...data.dependencies, ...data.optionalDependencies, ...data.peerDependencies };
  for (const name of Object.keys(edges).sort()) {
    const next = packageFile(name, dirname(path));
    if (!next) {
      if (data.optionalDependencies?.[name] || data.peerDependenciesMeta?.[name]?.optional) { absentOptional.add(`${data.name}: ${name}`); continue; }
      throw new Error(`Missing installed runtime package ${name} required by ${data.name}; run the project's normal install separately`);
    }
    visit(next, data.name);
  }
}
for (const path of workspaces.values()) visit(path, 'workspace root');
for (const entry of manifest.browserImportedDevPackages ?? []) {
  const path = packageFile(entry.name, root);
  if (!path) throw new Error(`Missing browser-imported emulator package: ${entry.name}`);
  visit(path, entry.reason);
}
// Supplemental notices are copied without traversing an unrelated framework's runtime graph.
for (const entry of manifest.supplementalPackages) {
  const path = packageFile(entry.name, root);
  if (!path) throw new Error(`Missing supplemental notice package: ${entry.name}`);
  if (!visited.has(path)) visited.set(path, { path, data: json(path), via: new Set([entry.reason]) });
  else visited.get(path).via.add(entry.reason);
}

const files = new Map();
const entries = [];
function copyText(source, destination) {
  const bytes = readFileSync(source);
  if (!bytes.length || bytes.subarray(0, 4096).includes(0)) throw new Error(`Expected a nonempty text notice: ${rel(source)}`);
  if (files.has(destination) && !files.get(destination).equals(bytes)) throw new Error(`Conflicting installed notice copies: ${destination}`);
  files.set(destination, bytes);
  return { file: destination, sourceFile: rel(source), bytes: bytes.length, sha256: sha(bytes) };
}
for (const { path, data, via } of [...visited.values()].sort((a, b) => rel(a.path) < rel(b.path) ? -1 : rel(a.path) > rel(b.path) ? 1 : 0)) {
  if (workspaces.has(data.name)) continue;
  const packageDir = dirname(path), sourcePath = rel(packageDir);
  const locked = lock[sourcePath];
  if (!locked || locked.version !== data.version) throw new Error(`Installed version differs from package-lock.json: ${data.name}`);
  const noticeNames = readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:licen[sc]e(?:[._-]|$)|notice(?:[._-]|$)|copyright(?:[._-]|$)|third[._ -]?party[._ -]?notices?)/i.test(entry.name))
    .map((entry) => entry.name).sort();
  let upstreamNotice;
  let notices = noticeNames.map((name) => copyText(join(packageDir, name), `packages/${slug(data.name)}@${data.version}/${name}`));
  if (!notices.length) {
    upstreamNotice = manifest.upstreamNotices?.find(entry => entry.name === data.name && entry.version === data.version);
    if (!upstreamNotice) throw new Error(`No full installed licence/notice file found for ${data.name}; inspect it explicitly instead of inventing terms`);
    const source = resolve(root, upstreamNotice.sourceFile);
    if (!source.startsWith(root + '/') || isAbsolute(upstreamNotice.sourceFile) || sha(readFileSync(source)) !== upstreamNotice.sha256) throw new Error(`Pinned upstream notice is missing or changed: ${data.name}`);
    notices = [copyText(source, `packages/${slug(data.name)}@${data.version}/${upstreamNotice.upstreamFile}`)];
  }
  entries.push({ kind: 'installed-package', name: data.name, version: data.version, licenseMetadata: data.license ?? locked.license ?? null,
    packageJson: rel(path), includedVia: [...via].sort(), ...(upstreamNotice ? { upstreamNotice } : {}), notices });
}
for (const entry of manifest.vendoredNotices) {
  const source = resolve(root, entry.sourceFile);
  if (!source.startsWith(root + '/') || isAbsolute(entry.sourceFile)) throw new Error('Vendored notice source must be inside the repository');
  entries.push({ kind: 'vendored-asset-notice', name: entry.name, version: entry.version, versionNote: entry.versionNote,
    includedVia: [entry.reason], notices: [copyText(source, `assets/${slug(entry.id)}/${basename(source)}`)] });
}
const index = { schemaVersion: 1, generator: 'scripts/bundle-third-party-notices.mjs', scopeManifest: manifestPath,
  scope: manifest.scope, omittedUninstalledOptionalDependencies: [...absentOptional].sort(), entries };
files.set('index.json', Buffer.from(JSON.stringify(index, null, 2) + '\n'));
const items = entries.map((entry) => `<li><strong>${html(entry.name)}</strong> ${html(entry.version ?? '(vendored; version not inferred)')}
  ${entry.upstreamNotice ? `<p>Full notice supplemented from <a href="${html(entry.upstreamNotice.url)}">official upstream ${html(entry.upstreamNotice.tag)}</a>, commit ${html(entry.upstreamNotice.commit)}; installed package omitted it.</p>` : ''}
  <ul>${entry.notices.map((n) => `<li><a href="${html(n.file)}">${html(basename(n.sourceFile))}</a> <small>source: ${html(n.sourceFile)}; SHA-256: ${n.sha256}</small></li>`).join('\n')}</ul></li>`).join('\n');
files.set('index.html', Buffer.from(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ControlAnything — Third-party notices</title>
<style>body{font:16px/1.5 system-ui;max-width:70rem;margin:2rem auto;padding:0 1rem}li{margin:.6rem 0}small{display:block;overflow-wrap:anywhere}</style>
<h1>Third-party notices</h1><p>These are exact full local licence and notice copies. Each component retains its own terms; the project's MIT licence does not replace them.</p>
<p>${html(manifest.scope)}</p><p>Including a notice does not claim that its package is used in every browser bundle. Server-only SAM material and supplemental icon attribution are included explicitly.</p>
<p>Versions, inclusion reasons, original filenames and SHA-256 hashes: <a href="index.json">machine-readable index</a>. Vendored versions are left unspecified where the original snapshot did not record them.</p>
<ul>${items}</ul>
</html>\n`));
files.set('README.txt', Buffer.from(`ControlAnything third-party notices\n\n${manifest.scope}\n\nGenerated by scripts/bundle-third-party-notices.mjs from the pinned installed packages, existing vendored asset notices and pinned official upstream supplements. Full notice bytes are preserved. See index.html or index.json for package versions, source filenames, inclusion reasons and SHA-256 hashes. Existing notices outside this directory are preserved.\n\nRegenerate: node scripts/bundle-third-party-notices.mjs\nVerify: node scripts/bundle-third-party-notices.mjs --check\nThe generator uses only local files and Node built-ins. It does not install, fetch, delete, build or deploy.\n`));

function verify(destination, label) {
  for (const [file, bytes] of files) {
    const target = join(destination, file);
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) throw new Error(`Notice copy differs or is missing: ${label}/${file}`);
  }
}
for (const output of manifest.outputs) {
  if (!/^apps\/(quest|companion|sim)\/public\/notices$/.test(output)) throw new Error('Notice output must be a declared public/notices directory');
  const destination = join(root, output);
  if (check) verify(destination, output);
  else for (const [file, bytes] of files) { const target = join(destination, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
}
for (const { app, path } of distChecks) verify(join(path, 'notices'), `${app} build notices`);
console.log(`${check ? 'Verified' : 'Copied'} ${entries.filter(e => e.kind === 'installed-package').length} installed package notice sets + ${manifest.vendoredNotices.length} vendored asset notices; ${files.size} files per public app${distChecks.length ? `; ${distChecks.length} scratch build checked` : ''}.`);
