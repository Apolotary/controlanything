/**
 * LINK: find the paired client that can reach the device and cross-check that the cable goes to the thing
 * the camera saw: USB port name against the chart's hint, then the MIDI identity request (F0 7E 7F 06 01 F7)
 * against the maker Spark read. Verdicts: confirmed / consistent / mismatch ("wrong device, refused") / unknown.
 */
import type { Capability, DeviceCardPayload, LinkResultPayload } from '@ce/protocol';
import { VISUAL_SYNTH_ID } from '../devices/visualSynth';
import { makerMatches, parseIdentityReply, portMatches } from '../devices/midi';
import type { MidiProfile } from '../devices/profiles';
import type { Dispatcher } from './dispatch';
import { type ExecutorPick, pickExecutor, type Roster } from './executors';
import { virtualScreenExecutor, visualSynthCompanions } from './visual-synth';

export type LinkCapability = 'midi' | 'ir' | 'local';

/** The one capability a card needs to be driven. */
export function neededCapability(card: Pick<DeviceCardPayload, 'requires' | 'protocols' | 'category'>): LinkCapability | undefined {
  const req = card.requires ?? [];
  for (const c of ['midi', 'ir', 'local'] as const) if (req.includes(c as Capability)) return c;
  if (card.protocols.includes('midi')) return 'midi';
  if (card.protocols.includes('ir')) return 'ir';
  if (card.category === 'computer' || card.category === 'phone') return 'local';
  return undefined;
}

export interface LinkOutcome {
  result: LinkResultPayload;
  executor?: ExecutorPick;
}

/**
 * Try to link now. Returns verdict 'none' with no executor when nothing online can do it (the caller sends
 * link.request and waits). For MIDI the identity probe runs through the dispatcher.
 */
export async function tryLink(
  deps: { roster: Roster; dispatcher: Dispatcher },
  card: DeviceCardPayload,
  cap: LinkCapability,
  opts: { linkId: string; profile?: MidiProfile; preferDeviceId?: string; signal?: AbortSignal; probeIdentity?: boolean } ,
): Promise<LinkOutcome> {
  const portHint = opts.profile?.usb?.portNameHint;
  const virtualExecutor = virtualScreenExecutor(card);
  const virtualDevice = virtualExecutor ? visualSynthCompanions(deps.roster.devices()).find((device) => device.deviceId === virtualExecutor) : undefined;
  if (virtualExecutor && !virtualDevice) return { result: { linkId: opts.linkId, cardId: card.cardId, verdict: 'none', evidence: [], reason: 'The selected Mac visual synth is not connected. Reopen its companion and visuals.' } };
  const simulated = opts.profile?.id === VISUAL_SYNTH_ID && card.source === 'fixture'
    ? deps.roster.devices().filter((device) => device.online && device.kind === 'sim' && device.ports?.some((port) => port.kind === 'midi-out' && portHint && portMatches(port, portHint))) : [];
  const explicitlyLinked = deps.roster.devices().some((device) => device.deviceId === opts.preferDeviceId && device.online && device.ports?.some((port) => portHint && portMatches(port, portHint)));
  const preferDeviceId = !explicitlyLinked && simulated.length === 1 ? simulated[0].deviceId : opts.preferDeviceId;
  const pick = virtualDevice
    ? { deviceId: virtualDevice.deviceId, name: virtualDevice.name, kind: virtualDevice.kind,
      port: virtualDevice.ports!.find((port) => port.id === 'ce-visual-synth' && port.kind === 'midi-out') }
    : pickExecutor(deps.roster, cap, { portHint, preferDeviceId });
  const base: LinkResultPayload = { linkId: opts.linkId, cardId: card.cardId, verdict: 'none', evidence: [] };
  if (!pick) return { result: { ...base, reason: `no online client with "${cap}"` } };
  if (cap === 'midi' && !pick.port) return { result: { ...base, reason: 'connect the instrument and select a unique MIDI output in the Mac app' } };
  const result: LinkResultPayload = { ...base, executorDeviceId: pick.deviceId, channel: pick.kind === 'sim' ? 'sim' : cap };
  if (pick.port) result.port = pick.port;

  if (cap === 'midi') {
    let modelConfirmed = false;
    let identityMismatch = false;
    if (portHint && pick.port) {
      const ok = portMatches(pick.port, portHint);
      result.evidence.push({ kind: 'port-name', ok, detail: ok ? `USB says "${pick.port.name}" (chart expects "${portHint}")` : `port "${pick.port.name}" does not mention "${portHint}"` });
    } else if (pick.port) result.evidence.push({ kind: 'port-name', ok: true, detail: `MIDI output "${pick.port.name}" (no chart hint to compare)` });
    else result.evidence.push({ kind: 'port-name', ok: false, detail: `${pick.name} has no MIDI output port` });

    if (opts.probeIdentity !== false) {
      try {
        const ack = await deps.dispatcher.exec(pick.deviceId, { kind: 'midi', msg: 'sysex-identity', channel: 1 }, { port: pick.port?.id, cardId: card.cardId, timeoutMs: 2500, signal: opts.signal, waitForSlot: true });
        const reply = ack.reply ? parseIdentityReply(ack.reply) : null;
        if (reply) {
          // a generic id (7D non-commercial, or one not in the table) names no maker: it can neither confirm nor refute
          const generic = /^unknown|non-commercial/i.test(reply.manufacturer);
          const cameraKnows = card.maker.trim() !== '' && card.maker.toLowerCase() !== 'unknown';
          const example = opts.profile?.identity?.replyExample;
          const expected = example && /^(?:[\da-f]{2}\s+)+[\da-f]{2}$/i.test(example.trim())
            ? parseIdentityReply(example.trim().split(/\s+/).map((b) => parseInt(b, 16))) : null;
          const modelMatches = !expected || (expected.family === reply.family && expected.model === reply.model
            && expected.manufacturerId.length === reply.manufacturerId.length && expected.manufacturerId.every((id, i) => id === reply.manufacturerId[i]));
          identityMismatch = !modelMatches || (!generic && cameraKnows && !makerMatches(reply.manufacturer, card.maker));
          modelConfirmed = Boolean(expected && !generic && !identityMismatch);
          if (generic) result.evidence.push({ kind: 'midi-identity', ok: true, detail: `identity reply: ${reply.manufacturer} id, family ${reply.family}, model ${reply.model} (names no maker; port name decides)` });
          else {
            const ok = !identityMismatch;
            result.evidence.push({ kind: 'midi-identity', ok, detail: `identity reply: ${reply.manufacturer}, family ${reply.family}, model ${reply.model}${ok ? '' : ` (camera said ${card.maker} ${card.model}; model must match the chart)`}` });
          }
        } else result.evidence.push({ kind: 'midi-identity', ok: false, detail: ack.reply?.length ? 'reply was not an identity message' : 'no identity reply (many devices stay silent; port name used instead)' });
      } catch (e) {
        result.evidence.push({ kind: 'midi-identity', ok: false, detail: `identity probe: ${(e as Error).message.slice(0, 120)}` });
      }
    }
    const identity = result.evidence.find((e) => e.kind === 'midi-identity');
    const port = result.evidence.find((e) => e.kind === 'port-name');
    if (identityMismatch || (portHint && !port?.ok)) result.verdict = 'mismatch';
    else if (identity?.ok && modelConfirmed) result.verdict = 'confirmed';
    else if (port?.ok && portHint) result.verdict = 'consistent';
    else result.verdict = 'unknown';
    if (result.verdict === 'mismatch') result.reason = 'the connected instrument is not the one the camera identified';
    return { result, executor: pick };
  }

  if (cap === 'ir') {
    result.evidence.push({ kind: pick.kind === 'sim' ? 'sim' : 'user', ok: true, detail: `${pick.name} will fire infrared; the camera decides which codes the light answers` });
    result.verdict = 'unknown';
    return { result, executor: pick };
  }

  result.evidence.push({ kind: pick.internal ? 'user' : 'user', ok: true, detail: `${pick.name} runs local actions on itself` });
  result.verdict = 'consistent';
  return { result, executor: pick };
}
