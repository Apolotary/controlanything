/** Explicit owner review for a connected instrument. A host card is never relabelled. */
import { createHash } from 'node:crypto';
import { newId, type DeviceCardPayload, type DeviceInfo } from '@ce/protocol';
import { isVisualSynthPort } from '../devices/visualSynth';
import { isMusicalSynthPort } from '../devices/musicalSynth';
import type { Target } from './types';
import { physicalOp1Outputs, type IdentityPortEvidence } from './identity-correction';

export const GENERAL_ASSISTANT_CARD = 'muse-general';
const normalize = (text: string) => text.normalize('NFKC').replace(/[‐‑‒–—]/g, '-').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const op1 = /\bop[ -]?(?:1|one)(?:\s*field)?\b/i;
export function isConnectedPeripheralRequest(text: string, host?: { name: string; identity?: { category?: string } }): boolean {
  const value = normalize(text);
  if (!op1.test(value)) return false;
  if (host && host.identity?.category === 'synthesizer' && op1.test(host.name)) return false;
  // A positive user-requested target, not a statement that this object is not that model.
  if (/\b(?:not|isn't)\s+(?:an?\s+)?op[ -]?(?:1|one)\b/i.test(value)) return false;
  const explicitHost = /\b(?:connected|plugged|attached)\b.{0,80}\b(?:mac|macbook|laptop|computer|paired|usb)\b/i.test(value);
  return explicitHost || (!host || host.identity?.category === 'computer' || /\b(?:macbook|laptop|computer)\b/i.test(host.name))
    && /\b(?:connect|control|gesture|play|synthesizer|instrument)\b/i.test(value);
}

/** A narrow wrong-target guard for the selected-device wiring path, not an automatic selection planner. */
export function isDifferentConnectedOp1ControlRequest(text: string, selected: { name: string; category?: string; port?: string }): boolean {
  const software = isVisualSynthPort(selected.port) || isMusicalSynthPort(selected.port);
  if (!software && selected.category !== 'computer') return false;
  if (!isConnectedPeripheralRequest(text, { name: selected.name, identity: { category: selected.category } })) return false;
  const value = normalize(text);
  // A named physical connection distinguishes this from an instrument-inspired browser scene.
  if (!/\b(?:connected|plugged|attached)\b.{0,80}\b(?:mac|macbook|laptop|computer|paired|usb)\b/i.test(value)) return false;
  const instrument = 'op[ -]?(?:1|one)(?:\\s*field)?';
  if (new RegExp(`\\b${instrument}[- ]+(?:style|inspired|like)\\b|\\b(?:inspired by|style of|look like|sound like|emulate)\\s+(?:my |the |an? )?${instrument}\\b`, 'i').test(value)) return false;
  const direct = new RegExp(`\\b(?:control|play|wire|connect)\\s+(?:(?:my|the|this|that|connected|physical|an?)\\s+){0,3}${instrument}\\b`, 'i').test(value);
  if (direct) return true;
  const named = op1.exec(value);
  const after = named ? value.slice(named.index + named[0].length) : '';
  if (/\bfor\s+(?:(?:my|the|this)\s+)?(?:visual(?:\s+synth)?|musical\s+synth|screen|water|ripples?)\b/i.test(after)) return false;
  return /\b(?:create|build|make|write|program|set up)\b.{0,45}\b(?:gesture|hand)\s*(?:controls?|controller|mapping|wiring)\b/i.test(after)
    || /\b(?:control|play|wire)\s+it\b|\bmake\s+it\s+react\b.{0,45}\b(?:hands?|gestures?)\b/i.test(after);
}

/** A positive host identity plus its peripheral is not a request to relabel that host. */
export function isHostPeripheralReference(text: string, host: { name: string; identity?: { category?: string } }): boolean {
  if (!isConnectedPeripheralRequest(text, host)) return false;
  const value = normalize(text);
  // Keep direct corrections such as "This is an OP-1 Field, not a laptop" in the identity flow.
  // This branch covers "This is my MacBook with an OP-1 Field connected to it" instead.
  return /\b(?:(?:this|that|it|the (?:device|object))\s+is|it's)\s+(?:actually\s+)?(?:(?:my|our|the|an?|this|that)\s+)?(?:apple\s+)?(?:macbook|mac|laptop|computer)\b/i.test(value);
}

const busy = (t?: Target) => Boolean(t && (t.armed || t.armId || t.abort && !t.abort.signal.aborted));
const signature = (t?: Target) => t ? JSON.stringify([t.cardId, t.card, t.runId, t.armed, t.armId, t.selection]) : 'general';
export interface PeripheralProposal { proposalId: string; text: string; summary: string[] }
interface Pending {
  sender: string; hostCardId: string; hostSignature: string; expiresAt: number;
  port: IdentityPortEvidence; cardId: string;
}
export class ConnectedPeripherals {
  private pending = new Map<string, Pending>();
  constructor(private readonly now: () => number = Date.now) {}
  propose(host: Target | undefined, hostCardId: string, text: string, sender: string, devices: DeviceInfo[]): { ok: true; proposal: PeripheralProposal } | { ok: false; text: string } {
    this.cancel(sender, hostCardId);
    if (!sender || hostCardId !== GENERAL_ASSISTANT_CARD && !host?.card) return { ok: false, text: 'Choose a tagged host or Ask Muse from the main menu first.' };
    if (busy(host)) return { ok: false, text: 'Stop the current device controls before choosing the connected instrument.' };
    if (!/\bop[ -]?(?:1|one)\s*field\b/i.test(normalize(text))) return { ok: false, text: 'Do you mean the original OP-1 or OP-1 Field? Tell me the model so its controls use the correct MIDI chart.' };
    const preferred = host?.link?.executorDeviceId ?? host?.driver?.executor.deviceId ?? host?.selection?.preferDeviceId;
    const all = physicalOp1Outputs(devices);
    const ports = preferred && devices.some((d) => d.deviceId === preferred && d.kind === 'mac') ? all.filter((p) => p.deviceId === preferred) : all;
    if (!ports.length) return { ok: false, text: 'You asked about the connected OP-1 Field. No physical OP-1 MIDI output is currently available on that paired Mac. Connect USB and enable MIDI in the companion, then ask again. Mac audio playback settings do not control this connection.' };
    if (ports.length !== 1) return { ok: false, text: 'More than one OP-1 MIDI output matches. Keep the intended instrument and companion connected, then ask again so I can choose the right one.' };
    for (const [id, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 64) return { ok: false, text: 'Dismiss an earlier instrument review and try again.' };
    const port = ports[0];
    const cardId = `connected-op1-field-${createHash('sha256').update(JSON.stringify([port.deviceId, port.portId])).digest('hex').slice(0, 20)}`;
    const proposalId = newId('peripheral-');
    this.pending.set(proposalId, { sender, hostCardId, hostSignature: signature(host), expiresAt: this.now() + 120_000, port, cardId });
    return { ok: true, proposal: { proposalId,
      text: 'Use the OP-1 Field connected to the Mac? The MIDI port confirms the OP-1 family; you confirm the Field model. This creates a separate instrument target and leaves the laptop unchanged. Controls stay off until its MIDI chart and effects are verified.',
      summary: ['Target → OP-1 Field', `Connected through ${port.deviceName}`.slice(0, 240), 'Confirm Field model; firmware unknown', 'Laptop identity unchanged', 'No music or controls start on confirmation'] } };
  }
  confirm(host: Target | undefined, p: { sender: string; cardId: string; proposalId: string; accept: boolean }, devices: DeviceInfo[]):
    { ok: false; text: string } | { ok: true; dismissed: true; text: string } | { ok: true; dismissed: false; card: DeviceCardPayload; port: IdentityPortEvidence } {
    const entry = this.pending.get(p.proposalId);
    if (!entry || entry.sender !== p.sender || entry.hostCardId !== p.cardId) return { ok: false, text: 'This instrument review does not belong to the current request.' };
    this.pending.delete(p.proposalId);
    if (!p.accept) return { ok: true, dismissed: true, text: 'Instrument selection dismissed. The laptop and its controls are unchanged.' };
    if (entry.expiresAt <= this.now() || entry.hostSignature !== signature(host) || busy(host)) return { ok: false, text: 'The host changed during review. Stop its controls and ask again.' };
    const matches = physicalOp1Outputs(devices).filter((x) => x.deviceId === entry.port.deviceId && x.portId === entry.port.portId);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(entry.port)) return { ok: false, text: 'The OP-1 connection changed. Reconnect it and review the instrument again.' };
    return { ok: true, dismissed: false, port: entry.port, card: {
      cardId: entry.cardId, name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field', category: 'synthesizer',
      protocols: ['midi'], requires: ['midi'], confidence: 1,
      evidence: ['Owner confirmed the connected instrument is an OP-1 Field.', `Connected MIDI output ${entry.port.portName} on ${entry.port.deviceName}; OP-1 family only.`.slice(0, 300)],
      followUp: ['Confirm firmware and review the incoming MIDI chart on Mac Details.', 'Set up and verify the physical effect before enabling controls.'],
      notes: 'Logical connected instrument selected by owner review. Not a visual detection. Firmware unknown; physical response unverified. Laptop identity unchanged.',
    } };
  }
  cancel(sender: string, hostCardId: string): void { for (const [id, p] of this.pending) if (p.sender === sender && p.hostCardId === hostCardId) this.pending.delete(id); }
}
