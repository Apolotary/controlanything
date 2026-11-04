/**
 * Executes the connector Muse just wrote. OS/WebMIDI access remains transport infrastructure;
 * choosing the bound port and producing the packets happens in the generated program.
 * VM inputs/results cross as JSON only. This is a bounded model-code contract, not an OS sandbox.
 */
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import type { ExecRequest } from './dispatch';
import { isNeutralSoftwareRelease } from './dispatch';
import type { FreshArtifacts, FreshContract, FreshGenerated } from './fresh-connector';
import { stripComments } from './wire-check';

type Port = FreshContract['ports'][number];
type Action = FreshContract['actions'][number];
const digest = (code: string) => createHash('sha256').update(code).digest('hex');
const MODEL = 'muse-spark-1.3';
const MAX_CODE_BYTES = 16_384;

export interface GeneratedMidi {
  connectorId: string;
  hash: string;
  bytes: number[];
  portId: string;
}
export interface ConnectorReceipt {
  cardId: string; driverId: string; wiringId: string; connectorId: string;
  hash: string; gestureHash: string; model: string; source: 'live'; installedAt: number;
  invocationCount: number; lastPortId?: string; lastBytes?: number[]; lastEncodedAt?: number;
}

/** No host object or function is passed into generated code. */
class ConnectorProgram {
  private readonly script: vm.Script;
  constructor(code: string) {
    if (!code.trim() || Buffer.byteLength(code) > MAX_CODE_BYTES) throw Error('Connector must contain 1–16384 bytes of JavaScript.');
    const text = stripComments(code).text;
    const forbidden = /\b(?:import|require|fetch|XMLHttpRequest|WebSocket|eval|Function|globalThis|self|postMessage|setTimeout|setInterval|setImmediate|document|window|navigator|location|this|constructor|__proto__|prototype|Reflect|Proxy|Promise|async|await|console|process|global|Atomics|SharedArrayBuffer|WebAssembly|with|debugger|Date)\b/;
    const token = text.match(forbidden)?.[0];
    if (token || /\\[ux][0-9a-f{]/i.test(text)) throw Error(`Connector uses a forbidden capability${token ? ': ' + token : ' or escaped identifier'}.`);
    // Compile the body independently so it cannot escape the function wrapper below.
    new Function('input', '"use strict";\n' + code);
    this.script = new vm.Script(`"use strict"; const serialize = JSON.stringify; const input = JSON.parse(__input); const connector = function(input) {\n${code}\n}; serialize(connector(input));`, { filename: 'muse-generated-connector.js' });
  }
  run(input: unknown): any {
    const context = vm.createContext(Object.assign(Object.create(null), { __input: JSON.stringify(input) }), { codeGeneration: { strings: false, wasm: false } });
    const json: unknown = this.script.runInContext(context, { timeout: 12 });
    if (typeof json !== 'string' || Buffer.byteLength(json) > 4096) throw Error('Connector must return a small JSON object.');
    return JSON.parse(json);
  }
}

/** Independent routing policy: the generated answer must identify the exact requested endpoint. */
function permittedPort(ports: Port[], hint: string): string | undefined {
  const live = ports.filter(p => p.state !== 'disconnected');
  const ids = live.filter(p => p.id === hint);
  if (ids.length === 1) return ids[0]!.id;
  if (ids.length > 1) return;
  const names = live.filter(p => p.name?.toLowerCase() === hint.toLowerCase());
  return names.length === 1 ? names[0]!.id : undefined;
}

function bind(program: ConnectorProgram, ports: Port[], hint: string): string {
  const allowed = permittedPort(ports, hint);
  if (!allowed) throw Error('The requested MIDI output is absent or ambiguous. Choose an exact output.');
  const answer = program.run({ kind: 'bind', ports, hint });
  if (!answer || answer.portId !== allowed) throw Error('Generated connector did not bind the exact requested MIDI output.');
  return allowed;
}

function checkedBytes(answer: any, action: Action, value?: number): number[] {
  const bytes: unknown = answer?.bytes;
  const cc = action.cc !== undefined;
  const length = cc ? 3 : 2;
  if (!Array.isArray(bytes) || bytes.length !== length || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw Error('Generated connector returned a malformed MIDI packet.');
  const status = (cc ? 0xb0 : 0xc0) + action.channel - 1;
  if (bytes[0] !== status || bytes[1] !== (cc ? action.cc : action.program)) throw Error(`Generated connector changed the reviewed channel or parameter for ${action.actionId}.`);
  if (cc) {
    const expected = Math.round(Math.max(action.min, Math.min(action.max, value!)));
    if (!Number.isFinite(value) || bytes[2] !== expected || bytes[2] < action.min || bytes[2] > action.max || bytes[2] > 127) throw Error(`Generated connector returned an unexpected value for ${action.actionId}.`);
  }
  return [...bytes];
}

/** Real executions, not model statements, determine whether a new connector can be installed. */
export function validateConnector(artifacts: FreshArtifacts, contract: FreshContract): string[] {
  const issues: string[] = [];
  const add = (message: string) => { if (!issues.includes(message)) issues.push(message.slice(0, 220)); };
  let program: ConnectorProgram;
  try { program = new ConnectorProgram(artifacts.connector); } catch (error) { return [(error as Error).message]; }
  if (!contract.portHint || !contract.actions.length || contract.actions.length > 128) return ['Connector needs an exact port hint and 1–128 reviewed actions.'];
  const ids = new Set<string>();
  for (const action of contract.actions) {
    if (ids.has(action.actionId) || !Number.isInteger(action.channel) || action.channel < 1 || action.channel > 16
      || (action.cc === undefined) === (action.program === undefined)
      || !Number.isInteger(action.cc ?? action.program) || (action.cc ?? action.program)! < 0 || (action.cc ?? action.program)! > 127
      || !Number.isInteger(action.min) || !Number.isInteger(action.max) || action.min < 0 || action.max > 127 || action.min > action.max) add(`Invalid reviewed action: ${action.actionId}.`);
    ids.add(action.actionId);
  }
  if (issues.length) return issues;
  try { bind(program, contract.ports, contract.portHint); } catch (error) { add((error as Error).message); }
  // These synthetic routing checks deliberately call Muse's bind implementation too.
  for (const [label, ports] of [
    ['missing', []],
    ['ambiguous', [{ id: '__duplicate-a', name: contract.portHint }, { id: '__duplicate-b', name: contract.portHint }]],
    ['disconnected', [{ id: contract.portHint, name: contract.portHint, state: 'disconnected' }]],
  ] as [string, Port[]][]) {
    try {
      const answer = program.run({ kind: 'bind', ports, hint: contract.portHint });
      if (answer?.portId) add(`Generated bind must refuse a ${label} output.`);
    } catch { /* An explicit refusal is correct. */ }
  }
  for (const action of contract.actions) {
    const values = action.cc === undefined ? [undefined] : [...new Set([action.min, Math.round((action.min + action.max) / 2), action.max])];
    for (const value of values) {
      try { checkedBytes(program.run({ kind: 'encode', actionId: action.actionId, ...(value === undefined ? {} : { value }) }), action, value); }
      catch (error) { add(`${action.actionId}: ${(error as Error).message}`); }
    }
    if (action.cc !== undefined) for (const value of [action.min - 1, action.max + 1]) {
      try { checkedBytes(program.run({ kind: 'encode', actionId: action.actionId, value }), action, value); }
      catch (error) {
        // Either reject invalid input or clamp correctly. Malformed returned packets are never accepted.
        try { program.run({ kind: 'encode', actionId: action.actionId, value }); add(`${action.actionId}: invalid-range input returned an unsafe packet.`); } catch { /* refused */ }
      }
    }
  }
  try { const answer = program.run({ kind: 'encode', actionId: '__unreviewed_action__', value: 64 }); if (answer?.bytes !== undefined) add('Generated encode must refuse an unknown action.'); } catch { /* refused */ }
  const firstSet = contract.actions.find(action => action.cc !== undefined);
  if (firstSet) for (const value of [null, '64', {}, true]) {
    try { const answer = program.run({ kind: 'encode', actionId: firstSet.actionId, value }); if (answer?.bytes !== undefined) add('Generated encode must refuse nonnumeric values.'); } catch { /* refused */ }
  }
  try { const answer = program.run({ kind: '__unknown_kind__' }); if (answer?.bytes !== undefined || answer?.portId) add('Generated connector must refuse an unknown input kind.'); } catch { /* refused */ }
  return issues;
}

interface Entry {
  program: ConnectorProgram; contract: FreshContract; receipt: ConnectorReceipt; executorDeviceId?: string;
}

export class GeneratedConnectorRegistry {
  private readonly entries = new Map<string, Entry>();
  /** Retiring a generated connector cannot silently fall back to an authored encoder. */
  private readonly retired = new Set<string>();
  constructor(private readonly getPorts: (executorDeviceId: string) => Port[]) {}

  install(input: { cardId: string; driverId: string; wiringId: string; executorDeviceId?: string; contract: FreshContract; generated: FreshGenerated }): void {
    this.entries.delete(input.cardId); this.retired.add(input.cardId);
    if (input.contract.cardId !== input.cardId) throw Error('Connector belongs to a different card.');
    const { generated } = input;
    if (generated.source !== 'live' || generated.model !== MODEL || !generated.observedModels.length || generated.observedModels.some(model => model !== MODEL)) throw Error('No verified live Meta model receipt for this connector.');
    if (generated.hashes.connector !== digest(generated.connector) || generated.hashes.gesture !== digest(generated.gesture)) throw Error('Generated files no longer match their checked hashes.');
    const issues = validateConnector(generated, input.contract);
    if (issues.length) throw Error(issues.join(' '));
    const entry: Entry = { program: new ConnectorProgram(generated.connector), contract: structuredClone(input.contract), executorDeviceId: input.executorDeviceId,
      receipt: { cardId: input.cardId, driverId: input.driverId, wiringId: input.wiringId, connectorId: generated.jobId,
        hash: generated.hashes.connector, gestureHash: generated.hashes.gesture, model: generated.model, source: 'live', installedAt: Date.now(), invocationCount: 0 } };
    if (input.executorDeviceId) bind(entry.program, this.getPorts(input.executorDeviceId), entry.contract.portHint);
    this.entries.set(input.cardId, entry); this.retired.delete(input.cardId);
  }

  encode(request: ExecRequest): GeneratedMidi | undefined {
    // Emergency transport behavior is authored infrastructure and never claimed as generated code.
    if (request.op.kind === 'midi' && request.op.msg === 'panic' || request.priorityRelease === true && isNeutralSoftwareRelease(request)) return;
    if (!request.cardId) return;
    const entry = this.entries.get(request.cardId);
    if (!entry) {
      if (this.retired.has(request.cardId)) throw Error('Generated connector was retired; ask Muse again.');
      return;
    }
    if (request.driverId !== entry.receipt.driverId || entry.executorDeviceId && request.executorDeviceId !== entry.executorDeviceId) throw Error('Generated connector no longer owns this driver or executor.');
    if (request.port !== entry.contract.portHint) throw Error('Generated connector request changed its reviewed output.');
    let action = entry.contract.actions.find(a => a.actionId === request.actionId)
      ?? entry.contract.actions.filter(a => request.actionId?.startsWith(a.actionId + ':')).sort((a, b) => b.actionId.length - a.actionId.length)[0];
    if (!action) throw Error('Generated connector received an unreviewed action.');
    const op = request.op;
    // Verification prepares this repo's software instruments under a primary action's
    // server-generated suffix. Encode the actual, separately reviewed catalog action.
    // A primary action or unknown suffix never gets this remapping privilege.
    const suffix = request.actionId?.slice(action.actionId.length + 1);
    const helper = suffix && /^(?:freeze-animation|baseline|probe-(?:release|action|gate|settle)|restore-(?:release|preset|parameter))$/.test(suffix);
    if (helper && op.kind === 'midi' && (op.msg === 'cc' || op.msg === 'pc')) {
      action = entry.contract.actions.find(candidate => candidate.channel === op.channel
        && (op.msg === 'cc' ? candidate.cc === op.number : candidate.program === op.number)) ?? action;
    }
    if (op.kind !== 'midi' || op.channel !== action.channel || op.number !== (action.cc ?? action.program)
      || op.msg !== (action.cc === undefined ? 'pc' : 'cc') || action.cc !== undefined && (!Number.isFinite(op.value) || typeof op.value !== 'number' || op.value < action.min || op.value > action.max)) throw Error('Generated connector request disagrees with the reviewed action.');
    const portId = bind(entry.program, this.getPorts(request.executorDeviceId), entry.contract.portHint);
    const bytes = checkedBytes(entry.program.run({ kind: 'encode', actionId: action.actionId, ...(action.cc === undefined ? {} : { value: op.value }) }), action, typeof op.value === 'number' ? op.value : undefined);
    entry.executorDeviceId ??= request.executorDeviceId;
    entry.receipt.invocationCount++; entry.receipt.lastBytes = bytes; entry.receipt.lastPortId = portId; entry.receipt.lastEncodedAt = Date.now();
    return { connectorId: entry.receipt.connectorId, hash: entry.receipt.hash, bytes, portId };
  }

  clear(cardId?: string): void {
    for (const id of cardId ? [cardId] : this.entries.keys()) {
      if (!this.entries.has(id) && !this.retired.has(id)) continue;
      this.entries.delete(id); this.retired.add(id);
    }
  }
  /** Called only for a newly requested ordinary WIRE, never on Stop or an encoding error. */
  useAuthored(cardId: string): void { this.entries.delete(cardId); this.retired.delete(cardId); }
  receipt(cardId: string): ConnectorReceipt | undefined { const entry = this.entries.get(cardId); return entry ? structuredClone(entry.receipt) : undefined; }
  list(): ConnectorReceipt[] { return [...this.entries.values()].map(entry => structuredClone(entry.receipt)); }
}
