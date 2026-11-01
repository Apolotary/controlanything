/**
 * Semantic checks on top of the protocol v1 schemas (packages/protocol, owned by brain). The wire shapes
 * are validated by parseMessage on receipt; these catch what a schema can't: unresolved "$value"
 * placeholders, fields a message kind needs, and what this executor's hardware can play.
 */
import type { ExecAckPayload, ExecCommandPayload, ExecErrorCode, IrOp, MidiOp } from '@ce/protocol';

export type { ExecAckPayload, ExecCommandPayload, ExecErrorCode, IrOp, MidiOp };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Problems with a MidiOp that the schema allows; undefined when it can be executed. */
export function checkMidiOp(op: MidiOp): string | undefined {
  if (op.msg === 'panic' || op.msg === 'sysex-identity') return undefined;
  if (op.value === '$value') return 'unresolved "$value" placeholder (the server must substitute the control value)';
  if (op.number === undefined) return `${op.msg} needs a number (CC, note or program)`;
  if (op.msg === 'cc' && op.value === undefined) return 'cc needs a value 0-127';
  return undefined;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function asStr(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

export function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
