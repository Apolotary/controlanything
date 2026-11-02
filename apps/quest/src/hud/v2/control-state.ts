import type { Control, ControlEvent } from '@ce/gen3d';

/** Power actions change the readout without discarding the last brightness value. */
export function controlPower(control: Pick<Control, 'kind' | 'label' | 'binding'>, value: ControlEvent['value']): boolean | undefined {
  const action = control.binding?.action.split('.').at(-1) ?? '';
  if (control.kind === 'toggle' && /^(power|onoff|on_off)$/i.test(action)) return Boolean(value);
  if (!value || (control.kind !== 'trigger' && control.kind !== 'toggle')) return undefined;
  if (/^(off|power[ _-]?off)$/i.test(action) || /\boff\b/i.test(control.label)) return false;
  if (/^(full[ _-]?on|full|on|power[ _-]?on)$/i.test(action) || /\bon\b/i.test(control.label)) return true;
  return undefined;
}

export function isBrightness(control: Pick<Control, 'kind' | 'label' | 'binding'>): boolean {
  return control.kind !== 'trigger' && control.kind !== 'toggle'
    && /brightness|brighter|dimmer|\blevel\b/i.test(`${control.label} ${control.binding?.action ?? ''}`);
}
