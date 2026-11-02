import type { ExecAckPayload, ExecCommandPayload, Port } from '@ce/protocol';
import { createVisualSynthPort, VISUAL_SYNTH_IDENTITY_REPLY, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID } from '@ce/vsynth';
import { checkMidiOp } from './contracts';

export const visualSynthPort: Port = { id: VISUAL_SYNTH_PORT_ID, name: VISUAL_SYNTH_PORT, kind: 'midi-out', manufacturer: 'ControlAnything', state: 'connected' };
export const isVisualPort = (port?: string): boolean => port === visualSynthPort.id || port === visualSynthPort.name;

/** Independent of Web MIDI permissions and all physical outputs. */
export class VisualSynthExecutor {
  constructor(private readonly port = createVisualSynthPort()) {}

  execute(cmd: ExecCommandPayload): ExecAckPayload {
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => ({ execId: cmd.execId, ok, sentAt: Date.now(), ...extra });
    if (cmd.op.kind !== 'midi' || !isVisualPort(cmd.port)) return ack(false, { error: 'no_port' });
    const op = cmd.op;
    const error = checkMidiOp(op);
    if (error || op.channel !== 1) return ack(false, { error: 'bad_args', detail: error ?? 'Visual synth listens on channel 1' });
    if (op.msg === 'note') return ack(false, { error: 'unsupported', detail: 'Visual synth accepts CCs and patterns; it has no audio' });
    if (cmd.dryRun) return ack(true, { detail: 'dry run' });
    if (op.msg === 'sysex-identity') return ack(true, { reply: [...VISUAL_SYNTH_IDENTITY_REPLY] });
    if (op.msg === 'panic') this.panic();
    else {
      const bytes = op.msg === 'cc' ? [0xb0, op.number!, op.value as number] : [0xc0, op.number!];
      if (this.port.receiveMidi(bytes) === false) return ack(false, { error: 'bad_args', detail: 'Unmapped visual command' });
    }
    return ack(true, { detail: 'Visual command delivered; camera verification decides the effect' });
  }

  panic(): void { this.port.reset(); }
}
