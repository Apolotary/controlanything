import type { PayloadOf, TaggedDevice } from '@ce/protocol';
import type { AppMode } from '../hud/contract';

export interface LocalTag extends Omit<TaggedDevice, 'cardId' | 'connection'> {
  targetId: string;
  cardId?: string;
  connection: TaggedDevice['connection'] | 'unknown';
  pending?: PayloadOf<'tag.add'>;
  busy?: boolean;
  sentence?: string;
}

/** Local intent survives a slow/offline server; only server snapshots establish connectivity. */
export class ModeState {
  mode: AppMode = 'annotate';
  readonly tags = new Map<string, LocalTag>();
  readonly removals = new Set<string>();
  private readonly cancelled = new Map<string, LocalTag>();

  add(targetId: string, payload: PayloadOf<'tag.add'>): LocalTag {
    this.cancelled.delete(targetId);
    const tag: LocalTag = { ...payload, targetId, connection: 'unknown', pending: payload };
    this.tags.set(targetId, tag);
    return tag;
  }

  byCard(cardId: string): LocalTag | undefined {
    for (const tag of this.tags.values()) if (tag.cardId === cardId) return tag;
    return undefined;
  }

  remove(targetId: string): LocalTag | undefined {
    const tag = this.tags.get(targetId);
    if (!tag) return;
    this.tags.delete(targetId);
    if (tag.cardId) this.removals.add(tag.cardId);
    else {
      this.cancelled.set(targetId, tag);
      while (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.keys().next().value!);
    }
    return tag;
  }

  /** Match pending picks by capture position/label, never by whichever object is selected now. */
  accept(remote: TaggedDevice): LocalTag | undefined {
    if (this.removals.has(remote.cardId)) return;
    for (const [id, cancelled] of this.cancelled) if (this.matches(cancelled, remote)) {
      this.cancelled.delete(id);
      this.removals.add(remote.cardId);
      return;
    }
    let tag = this.byCard(remote.cardId);
    if (!tag) {
      let nearest = Infinity;
      for (const candidate of this.tags.values()) {
        if (candidate.cardId) continue;
        const a = candidate.pending?.position ?? candidate.position, b = remote.position;
        const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
        const sameLabel = candidate.label.toLowerCase() === remote.label.toLowerCase();
        if ((distance < 0.5 || sameLabel && !b) && distance <= nearest) {
          tag = candidate;
          nearest = distance;
        }
      }
    }
    if (!tag) {
      tag = { ...remote, targetId: `tag:${remote.cardId}` };
      this.tags.set(tag.targetId, tag);
    }
    // The local tracker owns the live pose; snapshots retain the persisted capture pose.
    const position = tag.position ?? remote.position;
    Object.assign(tag, remote, { position, pending: undefined });
    return tag;
  }

  private matches(local: LocalTag, remote: TaggedDevice): boolean {
    const a = local.pending?.position ?? local.position, b = remote.position;
    if (a && b) return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.5;
    return local.label.toLowerCase() === remote.label.toLowerCase();
  }

  snapshot(tags: TaggedDevice[]): LocalTag[] {
    const present = new Set(tags.map((tag) => tag.cardId));
    const removed: LocalTag[] = [];
    for (const tag of this.tags.values()) if (tag.cardId && !present.has(tag.cardId)) {
      this.tags.delete(tag.targetId);
      removed.push(tag);
    }
    for (const cardId of this.removals) if (!present.has(cardId)) this.removals.delete(cardId);
    for (const tag of tags) this.accept(tag);
    return removed;
  }

  disconnected(): void {
    for (const tag of this.tags.values()) tag.connection = 'unknown';
  }

  canSetup(targetId: string): boolean {
    const tag = this.tags.get(targetId);
    return this.mode === 'control' && !!tag?.cardId && tag.connection === 'setup' && !tag.busy;
  }
}
