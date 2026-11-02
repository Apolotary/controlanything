import type { LibraryDevice, RoomPlacement } from '@ce/protocol';
import { Quaternion, Vector3 } from 'three';

export const MAX_PERSISTENT_ANCHORS = 8;
export type LocationState = 'unlocated' | 'locating' | 'located';
interface PersistentAnchor { anchorSpace: XRSpace; delete(): void; requestPersistentHandle?: () => Promise<string> }
export interface AnchorSession {
  enabledFeatures?: readonly string[];
  persistentAnchors?: readonly string[];
  restorePersistentAnchor?: (handle: string) => Promise<PersistentAnchor>;
  deletePersistentAnchor?: (handle: string) => Promise<void>;
}
export interface AnchorFrame {
  session: AnchorSession;
  createAnchor?: (pose: XRRigidTransform, space: XRSpace) => Promise<PersistentAnchor>;
  getPose(space: XRSpace, baseSpace: XRSpace): XRPose | null | undefined;
}
interface PendingAnchor { position: Vector3; facing: Vector3; placement: RoomPlacement; prepared: boolean }

export function localPlacement(placement: RoomPlacement | undefined, headsetId: string, origin: string): boolean {
  return !!placement && placement.headsetId === headsetId && placement.origin === origin;
}

/** Session coordinates stay in memory. Only a headset/origin-scoped handle and relative offset are saved. */
export class RoomAnchors {
  readonly devices = new Map<string, LibraryDevice>();
  readonly states = new Map<string, LocationState>();
  private readonly anchors = new Map<string, PersistentAnchor>();
  private readonly pending = new Map<string, PendingAnchor>();
  private readonly restoring = new Set<string>();
  private readonly attempted = new Set<string>();
  private readonly usedAt = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private session?: AnchorSession;
  private generation = 0;
  private busy = false;
  private headsetId = '';
  private origin = '';
  private readonly orientation = new Quaternion();
  private readonly offset = new Vector3();

  constructor(private readonly callbacks: {
    save(cardId: string, placement: RoomPlacement): void;
    locate(cardId: string, position: Vector3 | null): void;
  }) {}

  setDevices(devices: readonly LibraryDevice[]): void {
    const present = new Set(devices.map((device) => device.cardId));
    for (const cardId of this.devices.keys()) if (!present.has(cardId)) void this.forget(cardId);
    for (const device of devices) {
      const previous = this.devices.get(device.cardId);
      // A pending local save can precede a snapshot emitted for an unrelated server event.
      const placement = previous?.placement && (!device.placement || previous.placement.updatedAt > device.placement.updatedAt) ? previous.placement : device.placement;
      this.devices.set(device.cardId, { ...device, placement });
      if (!this.states.has(device.cardId)) this.states.set(device.cardId, 'unlocated');
    }
    this.restore();
  }

  begin(session: AnchorSession, headsetId: string, origin: string): void {
    this.end();
    this.session = session; this.headsetId = headsetId; this.origin = origin;
    this.restore();
  }

  end(): void {
    this.generation++;
    for (const anchor of this.anchors.values()) anchor.delete();
    this.anchors.clear(); this.pending.clear(); this.restoring.clear(); this.attempted.clear();
    this.session = undefined; this.busy = false;
    for (const cardId of this.devices.keys()) this.states.set(cardId, 'unlocated');
  }

  private restore(): void {
    const session = this.session, generation = this.generation;
    if (!session?.restorePersistentAnchor || !session.persistentAnchors || session.enabledFeatures && !session.enabledFeatures.includes('anchors')) return;
    for (const device of this.devices.values()) {
      const placement = device.placement;
      if (device.hidden || !placement?.handle || !localPlacement(placement, this.headsetId, this.origin)
        || this.anchors.has(device.cardId) || this.pending.has(device.cardId) || this.attempted.has(device.cardId)) continue;
      this.attempted.add(device.cardId);
      if (!session.persistentAnchors.includes(placement.handle)) continue;
      this.states.set(device.cardId, 'locating'); this.restoring.add(device.cardId);
      void session.restorePersistentAnchor(placement.handle).then((anchor) => {
        if (this.generation !== generation || this.devices.get(device.cardId)?.placement?.handle !== placement.handle) { anchor.delete(); return; }
        this.anchors.set(device.cardId, anchor);
      }).catch(() => {
        if (this.generation === generation && this.devices.get(device.cardId)?.placement?.handle === placement.handle) {
          this.states.set(device.cardId, 'unlocated'); this.callbacks.locate(device.cardId, null);
        }
      })
        .finally(() => { if (this.generation === generation) this.restoring.delete(device.cardId); });
    }
  }

  /** Called after an explicit pick or an unambiguous fresh detection, never from saved XYZ. */
  place(cardId: string, position: Vector3, facing = new Vector3(0, 0, 1)): void {
    const device = this.devices.get(cardId);
    if (!device || !this.headsetId || !this.session) return;
    this.revisions.set(cardId, (this.revisions.get(cardId) ?? 0) + 1);
    this.anchors.get(cardId)?.delete(); this.anchors.delete(cardId);
    const placement: RoomPlacement = { headsetId: this.headsetId, origin: this.origin,
      panelOffset: device.placement?.panelOffset ?? { x: 0, y: 0, z: 0 },
      fallback: { label: device.identity.label, appearance: device.identity.appearance }, updatedAt: Date.now() };
    const oldHandle = localPlacement(device.placement, this.headsetId, this.origin) ? device.placement?.handle : undefined;
    // A moved object gets a new anchor; the old physical place must not return next session.
    this.pending.set(cardId, { position: position.clone(), facing: facing.clone(), placement, prepared: !oldHandle || !this.session?.deletePersistentAnchor });
    if (oldHandle) void this.session?.deletePersistentAnchor?.(oldHandle).catch(() => undefined).finally(() => {
      const pending = this.pending.get(cardId); if (pending?.placement === placement) pending.prepared = true;
    });
    this.usedAt.set(cardId, placement.updatedAt);
    this.save(cardId, placement); this.states.set(cardId, 'located');
    this.callbacks.locate(cardId, this.panelPosition(position, facing, placement.panelOffset));
  }

  private save(cardId: string, placement: RoomPlacement): void {
    const device = this.devices.get(cardId);
    if (!device) return;
    device.placement = placement;
    this.callbacks.save(cardId, placement);
  }

  touch(cardId: string): void {
    if (this.devices.has(cardId)) this.usedAt.set(cardId, Date.now());
  }

  private panelPosition(position: Vector3, facing: Vector3, offset: RoomPlacement['panelOffset']): Vector3 {
    this.orientation.setFromUnitVectors(new Vector3(0, 0, 1), facing.clone().normalize());
    return position.clone().add(this.offset.set(offset.x, offset.y, offset.z).applyQuaternion(this.orientation));
  }

  /** Creation is invoked synchronously inside the active XRFrame, after asynchronous eviction has finished. */
  update(frame: AnchorFrame, referenceSpace: XRReferenceSpace): void {
    if (frame.session !== this.session) return;
    const session = this.session;
    for (const cardId of this.restoring) this.callbacks.locate(cardId, null);
    for (const [cardId, anchor] of this.anchors) {
      let pose: XRPose | null = null;
      try { pose = frame.getPose(anchor.anchorSpace, referenceSpace) ?? null; } catch { /* tracking may be temporarily unavailable */ }
      this.states.set(cardId, pose ? 'located' : 'locating');
      if (!pose) { this.callbacks.locate(cardId, null); continue; }
      const point = pose.transform.position, rotation = pose.transform.orientation;
      const offset = this.devices.get(cardId)?.placement?.panelOffset ?? { x: 0, y: 0, z: 0 };
      this.orientation.set(rotation.x, rotation.y, rotation.z, rotation.w);
      this.offset.set(offset.x, offset.y, offset.z).applyQuaternion(this.orientation).add(new Vector3(point.x, point.y, point.z));
      this.callbacks.locate(cardId, this.offset);
    }
    if (this.busy || !this.pending.size) return;
    const [cardId, pending] = this.pending.entries().next().value!;
    if (!pending.prepared) return;
    if (!frame.createAnchor || !session?.restorePersistentAnchor || session.enabledFeatures && !session.enabledFeatures.includes('anchors')) {
      this.pending.delete(cardId); return;
    }
    if ((session.persistentAnchors?.length ?? 0) >= MAX_PERSISTENT_ANCHORS) {
      this.busy = true;
      const generation = this.generation;
      void this.makeRoom(session, cardId).finally(() => { if (generation === this.generation) this.busy = false; });
      return;
    }
    this.pending.delete(cardId); this.busy = true;
    const generation = this.generation;
    const revision = this.revisions.get(cardId);
    this.orientation.setFromUnitVectors(new Vector3(0, 0, 1), pending.facing.normalize());
    let created: Promise<PersistentAnchor>;
    try { created = frame.createAnchor(new XRRigidTransform(pending.position, this.orientation), referenceSpace); }
    catch { this.busy = false; return; }
    void created.then(async (anchor) => {
      if (this.generation !== generation || !this.devices.has(cardId) || this.revisions.get(cardId) !== revision) { anchor.delete(); return; }
      this.anchors.set(cardId, anchor);
      if (!anchor.requestPersistentHandle) return;
      const handle = await anchor.requestPersistentHandle();
      if (this.generation !== generation || !this.devices.has(cardId) || this.revisions.get(cardId) !== revision) { await session.deletePersistentAnchor?.(handle); return; }
      this.save(cardId, { ...pending.placement, handle });
    }).catch(() => undefined).finally(() => { if (generation === this.generation) this.busy = false; });
  }

  private async makeRoom(session: AnchorSession, except: string): Promise<void> {
    const pending = this.pending.get(except);
    const handles = session.persistentAnchors ?? [];
    const owners = [...this.devices.values()].filter((device) => device.cardId !== except
      && localPlacement(device.placement, this.headsetId, this.origin) && handles.includes(device.placement?.handle ?? ''))
      .sort((a, b) => (this.usedAt.get(a.cardId) ?? a.placement!.updatedAt) - (this.usedAt.get(b.cardId) ?? b.placement!.updatedAt));
    const owner = owners[0];
    const handle = owner?.placement?.handle ?? handles[0];
    if (!handle || !session.deletePersistentAnchor) { if (this.pending.get(except) === pending) this.pending.delete(except); return; }
    try {
      await session.deletePersistentAnchor(handle);
      const current = owner && this.devices.get(owner.cardId);
      if (current?.placement?.handle === handle) { const { handle: _handle, ...fallback } = current.placement; this.save(current.cardId, fallback); }
    } catch { if (this.pending.get(except) === pending) this.pending.delete(except); }
  }

  async forget(cardId: string): Promise<void> {
    const placement = this.devices.get(cardId)?.placement;
    this.anchors.get(cardId)?.delete(); this.anchors.delete(cardId); this.pending.delete(cardId);
    this.devices.delete(cardId); this.states.delete(cardId); this.attempted.delete(cardId); this.usedAt.delete(cardId); this.revisions.delete(cardId);
    if (placement?.handle && localPlacement(placement, this.headsetId, this.origin)) {
      await this.session?.deletePersistentAnchor?.(placement.handle).catch(() => undefined);
    }
  }
}
