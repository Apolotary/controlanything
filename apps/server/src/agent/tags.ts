import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DeviceCardPayload, Driver, Id, LinkResultPayload, TaggedDevice, UiSpecPayload, VerifyState } from '@ce/protocol';
import { z } from 'zod';
import { roster as devices, type Roster } from './executors';
import { neededCapability, type LinkCapability } from './link';
import { MAC_LOCAL_ID } from './maclocal';
import { synthConnectionGuidance } from './guidance';
import type { Target } from './types';

const StoredTagSchema = z.object({
  cardId: Id,
  label: TaggedDevice.shape.label,
  position: TaggedDevice.shape.position,
  card: DeviceCardPayload.optional(),
  selection: z.object({ userText: z.string().optional(), preferDeviceId: Id.optional() }).optional(),
  driver: Driver.optional(),
  link: LinkResultPayload.optional(),
  verification: z.record(z.string(), VerifyState).default({}),
  armed: z.boolean().default(false),
  specId: Id.optional(),
  uiSpec: UiSpecPayload.optional(),
  controlCount: z.number().int().nonnegative().optional(),
  stepIndex: z.record(z.string(), z.number()).default({}),
  paramValues: z.record(z.string(), z.number()).default({}),
});
const TagFile = z.object({ version: z.literal(1), tags: z.array(StoredTagSchema).max(64) });

export type StoredTag = z.infer<typeof StoredTagSchema>;

/** Persistent user selections and their completed setup; frame bytes and in-flight work stay in memory. */
export class TagStore {
  private readonly tags = new Map<string, StoredTag>();

  /** An omitted path keeps the store in memory for tests. */
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    const data = TagFile.parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const tag of data.tags) this.tags.set(tag.cardId, tag);
  }

  list(): StoredTag[] {
    return structuredClone([...this.tags.values()]);
  }

  get(cardId: string): StoredTag | undefined {
    const tag = this.tags.get(cardId);
    return tag ? structuredClone(tag) : undefined;
  }

  has(cardId: string): boolean {
    return this.tags.has(cardId);
  }

  add(target: Target, label: string, position?: TaggedDevice['position']): StoredTag {
    if (!this.has(target.cardId) && this.tags.size >= 64) throw new Error('A space can have at most 64 tagged devices');
    const tag = this.capture(target, label, position ?? this.tags.get(target.cardId)?.position);
    this.tags.set(tag.cardId, tag);
    this.flush();
    return structuredClone(tag);
  }

  /** Synchronize setup changes only for a device the user has already tagged. */
  sync(target: Target, spec?: UiSpecPayload): void {
    const old = this.tags.get(target.cardId);
    if (!old) return;
    const tag = this.capture(target, old.label, old.position, spec);
    if (JSON.stringify(old) === JSON.stringify(tag)) return;
    this.tags.set(tag.cardId, tag);
    this.flush();
  }

  remove(cardId: string): boolean {
    if (!this.tags.delete(cardId)) return false;
    this.flush();
    return true;
  }

  private capture(t: Target, label: string, position?: TaggedDevice['position'], spec?: UiSpecPayload): StoredTag {
    const candidate = spec ?? this.tags.get(t.cardId)?.uiSpec;
    const uiSpec = candidate?.specId === t.specId && candidate?.cardId === t.cardId && candidate?.driverId === t.driver?.driverId ? candidate : undefined;
    return StoredTagSchema.parse({
      cardId: t.cardId, label, position, card: t.card, selection: t.selection,
      driver: t.driver, link: t.link, verification: t.verification, armed: t.armed,
      specId: t.specId, uiSpec, controlCount: t.controlCount, stepIndex: t.stepIndex, paramValues: t.paramValues,
    });
  }

  private flush(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, tags: [...this.tags.values()] }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export function tagCapability(t: Target): LinkCapability | undefined {
  const card = t.card;
  if (!card) return undefined;
  switch (card.category) {
    case 'synthesizer':
    case 'drum-machine':
    case 'sampler':
    case 'groovebox':
    case 'midi-controller': return 'midi';
    case 'lighting':
    case 'remote-control': return 'ir';
    case 'computer':
    case 'phone': return 'local';
  }
  const label = `${card.name} ${t.detection?.label ?? ''}`;
  if (/\b(synth(?:esizer)?|keyboard)\b/i.test(label)) return 'midi';
  if (/\b(light|lamp|tv|television|ac|air conditioner)\b/i.test(label)) return 'ir';
  if (/\b(laptop|macbook|this mac)\b/i.test(label)) return 'local';
  return neededCapability(card);
}

/** Recompute from current presence on every snapshot; an old link is never proof of a live bridge. */
export function evaluateConnection(t: Target, roster: Roster): Pick<TaggedDevice, 'connection' | 'hint' | 'action'> {
  if (!t.card) return { connection: 'offline', hint: 'Identify this tagged device before setting up control' };
  const cap = tagCapability(t);
  const hint = cap === 'ir'
      ? 'Pair the Cardputer IR node or connect a Nature Remo bridge'
      : cap === 'local'
        ? 'Open the Mac app and enable control of this Mac'
        : 'Connect a companion that can reach this device';
  let offline: Pick<TaggedDevice, 'connection' | 'hint' | 'action'> = {
    connection: 'offline', hint, ...(cap === 'ir' ? { action: 'pair-device' } : cap === 'local' ? { action: 'open-companion' } : {}),
  };
  if (!cap) return offline;
  const present = devices(roster);
  // Scan selection also carries the requesting headset; it is not the device being controlled.
  const selectedLocal = cap === 'local'
    ? /^device:(.+)$/.exec(t.card.notes ?? '')?.[1]
      ?? present.find((d) => d.deviceId === t.selection?.preferDeviceId && d.capabilities.includes('local') && (d.kind === 'mac' || d.kind === 'sim'))?.deviceId
    : undefined;
  const assigned = t.driver?.executor.deviceId ?? t.link?.executorDeviceId ?? selectedLocal;
  const portId = t.driver?.executor.port ?? t.link?.port?.id;
  if (cap === 'midi') {
    // A connected companion can have no MIDI capability yet (permission pending, or a standby tab).
    // The internal Mac executor never hosts browser MIDI ports.
    const companionOnline = present.some((d) => d.online && d.deviceId !== MAC_LOCAL_ID
      && (!assigned || d.deviceId === assigned) && (d.role === 'companion' || d.capabilities.includes('midi')));
    const guidance = synthConnectionGuidance(companionOnline);
    offline = { connection: 'offline', hint: guidance.hint, ...(guidance.action ? { action: guidance.action } : {}) };
  }
  const online = present.filter((d) => d.online && d.capabilities.includes(cap));
  const reachable = online.some((d) => {
    if (assigned && d.deviceId !== assigned) return false;
    if (cap === 'midi') return d.ports?.some((p) => p.kind === 'midi-out' && p.state !== 'disconnected' && (!portId || p.id === portId));
    if (cap === 'local' && !assigned) return d.deviceId === MAC_LOCAL_ID || d.kind === 'mac' || d.kind === 'sim';
    return true;
  });
  if (!reachable) return offline;
  const verified = t.driver?.actions.some((a) => t.verification[a.actionId] === 'pass');
  if (t.driver && t.armed && t.specId && verified && (cap !== 'midi' || t.driver.executor.port)) {
    return { connection: 'ready' };
  }
  return { connection: 'setup', hint: 'Set up control for this device' };
}

export function tagSnapshot(tag: StoredTag, target: Target, roster: Roster): TaggedDevice {
  return {
    cardId: tag.cardId, label: tag.label, position: tag.position,
    name: target.card?.name, category: target.card?.category, specId: target.specId,
    ...evaluateConnection(target, roster),
  };
}
