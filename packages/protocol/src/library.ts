import { z } from 'zod';
import { Id, Vec3 } from './primitives';

/** Identity is independent of a room coordinate system. Bridge details disambiguate matching devices. */
export const LibraryIdentity = z.object({
  label: z.string().min(1).max(120),
  appearance: z.string().max(2000).optional(),
  maker: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  executorDeviceId: Id.optional(),
  portId: z.string().max(256).optional(),
  portName: z.string().max(256).optional(),
  manufacturer: z.string().max(256).optional(),
  irFingerprint: z.string().max(128).optional(),
});
export type LibraryIdentity = z.infer<typeof LibraryIdentity>;

/** Handles belong to one headset and HTTPS origin; fallback placement uses a fresh observation. */
export const RoomPlacement = z.object({
  headsetId: Id,
  origin: z.string().url().max(2048),
  handle: z.string().min(1).max(512).optional(),
  panelOffset: Vec3,
  fallback: z.object({ label: z.string().min(1).max(120), appearance: z.string().max(2000).optional() }),
  updatedAt: z.number().finite().nonnegative(),
});
export type RoomPlacement = z.infer<typeof RoomPlacement>;

export const LibraryDevice = z.object({
  cardId: Id,
  displayName: z.string().min(1).max(120),
  hidden: z.boolean(),
  identity: LibraryIdentity,
  placement: RoomPlacement.optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  enabled: z.boolean(),
  activeVersionId: Id.optional(),
  versions: z.array(z.object({ versionId: Id, createdAt: z.number().finite().nonnegative(), specId: Id.optional() })),
  lastKnownState: z.object({
    at: z.number().finite().nonnegative(),
    stepIndex: z.record(z.string(), z.number().finite()),
    paramValues: z.record(z.string(), z.number().finite()),
  }).optional(),
  connection: z.enum(['ready', 'setup', 'offline']),
});
export type LibraryDevice = z.infer<typeof LibraryDevice>;
export const LibraryStatePayload = z.object({ devices: z.array(LibraryDevice).max(64) });
export type LibraryStatePayload = z.infer<typeof LibraryStatePayload>;
export const LibraryPlacePayload = z.object({ cardId: Id, placement: RoomPlacement });
export type LibraryPlacePayload = z.infer<typeof LibraryPlacePayload>;
export const LibraryForgetPayload = z.object({ cardId: Id });
export const LibraryRestorePayload = z.object({ cardId: Id, versionId: Id });
export const LibraryRenamePayload = z.object({ cardId: Id, displayName: z.string().trim().min(1).max(120) });
