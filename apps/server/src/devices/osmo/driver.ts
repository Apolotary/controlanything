/**
 * What the agent knows about a DJI Osmo Mobile: the research brief for DRIVE, the curated driver template (the
 * FIXTURE answer and the honest last resort), and the card test that routes a gimbal to the `ble` transport.
 */
import type { DeviceCardPayload, DriverDraft, Provenance } from '@ce/protocol';
import { OSMO_LIMITS } from './om';

export const OSMO_PROFILE_ID = 'dji-osmo-mobile';

/** A phone gimbal the Osmo bridge can drive (by what the camera / Muse Spark read). */
export function isGimbalCard(card: Pick<DeviceCardPayload, 'name' | 'maker' | 'model'> & { notes?: string }): boolean {
  return /\b(gimbal|osmo|om ?[2-7]|stabili[sz]er)\b/i.test(`${card.name} ${card.maker} ${card.model}`);
}

export const OSMO_PROVENANCE: Provenance[] = [
  { source: 'curated', ref: 'apps/server/src/devices/osmo/om.ts', note: 'DUML over BLE: service FFF0, notify FFF4, write FFF5; rotation cmd 0x04/0x14' },
  { source: 'manual', ref: 'https://github.com/alkersan/om-research', note: 'Osmo Mobile BLE protocol research (MIT), tested on OM2/OM3/OM4' },
];

export function osmoBrief(): string {
  const L = OSMO_LIMITS;
  return [
    'DJI Osmo Mobile phone gimbal (OM 4), reached over Bluetooth LE by the server\'s Osmo bridge (transport "ble", profile "dji-osmo").',
    'Ops (encode {"kind":"ble","profile":"dji-osmo","op":..., "arg":...}; angles in degrees):',
    `  pan: absolute yaw, arg a number or "$value" (left/right), safe range ${L.yaw.min}..${L.yaw.max}`,
    `  tilt: absolute pitch, arg a number or "$value" (down/up), safe range ${L.pitch.min}..${L.pitch.max}`,
    '  nudge: arg {"yaw":deg,"pitch":deg} relative to the current aim · recenter: back to 0/0 · stop: hold where it is',
    `The bridge clamps every target and caps the slew at ${L.maxDegPerSec} deg/s and ${L.maxRateHz} commands/s.`,
    'Verification: expect {"sense":"ack","effect":"any"}; the bridge acknowledges with the gimbal\'s own angle report when it sends one.',
    'Make "pan" and "tilt" set actions (step 1) so a two-axis pad or the hand can aim the phone, plus a Recenter trigger and small Look left / Look right nudges.',
  ].join('\n');
}

/** The curated driver: pan + tilt (continuous), recenter, look left / right. */
export function osmoDraft(cardId: string, provenance: Provenance[] = OSMO_PROVENANCE): DriverDraft {
  const L = OSMO_LIMITS;
  const ack = { sense: 'ack' as const, effect: 'any' as const };
  return {
    cardId,
    name: 'DJI Osmo Mobile',
    transport: 'ble',
    provenance,
    maxRateHz: L.maxRateHz,
    notes: 'Template from this repo (DUML over BLE through the Osmo bridge). Angles in degrees, clamped by the bridge.',
    actions: [
      { actionId: 'pan', label: 'Pan', kind: 'set', range: { min: -90, max: 90, step: 1 }, curve: 'linear', encode: { kind: 'ble', profile: 'dji-osmo', op: 'pan', arg: '$value' }, expect: ack, description: 'Turn the phone left/right (degrees from center)' },
      { actionId: 'tilt', label: 'Tilt', kind: 'set', range: { min: -30, max: 30, step: 1 }, curve: 'linear', encode: { kind: 'ble', profile: 'dji-osmo', op: 'tilt', arg: '$value' }, expect: ack, description: 'Tip the phone down/up (degrees from level)' },
      { actionId: 'look_left', label: 'Look left', kind: 'trigger', encode: { kind: 'ble', profile: 'dji-osmo', op: 'nudge', arg: { yaw: -30 } }, expect: ack, inverseActionId: 'look_right' },
      { actionId: 'look_right', label: 'Look right', kind: 'trigger', encode: { kind: 'ble', profile: 'dji-osmo', op: 'nudge', arg: { yaw: 30 } }, expect: ack, inverseActionId: 'look_left' },
      { actionId: 'recenter', label: 'Recenter', kind: 'trigger', encode: { kind: 'ble', profile: 'dji-osmo', op: 'recenter' }, expect: ack },
    ],
  };
}

export function templateBleDraft(card: Pick<DeviceCardPayload, 'cardId'>, provenance?: Provenance[]): DriverDraft {
  return { ...osmoDraft(card.cardId, provenance), notes: 'FIXTURE/template driver for the DJI Osmo bridge; no Meta model wrote it' };
}
