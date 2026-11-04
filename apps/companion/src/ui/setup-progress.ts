import { SetupProgressTracker, type Message, type SetupProgressView } from '@ce/protocol';
import { el } from './dom';

const TYPES = new Set(['agent.step', 'device.card', 'target.status', 'link.request', 'link.result', 'driver.spec', 'driver.status',
  'verify.result', 'ui.partial', 'ui.spec', 'arm.request', 'arm.result', 'control.cancel', 'target.cancel', 'panic', 'tags.state', 'mode.state']);
interface Owner { runId?: string; runAt: number; deviceId?: string; transport?: string; statusSeen: boolean }

/** Shared progress is room-wide; this view only belongs to an explicitly assigned executor. */
export class CompanionSetupProgress {
  private readonly tracker = new SetupProgressTracker();
  private readonly owners = new Map<string, Owner>();
  private mode = 'control';

  constructor(private readonly context: () => { deviceId?: string; local: boolean; replay: boolean }) {}

  update(message: Message): boolean {
    if (message.from !== 'server' || !TYPES.has(message.type)) return false;
    this.tracker.update(message);
    if (message.type === 'mode.state') this.mode = message.payload.mode;
    if (message.type === 'tags.state') {
      const present = new Set(message.payload.tags.map((tag) => tag.cardId));
      for (const id of this.owners.keys()) if (!present.has(id)) { this.owners.delete(id); this.tracker.clear(id); }
    }
    const payload = message.payload as { cardId?: string; runId?: string };
    if (!payload.cardId) return true;
    const view = this.tracker.get(payload.cardId);
    if (!view || payload.runId && view.runId !== payload.runId) return true;
    let owner = this.owners.get(payload.cardId);
    if (!owner || view.runId && view.runId !== owner.runId) owner = { runId: view.runId, runAt: message.ts, statusSeen: false };
    if (message.ts < owner.runAt) return true;
    if (message.type === 'target.status') {
      owner.statusSeen = true;
      if (message.payload.executorDeviceId) owner.deviceId = message.payload.executorDeviceId;
    } else if (message.type === 'driver.spec') {
      if (!owner.statusSeen) owner.deviceId = message.payload.executor.deviceId;
      owner.transport = message.payload.transport;
    } else if (message.type === 'link.result') {
      if (!owner.deviceId) owner.deviceId = message.payload.executorDeviceId;
      owner.transport = message.payload.channel;
    }
    this.owners.delete(payload.cardId);
    this.owners.set(payload.cardId, owner);
    while (this.owners.size > 64) this.owners.delete(this.owners.keys().next().value!);
    return true;
  }

  /** The room mode once it has settled (the workbench holds back a mode that flips straight back). */
  setMode(mode: string): void { this.mode = mode; }

  get(): SetupProgressView | undefined {
    if (this.mode === 'annotate') return;
    const context = this.context();
    const relevant = [...this.owners.entries()].reverse().filter(([, owner]) => context.replay || !!context.deviceId
      && (owner.deviceId === context.deviceId || context.local && owner.deviceId === 'mac-local' && owner.transport === 'local'));
    const views = relevant.flatMap(([id]) => { const view = this.tracker.get(id); return view ? [view] : []; });
    const view = views.find((candidate) => candidate.working) ?? views[0];
    return view && context.replay ? { ...view, source: 'Recorded demo · no device commands',
      facts: view.facts.map((fact) => fact.replace(/(^|:\s*)Live(?=\s*·|$)/g, '$1Recorded')) } : view;
  }

  clear(cardId?: string): void {
    this.tracker.clear(cardId);
    if (cardId) this.owners.delete(cardId);
    else this.owners.clear();
  }
  disconnect(): void { this.tracker.disconnect(); }
}

/** Stable text-only workspace. No timers, animated typing, arbitrary HTML or action execution. */
export class SetupProgressPanel {
  private previous = '';
  constructor(private readonly host: HTMLElement) {}

  render(view?: SetupProgressView): void {
    if (this.host.hidden !== !view) this.host.hidden = !view;
    const key = JSON.stringify(view) ?? '';
    if (key === this.previous) return;
    this.previous = key;
    if (!view) { this.host.replaceChildren(); return; }
    const id = (suffix: string) => `${this.host.id}-${suffix}`;
    this.host.dataset.cardId = view.cardId;
    this.host.dataset.state = view.working ? 'working' : 'settled';
    this.host.setAttribute('aria-labelledby', id('title'));
    const title = el('h2', { id: id('title'), text: view.title });
    const source = el('span', { id: id('source'), className: 'setup-source', text: view.source ?? 'Source not reported' });
    const detail = el('p', { id: id('detail'), className: 'setup-detail', text: view.detail });
    detail.setAttribute('role', 'status');
    detail.setAttribute('aria-live', 'polite');
    const stages = el('ol', { id: id('stages'), className: 'setup-stages' });
    stages.setAttribute('aria-label', 'Setup stages');
    for (const [index, stage] of view.stages.entries()) {
      const marker = el('span', { className: 'setup-stage-marker', text: stage.status === 'done' ? '✓' : stage.status === 'failed' ? '!' : String(index + 1) });
      marker.setAttribute('aria-hidden', 'true');
      const item = el('li', { data: { status: stage.status, stage: stage.id } }, marker, el('span', { text: stage.label }));
      item.setAttribute('aria-label', `${stage.label}: ${stage.status}`);
      if (stage.status === 'active') item.setAttribute('aria-current', 'step');
      stages.append(item);
    }
    const artifactLabel = el('h3', { id: id('artifact-label'), text: !view.artifact ? 'Generated definitions'
      : /driver/i.test(view.artifact.label) ? 'Generated driver' : 'Generated interface' });
    const code = el('code', { id: id('code'), text: view.artifact?.code ?? '' });
    const preview = el('pre', { className: 'setup-code' }, code);
    preview.tabIndex = 0;
    preview.setAttribute('aria-labelledby', id('artifact-label'));
    preview.hidden = !view.artifact;
    const empty = el('p', { className: 'setup-artifact-empty', text: 'The definitions will appear here when Muse has generated them.' });
    empty.hidden = !!view.artifact;
    const artifact = el('div', { className: 'setup-artifact' },
      el('div', { className: 'setup-artifact-top' }, artifactLabel, el('span', { className: 'setup-filetype', text: 'JSON' })), preview, empty,
      el('p', { className: 'setup-artifact-note', text: 'A preview of the command and interface definitions Muse prepared.' }));
    const facts = el('ul', { id: id('facts'), className: 'setup-facts' }, ...view.facts.map((fact) => el('li', { text: fact })));
    const evidence = el('aside', { className: 'setup-evidence' }, el('h3', { text: 'What Muse has established' }), facts);
    evidence.hidden = !view.facts.length;
    this.host.replaceChildren(
      el('header', { className: 'setup-workspace-header' }, el('div', {}, el('p', { className: 'setup-eyebrow', text: 'MUSE · SETUP WORKSPACE' }), title), source),
      detail, stages, el('div', { className: 'setup-workspace-body', data: { facts: String(!!view.facts.length) } }, artifact, evidence),
    );
  }
}
