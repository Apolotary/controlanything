/**
 * LINK: find the paired client that can reach the device and cross-check that the cable goes to the thing
 * the camera saw: USB port name against the chart's hint, then the MIDI identity request (F0 7E 7F 06 01 F7)
 * against the maker Spark read. Verdicts: confirmed / consistent / mismatch ("wrong device, refused") / unknown.
 */
import type { Capability, DeviceCardPayload, LinkResultPayload } from '@ce/protocol';
import { makerMatches, parseIdentityReply } from '../devices/midi';
import type { MidiProfile } from '../devices/profiles';
import type { Dispatcher } from './dispatch';
import { type ExecutorPick, pickExecutor, type Roster } from './executors';

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
  const pick = pickExecutor(deps.roster, cap, { portHint, preferDeviceId: opts.preferDeviceId });
  const base: LinkResultPayload = { linkId: opts.linkId, cardId: card.cardId, verdict: 'none', evidence: [] };
  if (!pick) return { result: { ...base, reason: `no online client with "${cap}"` } };
  const result: LinkResultPayload = { ...base, executorDeviceId: pick.deviceId, channel: pick.kind === 'sim' ? 'sim' : cap };
  if (pick.port) result.port = pick.port;

  if (cap === 'midi') {
    if (portHint && pick.port) {
      const ok = pick.port.name.toLowerCase().includes(portHint.toLowerCase());
      result.evidence.push({ kind: 'port-name', ok, detail: ok ? `USB says "${pick.port.name}" (chart expects "${portHint}")` : `port "${pick.port.name}" does not mention "${portHint}"` });
    } else if (pick.port) result.evidence.push({ kind: 'port-name', ok: true, detail: `MIDI output "${pick.port.name}" (no chart hint to compare)` });
    else result.evidence.push({ kind: 'port-name', ok: false, detail: `${pick.name} has no MIDI output port` });

    if (opts.probeIdentity !== false) {
      try {
        const ack = await deps.dispatcher.exec(pick.deviceId, { kind: 'midi', msg: 'sysex-identity', channel: 1 }, { port: pick.port?.id, cardId: card.cardId, timeoutMs: 2500, signal: opts.signal, waitForSlot: true });
        const reply = ack.reply ? parseIdentityReply(ack.reply) : null;
        if (reply) {
          const ok = card.maker.toLowerCase() === 'unknown' ? true : makerMatches(reply.manufacturer, card.maker);
          result.evidence.push({ kind: 'midi-identity', ok, detail: `identity reply: ${reply.manufacturer}, family ${reply.family}, model ${reply.model}${ok ? '' : ` (camera said ${card.maker})`}` });
        } else result.evidence.push({ kind: 'midi-identity', ok: false, detail: ack.reply?.length ? 'reply was not an identity message' : 'no identity reply (many devices stay silent; port name used instead)' });
      } catch (e) {
        result.evidence.push({ kind: 'midi-identity', ok: false, detail: `identity probe: ${(e as Error).message.slice(0, 120)}` });
      }
    }
    const identity = result.evidence.find((e) => e.kind === 'midi-identity');
    const port = result.evidence.find((e) => e.kind === 'port-name');
    if (identity?.ok && /identity reply/.test(identity.detail)) result.verdict = 'confirmed';
    else if (identity && !identity.ok && /camera said/.test(identity.detail)) result.verdict = 'mismatch';
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
