import { isVisualSynthPort, visualSynthNeedsUpgrade } from '../devices/visualSynth';
import type { TaggedDevice } from '@ce/protocol';
import { roster as devices, type Roster } from './executors';
import { neededCapability, type LinkCapability } from './link';
import { isGimbalCard } from '../devices/osmo/driver';
import { MAC_LOCAL_ID } from './maclocal';
import { synthConnectionGuidance } from './guidance';
import type { Target } from './types';
import { isHelperDevice } from '../helpers';
import type { StoredTag } from './library-schema';
import { virtualScreenExecutor, visualSynthHosts, VIRTUAL_SCREEN_GUIDANCE } from './visual-synth';

export { TagStore } from './library-store';
export type { AssetRef, LibraryRecord, SetupVersion, StoredTag } from './library-schema';

export function isLaptopTarget(t: Target, label = ''): boolean {
  if (virtualScreenExecutor(t.card)) return false; // the visual synth card itself is the instrument, not the laptop
  // A screen showing the visual synth is the Mac too: Muse often names it by what is on screen.
  return t.card?.category === 'computer' || /\b(laptop|computer|macbook|imac|notebook|this mac|monitor|display screen|computer screen|visual[\s-]?synth)\b/i.test(`${t.card?.name ?? ''} ${t.card?.model ?? ''} ${t.detection?.label ?? ''} ${label}`);
}

export function tagCapability(t: Target): LinkCapability | undefined {
  const card = t.card;
  if (card && isGimbalCard(card)) return 'ble';
  if (card?.protocols.includes('hid') && !card.protocols.includes('midi') && !card.requires?.includes('midi')) return undefined;
  if (isLaptopTarget(t)) return 'local';
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
  if (/\b(synth(?:esizer)?|midi keyboard|musical keyboard)\b/i.test(label)) return 'midi';
  if (/\b(light|lamp|tv|television|ac|air conditioner)\b/i.test(label)) return 'ir';
  return neededCapability(card);
}

/** Recompute from current presence on every snapshot; an old link is never proof of a live bridge. */
export function evaluateConnection(t: Target, roster: Roster, label?: string): Pick<TaggedDevice, 'connection' | 'hint' | 'action'> {
  if (t.card?.protocols.includes('hid') && !tagCapability(t)) return { connection: 'offline',
    hint: 'This is a typing keyboard. This demo does not control HID keyboards; choose Try visual synth from Menu.' };
  // The Mac in this demo is controlled through its visual synth: select and setup reroute a tagged laptop there.
  if (isLaptopTarget(t, label) && !virtualScreenExecutor(t.card) && visualSynthHosts(roster.devices()).length) {
    // CE_DEMO: Muse named it the Mac, so the headset that just pinched it continues into the visual synth by itself.
    return process.env.CE_DEMO === '1'
      ? { connection: 'setup', hint: 'This is the Mac: opening its visual synth…', action: 'select-visual-synth' }
      : { connection: 'setup', hint: 'Pinch to play the Mac visual synth' };
  }
  if (isLaptopTarget(t, label) && !roster.devices().some((device) => device.online && isHelperDevice(device))) {
    const url = (roster.helperUrl?.() ?? 'http://localhost:8787/pair').replace(/^https?:\/\//, '');
    return { connection: 'offline', hint: `Open ${url} on this laptop`, action: 'open-companion' };
  }
  if (!t.card) return { connection: 'offline', hint: 'Identify this tagged device before setting up control' };
  const cap = tagCapability(t);
  const hint = cap === 'ir'
      ? 'Pair the Cardputer IR node or connect a Nature Remo bridge'
      : cap === 'ble'
        ? 'Switch the DJI gimbal on and close the Mimo app (the server needs CE_OSMO=ble)'
      : cap === 'local'
        ? 'Open the Mac app and enable control of this Mac'
        : 'Connect a companion that can reach this device';
  let offline: Pick<TaggedDevice, 'connection' | 'hint' | 'action'> = {
    connection: 'offline', hint, ...(cap === 'ir' ? { action: 'pair-device' } : cap === 'local' ? { action: 'open-companion' } : {}),
  };
  if (!cap) return { connection: 'offline', hint: t.card.protocols.includes('hid')
    ? 'This is a typing keyboard. This demo does not control HID keyboards; choose Try visual synth from Menu.'
    : 'This demo does not have a control connection for this device.' };
  const present = devices(roster);
  // Scan selection also carries the requesting headset; it is not the device being controlled.
  const selectedLocal = cap === 'local'
    ? /^device:(.+)$/.exec(t.card.notes ?? '')?.[1]
      ?? present.find((d) => d.deviceId === t.selection?.preferDeviceId && d.capabilities.includes('local') && (d.kind === 'mac' || d.kind === 'sim'))?.deviceId
    : undefined;
  const virtualExecutor = virtualScreenExecutor(t.card);
  const assigned = virtualExecutor ?? t.driver?.executor.deviceId ?? t.link?.executorDeviceId ?? selectedLocal;
  if (cap === 'local' && roster.silentLocal && (assigned === MAC_LOCAL_ID || !assigned && roster.macLocal)) {
    const url = (roster.helperUrl?.() ?? 'http://localhost:8787/pair').replace(/^https?:\/\//, '');
    return { connection: 'offline', hint: `Open ${url} on this Mac to play its visual synth`, action: 'open-companion' };
  }
  const portId = t.driver?.executor.port ?? t.link?.port?.id;
  if (cap === 'midi') {
    // A connected companion can have no MIDI capability yet (permission pending, or a standby tab).
    // The internal Mac executor never hosts browser MIDI ports.
    const companionOnline = present.some((d) => d.online && d.deviceId !== MAC_LOCAL_ID
      && (!assigned || d.deviceId === assigned) && (d.role === 'companion' || d.capabilities.includes('midi')));
    const guidance = synthConnectionGuidance(companionOnline);
    offline = { connection: 'offline', hint: guidance.hint, ...(guidance.action ? { action: guidance.action } : {}) };
    if (virtualExecutor) offline = roster.devices().some((d) => d.deviceId === virtualExecutor && d.online)
      ? { connection: 'offline', hint: 'Opening the Mac visuals…' }
      : { connection: 'offline', hint: 'Open the paired Mac companion and its visual synth.', action: 'open-companion' };
  }
  const wantsVisual = isVisualSynthPort(portId) || /visual[\s-]synth/i.test(`${t.card?.name ?? ''} ${t.detection?.label ?? ''}`);
  const online = present.filter((d) => d.online && d.capabilities.includes(cap));
  // A renderer or companion that blinked away (app switch, notification) keeps its card for a short grace.
  const inGrace = !!virtualExecutor && !!roster.visualGrace?.(virtualExecutor);
  const reachable = inGrace || online.some((d) => {
    if (assigned && d.deviceId !== assigned) return false;
    // The virtual visual synth port reaches only the visual synth; it never makes a physical synth look connected.
    if (cap === 'midi') return d.ports?.some((p) => p.kind === 'midi-out' && p.state !== 'disconnected' && (!portId || p.id === portId)
      && (isVisualSynthPort(p.id) || isVisualSynthPort(p.name)) === wantsVisual);
    if (cap === 'local' && !assigned) return d.deviceId === MAC_LOCAL_ID || d.kind === 'mac' || d.kind === 'sim';
    return true;
  });
  if (!reachable) return offline;
  if (visualSynthNeedsUpgrade(t.driver)) return { connection: 'setup', hint: 'Update visual controls to add forward/back Water ripples. Choose Set up control.' };
  const verified = t.driver?.actions.some((a) => t.verification[a.actionId] === 'pass');
  if (t.driver && t.armed && t.specId && verified && (cap !== 'midi' || t.driver.executor.port)) {
    return { connection: 'ready' };
  }
  return { connection: 'setup', hint: virtualExecutor ? VIRTUAL_SCREEN_GUIDANCE : 'Set up control for this device' };
}

export function tagSnapshot(tag: StoredTag, target: Target, roster: Roster): TaggedDevice {
  return {
    cardId: tag.cardId, label: tag.label, position: tag.position, placement: tag.placement,
    identityRevision: target.identityRevision ?? 0,
    name: target.card?.name, category: target.card?.category, specId: target.specId,
    ...evaluateConnection(target, roster, tag.label),
  };
}
