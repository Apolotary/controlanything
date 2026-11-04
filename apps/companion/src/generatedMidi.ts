import type { ExecCommandPayload } from '@ce/protocol';

/** Validate supplied packets against policy; never substitute an authored encoder on failure. */
export function generatedMidiPacket(cmd: ExecCommandPayload, exactPortId: string):
  { ok: true; bytes: number[]; receipt: string } | { ok: false; error: string } | undefined {
  const generated = cmd.generatedMidi;
  if (!generated) return;
  const op = cmd.op;
  if (op.kind !== 'midi' || op.msg !== 'cc' && op.msg !== 'pc') return { ok: false, error: 'Generated connectors may send only authorized CC or program bytes' };
  if (cmd.port !== generated.portId || exactPortId !== generated.portId) return { ok: false, error: 'Generated connector binding does not match the exact MIDI output id' };
  const expected = op.msg === 'cc' ? [0xb0 + op.channel - 1, op.number, op.value] : [0xc0 + op.channel - 1, op.number];
  if (generated.bytes.length !== expected.length || generated.bytes.some((byte, i) => !Number.isInteger(byte) || byte !== expected[i])) {
    return { ok: false, error: 'Generated MIDI bytes disagree with the authorized command' };
  }
  return { ok: true, bytes: [...generated.bytes], receipt: `Muse connector ${generated.connectorId} · ${generated.hash.slice(0, 12)}` };
}
