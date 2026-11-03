import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CanvasDocument, CanvasSpec } from '@ce/protocol';
import { z } from 'zod';

export const CANVAS_OBJECT_LIMIT = 64;
export const CANVAS_VERSION_LIMIT = 8;
const FILE_LIMIT = 8 * 1024 * 1024;
const Version = CanvasDocument.omit({ cardId: true, canvasId: true, history: true });
const RecordSchema = z.object({ cardId: z.string().min(1).max(128), canvasId: z.string().min(1).max(128), versions: z.array(Version).min(1).max(CANVAS_VERSION_LIMIT) });
type RecordValue = z.infer<typeof RecordSchema>;
type VersionValue = z.infer<typeof Version>;

/** Separate software experiences: no driver, verification or physical authority is persisted here. */
export class CanvasStore {
  private records = new Map<string, RecordValue>();
  readonly warnings: string[] = [];
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size > FILE_LIMIT) throw new Error('too large');
      const root = z.object({ version: z.literal(1), records: z.array(z.unknown()).max(CANVAS_OBJECT_LIMIT) }).parse(JSON.parse(readFileSync(file, 'utf8')));
      for (const raw of root.records) {
        const parsed = RecordSchema.safeParse(raw);
        if (!parsed.success || parsed.data.versions.some((v, i, a) => i > 0 && v.revision <= a[i - 1].revision)) {
          this.warnings.push('Skipped invalid canvas history'); continue;
        }
        this.records.set(parsed.data.cardId, parsed.data);
      }
    } catch { this.warnings.push('Could not read canvas history; starting empty'); }
  }
  get(cardId: string): CanvasDocument | undefined {
    const record = this.records.get(cardId);
    if (!record) return;
    return structuredClone({ ...record.versions.at(-1)!, cardId, canvasId: record.canvasId,
      history: record.versions.map(({ revision, spec }) => ({ revision, title: spec.title })) });
  }
  list(): CanvasDocument[] { return [...this.records.keys()].map((id) => this.get(id)!); }
  commit(cardId: string, input: Omit<VersionValue, 'revision' | 'updatedAt'>, baseRevision?: number): CanvasDocument {
    const previous = this.records.get(cardId), latest = previous?.versions.at(-1);
    if (latest?.revision !== baseRevision) throw new Error('This canvas changed. Open its latest revision and try again.');
    const next = Version.parse({ ...input, spec: CanvasSpec.parse(input.spec), revision: (latest?.revision ?? 0) + 1, updatedAt: Date.now() });
    const record = RecordSchema.parse({ cardId, canvasId: previous?.canvasId ?? `canvas-${randomUUID()}`, versions: [...(previous?.versions ?? []), next].slice(-CANVAS_VERSION_LIMIT) });
    const records = new Map(this.records); records.delete(cardId); records.set(cardId, record);
    while (records.size > CANVAS_OBJECT_LIMIT) records.delete(records.keys().next().value!);
    this.persist(records); this.records = records;
    return this.get(cardId)!;
  }
  restore(cardId: string, revision: number, baseRevision: number): CanvasDocument {
    const old = this.records.get(cardId)?.versions.find((version) => version.revision === revision);
    if (!old) throw new Error('That revision is no longer in the saved history.');
    return this.commit(cardId, old, baseRevision);
  }
  forget(cardId: string): void {
    if (!this.records.has(cardId)) return;
    const next = new Map(this.records); next.delete(cardId); this.persist(next); this.records = next;
  }
  private persist(records: Map<string, RecordValue>): void {
    if (!this.file) return;
    const json = JSON.stringify({ version: 1, records: [...records.values()] });
    if (Buffer.byteLength(json) > FILE_LIMIT) throw new Error('Canvas history is full. Forget an unused object.');
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, json); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.file);
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
  }
}
