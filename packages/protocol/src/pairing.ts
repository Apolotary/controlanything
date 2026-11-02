/**
 * Device pairing (OAuth device-code style), shared by the server and every client.
 *
 *   1. An unpaired device calls POST /api/pair/start (or sends WS `pair.start`) and shows
 *      the returned `qr` URL as a QR code plus the code as "K7Q-4M2".
 *   2. A trusted device (a paired quest/mac/iphone, the Mac on localhost, or the server console)
 *      approves it: POST /api/pair/approve {code} or WS `pair.approve {code}`.
 *   3. The new device polls GET /api/pair/status?pairingId&pollSecret (or waits on the WS) and
 *      receives {deviceId, deviceToken} exactly once. It stores the token and connects to /ws
 *      with `hello {deviceToken}`.
 */
import { z } from 'zod';
import { Capability, DeviceKind, Id, Role } from './primitives';

/** Unambiguous alphabet: no 0/O, 1/I/L. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
/** How long a pairing request stays valid. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Upper-case and drop separators, so "k7q-4m2" and "K7Q 4M2" both become "K7Q4M2". */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** "K7Q4M2" -> "K7Q-4M2" (display form). */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

export function isValidCode(input: string): boolean {
  const c = normalizeCode(input);
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

/** Who acts as what by default; a device may override its role in `hello`. */
export const DEFAULT_ROLE: Record<DeviceKind, Role> = {
  quest: 'hmd',
  mac: 'companion',
  iphone: 'controller',
  devterm: 'device',
  cardputer: 'device',
  web: 'controller',
  sim: 'device',
  remo: 'device',
};

/** Only these kinds may approve new devices. */
export const APPROVER_KINDS: readonly DeviceKind[] = ['quest', 'mac', 'iphone'];

export function kindCanApprove(kind: DeviceKind): boolean {
  return APPROVER_KINDS.includes(kind);
}

export const PairingStatus = z.enum(['pending', 'approved', 'denied', 'expired']);
export type PairingStatus = z.infer<typeof PairingStatus>;

// --- HTTP API bodies (WS `pair.*` payloads reuse these where the shapes match) -----------------

/** POST /api/pair/start body; also the WS `pair.start` payload. */
export const PairStartRequest = z.object({
  name: z.string().min(1).max(120),
  kind: DeviceKind,
  capabilities: z.array(Capability).max(32).optional(),
  /**
   * true = never auto-approve this request (not for localhost, not for trust-first-device): it stays pending
   * until the Quest looks at the QR or the owner types the code. Used when the companion pairs on behalf of
   * a Cardputer so the QR moment really happens.
   */
  requireApproval: z.boolean().optional(),
});
export type PairStartRequest = z.infer<typeof PairStartRequest>;

/**
 * POST /api/pair/start response. When the server approves on the spot (request from localhost,
 * or CE_TRUST_FIRST_DEVICE with an empty registry) `status` is "approved" and the credentials
 * are included right away.
 */
export const PairStartResponse = z.object({
  pairingId: Id,
  /** canonical code, e.g. "K7Q4M2" */
  code: z.string(),
  /** display form, e.g. "K7Q-4M2" */
  display: z.string(),
  /** short URL to encode as the QR: https://<lan-host>:8443/p/<pairingId>#<code> */
  qr: z.string(),
  expiresAt: z.number(),
  /** secret for GET /api/pair/status; only the requesting device has it */
  pollSecret: z.string(),
  status: PairingStatus,
  deviceId: Id.optional(),
  deviceToken: z.string().optional(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

/** GET /api/pair/status response. deviceId/deviceToken appear once, on the first read after approval. */
export const PairStatusResponse = z.object({
  pairingId: Id,
  status: PairingStatus,
  expiresAt: z.number(),
  deviceId: Id.optional(),
  deviceToken: z.string().optional(),
  reason: z.string().optional(),
});
export type PairStatusResponse = z.infer<typeof PairStatusResponse>;

/** POST /api/pair/approve body; also the WS `pair.approve` payload. */
export const PairApproveRequest = z.object({
  code: z.string().min(1).max(32),
  /** optional: when known (e.g. from the QR URL) the code must match this request */
  pairingId: Id.optional(),
});
export type PairApproveRequest = z.infer<typeof PairApproveRequest>;

/** POST /api/pair/deny body; also the WS `pair.deny` payload. Give pairingId or code. */
export const PairDenyRequest = z.object({
  pairingId: Id.optional(),
  code: z.string().max(32).optional(),
});
export type PairDenyRequest = z.infer<typeof PairDenyRequest>;

/** A pending request as approvers see it (GET /api/pair/pending, WS `pair.pending`). */
export const PendingPairing = z.object({
  pairingId: Id,
  name: z.string(),
  kind: DeviceKind,
  capabilities: z.array(Capability),
  code: z.string(),
  display: z.string(),
  requestedAt: z.number(),
  expiresAt: z.number(),
  /** remote address the request came from */
  origin: z.string().optional(),
});
export type PendingPairing = z.infer<typeof PendingPairing>;
