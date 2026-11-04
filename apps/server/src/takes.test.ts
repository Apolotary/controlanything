import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZip, saveTake, takeName } from './takes';

/** A STORE/DEFLATE zip writer just for the test (mirrors apps/quest/src/replay/zip.ts). */
function zip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('takes', () => {
  it('reads STORE and DEFLATE entries', () => {
    const files = readZip(zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b/c.txt', data: Buffer.from('world'.repeat(50)), deflate: true }]));
    expect(files.map((f) => [f.name, f.data.toString().slice(0, 5)])).toEqual([['a.txt', 'hello'], ['b/c.txt', 'world']]);
    expect(() => readZip(Buffer.from('not a zip at all, really not'))).toThrow(/not a zip/);
  });
  it('unpacks a take into <root>/<take>/, with or without the take folder prefix, and refuses climbing paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ce-takes-'));
    try {
      const r = saveTake(root, 'take-1', zip([{ name: 'take-1/session.jsonl', data: Buffer.from('{"take":"take-1"}\n') }, { name: 'take-1/frames/f1.jpg', data: Buffer.from([0xff, 0xd8]) }]));
      expect(r.files.sort()).toEqual(['frames/f1.jpg', 'session.jsonl']);
      expect(readFileSync(join(root, 'take-1', 'session.jsonl'), 'utf8')).toContain('take-1');
      expect(() => saveTake(root, 'take-2', zip([{ name: 'frames/f1.jpg', data: Buffer.from([1]) }]))).toThrow(/session.jsonl/);
      expect(() => saveTake(root, 'take-3', zip([{ name: 'session.jsonl', data: Buffer.from('{}') }, { name: '../escape.txt', data: Buffer.from('x') }]))).toThrow(/refusing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('accepts only directory-safe take names', () => {
    expect(takeName('take-2026-11-02T0210.zip')).toBe('take-2026-11-02T0210');
    expect(takeName('../x')).toBeUndefined();
    expect(takeName('a/b')).toBeUndefined();
  });
  it('refuses active web content and duplicate files before writing a capture', () => {
    const root = mkdtempSync(join(tmpdir(), 'ce-takes-'));
    try {
      const meta = { name: 'session.jsonl', data: Buffer.from('{}') };
      expect(() => saveTake(root, 'bad', zip([meta, { name: 'index.html', data: Buffer.from('<script>bad()</script>') }]))).toThrow(/unsupported take file/);
      expect(() => saveTake(root, 'bad', zip([meta, meta]))).toThrow(/duplicate take file/);
      saveTake(root, 'bad', zip([meta]));
      expect(() => saveTake(root, 'bad', zip([meta]))).toThrow();
      expect(readFileSync(join(root, 'bad', 'session.jsonl'), 'utf8')).toBe('{}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects a forged archive size before unbounded decompression', () => {
    const archive = zip([{ name: 'session.jsonl', data: Buffer.from('{}'), deflate: true }]);
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(65 * 1024 * 1024, central + 24);
    expect(() => readZip(archive)).toThrow(/64 MB/);
  });
});
