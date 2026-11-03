/** Owner-reviewed identity corrections. This module never calls models or device executors. */
import { DeviceCardPayload, newId, type DeviceInfo } from '@ce/protocol';
import { z } from 'zod';
import type { Target } from './types';

export const IDENTITY_REVIEW_TTL_MS = 120_000;
const normalize = (text: string) => text.normalize('NFKC').replace(/[‐‑‒–—]/g, '-').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const fieldName = /\bop[ -]?(?:1|one)\s*field\b/i;

/** Detect correction intent before an assistant reuses the stale object's control capabilities. */
export function isIdentityCorrectionRequest(text: string): boolean {
  const value = normalize(text);
  return /\b(re-?identify|misidentified|misclassified|wrong (?:device|object|identity)|correct (?:the |this |its |your )?(?:identity|identification|device|object))\b/i.test(value)
    || (/\b(?:this|that|it|the (?:device|object|instrument|keyboard)|this (?:device|object|instrument|keyboard))\s+(?:is|isn't|is not|is actually|should be|was misidentified|was identified)\b/i.test(value)
      && /\b(?:op[ -]?(?:1|one)|actually|not|isn't)\b/i.test(value))
    || /\bit's\s+(?:actually\s+)?(?:an?\s+)?(?:(?:teenage\s+engineering\s+)?op[ -]?(?:1|one)|not\b)/i.test(value);
}

export interface IdentityPortEvidence {
  deviceId: string;
  deviceName: string;
  portId: string;
  portName: string;
  manufacturer?: string;
}

/** A USB family name is corroboration, never proof of Field model, firmware, or working controls. */
export function physicalOp1Outputs(devices: DeviceInfo[]): IdentityPortEvidence[] {
  const ports = new Map<string, IdentityPortEvidence>();
  for (const device of devices) {
    if (!device.online || device.kind !== 'mac' || device.role !== 'companion' || !device.capabilities.includes('midi')) continue;
    for (const port of device.ports ?? []) {
      if (port.kind !== 'midi-out' || port.state !== 'connected' || !/\bop[ -]?1\b/i.test(normalize(port.name))) continue;
      if (port.manufacturer?.trim() && !/teenage\s+engineering/i.test(port.manufacturer)) continue;
      ports.set(JSON.stringify([device.deviceId, port.id]), { deviceId: device.deviceId, deviceName: device.name,
        portId: port.id, portName: port.name, ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}) });
    }
  }
  return [...ports.values()];
}

function signature(target: Target): string {
  return JSON.stringify([target.cardId, target.runId, target.card, target.selectedBy, target.selection,
    target.state, target.driver, target.specId, target.verification, target.armed, target.armId]);
}
const busy = (target: Target) => target.armed || Boolean(target.armId || target.abort && !target.abort.signal.aborted);

export interface IdentityCorrectionProposal {
  proposalId: string;
  cardId: string;
  summary: string;
  reviewLines: string[];
  evidence: IdentityPortEvidence;
  expiresAt: number;
  firmware: 'unknown';
}
export type IdentityProposalResult = { ok: true; proposal: IdentityCorrectionProposal } | { ok: false; reason: string };
export const IdentityCorrectionAudit = z.object({
  source: z.literal('user-confirmed'), proposalId: z.string().min(1).max(128), cardId: z.string().min(1).max(128),
  confirmedBy: z.string().min(1).max(128), confirmedAt: z.number().int().nonnegative(),
  previousIdentity: DeviceCardPayload.pick({ name: true, maker: true, model: true, category: true, protocols: true }),
  identity: z.object({ maker: z.literal('Teenage Engineering'), model: z.literal('OP-1 Field') }).strict(),
  portEvidence: z.object({ deviceId: z.string().min(1).max(128), deviceName: z.string().max(120),
    portId: z.string().min(1).max(200), portName: z.string().max(200), manufacturer: z.string().max(120).optional() }).strict(),
  firmware: z.literal('unknown'), physicalControlVerified: z.literal(false),
}).strict();
export type IdentityCorrectionAudit = z.infer<typeof IdentityCorrectionAudit>;
export type IdentityConfirmationResult =
  | { status: 'confirmed'; patch: Partial<Target> & { card: DeviceCardPayload; armed: false }; audit: IdentityCorrectionAudit }
  | { status: 'dismissed' | 'rejected'; reason: string };
interface Pending {
  proposal: IdentityCorrectionProposal;
  sender: string;
  signature: string;
}

/** Integration owns auth, durable tags and cancelling local UI/driver subscriptions before patch application. */
export class IdentityCorrections {
  private pending = new Map<string, Pending>();
  constructor(private readonly now: () => number = Date.now) {}

  propose(target: Target, text: string, sender: string, devices: DeviceInfo[]): IdentityProposalResult {
    this.cancel(sender, target.cardId);
    for (const [id, entry] of this.pending) if (entry.proposal.expiresAt <= this.now()) this.pending.delete(id);
    if (!sender || !target.card) return { ok: false, reason: 'Select an identified object first, then correct its exact maker and model.' };
    if (busy(target)) return { ok: false, reason: 'Stop controls and finish or cancel setup before correcting this object.' };
    const request = normalize(text);
    if (!isIdentityCorrectionRequest(request) || !fieldName.test(request)
      || /\b(?:not|isn't)\s+(?:an?\s+)?(?:teenage engineering\s+)?op[ -]?(?:1|one)\s*field\b/i.test(request)) {
      return { ok: false, reason: 'Tell me the exact maker and model as a correction. This prototype can review “This is an OP-1 Field”; a plain OP-1 name does not establish Field.' };
    }
    const ports = physicalOp1Outputs(devices);
    if (!ports.length) return { ok: false, reason: 'I heard OP-1 Field, but no connected physical OP-1 MIDI output is available on a paired Mac. Connect it, then ask to correct this object again.' };
    if (ports.length !== 1) return { ok: false, reason: 'More than one Mac or OP-1 output matches. Keep the intended MIDI companion connected, then review this correction again.' };
    if (this.pending.size >= 64) return { ok: false, reason: 'Too many pending identity reviews. Dismiss an older proposal, then try again.' };
    const proposal: IdentityCorrectionProposal = {
      proposalId: newId('identity-'), cardId: target.cardId, expiresAt: this.now() + IDENTITY_REVIEW_TTL_MS,
      summary: `Change “${target.card.name}” to OP-1 Field? The connected OP-1 port corroborates the family only. Confirm the Field model yourself. Old controls will be cleared; firmware and physical control remain unverified.`,
      reviewLines: ['Identity → OP-1 Field', 'USB confirms OP-1 family only', 'Firmware not checked', 'Clear old controls; setup stays off'],
      evidence: ports[0], firmware: 'unknown',
    };
    this.pending.set(proposal.proposalId, { proposal: structuredClone(proposal), sender, signature: signature(target) });
    return { ok: true, proposal };
  }

  confirm(target: Target, request: { proposalId: string; cardId: string; sender: string; accept: boolean; canApprove: boolean }, devices: DeviceInfo[]): IdentityConfirmationResult {
    const pending = this.pending.get(request.proposalId);
    if (!request.canApprove || !pending || pending.sender !== request.sender || pending.proposal.cardId !== request.cardId || target.cardId !== request.cardId) {
      return { status: 'rejected', reason: 'This identity review does not belong to the current selected object and approver.' };
    }
    this.pending.delete(request.proposalId); // One-use even if stale, declined, or a later persistence step fails.
    if (!request.accept) return { status: 'dismissed', reason: 'Identity correction dismissed. The object is unchanged.' };
    if (pending.proposal.expiresAt <= this.now() || !target.card || signature(target) !== pending.signature || busy(target)) {
      return { status: 'rejected', reason: 'This identity review is stale. Ask again for the current object after stopping its controls.' };
    }
    const ports = physicalOp1Outputs(devices);
    if (ports.length !== 1 || JSON.stringify(ports[0]) !== JSON.stringify(pending.proposal.evidence)) {
      return { status: 'rejected', reason: 'The connected OP-1 output changed. Reconnect the intended instrument and review the correction again.' };
    }
    const old = target.card, confirmedAt = this.now(), port = ports[0];
    const card = DeviceCardPayload.parse({
      cardId: old.cardId, name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field', category: 'synthesizer',
      // This confidence refers to the explicit owner-confirmed label, not a new model/vision result.
      confidence: 1, protocols: ['midi'], requires: ['midi'],
      evidence: ['Owner explicitly confirmed this selected object is an OP-1 Field.',
        `Connected MIDI output “${port.portName}” on ${port.deviceName}; this confirms an OP-1 family connection only.`.slice(0, 300)],
      followUp: ['Confirm the instrument firmware before using its incoming MIDI chart.', 'Run a new setup and effect verification before enabling physical controls.'],
      notes: 'Identity source: explicit owner correction, not a new visual identification. USB port name corroborates OP-1 family only. Firmware is unknown; the stored broad incoming-CC chart requires firmware >=1.7.0. Physical control is unverified.',
      snapshotId: old.snapshotId, frameId: old.frameId, detId: old.detId, bbox: old.bbox,
    });
    const audit = IdentityCorrectionAudit.parse({ source: 'user-confirmed', proposalId: request.proposalId, cardId: target.cardId, confirmedBy: request.sender, confirmedAt,
      previousIdentity: { name: old.name, maker: old.maker, model: old.model, category: old.category, protocols: [...old.protocols] },
      identity: { maker: 'Teenage Engineering', model: 'OP-1 Field' }, portEvidence: structuredClone(port), firmware: 'unknown', physicalControlVerified: false });
    return {
      status: 'confirmed',
      patch: {
        card, identityCorrection: audit, identityRevision: undefined, runId: newId('run-'), state: 'identified', since: confirmedAt,
        selection: { preferDeviceId: port.deviceId },
        link: undefined, research: undefined, driver: undefined, driverIssues: undefined, specId: undefined, controlCount: undefined,
        verification: {}, evidence: [], armed: false, armId: undefined, abort: undefined, stepIndex: {}, paramValues: {},
        lastError: undefined, detail: 'Identity corrected by the owner; controls remain off',
        sentence: 'Identity corrected: OP-1 Field', hint: 'Firmware is not checked. Confirm it before a new control setup.', action: 'retry',
      },
      audit,
    };
  }

  cancel(sender: string, cardId: string): void {
    for (const [id, entry] of this.pending) if (entry.sender === sender && entry.proposal.cardId === cardId) this.pending.delete(id);
  }
  invalidate(cardId?: string): void {
    for (const [id, entry] of this.pending) if (!cardId || entry.proposal.cardId === cardId) this.pending.delete(id);
  }
}
