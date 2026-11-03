import {
  DeviceCardPayload, Driver, Evidence, Id, IrCapture, IrOp, LibraryIdentity,
  LinkResultPayload, Provenance, RoomPlacement, TaggedDevice, UiSpecPayload, VerifyState,
} from '@ce/protocol';
import { z } from 'zod';
import type { Research } from './types';
import { IdentityCorrectionAudit } from './identity-correction';

const Timestamp = z.number().finite().nonnegative();
const Values = z.record(z.string(), z.number().finite());
const Source = z.object({ title: z.string(), url: z.string(), confidence: z.string().optional() });
const MidiProfile = z.object({
  id: z.string(), device: z.string(), manufacturer: z.string(), firmwareNotes: z.string().optional(),
  sense: z.enum(['camera', 'audio']).optional(),
  reviewedChart: z.object({ cardId: z.string(), revision: z.number().int().positive(), channel: z.number().int().min(1).max(16), reviewedAt: z.number().nonnegative(), reviewedBy: z.string() }).optional(),
  sources: z.array(Source),
  usb: z.object({ classCompliantMidi: z.boolean().optional(), classCompliantAudio: z.boolean().optional(), portNameHint: z.string().optional(), notes: z.string().optional() }).optional(),
  identity: z.object({ respondsToUniversalInquiry: z.boolean().nullable(), manufacturerId: z.array(z.number()).optional(), replyExample: z.string().nullable().optional(), notes: z.string().optional() }).optional(),
  channels: z.object({ receive: z.string().optional(), send: z.string().optional(), notes: z.string().optional() }).optional(),
  parameters: z.array(z.object({ name: z.string(), group: z.string().optional(), cc: z.number().nullable(), nrpn: z.number().nullable().optional(), range: z.tuple([z.number(), z.number()]).optional(), channel: z.string().optional(), confidence: z.string().optional(), notes: z.string().optional() })),
  unsafeMessages: z.array(z.string()).optional(),
  demo: z.object({ bestParameters: z.array(z.string()).optional(), visualFeedback: z.string().optional(), audibleFeedback: z.string().optional(), risks: z.array(z.string()).optional(), setup: z.array(z.string()).optional() }).optional(),
});

export const SavedResearch = z.object({
  brief: z.string(), provenance: z.array(Provenance), profile: MidiProfile.optional(),
  allowedCcs: z.array(z.number().int().min(0).max(127)).optional(),
  irLibrary: z.object({
    id: z.string(), device: z.string(), status: z.string().optional(), sources: z.array(Source),
    candidates: z.array(z.object({ ref: z.string(), brand: z.string(), channel: z.number(), key: z.string(), op: IrOp, confidence: z.string(), order: z.number() })),
    doNotSend: z.array(z.object({ brand: z.string(), what: z.string(), bytes: z.array(z.array(z.number())) })),
  }).optional(),
  learned: z.array(IrCapture.extend({
    learnId: z.string(), button: z.string(),
    hypothesis: z.enum(['fullOn', 'off', 'brighter', 'dimmer', 'nightLight', 'warmer', 'cooler', 'unknown']),
    seen: z.string().optional(), capturedAt: Timestamp,
  })).optional(),
  modelId: z.string().optional(),
});

export function saveResearch(research?: Research): z.infer<typeof SavedResearch> | undefined {
  return research ? SavedResearch.parse({ ...research, allowedCcs: research.allowedCcs ? [...research.allowedCcs] : undefined }) : undefined;
}

export function restoreResearch(research?: z.infer<typeof SavedResearch>): Research | undefined {
  return research ? { ...structuredClone(research), allowedCcs: research.allowedCcs ? new Set(research.allowedCcs) : undefined } : undefined;
}

export const AssetRef = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/), ext: z.string().regex(/^[a-z0-9]{1,10}$/),
  path: z.string().regex(/^library\/assets\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/),
  mime: z.string().optional(),
}).refine((ref) => ref.path === `library/assets/${ref.hash}.${ref.ext}`, 'Asset path must match its content hash');
export type AssetRef = z.infer<typeof AssetRef>;

export const SetupData = z.object({
  identityRevision: z.number().int().nonnegative().optional(),
  driver: Driver, link: LinkResultPayload.optional(),
  verification: z.record(z.string(), VerifyState), evidence: z.array(Evidence),
  research: SavedResearch.optional(), specId: Id, uiSpec: UiSpecPayload,
  controlCount: z.number().int().nonnegative().optional(),
  forgeContext: z.json().optional(), skinRefs: z.array(AssetRef).default([]),
});
export const SetupVersion = SetupData.extend({ versionId: Id, createdAt: Timestamp }).superRefine((setup, ctx) => {
  if (setup.uiSpec.specId !== setup.specId || setup.uiSpec.driverId !== setup.driver.driverId || setup.uiSpec.cardId !== setup.driver.cardId) {
    ctx.addIssue({ code: 'custom', message: 'Setup driver and interface must belong together' });
  }
});
export type SetupVersion = z.infer<typeof SetupVersion>;

export const LegacyTag = z.object({
  cardId: Id, label: TaggedDevice.shape.label, position: TaggedDevice.shape.position,
  card: DeviceCardPayload.optional(),
  selection: z.object({ userText: z.string().optional(), preferDeviceId: Id.optional() }).optional(),
  driver: Driver.optional(), link: LinkResultPayload.optional(),
  verification: z.record(z.string(), VerifyState).default({}), armed: z.boolean().default(false),
  specId: Id.optional(), uiSpec: UiSpecPayload.optional(), controlCount: z.number().int().nonnegative().optional(),
  stepIndex: Values.default({}), paramValues: Values.default({}),
});

export const LibraryRecord = z.object({
  cardId: Id, displayName: z.string().min(1).max(120), hidden: z.boolean(),
  identity: LibraryIdentity, placement: RoomPlacement.optional(),
  identityRevision: z.number().int().nonnegative().optional(),
  identityCorrections: z.array(IdentityCorrectionAudit).max(32).optional(),
  // Old coordinates are retained for migration only; clients must qualify them by session before use.
  position: TaggedDevice.shape.position,
  card: DeviceCardPayload.optional(), selection: LegacyTag.shape.selection,
  draft: LegacyTag.extend({ identityRevision: z.number().int().nonnegative().optional(), evidence: z.array(Evidence).default([]), research: SavedResearch.optional() }).optional(),
  createdAt: Timestamp, updatedAt: Timestamp, enabled: z.boolean(),
  activeVersionId: Id.optional(), candidateVersionId: Id.optional(),
  candidate: z.object({ id: Id, createdAt: Timestamp, enabledAtStart: z.boolean(), cancelled: z.boolean().default(false) }).optional(),
  versions: z.array(SetupVersion),
  lastKnownState: z.object({ at: Timestamp, stepIndex: Values, paramValues: Values }).optional(),
}).superRefine((record, ctx) => {
  const ids = new Set(record.versions.map((version) => version.versionId));
  if (ids.size !== record.versions.length || record.versions.some((version) => version.driver.cardId !== record.cardId)) {
    ctx.addIssue({ code: 'custom', message: 'Setup versions must uniquely belong to their device' });
  }
  if ([record.activeVersionId, record.candidateVersionId].some((id) => id !== undefined && !ids.has(id))) {
    ctx.addIssue({ code: 'custom', message: 'Referenced setup version is missing' });
  }
  if (record.card && record.card.cardId !== record.cardId) ctx.addIssue({ code: 'custom', message: 'Card identity does not match its record' });
});
export type LibraryRecord = z.infer<typeof LibraryRecord>;

export const LibraryFile = z.object({ version: z.literal(2), records: z.array(LibraryRecord).max(64) });
export type StoredTag = z.infer<typeof LegacyTag> & {
  evidence: z.infer<typeof Evidence>[];
  research?: Research;
  forgeContext?: unknown;
  skinRefs: AssetRef[];
  placement?: z.infer<typeof RoomPlacement>;
  activeVersionId?: string;
  identityRevision?: number;
  identityCorrection?: z.infer<typeof IdentityCorrectionAudit>;
};
