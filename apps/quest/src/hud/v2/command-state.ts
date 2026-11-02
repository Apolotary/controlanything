import type { ControlEvent } from '@ce/gen3d';

export type CommandPhase = 'sending' | 'ok' | 'fail';
export interface CommandState { controlId: string; ts: number; value: ControlEvent['value']; phase: CommandPhase; at: number; hack?: { targetId: string; itemId: string; controlId?: string; index: number } }

/** A late executor result must never settle a newer gesture (rule 10). */
export function acceptsCommandResult(command: CommandState | undefined, controlId: string, ts: number): boolean {
  return !!command && command.controlId === controlId && command.ts === ts;
}
export function commandTimedOut(command: CommandState | undefined, now: number): boolean {
  return command?.phase === 'sending' && now - command.at >= 5000;
}
export function routeLabel(transport: string | undefined, channel?: string): string {
  if (transport === 'usb-midi' || channel === 'midi') return 'via Mac (USB MIDI)';
  if (transport === 'ble-midi') return 'via Mac (Bluetooth MIDI)';
  if (transport === 'ir' || channel === 'ir') return 'via IR bridge';
  if (transport === 'sim') return 'via Simulator';
  if (transport === 'serial') return 'via Mac (USB)';
  if (channel === 'local') return 'via Mac';
  return 'via connected bridge';
}
export function commandSubtitle(phase: CommandPhase | undefined, route: string, state = 'Ready', setup?: string): string {
  if (setup) {
    if (/mic|audio|sound/i.test(setup)) return 'Testing with the headset mic…';
    if (/camera|frame|visual/i.test(setup)) return 'Testing with the headset camera…';
    return setup;
  }
  if (phase === 'sending') return 'Sending…';
  if (phase === 'fail') return 'Couldn’t send · Retry';
  return `${state} · ${route}`;
}
