#!/usr/bin/env node
/** Local, redacted publication check. No uploads, no credential validation, no Git mutations. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

const history = process.argv.includes('--history');
const git = (args, input) => execFileSync('git', args, { input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['vendor-api-key', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{25,}/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}/g],
  ['credential-url', /https?:\/\/[^\s/:"']+:[^\s/@"']{8,}@[^\s"']+/gi],
  ['secret-assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+/=.-]{20,}["']/gi],
];
const known = new Set();
const addKnown = (name, value) => {
  if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD)$/.test(name) && value?.length >= 16 && !/^(?:your[-_]|example|placeholder|changeme)/i.test(value)) known.add(value);
};
for (const [name, value] of Object.entries(process.env)) addKnown(name, value);
for (const path of ['.env', '.env.local', 'apps/server/.env']) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = match[2].startsWith('"') || match[2].startsWith("'")
        ? match[2].slice(1, match[2].lastIndexOf(match[2][0])) : match[2].replace(/\s+#.*$/, '').trim();
      addKnown(match[1], value);
    }
  } catch { /* A clean reviewer checkout has no local secrets. */ }
}

// These historical technical notes and synthetic room takes have been reviewed; future captures stay private.
const reviewedHistoryNotes = new Set(['research/21-helper-pairing.md', 'research/25-mobile-ar.md', 'research/screens/v2-flow/.gitkeep']);
const syntheticTake = /^apps\/quest\/public\/takes\/take-2026-11-02T02-(?:22-10|45-47)\//;
const privatePath = (path) => {
  if (path.endsWith('/.env.example') || path === '.env.example') return false;
  return /(^|\/)(?:\.env(?:\.[^/]*)?|\.data|\.certs|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa|id_ed25519)(\/|$)/.test(path)
    || /\.(?:pem|key|p12|pfx|mobileprovision|har|heapsnapshot|zip)$/i.test(path)
    || /^(?:research|notes)\//.test(path) && !reviewedHistoryNotes.has(path)
    || /^(?:AGENTS|CODEX-HANDOFF|HANDOFF)\.md$/.test(path)
    || path.startsWith('apps/quest/public/takes/') && !syntheticTake.test(path);
};
const findings = [];
let blobs = 0, bytes = 0;
function scan(path, data, scope, object) {
  blobs++; bytes += data.length;
  const base = { scope, path, ...(object ? { object } : {}) };
  if (privatePath(path)) findings.push({ ...base, rule: 'private-file-path' });
  const text = data.toString('utf8');
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) findings.push({ ...base, rule, line: text.slice(0, match.index).split('\n').length });
  }
  for (const secret of known) {
    const index = text.indexOf(secret);
    if (index !== -1) findings.push({ ...base, rule: 'known-local-secret', line: text.slice(0, index).split('\n').length });
  }
}

try {
  const paths = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean));
  for (const path of paths) {
    try { scan(path, lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path), 'worktree'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let commits = 0;
  if (history) {
    commits = Number(git(['rev-list', '--all', '--count']).toString().trim());
    const objects = new Map(git(['rev-list', '--objects', '--all']).toString().trim().split('\n').map((line) => {
      const space = line.indexOf(' ');
      return space === -1 ? [line, '(commit)'] : [line.slice(0, space), line.slice(space + 1)];
    }));
    const batch = git(['cat-file', '--batch'], [...objects.keys()].join('\n') + '\n');
    let offset = 0;
    while (offset < batch.length) {
      const end = batch.indexOf(10, offset);
      const [object, type, rawSize] = batch.subarray(offset, end).toString().split(' ');
      const size = Number(rawSize), start = end + 1;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git batch');
      if (type === 'blob' || type === 'commit' || type === 'tag') scan(objects.get(object) ?? '(object)', batch.subarray(start, start + size), 'history', object);
      offset = start + size + 1;
    }
  }
  console.log(JSON.stringify({ ok: findings.length === 0, history, commits, objectsScanned: blobs, bytesScanned: bytes, knownSecretValuesCompared: known.size, findings }, null, 2));
  process.exitCode = findings.length ? 1 : 0;
} catch (error) {
  // Never echo child stderr or matched values; either may contain credentials.
  console.error(`Publication audit could not complete (${error.code ?? 'scan error'}).`);
  process.exitCode = 2;
}
