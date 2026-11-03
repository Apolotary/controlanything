import type { Message } from './messages';
import type { AgentPhase } from './payloads';
import type { TargetState } from './primitives';

export type SetupStageId = 'connect' | 'learn' | 'driver' | 'check' | 'interface' | 'enable';
export type SetupStageStatus = 'pending' | 'active' | 'done' | 'failed';
export interface SetupProgressView {
  cardId: string;
  runId?: string;
  title: string;
  detail: string;
  stages: Array<{ id: SetupStageId; label: string; status: SetupStageStatus }>;
  artifact?: { label: string; code: string };
  facts: string[];
  source?: string;
  working: boolean;
}

const STAGES: ReadonlyArray<readonly [SetupStageId, string]> = [
  ['connect', 'Connect'], ['learn', 'Learn device'], ['driver', 'Write commands'],
  ['check', 'Check effects'], ['interface', 'Build controls'], ['enable', 'Enable'],
];
const MAX_CARDS = 64;
export const SETUP_ARTIFACT_MAX_CHARS = 2400;
const short = (value: string | undefined, max = 240): string => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const phaseStage: Partial<Record<AgentPhase, SetupStageId>> = {
  identify: 'connect', link: 'connect', research: 'learn', plan: 'learn', drive: 'driver', codegen: 'driver',
  verify: 'check', forge: 'interface', ui: 'interface', arm: 'enable', deploy: 'enable',
};
const stateStage: Partial<Record<TargetState, SetupStageId>> = {
  identifying: 'connect', identified: 'connect', linking: 'connect', 'needs-companion': 'connect', linked: 'connect',
  researching: 'learn', driving: 'driver', verifying: 'check', verified: 'check', forging: 'interface',
  forged: 'enable', arming: 'enable', armed: 'enable', controlling: 'enable',
};
interface Entry {
  view: SetupProgressView;
  stage: SetupStageId;
  runAt: number;
  statusAt: number;
  seenAt: number;
  retired: Set<string>;
  retiredDrivers: Set<string>;
  retiredSpecs: Set<string>;
  retiredArms: Set<string>;
  clocks: Map<string, number>;
  facts: Map<string, string>;
  sources: Map<SetupStageId, string>;
  verification: Map<string, string>;
  actionIds?: Set<string>;
  driverId?: string;
  specId?: string;
  armId?: string;
  partialSeq: number;
  revision: number;
  stopped: boolean;
  disconnected: boolean;
}
function entry(cardId: string, runId?: string, at = -Infinity): Entry {
  return { view: { cardId, ...(runId ? { runId } : {}), title: 'Preparing device setup', detail: '',
    stages: STAGES.map(([id, label]) => ({ id, label, status: 'pending' })), facts: [], working: false },
  stage: 'connect', runAt: at, statusAt: -Infinity, seenAt: at, retired: new Set(), retiredDrivers: new Set(), retiredSpecs: new Set(), retiredArms: new Set(), clocks: new Map(),
  facts: new Map(), sources: new Map(), verification: new Map(), partialSeq: -1, revision: 0, stopped: false, disconnected: false };
}

/** A bounded projection of received declarative data, always valid JSON, never invented executable code. */
function artifact(value: Record<string, unknown>): string {
  const project = (item: unknown, width: number, depth = 0): unknown => {
    if (typeof item === 'string') return item.slice(0, width * 20);
    if (Array.isArray(item)) return item.slice(0, width).map(value => project(value, width, depth + 1));
    if (item && typeof item === 'object') return depth > 5 ? undefined : Object.fromEntries(Object.entries(item)
      .filter(([, value]) => value !== undefined).slice(0, width * 2).map(([key, value]) => [key, project(value, width, depth + 1)]));
    return item;
  };
  for (const width of [6, 3, 1]) {
    const code = JSON.stringify(project(value, width), null, 2);
    if (code.length <= SETUP_ARTIFACT_MAX_CHARS) return code;
  }
  return '{}';
}

/** Event-driven setup presentation. Callers supply trusted server messages, plus their own cancel intent. */
export class SetupProgressTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly removed = new Map<string, { runId?: string; at: number }>();

  get(cardId: string): SetupProgressView | undefined {
    const current = this.entries.get(cardId);
    return current ? structuredClone(current.view) : undefined;
  }

  clear(cardId?: string): void {
    const cards = cardId ? [cardId] : [...this.entries.keys()];
    for (const id of cards) {
      const current = this.entries.get(id);
      this.removed.set(id, { runId: current?.view.runId, at: current?.seenAt ?? -Infinity });
      this.entries.delete(id);
    }
    while (this.removed.size > MAX_CARDS) this.removed.delete(this.removed.keys().next().value!);
  }

  disconnect(): void {
    for (const current of this.entries.values()) {
      this.stop(current, 'Connection lost', 'Waiting for the server. Received results are retained; control is not confirmed online.');
      current.disconnected = true;
    }
  }

  update(message: Message): void {
    if (message.type === 'panic') {
      for (const current of this.entries.values()) if (!message.payload.cardId || current.view.cardId === message.payload.cardId) {
        this.stop(current, 'Controls stopped', message.payload.reason ?? 'Choose Set up control to enable this device again.');
        this.stage(current, 'enable', 'pending');
      }
      return;
    }
    const payload = message.payload;
    const cardId = 'cardId' in payload && typeof payload.cardId === 'string' ? payload.cardId : undefined;
    if (!cardId) return;
    const supported = ['target.status', 'agent.step', 'driver.spec', 'driver.status', 'link.result', 'verify.result',
      'ui.partial', 'ui.spec', 'arm.request', 'arm.result', 'control.cancel', 'target.cancel', 'tag.remove'];
    if (!supported.includes(message.type)) return;
    if (message.type === 'tag.remove') { this.clear(cardId); return; }
    const runId = 'runId' in payload && typeof payload.runId === 'string' ? payload.runId : undefined;
    const at = Number.isFinite(message.ts) ? message.ts : -Infinity;
    const tombstone = this.removed.get(cardId);
    if (tombstone) {
      if (message.type !== 'target.status' || !runId || runId === tombstone.runId || at < tombstone.at) return;
      this.removed.delete(cardId);
    }
    let current = this.entries.get(cardId);
    if (current && message.type === 'target.status') {
      if (current.retired.has(runId ?? '') || message.payload.since < current.statusAt) return;
      if (runId && current.view.runId && runId !== current.view.runId) {
        const previous = current;
        const reenable = ['arming', 'forged', 'armed', 'controlling'].includes(message.payload.state)
          && !!message.payload.driverId && message.payload.driverId === previous.driverId
          && !!message.payload.specId && message.payload.specId === previous.specId;
        const retired = new Set(current.retired); retired.add(current.view.runId);
        const retiredDrivers = new Set(current.retiredDrivers), retiredSpecs = new Set(current.retiredSpecs);
        const retiredArms = new Set(current.retiredArms); if (current.armId) retiredArms.add(current.armId);
        if (!reenable && current.driverId) retiredDrivers.add(current.driverId);
        if (!reenable && current.specId) retiredSpecs.add(current.specId);
        while (retired.size > 16) retired.delete(retired.values().next().value!);
        for (const ids of [retiredDrivers, retiredSpecs, retiredArms]) while (ids.size > 16) ids.delete(ids.values().next().value!);
        current = entry(cardId, runId, at); current.retired = retired; current.retiredDrivers = retiredDrivers; current.retiredSpecs = retiredSpecs; current.retiredArms = retiredArms;
        if (reenable) {
          current.view.artifact = previous.view.artifact; current.view.stages = structuredClone(previous.view.stages);
          current.facts = new Map(previous.facts); current.verification = new Map(previous.verification); current.sources = new Map(previous.sources);
          current.actionIds = previous.actionIds ? new Set(previous.actionIds) : undefined;
          current.sources.set('enable', 'Reused setup · original driver and interface');
          current.driverId = previous.driverId; current.specId = previous.specId; current.revision = previous.revision;
        }
        this.entries.set(cardId, current);
      }
      if (current.disconnected) { current.disconnected = false; current.stopped = false; }
    }
    if (!current) {
      // A cancellation without prior setup has nothing to present.
      if (message.type === 'control.cancel' || message.type === 'target.cancel') return;
      current = entry(cardId, runId, at); this.entries.set(cardId, current);
      while (this.entries.size > MAX_CARDS) this.entries.delete(this.entries.keys().next().value!);
    }
    if (runId && current.view.runId && runId !== current.view.runId) return;
    if (runId && !current.view.runId) { current.view.runId = runId; current.runAt = at; }
    if (at < current.runAt) return;
    const driverId = 'driverId' in payload && typeof payload.driverId === 'string' ? payload.driverId : undefined;
    const specId = 'specId' in payload && typeof payload.specId === 'string' ? payload.specId : undefined;
    if ((message.type === 'arm.result' || message.type === 'arm.request') && current.retiredArms.has(message.payload.armId)) return;
    if (message.type !== 'target.status' && (driverId && current.retiredDrivers.has(driverId) || specId && current.retiredSpecs.has(specId))) return;
    if (message.type !== 'target.status' && driverId && current.driverId && driverId !== current.driverId) return;
    if (message.type !== 'target.status' && specId && current.specId && specId !== current.specId) return;
    const clockKey = message.type === 'agent.step' ? `step:${message.payload.stepId}` : message.type;
    if (at < (current.clocks.get(clockKey) ?? -Infinity)) return;
    current.clocks.set(clockKey, at); current.seenAt = Math.max(current.seenAt, at);
    while (current.clocks.size > 128) current.clocks.delete(current.clocks.keys().next().value!);
    if (message.type === 'control.cancel' || message.type === 'target.cancel') {
      this.stop(current, 'Setup cancelled', 'No further setup progress is accepted until a new attempt.'); return;
    }
    if (current.stopped && message.type !== 'target.status') return;
    if (current.stopped && !current.disconnected && message.type === 'target.status' && message.payload.state !== 'failed') return;

    switch (message.type) {
      case 'target.status': {
        const p = message.payload; current.statusAt = p.since;
        if (p.driverId) current.driverId = p.driverId;
        if (p.specId) current.specId = p.specId;
        const stage = stateStage[p.state];
        if (p.state === 'failed') { this.stop(current, /cancel/i.test(`${p.sentence} ${p.detail}`) ? 'Setup cancelled' : 'Setup stopped', p.hint ?? p.detail ?? p.sentence); break; }
        if (!stage) break;
        this.activate(current, stage);
        current.view.detail = short(p.hint ?? p.detail);
        if (p.state === 'needs-companion') { current.view.title = 'Waiting for a connection'; current.view.working = false; }
        if (p.state === 'linked') { this.stage(current, 'connect', 'done'); current.view.title = 'Connection found'; current.view.working = false; }
        if (p.state === 'verified') { this.stage(current, 'check', 'done'); current.view.title = 'Device checks completed'; current.view.working = false; }
        if (p.state === 'forged' || p.state === 'arming') {
          this.stage(current, 'interface', 'done'); current.view.title = 'Waiting for Enable'; current.view.working = false;
          current.view.detail = 'The interface is ready. Confirm in the headset before control starts.';
        }
        if (p.state === 'armed' || p.state === 'controlling') this.enabled(current);
        break;
      }
      case 'agent.step': {
        const p = message.payload, stage = phaseStage[p.phase]; if (!stage) break;
        this.source(current, p.source, p.model, p.recordedFrom, `${p.title} ${p.evidence ?? ''} ${p.detail ?? ''}`, stage);
        const foreground = STAGES.findIndex(([id]) => id === stage) >= STAGES.findIndex(([id]) => id === current!.stage);
        if (p.status === 'running' && foreground) { this.activate(current, stage); current.view.detail = short(p.detail ?? p.title); }
        if (p.status === 'ok' && (stage === 'connect' || stage === 'learn')) this.stage(current, stage, 'done');
        // Attempt failures, skin failures and proof notes are not a failed setup or a completed stage.
        if (p.evidence) this.fact(current, 'step', p.evidence);
        else if (p.status === 'fail') this.fact(current, 'step', `${p.title}: a step did not complete`);
        break;
      }
      case 'link.result': {
        const p = message.payload;
        if (p.verdict === 'confirmed' || p.verdict === 'consistent') this.stage(current, 'connect', 'done');
        this.fact(current, 'connection', p.verdict === 'confirmed' ? `Connection confirmed${p.port ? `: ${p.port.name}` : ''}`
          : p.verdict === 'consistent' ? `Port matched${p.port ? `: ${p.port.name}` : ''}; device effects still need checking`
            : p.reason ?? `Connection: ${p.verdict}`);
        break;
      }
      case 'driver.spec': {
        const p = message.payload; current.driverId = p.driverId;
        current.actionIds = new Set(p.actions.map(action => action.actionId));
        for (const id of current.verification.keys()) if (!current.actionIds.has(id)) current.verification.delete(id);
        for (const action of p.actions) current.verification.set(action.actionId, action.verified ?? current.verification.get(action.actionId) ?? 'untested');
        this.stage(current, 'driver', 'done'); this.source(current, p.source, p.modelId, undefined, p.provenance.map(value => `${value.source} ${value.ref}`).join(' '), 'driver');
        current.view.source = current.sources.get('driver');
        current.view.artifact = { label: 'Declarative driver JSON', code: artifact({ transport: p.transport,
          actions: p.actions.slice(0, 3).map(action => ({ label: action.label, encode: action.encode, expect: action.expect, actionId: action.actionId })), actionCount: p.actions.length }) };
        this.fact(current, 'driver', `${p.actions.length} command definitions ready`);
        if (this.foreground(current, 'driver')) {
          this.activate(current, 'driver'); this.stage(current, 'driver', 'done'); current.view.working = false;
          current.view.title = 'Commands prepared'; current.view.detail = `${p.actions.length} declarative commands received. Device response checks come next.`;
        }
        break;
      }
      case 'driver.status': {
        const p = message.payload; current.driverId ??= p.driverId;
        if (p.actions && !current.actionIds) current.actionIds = new Set(p.actions.map(action => action.actionId));
        for (const action of p.actions ?? []) if (current.actionIds?.has(action.actionId)) current.verification.set(action.actionId, action.verified);
        this.checkFact(current);
        if (p.phase === 'verifying' && this.foreground(current, 'check')) {
          this.activate(current, 'check'); current.view.detail = short(p.detail ?? 'Checking the prepared commands against the device response.');
        }
        if (p.phase === 'verified') {
          if (this.foreground(current, 'check')) {
            this.activate(current, 'check'); current.view.title = 'Device checks completed'; current.view.working = false;
            current.view.detail = current.facts.get('check') ?? 'The server reported verification results. Enable is still separate.';
          }
          this.stage(current, 'check', 'done');
        }
        if (p.phase === 'disarmed') { this.stage(current, 'enable', 'pending'); current.view.working = false; current.view.title = 'Controls are not enabled'; }
        break;
      }
      case 'verify.result': {
        const p = message.payload; current.driverId ??= p.driverId;
        if (current.actionIds?.has(p.actionId)) current.verification.set(p.actionId, p.pass ? 'pass' : 'fail');
        this.checkFact(current);
        this.fact(current, 'evidence', p.observed.sense === 'ack' ? `${p.actionId}: executor acknowledgement; no camera or audio proof`
          : `${p.actionId}: ${p.observed.sense} ${p.pass ? 'check passed' : 'check did not pass'}${p.observed.note ? ` · ${p.observed.note}` : ''}`);
        break;
      }
      case 'ui.partial': {
        const p = message.payload; if (p.seq <= current.partialSeq || current.revision > 0) break;
        current.partialSeq = p.seq; current.specId ??= p.specId;
        if (current.view.stages.find(stage => stage.id === 'interface')!.status !== 'done' && this.foreground(current, 'interface')) {
          this.activate(current, 'interface'); current.view.detail = 'An interface component arrived. Waiting for the complete controls.';
        }
        current.view.artifact = { label: 'Control interface arriving · JSON', code: artifact({ control: p.control, hack: p.hack, specId: p.specId }) };
        this.fact(current, 'interface', 'An interface component arrived; complete controls and Enable are still separate steps');
        break;
      }
      case 'ui.spec': {
        const p = message.payload; if ((p.rev ?? 1) < current.revision) break;
        current.revision = p.rev ?? 1; current.specId = p.specId; current.driverId ??= p.driverId;
        this.stage(current, 'interface', 'done'); this.source(current, p.source, p.modelId, p.recordedFrom, '', 'interface');
        current.view.source = current.sources.get('interface');
        const controls = p.gen3d?.controls ?? p.widgets ?? [];
        const hacks = p.hackset?.hacks ?? [];
        const definitions = controls.length ? { controls: controls.slice(0, 4).map(control => ({ label: control.label, kind: control.kind, binding: control.binding, id: control.id })) }
          : { hacks: hacks.slice(0, 4).map(hack => ({ name: hack.name, control: hack.control, commands: hack.commands, id: hack.id })) };
        const count = controls.length || hacks.length;
        current.view.artifact = { label: 'Control interface JSON', code: artifact({
          ...definitions, controlCount: count, specId: p.specId, rev: p.rev }) };
        this.fact(current, 'interface', `${count} controls received`);
        if (this.foreground(current, 'interface')) {
          this.activate(current, 'interface'); this.stage(current, 'interface', 'done'); current.view.working = false;
          current.view.title = 'Interface ready'; current.view.detail = 'The controls have arrived. Confirm Enable in the headset before device output starts.';
        }
        break;
      }
      case 'arm.request': {
        const p = message.payload; current.armId = p.armId; current.driverId ??= p.driverId; current.specId ??= p.specId;
        this.activate(current, 'enable'); current.view.title = 'Waiting for Enable'; current.view.detail = short(p.summary); break;
      }
      case 'arm.result': {
        const p = message.payload; if (current.armId && p.armId !== current.armId) break;
        current.driverId ??= p.driverId;
        if (p.armed) this.enabled(current);
        else { this.stage(current, 'enable', 'pending'); current.view.working = false; current.view.title = 'Controls are not enabled'; current.view.detail = short(p.reason ?? 'Enable was declined or expired.'); }
        break;
      }
    }
    this.refreshFacts(current);
  }

  private stage(current: Entry, id: SetupStageId, status: SetupStageStatus): void { current.view.stages.find(stage => stage.id === id)!.status = status; }
  private foreground(current: Entry, id: SetupStageId): boolean {
    return current.view.stages.find(stage => stage.id === 'enable')!.status !== 'done'
      && STAGES.findIndex(([stage]) => stage === current.stage) <= STAGES.findIndex(([stage]) => stage === id);
  }
  private activate(current: Entry, id: SetupStageId): void {
    for (const stage of current.view.stages) if (stage.status === 'active' && stage.id !== id) stage.status = 'pending';
    current.stage = id; this.stage(current, id, 'active'); current.view.working = id !== 'enable';
    const stageSource = current.sources.get(id);
    // While checking or awaiting consent, keep the displayed artifact's origin visible.
    // Starting a new generation stage still needs its own source before claiming reuse/live work.
    current.view.source = stageSource ?? (id === 'check' ? current.sources.get('driver')
      : id === 'enable' ? current.sources.get('interface') ?? current.sources.get('driver') : undefined);
    const stored = stageSource?.startsWith('Fixture') || stageSource?.startsWith('Curated') || stageSource?.startsWith('Reused');
    current.view.title = id === 'connect' ? 'Connecting to the device' : id === 'learn' ? 'Learning how this device works'
      : id === 'driver' ? stored ? 'Loading stored device commands' : stageSource?.startsWith('Live') ? 'Muse is writing device commands' : 'Preparing device commands'
        : id === 'check' ? 'Checking the device response' : id === 'interface' ? stored ? 'Loading the control interface' : stageSource?.startsWith('Live') ? 'Muse is building the controls' : 'Building the controls' : 'Waiting for Enable';
  }
  private enabled(current: Entry): void {
    current.stage = 'enable';
    for (const stage of current.view.stages) if (stage.status === 'active' && stage.id !== 'enable') stage.status = 'pending';
    this.stage(current, 'enable', 'done'); current.view.working = false; current.view.title = 'Controls enabled';
    current.view.detail = 'Verified controls are enabled. Choose Perform to use your hands.';
    this.fact(current, 'enabled', 'Enable confirmed by the server');
  }
  private stop(current: Entry, title: string, detail?: string): void {
    for (const stage of current.view.stages) if (stage.status === 'active') stage.status = 'failed';
    current.stopped = true; current.view.working = false; current.view.title = title; current.view.detail = short(detail);
  }
  private fact(current: Entry, key: string, value: string): void { current.facts.set(key, short(value, 160)); }
  private checkFact(current: Entry): void {
    if (!current.verification.size) return;
    const passed = [...current.verification.values()].filter(value => value === 'pass').length;
    this.fact(current, 'check', `${passed}/${current.verification.size} commands verified`);
  }
  private source(current: Entry, source?: string, model?: string, recordedFrom?: string, provenance = '', stage = current.stage): void {
    const reused = /\b(reused|cached|saved|stored)\b/i.test(provenance);
    const label = model === 'template' ? 'Curated template · no model generation'
      : reused ? short(`Reused knowledge${model ? ` · ${model}` : ''}`, 160)
        : source ? short(`${source === 'fixture' ? 'Fixture' : 'Live'}${recordedFrom ? ` · recorded from ${recordedFrom}` : model ? ` · ${model}` : ''}`, 160) : undefined;
    if (label) { current.sources.set(stage, label); this.fact(current, `source:${stage}`, `${STAGES.find(([id]) => id === stage)![1]}: ${label}`); }
    if (stage === current.stage && label) current.view.source = label;
  }
  private refreshFacts(current: Entry): void {
    current.view.facts = ['check', 'evidence', 'driver', 'interface', 'connection', 'enabled', 'source:learn', 'source:driver', 'source:interface', 'step']
      .flatMap(key => current.facts.get(key) ? [current.facts.get(key)!] : []).slice(0, 5);
  }
}
