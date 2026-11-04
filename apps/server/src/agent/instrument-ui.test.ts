import { describe, expect, it } from 'vitest';
import { InstrumentDesign, compileInstrument } from './instrument-ui';
import { fixtureScript, type AgentContext } from './muse-agent';

describe('Muse instrument composer', () => {
  for (const name of ['OP-1', 'Visual synth', 'ControlAnything Synth']) it(`compiles the ${name} fixture into bounded existing archetypes`, () => {
    const ctx: AgentContext = { cardId: 'test-card', deviceName: name, companion: { online: true, midiOutputs: ['OP-1', 'ControlAnything Synth'], visualsOpen: true, musicalOpen: true } };
    const steps = fixtureScript(ctx, name === 'Visual synth' ? 'Give me knobs' : 'Give me keys and coloured knobs');
    const deployed = steps.find(s => s.name === 'deploy_connector')!.args;
    const finish = steps.find(s => s.name === 'finish')!.args;
    const design = InstrumentDesign.parse(finish.ui);
    const result = compileInstrument(design, deployed.actions as never, { cardId: ctx.cardId, title: name, source: 'fixture', model: 'fixture' });
    expect(result.issues).toEqual([]);
    expect(result.spec?.controls.every(c => c.armed)).toBe(true);
    expect(result.spec?.parts.some(p => p.archetype === (name === 'Visual synth' ? 'xy-orb' : 'keys'))).toBe(true);
    expect(result.used).toContain(name === 'Visual synth' ? 'cc22' : 'note');
    expect(JSON.stringify(result.spec).length).toBeLessThan(20_000);
  });
  it('compiles every advertised widget type and a single trigger pad', () => {
    const actions = [{ id: 'x', label: 'X', kind: 'set' as const, min: 0, max: 127 }, { id: 'y', label: 'Y', kind: 'set' as const, min: 0, max: 127 }, { id: 'hit', label: 'Hit', kind: 'trigger' as const }, { id: 'on', label: 'On', kind: 'toggle' as const }];
    for (const type of ['keys', 'pads', 'xy-orb', 'fader', 'knob', 'wheel', 'dimmer-ring', 'lever', 'button', 'toggle']) {
      const design = InstrumentDesign.parse({ style: { accent: '#8ad8ff' }, widgets: [{ type, label: type, ...(type === 'xy-orb' ? { actions: ['x', 'y'] } : { action: type === 'button' ? 'hit' : type === 'toggle' ? 'on' : 'x' }) }] });
      expect(compileInstrument(design, actions, { cardId: 'test', title: 'test', source: 'fixture', model: 'fixture' }).issues, type).toEqual([]);
    }
    const pad = InstrumentDesign.parse({ style: { accent: '#8ad8ff' }, widgets: [{ type: 'pads', label: 'Hit', actions: ['hit'] }] });
    expect(compileInstrument(pad, actions, { cardId: 'test', title: 'test', source: 'fixture', model: 'fixture' }).issues).toEqual([]);
  });
  it('keeps reviewer fixtures touchable without hand tracking or calibration', () => {
    const ctx: AgentContext = { cardId: 'test', deviceName: 'Visual synth', companion: { online: true, midiOutputs: ['ControlAnything Visual Synth'], visualsOpen: true, musicalOpen: false, app: 'reviewer-software@1' } };
    const finish = fixtureScript(ctx, 'Touch the water with mouse controls only').find(s => s.name === 'finish')!.args;
    expect(finish.ui).toBeTruthy(); expect(finish.hand_program).toBeUndefined();
  });
  it('rejects undeployed bindings and incompatible XY/keyboard ranges', () => {
    const actions = [{ id: 'cutoff', label: 'Cutoff', kind: 'set' as const, min: 0, max: 1 }];
    for (const widget of [{ type: 'knob', label: 'Bad', action: 'missing' }, { type: 'xy-orb', label: 'Bad', actions: ['cutoff'] }, { type: 'keys', label: 'Bad', action: 'cutoff' }]) {
      const result = compileInstrument(InstrumentDesign.parse({ style: { accent: '#8ad8ff' }, widgets: [widget] }), actions, { cardId: 'test', title: 'test', source: 'fixture', model: 'fixture' });
      expect(result.issues.length).toBeGreaterThan(0); expect(result.spec).toBeUndefined();
    }
  });
  it('only chooses a gimbal fixture for a connected gimbal and deliberate gimbal request', () => {
    const ctx: AgentContext = { cardId: 'camera', deviceName: 'Camera', companion: { online: true, midiOutputs: ['OP-1'], visualsOpen: false, musicalOpen: false }, gimbal: { bridge: 'connected' } };
    const script = fixtureScript(ctx, 'Give me pan and tilt controls for the gimbal');
    expect(script.find(s => s.name === 'deploy_connector')?.args.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'pan' }), expect.objectContaining({ id: 'tilt' })]));
    expect(script.find(s => s.name === 'write_file')?.args.content).toContain('gimbal.pan');
  });
});
