/**
 * The space: one per server, persisted to apps/server/.data/space.json (gitignored).
 * Holds every paired device. Only a SHA-256 of each device token is stored.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Capability, type DeviceKind, kindCanApprove } from '@ce/protocol';
import { randomId, randomSecret, safeEqual, sha256Hex } from './crypto';

export interface DeviceRecord {
  deviceId: string;
  name: string;
  kind: DeviceKind;
  capabilities: Capability[];
  tokenHash: string;
  canApprove: boolean;
  pairedAt: number;
  lastSeen?: number;
}

interface SpaceFile {
  version: 1;
  spaceId: string;
  name: string;
  createdAt: number;
  devices: DeviceRecord[];
}

export class DeviceRegistry {
  readonly spaceId: string;
  readonly name: string;
  private readonly createdAt: number;
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly byHash = new Map<string, string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** `file` undefined = in memory only (tests). */
  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    let data: SpaceFile | undefined;
    if (file && existsSync(file)) {
      try {
        data = JSON.parse(readFileSync(file, 'utf8')) as SpaceFile;
      } catch (e) {
        throw new Error(`cannot read ${file}: ${(e as Error).message} (fix or delete it to start a new space)`);
      }
    }
    this.spaceId = data?.spaceId ?? `space-${randomId(8)}`;
    this.name = data?.name ?? 'Default space';
    this.createdAt = data?.createdAt ?? this.now();
    for (const d of data?.devices ?? []) {
      this.devices.set(d.deviceId, d);
      this.byHash.set(d.tokenHash, d.deviceId);
    }
    if (file && !data) this.flush();
  }

  get size(): number {
    return this.devices.size;
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => a.pairedAt - b.pairedAt);
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  /** The device a token belongs to, or undefined (unknown or revoked). */
  authenticate(token: string | undefined): DeviceRecord | undefined {
    if (!token) return undefined;
    const hash = sha256Hex(token);
    const id = this.byHash.get(hash);
    const device = id ? this.devices.get(id) : undefined;
    return device && safeEqual(device.tokenHash, hash) ? device : undefined;
  }

  /** Register a device; returns its token (shown once, never stored in clear). */
  add(input: { name: string; kind: DeviceKind; capabilities?: Capability[]; canApprove?: boolean }): { device: DeviceRecord; token: string } {
    const token = randomSecret(32);
    const device: DeviceRecord = {
      deviceId: `${input.kind}-${randomId(8)}`,
      name: input.name,
      kind: input.kind,
      capabilities: [...new Set(input.capabilities ?? [])],
      tokenHash: sha256Hex(token),
      canApprove: input.canApprove ?? kindCanApprove(input.kind),
      pairedAt: this.now(),
    };
    this.devices.set(device.deviceId, device);
    this.byHash.set(device.tokenHash, device.deviceId);
    this.flush();
    return { device, token };
  }

  remove(deviceId: string): boolean {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    this.devices.delete(deviceId);
    this.byHash.delete(d.tokenHash);
    this.flush();
    return true;
  }

  /** Descriptive fields a connected device may update (never kind or canApprove). */
  update(deviceId: string, patch: { capabilities?: Capability[] }): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    if (patch.capabilities) d.capabilities = [...new Set(patch.capabilities)];
    this.scheduleSave();
  }

  touch(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.lastSeen = this.now();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref?.();
  }

  /** Write now (atomic: temp file + rename). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.file) return;
    const data: SpaceFile = { version: 1, spaceId: this.spaceId, name: this.name, createdAt: this.createdAt, devices: this.list() };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
