import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LibraryIdentity, RoomPlacement, type TaggedDevice, type UiSpecPayload } from '@ce/protocol';
import { z } from 'zod';
import {
  AssetRef, LegacyTag, LibraryFile, LibraryRecord, SetupData, SetupVersion,
  restoreResearch, saveResearch, type StoredTag,
} from './library-schema';
import type { Target } from './types';

export type { AssetRef, LibraryRecord, SetupVersion, StoredTag } from './library-schema';
export interface SetupContext { forgeContext?: unknown; skinRefs?: AssetRef[] }

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const jsonValue = (value: unknown): z.infer<ReturnType<typeof z.json>> | undefined => value === undefined ? undefined : z.json().parse(JSON.parse(JSON.stringify(value)));

/** Synchronous transactions serialize writes, including rename and directory fsync, before returning. */
function atomicWrite(file: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/** One durable device record with immutable setups; hiding a chip never erases its saved work. */
export class TagStore {
  private records = new Map<string, LibraryRecord>();
  private readonly file?: string;
  private lastSerialized?: string;
  private readonly memoryAssets = new Map<string, Buffer>();
  readonly loadWarnings: string[] = [];

  /** An omitted path keeps the store in memory. A former tags.json path migrates beside it. */
  constructor(file?: string) {
    this.file = file && basename(file) === 'tags.json' ? join(dirname(file), 'library.json') : file;
    if (!this.file) return;
    if (existsSync(this.file) || existsSync(`${this.file}.last-good`)) {
      for (const source of [this.file, `${this.file}.last-good`]) {
        if (!existsSync(source)) continue;
        try {
          const root = z.object({ version: z.literal(2), records: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(source, 'utf8')));
          for (const [index, raw] of root.records.entries()) {
            const parsed = LibraryRecord.safeParse(raw);
            if (!parsed.success || this.records.has(parsed.data.cardId) || this.records.size >= 64) {
              this.loadWarnings.push(`Skipped invalid library record ${index}`);
              continue;
            }
            this.records.set(parsed.data.cardId, parsed.data);
          }
          this.lastSerialized = this.serialize();
          return;
        } catch {
          this.loadWarnings.push(`Could not read ${basename(source)}`);
        }
      }
      throw new Error('The device library and its last-good snapshot could not be read');
    }
    const legacyFile = join(dirname(this.file), 'tags.json');
    if (existsSync(legacyFile)) this.migrate(legacyFile);
  }

  list(): StoredTag[] { return this.library().filter((record) => !record.hidden).map((record) => this.snapshot(record)); }
  listAll(): StoredTag[] { return this.library().map((record) => this.snapshot(record)); }
  library(): LibraryRecord[] { return structuredClone([...this.records.values()]); }
  get(cardId: string): StoredTag | undefined { const record = this.records.get(cardId); return record ? this.snapshot(record) : undefined; }
  has(cardId: string): boolean { const record = this.records.get(cardId); return !!record && !record.hidden; }

  add(target: Target, label: string, position?: TaggedDevice['position']): StoredTag {
    if (!this.records.has(target.cardId) && this.records.size >= 64) throw new Error('A space can have at most 64 saved devices');
    this.transaction(() => {
      const old = this.records.get(target.cardId);
      const now = Date.now();
      const record: LibraryRecord = old ?? {
        cardId: target.cardId, displayName: label, identity: { label }, hidden: false,
        createdAt: now, updatedAt: now, enabled: target.armed, versions: [],
      };
      record.displayName = label;
      record.hidden = false;
      record.position = position ?? record.position;
      this.records.set(target.cardId, record);
      this.capture(record, target);
    });
    return this.get(target.cardId)!;
  }

  /** Save state and completed setups only for devices the user explicitly tagged. */
  sync(target: Target, spec?: UiSpecPayload, extras: SetupContext = {}): void {
    if (!this.has(target.cardId)) return;
    this.transaction(() => this.capture(this.records.get(target.cardId)!, target, spec, extras));
  }

  beginCandidate(cardId: string): boolean {
    return this.change(cardId, (record) => {
      record.candidate = { id: `candidate-${randomUUID()}`, createdAt: Date.now(), enabledAtStart: record.enabled, cancelled: false };
      record.candidateVersionId = undefined;
    });
  }

  activateCandidate(cardId: string): StoredTag | undefined {
    const record = this.records.get(cardId);
    if (!record?.candidateVersionId || !record.enabled || record.candidate?.cancelled) return undefined;
    this.change(cardId, (current) => {
      current.activeVersionId = current.candidateVersionId;
      current.candidateVersionId = undefined;
      current.candidate = undefined;
    });
    return this.get(cardId);
  }

  restoreVersion(cardId: string, versionId: string): StoredTag | undefined {
    const record = this.records.get(cardId);
    if (!record?.versions.some((version) => version.versionId === versionId)) return undefined;
    this.change(cardId, (current) => {
      current.activeVersionId = versionId;
      current.candidateVersionId = undefined;
      current.candidate = undefined;
    });
    return this.get(cardId);
  }

  /** Explicit enablement is independent of version selection, so rollback cannot undo a disable. */
  setEnabled(cardId: string, enabled: boolean): boolean {
    return this.change(cardId, (record) => {
      record.enabled = enabled;
      if (record.candidate) record.candidate.cancelled = !enabled;
    });
  }

  setPlacement(cardId: string, placement: z.infer<typeof RoomPlacement>): boolean {
    const parsed = RoomPlacement.parse(placement);
    return this.change(cardId, (record) => { record.placement = parsed; });
  }

  rename(cardId: string, displayName: string): boolean {
    const name = LibraryRecord.shape.displayName.parse(displayName);
    return this.change(cardId, (record) => { record.displayName = name; });
  }

  /** Untag means hide. Only forget deletes the saved identity and setup history. */
  remove(cardId: string): boolean {
    if (!this.has(cardId)) return false;
    return this.change(cardId, (record) => {
      record.hidden = true;
      record.enabled = false;
      if (record.candidate) record.candidate.cancelled = true;
    });
  }

  forget(cardId: string): boolean {
    if (!this.records.has(cardId)) return false;
    this.transaction(() => { this.records.delete(cardId); });
    return true;
  }

  /** Accepted edits and late skin completion produce another immutable version immediately. */
  saveSetupContext(cardId: string, extras: SetupContext, spec?: UiSpecPayload): boolean {
    const saved = this.get(cardId);
    if (!saved?.driver || !saved.uiSpec) return false;
    const record = this.records.get(cardId)!;
    const active = record.versions.find((version) => version.versionId === record.activeVersionId);
    if (!active) return false;
    this.change(cardId, (current) => {
      const uiSpec = spec ?? active.uiSpec;
      const version = this.version(current, {
        ...active, uiSpec, specId: uiSpec.specId,
        forgeContext: extras.forgeContext === undefined ? active.forgeContext : this.storeContext(extras.forgeContext),
        skinRefs: extras.skinRefs ?? active.skinRefs,
      });
      current.activeVersionId = version.versionId;
    });
    return true;
  }

  /** Asset bytes reach durable storage before a setup can refer to their hash. */
  putAsset(bytes: Uint8Array, ext: string, mime?: string): AssetRef {
    const ref = AssetRef.parse({ hash: hash(bytes), ext, path: `library/assets/${hash(bytes)}.${ext}`, mime });
    if (this.file) {
      const file = join(dirname(this.file), ref.path);
      if (!existsSync(file) || hash(readFileSync(file)) !== ref.hash) atomicWrite(file, bytes);
    } else this.memoryAssets.set(ref.path, Buffer.from(bytes));
    return ref;
  }

  readAsset(contentHash: string, ext: string): Buffer | undefined {
    const parsed = AssetRef.safeParse({ hash: contentHash, ext, path: `library/assets/${contentHash}.${ext}` });
    if (!parsed.success) return undefined;
    const ref = parsed.data;
    const file = this.file ? join(dirname(this.file), ref.path) : undefined;
    const bytes = file ? existsSync(file) ? readFileSync(file) : undefined : this.memoryAssets.get(ref.path);
    return bytes && hash(bytes) === contentHash ? Buffer.from(bytes) : undefined;
  }

  private snapshot(record: LibraryRecord): StoredTag {
    const setup = record.versions.find((version) => version.versionId === record.activeVersionId);
    const draft = record.draft;
    return structuredClone({
      cardId: record.cardId, label: record.displayName.slice(0, 80), position: record.position,
      card: record.card, selection: record.selection, driver: setup?.driver ?? draft?.driver,
      link: setup?.link ?? draft?.link, verification: setup?.verification ?? draft?.verification ?? {},
      evidence: setup?.evidence ?? draft?.evidence ?? [], research: restoreResearch(setup?.research ?? draft?.research),
      armed: !!setup && record.enabled && !record.hidden,
      specId: setup?.specId, uiSpec: setup?.uiSpec, controlCount: setup?.controlCount,
      stepIndex: record.lastKnownState?.stepIndex ?? {}, paramValues: record.lastKnownState?.paramValues ?? {},
      forgeContext: this.loadContext(setup?.forgeContext), skinRefs: setup?.skinRefs ?? [], placement: record.placement,
      activeVersionId: record.activeVersionId,
    });
  }

  private capture(record: LibraryRecord, target: Target, spec?: UiSpecPayload, extras: SetupContext = {}): void {
    const active = record.versions.find((version) => version.versionId === record.activeVersionId);
    const prior = record.versions.find((version) => version.versionId === record.candidateVersionId) ?? active;
    const candidate = spec ?? prior?.uiSpec;
    const uiSpec = candidate?.specId === target.specId && candidate?.cardId === target.cardId && candidate?.driverId === target.driver?.driverId ? candidate : undefined;
    record.card = target.card ?? record.card;
    record.selection = target.selection ?? record.selection;
    const port = target.link?.port;
    if (!active || !record.candidate || target.armed && !record.candidate.cancelled) record.identity = LibraryIdentity.parse({
      ...record.identity, label: record.identity.label || record.displayName,
      appearance: record.identity.appearance ?? target.card?.evidence.join('; ').slice(0, 2000),
      maker: target.card?.maker ?? record.identity.maker, model: target.card?.model ?? record.identity.model,
      category: target.card?.category ?? record.identity.category,
      executorDeviceId: target.driver?.executor.deviceId ?? target.link?.executorDeviceId ?? record.identity.executorDeviceId,
      portId: target.driver?.executor.port ?? port?.id ?? record.identity.portId,
      portName: port?.name ?? record.identity.portName, manufacturer: port?.manufacturer ?? record.identity.manufacturer,
      irFingerprint: target.driver?.transport === 'ir' ? hash(canonical(target.driver.actions.map((action) => action.encode))) : record.identity.irFingerprint,
    });
    if (!record.candidate) record.enabled = target.armed;
    const values = { stepIndex: target.stepIndex, paramValues: target.paramValues };
    if ((!record.candidate || target.armed) && (!record.lastKnownState || canonical(values) !== canonical({ stepIndex: record.lastKnownState.stepIndex, paramValues: record.lastKnownState.paramValues }))) {
      record.lastKnownState = { at: Date.now(), ...structuredClone(values) };
    }
    record.draft = LibraryRecord.shape.draft.parse({
      cardId: target.cardId, label: record.displayName.slice(0, 80), card: target.card, selection: target.selection,
      driver: target.driver, link: target.link, verification: target.verification, evidence: target.evidence,
      research: saveResearch(target.research), armed: false, specId: target.specId, uiSpec,
      controlCount: target.controlCount, stepIndex: target.stepIndex, paramValues: target.paramValues,
    });
    if (!target.driver || !uiSpec || !target.driver.actions.some((action) => target.verification[action.actionId] === 'pass')) return;
    const matchingPrior = prior?.specId === uiSpec.specId && prior.driver.driverId === target.driver.driverId ? prior : undefined;
    const version = this.version(record, {
      driver: target.driver, link: target.link, verification: target.verification, evidence: target.evidence,
      research: saveResearch(target.research), specId: target.specId, uiSpec, controlCount: target.controlCount,
      forgeContext: extras.forgeContext === undefined ? matchingPrior?.forgeContext : this.storeContext(extras.forgeContext),
      skinRefs: extras.skinRefs ?? matchingPrior?.skinRefs ?? [],
    });
    if (target.armed && !record.candidate?.cancelled) {
      record.enabled = true;
      record.activeVersionId = version.versionId;
      record.candidateVersionId = undefined;
      record.candidate = undefined;
    } else if (record.activeVersionId !== version.versionId) record.candidateVersionId = version.versionId;
  }

  private version(record: LibraryRecord, input: unknown): SetupVersion {
    const data = SetupData.parse(input);
    const versionId = `setup-${hash(canonical(data))}`;
    const existing = record.versions.find((version) => version.versionId === versionId);
    if (existing) return existing;
    for (const ref of data.skinRefs) if (!this.readAsset(ref.hash, ref.ext)) throw new Error(`Save asset ${ref.hash} before referencing it in a setup`);
    const version = SetupVersion.parse({ ...data, versionId, createdAt: Date.now() });
    record.versions.push(version);
    return version;
  }

  private storeContext(context: unknown): z.infer<ReturnType<typeof z.json>> | undefined {
    const externalize = (value: unknown, key = ''): unknown => {
      if (key === 'jpegBase64' && typeof value === 'string' && value.length) {
        return { $libraryAsset: this.putAsset(Buffer.from(value, 'base64'), 'jpeg', 'image/jpeg') };
      }
      if (Array.isArray(value)) return value.map((item) => externalize(item));
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, externalize(item, name)]));
      return value;
    };
    return jsonValue(externalize(context));
  }

  private loadContext(context: unknown): unknown {
    if (Array.isArray(context)) return context.map((item) => this.loadContext(item));
    if (context !== null && typeof context === 'object') {
      if ('$libraryAsset' in context) {
        const ref = AssetRef.parse(context.$libraryAsset);
        return this.readAsset(ref.hash, ref.ext)?.toString('base64');
      }
      return Object.fromEntries(Object.entries(context).map(([key, item]) => [key, this.loadContext(item)]));
    }
    return context;
  }

  private change(cardId: string, update: (record: LibraryRecord) => void): boolean {
    if (!this.records.has(cardId)) return false;
    this.transaction(() => update(this.records.get(cardId)!));
    return true;
  }

  private transaction(update: () => void): void {
    const before = structuredClone(this.records);
    const previous = this.serialize();
    try {
      update();
      if (this.serialize() === previous) return;
      for (const [id, record] of this.records) if (canonical(record) !== canonical(before.get(id))) record.updatedAt = Date.now();
      this.flush();
    } catch (error) {
      this.records = before;
      throw error;
    }
  }

  private serialize(): string { return JSON.stringify(LibraryFile.parse({ version: 2, records: [...this.records.values()] })); }

  private flush(): void {
    const serialized = this.serialize();
    if (this.file) {
      atomicWrite(`${this.file}.last-good`, this.lastSerialized ?? serialized);
      atomicWrite(this.file, serialized);
    }
    this.lastSerialized = serialized;
  }

  private migrate(file: string): void {
    const root = z.object({ version: z.literal(1), tags: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(file, 'utf8')));
    const now = Date.now();
    for (const [index, raw] of root.tags.entries()) {
      const parsed = LegacyTag.safeParse(raw);
      if (!parsed.success || this.records.has(parsed.data.cardId) || this.records.size >= 64) {
        this.loadWarnings.push(`Skipped invalid legacy tag ${index}`);
        continue;
      }
      const tag = parsed.data;
      const record: LibraryRecord = {
        cardId: tag.cardId, displayName: tag.label, hidden: false, identity: { label: tag.label },
        position: tag.position, card: tag.card, selection: tag.selection, createdAt: now, updatedAt: now,
        enabled: tag.armed, versions: [], lastKnownState: { at: now, stepIndex: tag.stepIndex, paramValues: tag.paramValues },
      };
      try {
        this.capture(record, { ...tag, evidence: [], runId: 'migration', state: 'scanned', since: now }, tag.uiSpec);
        LibraryRecord.parse(record);
        this.records.set(record.cardId, record);
      } catch {
        this.loadWarnings.push(`Skipped invalid legacy tag ${index}`);
      }
    }
    this.flush();
  }
}
