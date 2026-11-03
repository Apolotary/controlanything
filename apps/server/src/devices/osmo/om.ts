/**
 * DJI Osmo Mobile (OM 2 / 3 / 4) gimbal commands over DUML, with the safety envelope ControlAnything enforces.
 *
 * Protocol facts (public, alkersan/om-research, tested there on OM2/OM3/OM4; o-gs/dji-firmware-tools):
 *   BLE service FFF0, notify FFF4 (gimbal -> host), write FFF5 (host -> gimbal). No pairing or auth handshake.
 *   Rotation: cmd set 0x04, id 0x14 (relative / absolute) or 0x0C (speed); sender 0x02 (app), receiver 0x04,
 *   cmd type 0x00. Payload: yaw, roll, pitch as int16 LE in 0.1 deg, then the mode byte (0x04 relative,
 *   0x05 absolute, 0x80 speed) and a duration byte in 0.1 s.
 *   Battery push: cmd set 0x05, id 0x06, payload[0] = percent, last byte 1 = charging.
 *   Attitude push: cmd set 0x04, id 0x05 (pitch, roll, yaw int16 in 0.1 deg) per the DUML gimbal dissector;
 *   [inferred] for the OM series until the hardware test logs it.
 */
import { buildDuml, type DumlPacket } from './duml';

export const OSMO_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const OSMO_NOTIFY_UUID = '0000fff4-0000-1000-8000-00805f9b34fb';
export const OSMO_WRITE_UUID = '0000fff5-0000-1000-8000-00805f9b34fb';

export const DEV_APP = 0x02;
export const DEV_GIMBAL = 0x04;
export const SET_GIMBAL = 0x04;
export const SET_CENTER = 0x05;
export const CMD_ROTATE = 0x14;
export const CMD_SPEED = 0x0c;
export const CMD_ATTITUDE_PUSH = 0x05;
export const CMD_BATTERY_PUSH = 0x06;

export const RotateMode = { relative: 0x04, absolute: 0x05, speed: 0x80 } as const;
export type RotateMode = keyof typeof RotateMode;

/** Angles in degrees. yaw = pan (left/right), pitch = tilt (up/down), roll = horizon. */
export interface Attitude {
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * What ControlAnything ever asks of the gimbal (well inside the OM 4's mechanical range). Every command is
 * clamped here, in one place, whatever wrote the driver.
 */
export const OSMO_LIMITS = {
  yaw: { min: -120, max: 120 },
  pitch: { min: -45, max: 45 },
  roll: { min: -30, max: 30 },
  /** fastest slew ControlAnything commands, degrees per second */
  maxDegPerSec: 90,
  /** a move never takes less than this (the duration byte is 0.1 s) */
  minDurationMs: 200,
  maxDurationMs: 5000,
  /** commands per second the bridge sends at most (hand control coalesces to the latest target) */
  maxRateHz: 10,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function clampAttitude(a: Partial<Attitude>, base: Attitude = { yaw: 0, pitch: 0, roll: 0 }): Attitude {
  return {
    yaw: clamp(finite(a.yaw, base.yaw), OSMO_LIMITS.yaw.min, OSMO_LIMITS.yaw.max),
    pitch: clamp(finite(a.pitch, base.pitch), OSMO_LIMITS.pitch.min, OSMO_LIMITS.pitch.max),
    roll: clamp(finite(a.roll, base.roll), OSMO_LIMITS.roll.min, OSMO_LIMITS.roll.max),
  };
}

/** Duration for a move from `from` to `to` that respects the speed cap (and the caller's wish, if slower). */
export function moveDurationMs(from: Attitude, to: Attitude, wishMs?: number): number {
  const span = Math.max(Math.abs(to.yaw - from.yaw), Math.abs(to.pitch - from.pitch), Math.abs(to.roll - from.roll));
  const needed = (span / OSMO_LIMITS.maxDegPerSec) * 1000;
  return Math.round(clamp(Math.max(needed, finite(wishMs, 0)), OSMO_LIMITS.minDurationMs, OSMO_LIMITS.maxDurationMs));
}

const tenth = (deg: number) => clamp(Math.round(deg * 10), -32768, 32767);

/** The raw 8-byte rotation payload. */
export function rotatePayload(a: Attitude, mode: RotateMode, durationMs: number): Uint8Array {
  const p = new Uint8Array(8);
  const dv = new DataView(p.buffer);
  dv.setInt16(0, tenth(a.yaw), true);
  dv.setInt16(2, tenth(a.roll), true);
  dv.setInt16(4, tenth(a.pitch), true);
  p[6] = RotateMode[mode];
  p[7] = clamp(Math.round(durationMs / 100), 0, 255);
  return p;
}

export function rotatePacket(a: Attitude, mode: RotateMode, durationMs: number, seq: number): Uint8Array {
  return buildDuml({ sender: DEV_APP, receiver: DEV_GIMBAL, seq, cmdType: 0x00, cmdSet: SET_GIMBAL, cmdId: mode === 'speed' ? CMD_SPEED : CMD_ROTATE, payload: rotatePayload(a, mode, durationMs) });
}

export interface RotateCommand {
  mode: RotateMode;
  attitude: Attitude;
  durationMs: number;
}

/** Decode a rotation command (the mock gimbal's input, and logs). */
export function decodeRotate(p: DumlPacket): RotateCommand | undefined {
  if (p.cmdSet !== SET_GIMBAL || (p.cmdId !== CMD_ROTATE && p.cmdId !== CMD_SPEED) || p.payload.length < 8) return undefined;
  const dv = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
  const modeByte = p.payload[6];
  const mode = (Object.keys(RotateMode) as RotateMode[]).find((k) => RotateMode[k] === modeByte);
  if (!mode) return undefined;
  return { mode, attitude: { yaw: dv.getInt16(0, true) / 10, roll: dv.getInt16(2, true) / 10, pitch: dv.getInt16(4, true) / 10 }, durationMs: p.payload[7] * 100 };
}

export function attitudePushPacket(a: Attitude, seq: number): Uint8Array {
  const p = new Uint8Array(6);
  const dv = new DataView(p.buffer);
  dv.setInt16(0, tenth(a.pitch), true);
  dv.setInt16(2, tenth(a.roll), true);
  dv.setInt16(4, tenth(a.yaw), true);
  return buildDuml({ sender: DEV_GIMBAL, receiver: DEV_APP, seq, cmdType: 0x00, cmdSet: SET_GIMBAL, cmdId: CMD_ATTITUDE_PUSH, payload: p });
}

export function batteryPushPacket(percent: number, charging: boolean, seq: number): Uint8Array {
  return buildDuml({ sender: DEV_GIMBAL, receiver: DEV_APP, seq, cmdType: 0x00, cmdSet: SET_CENTER, cmdId: CMD_BATTERY_PUSH, payload: Uint8Array.from([clamp(Math.round(percent), 0, 100), 0, charging ? 1 : 0]) });
}

export type OsmoReport = { kind: 'attitude'; attitude: Attitude } | { kind: 'battery'; percent: number; charging: boolean };

/** What a notification says, when we understand it. */
export function decodeReport(p: DumlPacket): OsmoReport | undefined {
  if (p.cmdSet === SET_CENTER && p.cmdId === CMD_BATTERY_PUSH && p.payload.length >= 1) {
    return { kind: 'battery', percent: p.payload[0], charging: p.payload[p.payload.length - 1] === 1 };
  }
  if (p.cmdSet === SET_GIMBAL && p.cmdId === CMD_ATTITUDE_PUSH && p.payload.length >= 6) {
    const dv = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
    const a = { pitch: dv.getInt16(0, true) / 10, roll: dv.getInt16(2, true) / 10, yaw: dv.getInt16(4, true) / 10 };
    // a value outside the mechanical range means this push is something else on this model
    if (Math.abs(a.pitch) <= 180 && Math.abs(a.roll) <= 180 && Math.abs(a.yaw) <= 360) return { kind: 'attitude', attitude: a };
  }
  return undefined;
}
