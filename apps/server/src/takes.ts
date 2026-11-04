/**
 * Takes recorded by the headset app (session.jsonl + frames/*.jpg, zipped by apps/quest/src/replay/zip.ts) can be
 * handed to the server over localhost (`POST /api/takes/:take`, body = the zip). The HTTP router stores them in
 * CE_DATA_DIR/takes, outside the public build and Git, ready for local replay (`/sim/?take=<take>`).
 * STORE and DEFLATE entries are read; nothing else is needed for these archives.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: Buffer;
}

const MAX_TAKE_BYTES = 64 * 1024 * 1024;
const MAX_TAKE_FILES = 2000;

/** The files of a zip archive (central directory walk). Throws on anything that is not a plain STORE/DEFLATE zip. */
export function readZip(buf: Buffer): ZipFile[] {
  // end of central directory: the last 0x06054b50 within the trailing 64 KiB comment window
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_TAKE_FILES) throw new Error('too many files in take');
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipFile[] = [];
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    if (usize > MAX_TAKE_BYTES - bytes) throw new Error('take exceeds the 64 MB unpacked limit');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (name.endsWith('/')) continue;
    if (method === 0) {
      if (raw.length > MAX_TAKE_BYTES - bytes) throw new Error('take exceeds the 64 MB unpacked limit');
      out.push({ name, data: Buffer.from(raw) });
    }
    else if (method === 8) {
      const data = inflateRawSync(raw, { maxOutputLength: Math.max(1, MAX_TAKE_BYTES - bytes) });
      if (usize && data.length !== usize) throw new Error(`size mismatch for ${name}`);
      out.push({ name, data });
    } else throw new Error(`unsupported compression ${method} for ${name}`);
    bytes += out[out.length - 1]!.data.length;
  }
  return out;
}

/** A take name is a directory name: letters, digits, dot, dash, underscore. */
export function takeName(raw: string): string | undefined {
  const s = raw.trim().replace(/\.zip$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s) && !s.includes('..') ? s : undefined;
}

/**
 * Unpack a take zip into `<root>/<take>/`. Entries may be prefixed with the take's own folder (`<take>/session.jsonl`)
 * or not; path components that climb out are refused. Returns what was written.
 */
export function saveTake(root: string, take: string, zip: Buffer): { dir: string; files: string[]; bytes: number } {
  if (takeName(take) !== take) throw new Error('invalid take name');
  const files = readZip(zip);
  const prepared = files.map((f) => {
    const parts = f.name.split('/').filter(Boolean);
    if (parts[0] === take) parts.shift();
    if (!parts.length || parts.some((s) => s === '..' || s === '.')) throw new Error(`refusing path ${f.name}`);
    const rel = parts.join('/');
    // Never host uploaded HTML/JavaScript on the same origin as the owner's bridge.
    if (rel !== 'session.jsonl' && !/^frames\/[A-Za-z0-9_-]+\.jpe?g$/i.test(rel)) throw new Error(`unsupported take file ${rel}`);
    return { rel, data: f.data };
  });
  if (!prepared.some((f) => f.rel === 'session.jsonl')) throw new Error('a take needs a session.jsonl');
  if (new Set(prepared.map((f) => f.rel)).size !== prepared.length) throw new Error('duplicate take file');
  const dir = join(root, take);
  mkdirSync(root, { recursive: true });
  // An upload cannot overwrite an earlier capture or follow an existing take-directory symlink.
  mkdirSync(dir);
  const written: string[] = [];
  let bytes = 0;
  for (const { rel, data } of prepared) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: 'wx' });
    written.push(rel);
    bytes += data.length;
  }
  return { dir, files: written, bytes };
}

export function takeExists(root: string, take: string): boolean {
  return existsSync(join(root, take, 'session.jsonl'));
}
