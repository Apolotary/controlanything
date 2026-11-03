/**
 * Small shared schemas used by several message payloads.
 *
 * Rules for every schema in this package (they double as Muse `response_format` json_schema):
 * no recursion, no `.meta({ id })` (keeps $ref out of the JSON Schema), nesting depth <= 10,
 * no transforms/dates/bigints (must survive `z.toJSONSchema`).
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

/** Opaque id (session, client, message, step, device, driver...). */
export const Id = z.string().min(1).max(128);

/** What kind of client is connected to a session. */
export const Role = z.enum(['hmd', 'companion', 'controller', 'device']);
export type Role = z.infer<typeof Role>;

/**
 * What a client can do for the agent. Extend this list when a new client type appears.
 * The server picks executors and sensors by capability, never by kind: midi/ir/local = executes
 * exec.command ops of that kind; camera/mic = answers sense.request; printer = LocalOp "print".
 */
export const Capability = z.enum([
  'midi',
  'serial',
  'ble',
  'ir',
  'camera',
  'mic',
  'hands',
  'display',
  'speaker',
  'gpio',
  'wifi',
  /** executes LocalOp (volume, music, say, torch, haptic, screen, beep) on itself */
  'local',
  'printer',
]);
export type Capability = z.infer<typeof Capability>;

/** A hardware port a client exposes (e.g. a Web MIDI output on the companion). */
export const PortKind = z.enum(['midi-in', 'midi-out', 'serial', 'ble', 'ir', 'usb']);
export type PortKind = z.infer<typeof PortKind>;

export const Port = z.object({
  id: z.string().min(1).max(256),
  kind: PortKind,
  name: z.string().max(256),
  manufacturer: z.string().max(256).optional(),
  state: z.enum(['connected', 'disconnected']).optional(),
});
export type Port = z.infer<typeof Port>;

/**
 * The kind of paired client device. Comes from the server's registry (set at pairing time),
 * never from what a connected client claims later.
 */
/**
 * `remo`: a Nature Remo IR blaster/learner on the LAN, bridged by the server itself (no app of its own).
 * `gimbal`: a Bluetooth LE phone gimbal (DJI Osmo Mobile), bridged by the server itself over BLE.
 */
export const DeviceKind = z.enum(['quest', 'mac', 'iphone', 'devterm', 'cardputer', 'web', 'sim', 'remo', 'gimbal']);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** One paired client device as seen in `presence`. */
export const DeviceInfo = z.object({
  deviceId: Id,
  name: z.string().max(120),
  kind: DeviceKind,
  /** how the device acts right now (from its latest `hello`, else the default for its kind) */
  role: Role,
  capabilities: z.array(Capability).max(32),
  ports: z.array(Port).max(128).optional(),
  /** client app name and version, e.g. "companion@0.1.0" */
  app: z.string().max(120).optional(),
  canApprove: z.boolean(),
  online: z.boolean(),
  /** open WebSocket connections for this device */
  connections: z.number().int().min(0),
  pairedAt: z.number(),
  lastSeen: z.number().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/** Whether model output came from a live Meta model call or a canned FIXTURE. */
export const ModelSource = z.enum(['live', 'fixture']);
export type ModelSource = z.infer<typeof ModelSource>;

// --- geometry -------------------------------------------------------------------------------

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

/** Unit quaternion (x, y, z, w), same convention as WebXR / three.js. */
export const Quat = z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() });
export type Quat = z.infer<typeof Quat>;

/** Position in metres + orientation, in the reference space named by the message (e.g. WebXR "local-floor"). */
export const Pose = z.object({ position: Vec3, orientation: Quat });
export type Pose = z.infer<typeof Pose>;

/** Axis-aligned box in normalised image coordinates: origin top-left, x/y/w/h in [0, 1]. */
export const BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type BBox = z.infer<typeof BBox>;

/** Pinhole intrinsics in pixels for the image the snapshot carries. */
export const CameraIntrinsics = z.object({
  fx: z.number(),
  fy: z.number(),
  cx: z.number(),
  cy: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type CameraIntrinsics = z.infer<typeof CameraIntrinsics>;

/** Pixel box of the image it refers to: [x, y, w, h], origin top-left. A 4-element array, not a tuple, for JSON Schema. */
export const PxBox = z.array(z.number()).min(4).max(4);
export type PxBox = z.infer<typeof PxBox>;

/** Simplified outline in pixels: [[x, y], ...], <= 64 points, closed implicitly. */
export const Polygon = z.array(z.array(z.number()).min(2).max(2)).min(3).max(64);
export type Polygon = z.infer<typeof Polygon>;

/**
 * Where a target (an identified physical device) is in the discovery loop:
 * SCAN -> IDENTIFY -> LINK -> RESEARCH -> DRIVE -> VERIFY -> FORGE -> ARM -> CONTROL.
 */
export const TargetState = z.enum([
  'scanned',
  'identifying',
  'identified',
  'linking',
  'needs-companion',
  'linked',
  'researching',
  'driving',
  'verifying',
  'verified',
  'forging',
  'forged',
  'arming',
  'armed',
  'controlling',
  'failed',
]);
export type TargetState = z.infer<typeof TargetState>;

/** An on-device detection attached to a legacy `snapshot` (scan.result carries the SAM detections). */
export const Detection = z.object({
  label: z.string().max(120),
  score: z.number().min(0).max(1),
  bbox: BBox,
  trackId: z.string().max(64).optional(),
  classId: z.number().int().optional(),
});
export type Detection = z.infer<typeof Detection>;

// --- controls -------------------------------------------------------------------------------

export const XY = z.object({ x: z.number(), y: z.number() });
export type XY = z.infer<typeof XY>;

/** A widget value: number (knob, fader, pad velocity), boolean (button, toggle) or {x, y} (xy pad). */
export const ControlValue = z.union([z.number(), z.boolean(), XY]);
export type ControlValue = z.infer<typeof ControlValue>;
