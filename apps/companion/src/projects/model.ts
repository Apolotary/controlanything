import { newId, type ProjectDocument, type ProjectStatePayload, type ProjectCatalogPayload, type PayloadOf } from '@ce/protocol';

export type ProjectCommand = 'project.list' | 'project.get' | 'project.request' | 'project.preset' | 'project.action' | 'project.cancel';
export type ProjectSender = <T extends ProjectCommand>(type: T, payload: PayloadOf<T>) => boolean;
export class ProjectStudio {
  online = false;
  writable = false;
  selectedId?: string;
  catalog: ProjectCatalogPayload['projects'] = [];
  readonly states = new Map<string, ProjectStatePayload>();
  pending?: { requestId: string; projectId?: string; preset?: boolean };
  private readonly ignoredRequests = new Set<string>();
  private readonly waitingToCancel = new Set<string>();
  constructor(private readonly send: ProjectSender, private readonly changed: () => void = () => {}) {}
  get current(): ProjectStatePayload | undefined { return this.selectedId ? this.states.get(this.selectedId) : undefined; }
  get document(): ProjectDocument | undefined { return this.current?.document; }
  connection(online: boolean, writable: boolean): void {
    this.online = online; this.writable = online && writable;
    if (!online) this.pending = undefined;
    if (online) { this.send('project.list', {}); if (this.selectedId) this.send('project.get', { projectId: this.selectedId }); }
    this.changed();
  }
  select(projectId?: string): void {
    if (projectId === this.selectedId && !this.pending) return;
    this.cancel(); this.selectedId = projectId;
    if (projectId && this.online) this.send('project.get', { projectId });
    this.changed();
  }
  receiveCatalog(payload: ProjectCatalogPayload): void { this.catalog = payload.projects; this.changed(); }
  receive(state: ProjectStatePayload): void {
    if (state.requestId && this.ignoredRequests.has(state.requestId)) {
      if (this.waitingToCancel.has(state.requestId) && this.online && this.send('project.cancel', { projectId: state.projectId, requestId: state.requestId })) this.waitingToCancel.delete(state.requestId);
      return;
    }
    const previous = this.states.get(state.projectId);
    if (state.document && previous?.document && state.document.revision < previous.document.revision) return;
    const revision = state.revision ?? state.document?.revision;
    if (!state.document && revision !== undefined && previous?.document?.revision !== revision) return;
    const sameRevision = !state.document || state.document.revision === previous?.document?.revision;
    if (sameRevision && state.sequence !== undefined && previous?.sequence !== undefined && state.sequence < previous.sequence) return;
    this.states.set(state.projectId, { ...previous, ...state, document: state.document ?? previous?.document });
    if (this.pending && this.pending.requestId === state.requestId) {
      this.pending.projectId = state.projectId; this.selectedId = state.projectId;
      if (state.status !== 'generating') this.pending = undefined;
    }
    this.changed();
  }
  request(prompt: string): boolean {
    if (!this.online || !this.writable || this.pending || this.current?.status === 'generating' || !prompt.trim()) return false;
    const requestId = newId('project');
    const previous = this.document;
    this.pending = { requestId, projectId: previous?.projectId };
    if (!this.send('project.request', { requestId, ...(previous ? { projectId: previous.projectId, baseRevision: previous.revision, cardId: previous.cardId } : {}), prompt: prompt.trim() })) { this.pending = undefined; return false; }
    this.changed(); return true;
  }
  createChordDemo(): boolean {
    if (!this.online || !this.writable || this.pending || this.current?.status === 'generating') return false;
    const requestId = newId('preset');
    this.pending = { requestId, preset: true };
    if (!this.send('project.preset', { requestId, presetId: 'chord-garden-v1' })) { this.pending = undefined; return false; }
    this.changed(); return true;
  }
  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    if (!pending.projectId || !this.online || !this.send('project.cancel', { projectId: pending.projectId, requestId: pending.requestId })) this.waitingToCancel.add(pending.requestId);
    this.ignoredRequests.add(pending.requestId);
    while (this.ignoredRequests.size > 64) { const oldest = this.ignoredRequests.values().next().value!; this.ignoredRequests.delete(oldest); this.waitingToCancel.delete(oldest); }
    if (pending.projectId) {
      const previous = this.states.get(pending.projectId);
      if (previous) this.states.set(pending.projectId, { ...previous, status: previous.document ? 'ready' : 'error', requestId: undefined, message: 'Generation cancelled. Your saved project is unchanged.' });
    }
    this.pending = undefined; this.changed();
  }
  action(actionId: string, value?: number): boolean {
    const document = this.document;
    if (!document || !this.online || !this.writable || this.current?.status === 'generating') return false;
    const action = document.spec.actions.find(a => a.id === actionId);
    if (!action || action.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < action.min! || value > action.max!) || action.kind === 'trigger' && value !== undefined) return false;
    return this.send('project.action', { projectId: document.projectId, revision: document.revision, requestId: newId('input'), actionId, ...(value === undefined ? {} : { value }) });
  }
}
