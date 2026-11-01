/**
 * The versioned envelope and the union of every WebSocket message.
 *
 *   { v: 1, type: "control.event", id: "m-…", ts: 1730500000000, from: "<deviceId>|server", to?: "<deviceId>", payload: {…} }
 *
 * - `from` is overwritten by the hub with the sender's deviceId (or "server"), so clients may send "".
 * - `to` targets one device; without it a relayed message goes to every other connection in the space.
 * - Types starting with "x." are experimental: the hub checks only the envelope and relays them.
 */
import { z } from 'zod';
import {
  AgentStepPayload,
  ControlEventPayload,
  DeviceCardPayload,
  DriverDeployPayload,
  DriverStatusPayload,
  HelloPayload,
  LogPayload,
  PairApprovedPayload,
  PairApprovePayload,
  PairDeniedPayload,
  PairDenyPayload,
  PairPendingPayload,
  PairStartPayload,
  PairStatusPayload,
  PresencePayload,
  SnapshotPayload,
  UiSpecPayload,
  WelcomePayload,
} from './payloads';
import { Id, PROTOCOL_VERSION } from './primitives';

export const SERVER_ID = 'server';

export const Envelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.string().min(1).max(64),
  id: Id,
  /** sender clock, epoch ms */
  ts: z.number(),
  from: z.string().max(128),
  to: Id.optional(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

/** Payload schema for every known message type. */
export const PayloadSchemas = {
  hello: HelloPayload,
  welcome: WelcomePayload,
  presence: PresencePayload,
  'pair.start': PairStartPayload,
  'pair.status': PairStatusPayload,
  'pair.approve': PairApprovePayload,
  'pair.deny': PairDenyPayload,
  'pair.pending': PairPendingPayload,
  'pair.approved': PairApprovedPayload,
  'pair.denied': PairDeniedPayload,
  snapshot: SnapshotPayload,
  'agent.step': AgentStepPayload,
  'device.card': DeviceCardPayload,
  'ui.spec': UiSpecPayload,
  'control.event': ControlEventPayload,
  'driver.deploy': DriverDeployPayload,
  'driver.status': DriverStatusPayload,
  log: LogPayload,
} as const;

export type MessageType = keyof typeof PayloadSchemas;
export type PayloadOf<T extends MessageType> = z.infer<(typeof PayloadSchemas)[T]>;
export const MESSAGE_TYPES = Object.keys(PayloadSchemas) as MessageType[];

export function isMessageType(type: string): type is MessageType {
  return Object.hasOwn(PayloadSchemas, type);
}

const EnvelopeBase = Envelope.omit({ type: true, payload: true });

function message<T extends MessageType>(type: T) {
  return EnvelopeBase.extend({ type: z.literal(type), payload: PayloadSchemas[type] as (typeof PayloadSchemas)[T] });
}

/** Full message schema per type (envelope + payload). */
export const MessageSchemas = {
  hello: message('hello'),
  welcome: message('welcome'),
  presence: message('presence'),
  'pair.start': message('pair.start'),
  'pair.status': message('pair.status'),
  'pair.approve': message('pair.approve'),
  'pair.deny': message('pair.deny'),
  'pair.pending': message('pair.pending'),
  'pair.approved': message('pair.approved'),
  'pair.denied': message('pair.denied'),
  snapshot: message('snapshot'),
  'agent.step': message('agent.step'),
  'device.card': message('device.card'),
  'ui.spec': message('ui.spec'),
  'control.event': message('control.event'),
  'driver.deploy': message('driver.deploy'),
  'driver.status': message('driver.status'),
  log: message('log'),
} as const;

export const Message = z.discriminatedUnion('type', [
  MessageSchemas.hello,
  MessageSchemas.welcome,
  MessageSchemas.presence,
  MessageSchemas['pair.start'],
  MessageSchemas['pair.status'],
  MessageSchemas['pair.approve'],
  MessageSchemas['pair.deny'],
  MessageSchemas['pair.pending'],
  MessageSchemas['pair.approved'],
  MessageSchemas['pair.denied'],
  MessageSchemas.snapshot,
  MessageSchemas['agent.step'],
  MessageSchemas['device.card'],
  MessageSchemas['ui.spec'],
  MessageSchemas['control.event'],
  MessageSchemas['driver.deploy'],
  MessageSchemas['driver.status'],
  MessageSchemas.log,
]);
export type Message = z.infer<typeof Message>;
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;

export const EXPERIMENTAL_TYPE = /^x\.[a-z0-9][a-z0-9._-]{0,60}$/i;
export const ExperimentalMessage = Envelope.extend({ type: z.string().regex(EXPERIMENTAL_TYPE) });
export type ExperimentalMessage = z.infer<typeof ExperimentalMessage>;
export type AnyMessage = Message | ExperimentalMessage;

/** Messages only the server may send; the hub refuses them from clients. */
export const SERVER_ONLY_TYPES: readonly MessageType[] = [
  'welcome',
  'presence',
  'pair.pending',
  'pair.approved',
  'pair.denied',
];

// --- ids ------------------------------------------------------------------------------------

/** Short random id. Works in browsers without a secure context (no crypto.randomUUID needed). */
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${prefix}${Date.now().toString(36)}${hex}`;
}

// --- build / parse --------------------------------------------------------------------------

export interface MessageOptions {
  from?: string;
  to?: string;
  id?: string;
  ts?: number;
}

/** Build a message. Does not validate; use parseMessage on the receiving side. */
export function makeMessage<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: MessageOptions = {}): MessageOf<T> {
  const m: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    type,
    id: opts.id ?? newId('m'),
    ts: opts.ts ?? Date.now(),
    from: opts.from ?? '',
    payload,
  };
  if (opts.to) m.to = opts.to;
  return m as MessageOf<T>;
}

/** Build and serialise in one go. */
export function encodeMessage<T extends MessageType>(type: T, payload: PayloadOf<T>, opts?: MessageOptions): string {
  return JSON.stringify(makeMessage(type, payload, opts));
}

export type ParseResult =
  | { ok: true; experimental: false; message: Message; raw: Record<string, unknown> }
  | { ok: true; experimental: true; message: ExperimentalMessage; raw: Record<string, unknown> }
  | { ok: false; error: string; issues: string[]; id?: string; type?: string };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

/**
 * Parse and validate a message from a string (as received on a socket) or an already-parsed object.
 * `raw` is the original object, so a relay can forward fields this version does not know about.
 */
export function parseMessage(input: unknown): ParseResult {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return { ok: false, error: 'not valid JSON', issues: [] };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'a message must be a JSON object', issues: [] };
  }
  const raw = obj as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  if (raw.v !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${JSON.stringify(raw.v)} (expected ${PROTOCOL_VERSION})`, issues: [], id, type };
  }
  if (type && EXPERIMENTAL_TYPE.test(type)) {
    const r = ExperimentalMessage.safeParse(raw);
    if (!r.success) return { ok: false, error: 'invalid envelope', issues: formatIssues(r.error), id, type };
    return { ok: true, message: r.data, experimental: true, raw };
  }
  if (!type || !isMessageType(type)) {
    return { ok: false, error: `unknown message type ${JSON.stringify(type)}`, issues: [], id, type };
  }
  const r = MessageSchemas[type].safeParse(raw);
  if (!r.success) return { ok: false, error: `invalid ${type}`, issues: formatIssues(r.error), id, type };
  return { ok: true, message: r.data as Message, experimental: false, raw };
}
