/** Fresh connector generation and hot-loading; the reviewed action catalog is data, not implementation. */
import type { Driver } from '@ce/protocol';
import { FreshConnectorGenerator, type FreshContract } from './fresh-connector';
import { GeneratedConnectorRegistry, validateConnector } from './connector-runtime';
import { actionBriefs, deviceHints, SIGNALS_API, type WireEmit, type WireInput, type WireWritten } from './wire';
import { dryRun, issueLines, resolveNeeds, validateWiring } from './wire-check';
import { RequestCancelledError } from '../muse/cancellation';
import { isVisualSynthPort } from '../devices/visualSynth';
import { VISUAL_SYNTH_MANIFEST } from '@ce/vsynth/manifest';

export function connectorContract(input: WireInput, ports: FreshContract['ports']): FreshContract {
  if (input.driver.transport !== 'midi' || !input.driver.executor.port) throw Error('Choose a connected MIDI or browser synth device first.');
  const briefs = actionBriefs(input.driver);
  const actions: FreshContract['actions'] = input.driver.actions.flatMap(action => {
    if (action.kind !== 'set' && action.kind !== 'trigger') return [];
    const e = action.encode;
    if (e.kind !== 'midi' || (e.msg !== 'cc' && e.msg !== 'pc') || !e.channel || e.number === undefined) return [];
    // The chart/manifest already passed the ordinary driver allowlist. These remain permission data.
    return [{ actionId: action.actionId, label: action.label, kind: action.kind,
      channel: e.channel, ...(e.msg === 'cc' ? { cc: e.number } : { program: e.number }),
      min: action.range?.min ?? (typeof e.value === 'number' ? e.value : 0),
      max: action.range?.max ?? (typeof e.value === 'number' ? e.value : 127),
      effect: briefs.find(b => b.actionId === action.actionId)?.effect }];
  });
  if (!actions.length) throw Error('This device has no permitted CC/program chart. Review its MIDI chart before asking for a connector.');
  const hints = deviceHints(input.driver);
  // The camera oracle freezes this known software instrument before comparing frames.
  // Supply its published capability as data, so even that preparation uses Muse's encoder.
  if (isVisualSynthPort(input.driver.executor.port) && !actions.some(a => a.cc === 1)) {
    const speed = VISUAL_SYNTH_MANIFEST.controls.find(c => c.cc === 1)!;
    actions.push({ actionId: 'host-visual-speed', label: speed.label, kind: 'set', channel: 1, cc: speed.cc,
      min: 0, max: 127, effect: speed.effect });
    hints.push('host-visual-speed is connector-only host verification preparation. Encode it, but never call it from gesture.js.');
  }
  return { cardId: input.cardId, deviceName: input.deviceName, request: input.request,
    portHint: input.driver.executor.port, ports, actions, signalsApi: SIGNALS_API, hints };
}

export function freshConnectorWriter(deps: {
  generator: FreshConnectorGenerator; registry: GeneratedConnectorRegistry;
  ports(executorId: string): FreshContract['ports'];
}) {
  return async (input: WireInput, emit: WireEmit, opts: { signal: AbortSignal; wiringId: string }): Promise<WireWritten> => {
    const started = Date.now();
    const ports = deps.ports(input.driver.executor.deviceId);
    if (!ports.length) throw Error('Refresh the Mac companion to load the latest connector executor, open its synth, then ask again.');
    const contract = connectorContract(input, ports);
    const checkedDriver = { ...input.driver, actions: input.driver.actions.filter(a => contract.actions.some(c => c.actionId === a.actionId)) };
    emit('writing', { title: 'Muse is building a new connector', note: 'New workspace · no connector or gesture implementation supplied', model: 'muse-spark-1.3', source: 'live' });
    const generated = await deps.generator.generate(contract, {
      signal: opts.signal,
      onProgress: (note, code) => emit('writing', { note, ...(code ? { code } : {}), model: 'muse-spark-1.3', source: 'live' }),
      check: artifacts => {
        const issues = validateConnector(artifacts, contract);
        const check = validateWiring(artifacts.gesture, checkedDriver);
        issues.push(...issueLines(check.issues));
        if (check.ok) issues.push(...issueLines(dryRun(artifacts.gesture, checkedDriver, resolveNeeds(artifacts.needs, check.reads)).issues));
        return issues;
      },
    });
    if (opts.signal.aborted) throw new RequestCancelledError();
    const check = validateWiring(generated.gesture, checkedDriver);
    const needs = resolveNeeds(generated.needs, check.reads);
    const dry = dryRun(generated.gesture, checkedDriver, needs);
    if (!check.ok || !dry.ok) throw Error('The generated hand program did not pass its final checks.');
    const driver = input.driver as Driver;
    if (!driver.driverId) throw Error('The selected device changed before connector loading.');
    deps.registry.install({ cardId: input.cardId, driverId: driver.driverId, executorDeviceId: driver.executor.deviceId,
      wiringId: opts.wiringId, contract, generated });
    emit('validating', { code: generated.gesture, model: generated.model, source: 'live',
      title: generated.title, explanation: generated.explanation,
      note: `New connector loaded · ${generated.hashes.connector.slice(0, 12)} · packet checks passed` });
    return { ok: true, code: generated.gesture, title: generated.title, explanation: generated.explanation,
      needs, model: generated.model, source: 'live', latencyMs: Date.now() - started, attempts: 1,
      used: [...new Set([...check.used, ...dry.actions])], check, dry, issues: [] };
  };
}
