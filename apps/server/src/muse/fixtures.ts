/**
 * Canned FIXTURE replies for chatJson in fixture mode, keyed by json_schema name.
 * Every human-visible string says FIXTURE so a fixture can never pass for a live model call on screen.
 * Register more with FixtureMuse.register(name, value) as new agent steps appear.
 */
import type { DeviceCardPayload, UiSpecPayload } from '@ce/protocol';
import type { FixtureFn, FixtureValue } from './adapter';

export const FIXTURE_DEVICE_CARD: DeviceCardPayload = {
  cardId: 'fixture-card-1',
  name: 'FIXTURE Digitakt II',
  maker: 'Elektron',
  model: 'Digitakt II',
  category: 'drum-machine',
  confidence: 0.5,
  protocols: ['midi'],
  evidence: ['FIXTURE: canned identification, no Meta model was called'],
  requires: ['midi'],
  source: 'fixture',
};

export const FIXTURE_UI_SPEC: UiSpecPayload = {
  specId: 'fixture-spec-1',
  title: 'FIXTURE · Digitakt II controls',
  cardId: 'fixture-card-1',
  widgets: [
    { id: 'cutoff', kind: 'knob', label: 'Filter', range: { min: 0, max: 127, step: 1 }, default: 64, binding: { action: 'midi.cc', channel: 1, cc: 74 }, layout: { group: 'Filter' } },
    { id: 'reso', kind: 'knob', label: 'Reso', range: { min: 0, max: 127, step: 1 }, default: 0, binding: { action: 'midi.cc', channel: 1, cc: 75 }, layout: { group: 'Filter' } },
    { id: 'level', kind: 'fader', label: 'Level', range: { min: 0, max: 127, step: 1 }, default: 100, binding: { action: 'midi.cc', channel: 1, cc: 95 } },
    {
      id: 'pads',
      kind: 'pads',
      label: 'Tracks',
      binding: { action: 'midi.note', channel: 1 },
      pads: [
        { label: 'BD', note: 0 },
        { label: 'SD', note: 1 },
        { label: 'HH', note: 2 },
        { label: 'CP', note: 3 },
      ],
    },
  ],
  notes: 'FIXTURE: canned control surface, no Meta model was called',
  source: 'fixture',
};

export const DEFAULT_FIXTURES: Record<string, FixtureValue | FixtureFn> = {
  device_card: FIXTURE_DEVICE_CARD,
  ui_spec: FIXTURE_UI_SPEC,
};
