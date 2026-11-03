import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProjectDocument, ProjectValues, type ProjectSpec } from '@ce/protocol';
import { z } from 'zod';

const RecordSchema = z.object({ document: ProjectDocument, values: ProjectValues, sequence: z.number().int().nonnegative() });
type RecordValue = z.infer<typeof RecordSchema>;
const MAX_BYTES = 8 * 1024 * 1024;
export const PROJECT_LIMIT = 32;

export function initialProjectValues(spec: ProjectSpec): Record<string, number> {
  return Object.fromEntries(spec.actions.map((a) => [a.id, a.kind === 'number' ? a.initial! : 0]));
}
/** Atomic bounded project storage. Continuous inputs are coalesced to one disk write/second. */
export class ProjectStore {
  private records = new Map<string, RecordValue>();
  private timer?: ReturnType<typeof setTimeout>;
  readonly warnings: string[] = [];
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size > MAX_BYTES) throw new Error('Too large');
      const data = z.object({ version: z.literal(1), projects: z.array(RecordSchema).max(PROJECT_LIMIT) }).parse(JSON.parse(readFileSync(file, 'utf8')));
      for (const record of data.projects) {
        const values = initialProjectValues(record.document.spec);
        for (const a of record.document.spec.actions) {
          const value = record.values[a.id];
          if (Number.isFinite(value) && (a.kind === 'number' ? value >= a.min! && value <= a.max! : Number.isSafeInteger(value) && value >= 0)) values[a.id] = value;
        }
        this.records.set(record.document.projectId, { ...record, values });
      }
    } catch { this.warnings.push('Could not read Muse projects; starting empty.'); }
  }
  get(id: string): RecordValue | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  list(): RecordValue[] { return [...this.records.values()].map((v) => structuredClone(v)); }
  commit(document: ProjectDocument, baseRevision?: number): RecordValue {
    const old = this.records.get(document.projectId);
    if (old?.document.revision !== baseRevision || document.revision !== (baseRevision ?? 0) + 1) throw new Error('Project changed. Reload before editing.');
    if (!old && this.records.size >= PROJECT_LIMIT) throw new Error('Project limit reached. Edit an existing project.');
    const next = RecordSchema.parse({ document, values: initialProjectValues(document.spec), sequence: (old?.sequence ?? 0) + 1 });
    const records = new Map(this.records); records.set(document.projectId, next);
    this.persist(records); this.records = records;
    return this.get(document.projectId)!;
  }
  update(id: string, values: Record<string, number>): RecordValue {
    const old = this.records.get(id); if (!old) throw new Error('Project missing');
    const next = { ...old, values: { ...values }, sequence: old.sequence + 1 };
    this.records.set(id, next);
    if (this.file && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; try { this.persist(this.records); } catch { this.warnings.push('Could not save recent Canvas inputs.'); } }, 1000);
      this.timer.unref?.();
    }
    return structuredClone(next);
  }
  close(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.persist(this.records); } }
  private persist(records: Map<string, RecordValue>): void {
    if (!this.file) return;
    const json = JSON.stringify({ version: 1, projects: [...records.values()] });
    if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Project storage is full.');
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`; let fd: number | undefined;
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, json); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.file); }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
  }
}
