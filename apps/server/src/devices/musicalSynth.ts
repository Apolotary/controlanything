/** Authored software instrument capabilities. Muse still writes every live gesture program. */
import type { Driver, DriverDraft, Provenance } from '@ce/protocol';
import { MUSICAL_SYNTH_MANIFEST as M, MUSICAL_SYNTH_PORT_ID, MUSICAL_SYNTH_NAME } from '@ce/vsynth/musical-manifest';
import type { MidiProfile } from './profiles';
export { MUSICAL_SYNTH_MANIFEST, MUSICAL_SYNTH_PORT_ID, MUSICAL_SYNTH_NAME } from '@ce/vsynth/musical-manifest';
export const isMusicalSynthPort = (port?: string) => port === MUSICAL_SYNTH_PORT_ID || port === MUSICAL_SYNTH_NAME;
export const musicalSynthProfile = (): MidiProfile => ({
  id: M.id, device: M.name, manufacturer: 'ControlAnything', sense: 'audio',
  sources: [{ title: 'Authored browser instrument capability manifest', url: 'builtin:musical-synth-manifest' }],
  usb: { portNameHint: MUSICAL_SYNTH_PORT_ID, notes: 'Exact browser software output, never a physical MIDI device.' },
  identity: { respondsToUniversalInquiry: false }, channels: { receive: '1' },
  parameters: M.controls.map(c => ({ name: c.label, cc: c.cc, range: [c.min, c.max], notes: c.effect })),
  unsafeMessages: ['Physical MIDI', 'Native note messages', 'SysEx', 'Transport'],
  demo: { bestParameters: M.controls.map(c => `CC ${c.cc}: ${c.label}`), setup: ['Explicitly choose Sound on on the Mac; only then may software audio verification run.'] },
});
export function musicalActions(): DriverDraft['actions'] {
  return M.controls.map(c => ({ actionId: `cc${c.cc}`, label: c.label, description: c.effect.slice(0, 300), kind: 'set',
    range: { min: c.min, max: c.max, step: 1 }, curve: 'linear',
    encode: { kind: 'midi', msg: 'cc', channel: 1, number: c.cc, value: '$value' }, expect: { sense: 'audio', effect: 'any' } }));
}
/** Clearly labelled fixture/fallback catalog; contains no hand interaction. */
export function musicalSynthDraft(cardId: string, provenance: Provenance[]): DriverDraft {
  return { cardId, name: M.name, transport: 'midi', provenance,
    notes: 'FIXTURE/template from the authored software instrument manifest; no model wrote this driver.',
    actions: [...musicalActions(), ...M.programs.map(p => ({ actionId: `preset${p.program}`, label: p.name, kind: 'trigger' as const,
      encode: { kind: 'midi' as const, msg: 'pc' as const, channel: 1, number: p.program }, expect: { sense: 'audio' as const, effect: 'any' as const } }))] };
}
/** Offer every published engine capability to Muse, including note/gate even if setup selected other controls. */
export function extendWithMusicalCapabilities<D extends Pick<Driver, 'executor' | 'actions'>>(driver: D): { driver: D; added: string[] } {
  if (!isMusicalSynthPort(driver.executor.port)) return { driver, added: [] };
  const have = new Set(driver.actions.flatMap(a => a.encode.kind === 'midi' && a.encode.msg === 'cc' ? [a.encode.number] : []));
  const ids = new Set(driver.actions.map(a => a.actionId));
  const missing = musicalActions().filter(a => a.encode.kind === 'midi' && !have.has(a.encode.number) && !ids.has(a.actionId));
  return { driver: missing.length ? { ...driver, actions: [...driver.actions, ...missing] } : driver, added: missing.map(a => a.actionId) };
}
