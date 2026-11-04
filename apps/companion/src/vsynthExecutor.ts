import type { ExecAckPayload, ExecCommandPayload, Port } from '@ce/protocol';
import { createVisualSynthPort, VISUAL_SYNTH_IDENTITY_REPLY, VISUAL_SYNTH_PORT, VISUAL_SYNTH_PORT_ID } from '@ce/vsynth';
import type { VisualSynthParameters, VisualSynthPort } from '@ce/vsynth';
import { checkMidiOp } from './contracts';
import { generatedMidiPacket } from './generatedMidi';

export const visualSynthPort: Port = { id: VISUAL_SYNTH_PORT_ID, name: VISUAL_SYNTH_PORT, kind: 'midi-out', manufacturer: 'ControlAnything', state: 'connected' };
export const isVisualPort = (port?: string): boolean => port === visualSynthPort.id || port === visualSynthPort.name;

type PortLike = Omit<VisualSynthPort, 'receiveMidiConfirmed'> & Partial<Pick<VisualSynthPort, 'receiveMidiConfirmed'>>;
const params = (state: VisualSynthParameters): Record<string, number> => ({ ...state });

/**
 * Independent of Web MIDI permissions and all physical outputs. Every applied CC/program change is
 * acknowledged with the parameter state after the command (`applied`): from the drawing page when a
 * live renderer confirms it within 150 ms, else from the headless port.
 */
export class VisualSynthExecutor {
  constructor(
    private readonly port: PortLike = createVisualSynthPort(),
    /** A visible renderer exists now, or was visible within the presence grace window. */
    private readonly connected: () => boolean = () => true,
  ) {}

  async execute(cmd: ExecCommandPayload): Promise<ExecAckPayload> {
    const ack = (ok: boolean, extra: Partial<ExecAckPayload> = {}): ExecAckPayload => ({ execId: cmd.execId, ok, sentAt: Date.now(), ...extra });
    if (cmd.op.kind !== 'midi' || !isVisualPort(cmd.port)) return ack(false, { error: 'no_port' });
    const op = cmd.op;
    const error = checkMidiOp(op);
    if (error || op.channel !== 1) return ack(false, { error: 'bad_args', detail: error ?? 'Visual synth listens on channel 1' });
    const generated = generatedMidiPacket(cmd, visualSynthPort.id);
    if (generated && !generated.ok) return ack(false, { error: 'refused', detail: generated.error });
    if (op.msg === 'note') return ack(false, { error: 'unsupported', detail: 'Visual synth accepts CCs and patterns; it has no audio' });
    if (cmd.dryRun) return ack(true, { detail: 'dry run' });
    if (op.msg !== 'panic' && !this.connected()) return ack(false, { error: 'no_port', detail: 'Open visuals from this companion and keep the visual screen visible.' });
    if (op.msg === 'sysex-identity') return ack(true, { reply: [...VISUAL_SYNTH_IDENTITY_REPLY] });
    if (op.msg === 'panic') {
      this.panic();
      return ack(true, { applied: { source: 'port', params: params(this.port.getState()), at: Date.now() } });
    }
    const bytes = generated?.ok ? generated.bytes : op.msg === 'cc' ? [0xb0, op.number!, op.value as number] : [0xc0, op.number!];
    const receipt = generated?.ok ? ` · ${generated.receipt}` : '';
    const started = Date.now();
    if (this.port.receiveMidiConfirmed) {
      const result = await this.port.receiveMidiConfirmed(bytes);
      if (!result.ok) return ack(false, { error: 'bad_args', detail: 'Unmapped visual command' });
      const report = result.receipt;
      return report
        ? ack(true, { detail: 'Visual command applied by the Mac renderer' + receipt, latencyMs: Math.max(0, report.at - started),
          applied: { source: 'renderer', params: params(report.params), visible: report.visible, frame: report.frame, at: report.at } })
        : ack(true, { detail: 'Visual command stored; no renderer confirmed it' + receipt, applied: { source: 'port', params: params(this.port.getState()), at: Date.now() } });
    }
    if (this.port.receiveMidi(bytes) === false) return ack(false, { error: 'bad_args', detail: 'Unmapped visual command' });
    return ack(true, { detail: 'Visual command stored' + receipt, applied: { source: 'port', params: params(this.port.getState()), at: Date.now() } });
  }

  panic(): void { this.port.reset(); }
}
