import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GeneratedConnectorRegistry, validateConnector } from './connector-runtime';
import type { FreshArtifacts, FreshContract, FreshGenerated } from './fresh-connector';
import type { ExecRequest } from './dispatch';

const contract: FreshContract = {
  cardId: 'test-card', deviceName: 'Fake reviewed MIDI device', request: 'hand push sweeps parameter',
  portHint: 'Test instrument', ports: [{ id: 'fake-output', name: 'Test instrument', state: 'connected' }],
  actions: [
    { actionId: 'cc50', label: 'Parameter', kind: 'set', channel: 2, cc: 50, min: 16, max: 64 },
    { actionId: 'pattern2', label: 'Pattern', kind: 'trigger', channel: 1, program: 2, min: 0, max: 1 },
  ], signalsApi: '', hints: [],
};
// Explicit test double, never a production/default connector or a live Muse claim.
const source = `
if (input.kind === 'bind') {
  const live = input.ports.filter(p => p.state !== 'disconnected');
  const ids = live.filter(p => p.id === input.hint);
  const matches = ids.length ? ids : live.filter(p => p.name && p.name.toLowerCase() === input.hint.toLowerCase());
  if (matches.length !== 1) throw Error('missing or ambiguous output');
  return {portId: matches[0].id};
}
if (input.kind !== 'encode') throw Error('bad kind');
if (input.actionId === 'cc50') {
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) throw Error('bad value');
  return {bytes:[177,50,Math.round(Math.max(16, Math.min(64,input.value)))]};
}
if (input.actionId === 'pattern2') return {bytes:[192,2]};
throw Error('unknown action');
`;
const artifacts: FreshArtifacts = { connector: source, gesture: 'if(s.right) out.set("cc50",16+s.right.push*48);', title: 'Push', explanation: 'Push your right hand.', needs: ['right'] };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const generated = (patch: Partial<FreshGenerated> = {}): FreshGenerated => ({ ...artifacts, jobId: 'explicit-test-double', model: 'muse-spark-1.3', source: 'live', workspace: '/test-only',
  hashes: { connector: sha(artifacts.connector), gesture: sha(artifacts.gesture) }, createdAt: 1, finishedAt: 2, observedModels: ['muse-spark-1.3'], ...patch });
const request = (patch: Partial<ExecRequest> = {}): ExecRequest => ({ cardId: contract.cardId, driverId: 'driver', executorDeviceId: 'paired-mac', port: contract.portHint,
  actionId: 'cc50', op: { kind: 'midi', msg: 'cc', channel: 2, number: 50, value: 40 }, ...patch });
const setup = (getPorts = () => contract.ports) => {
  const registry = new GeneratedConnectorRegistry(getPorts);
  registry.install({ cardId: contract.cardId, driverId: 'driver', wiringId: 'wire-epoch', executorDeviceId: 'paired-mac', contract, generated: generated() });
  return registry;
};

describe('newly generated connector execution', () => {
  it('checks real bind and CC/PC encoding against reviewed data', () => {
    expect(validateConnector(artifacts, contract)).toEqual([]);
    const registry = setup();
    expect(registry.encode(request())).toEqual({ connectorId: 'explicit-test-double', hash: sha(source), portId: 'fake-output', bytes: [177, 50, 40] });
    expect(registry.encode(request({ actionId: 'pattern2', op: { kind: 'midi', msg: 'pc', channel: 1, number: 2 } }))?.bytes).toEqual([192, 2]);
    expect(registry.receipt(contract.cardId)).toMatchObject({ invocationCount: 2, lastBytes: [192, 2], wiringId: 'wire-epoch', lastPortId: 'fake-output' });
  });

  it('rejects wrong-channel packets even when the model source otherwise runs', () => {
    expect(validateConnector({ ...artifacts, connector: source.replace('[177,50,', '[176,50,') }, contract).join(' ')).toContain('reviewed channel');
  });

  it('rejects broad range clamping and guessed/ambiguous output binding', () => {
    expect(validateConnector({ ...artifacts, connector: source.replace('Math.max(16, Math.min(64,input.value))', 'Math.max(0, Math.min(127,input.value))') }, contract).join(' ')).toContain('unsafe packet');
    expect(validateConnector({ ...artifacts, connector: source.replace("if (matches.length !== 1)", "if (matches.length === 0)") }, contract).join(' ')).toContain('ambiguous');
    expect(validateConnector(artifacts, { ...contract, ports: [{ id: 'wrong', name: 'Other device' }] }).join(' ')).toContain('absent or ambiguous');
  });

  it('binds again against current ports, refusing disconnect and a different paired executor', () => {
    let ports = contract.ports;
    const registry = setup(() => ports);
    expect(registry.encode(request())?.portId).toBe('fake-output');
    ports = [{ id: 'fake-output', name: contract.portHint, state: 'disconnected' }];
    expect(() => registry.encode(request())).toThrow('absent or ambiguous');
    ports = contract.ports;
    expect(() => registry.encode(request({ executorDeviceId: 'other-mac' }))).toThrow('owns this driver or executor');
  });

  it('permits verification suffixes only with the exact reviewed semantic operation', () => {
    const registry = setup();
    expect(registry.encode(request({ actionId: 'cc50:baseline' }))?.bytes).toEqual([177, 50, 40]);
    expect(() => registry.encode(request({ actionId: 'cc50:baseline', op: { kind: 'midi', msg: 'cc', channel: 2, number: 51, value: 40 } }))).toThrow('disagrees');
    expect(() => registry.encode(request({ actionId: 'unknown' }))).toThrow('unreviewed');
    expect(() => registry.encode(request({ driverId: 'retired-driver' }))).toThrow('owns this driver or executor');
    expect(() => registry.encode(request({ driverId: undefined }))).toThrow('owns this driver or executor');
    // An internal verification preparation can use another actual catalog action;
    // the generated encoder must receive that action's ID, not the primary one.
    expect(registry.encode(request({ actionId: 'cc50:baseline', op: { kind: 'midi', msg: 'pc', channel: 1, number: 2 } }))?.bytes).toEqual([192, 2]);
    expect(() => registry.encode(request({ actionId: 'cc50:arbitrary', op: { kind: 'midi', msg: 'pc', channel: 1, number: 2 } }))).toThrow('disagrees');
    expect(() => registry.encode(request({ actionId: 'cc50', op: { kind: 'midi', msg: 'pc', channel: 1, number: 2 } }))).toThrow('disagrees');
  });

  it('fails closed after Stop until an explicit new install or authored WIRE', () => {
    const registry = setup();
    registry.clear(contract.cardId);
    expect(() => registry.encode(request())).toThrow('retired');
    expect(registry.encode(request({ op: { kind: 'midi', msg: 'panic', channel: 1 } }))).toBeUndefined();
    expect(() => registry.encode(request({ priorityRelease: true }))).toThrow('retired');
    registry.useAuthored(contract.cardId);
    expect(registry.encode(request())).toBeUndefined();
    registry.install({ cardId: contract.cardId, driverId: 'driver', wiringId: 'new-epoch', contract, generated: generated() });
    expect(registry.encode(request())?.bytes).toEqual([177, 50, 40]);
    registry.clear('never-generated-card');
    expect(registry.encode(request({ cardId: 'never-generated-card' }))).toBeUndefined();
  });

  it('rejects changed file hashes and missing observed model evidence', () => {
    const registry = setup();
    const install = (g: FreshGenerated) => registry.install({ cardId: contract.cardId, driverId: 'driver', wiringId: 'new', contract, generated: g });
    expect(() => install(generated({ connector: source + '\nreturn {};' }))).toThrow('hashes');
    expect(() => registry.encode(request())).toThrow('retired');
    expect(() => install(generated({ observedModels: [] }))).toThrow('Meta model receipt');
  });

  it('refuses runtime imports, dynamic code/host access, and an endless generated program', () => {
    for (const connector of ['return process.env;', 'return input.constructor;', 'return eval("1");', 'while(true) {}']) {
      expect(validateConnector({ ...artifacts, connector }, contract).length).toBeGreaterThan(0);
    }
  });

  it('uses changed generated bytes directly rather than silently reverting to an authored encoder', () => {
    const registry = setup();
    expect(registry.encode(request())?.bytes).toEqual([177, 50, 40]);
    const mutated = generated({ connector: source.replace('[177,50,', '[178,50,') });
    mutated.hashes.connector = sha(mutated.connector);
    expect(() => registry.install({ cardId: contract.cardId, driverId: 'driver', wiringId: 'bad', contract, generated: mutated })).toThrow('reviewed channel');
    expect(() => registry.encode(request())).toThrow('retired');
  });
});
