import { newId, type CanvasStatePayload, type Message, type PayloadOf, type TaggedDevice } from '@ce/protocol';
import { button, el } from './dom';

export type CanvasCommandType = 'canvas.request' | 'canvas.get' | 'canvas.cancel' | 'canvas.restore' | 'canvas.action';
export type CanvasSender = <T extends CanvasCommandType>(type: T, payload: PayloadOf<T>) => boolean;
export interface CanvasView {
  tags: TaggedDevice[];
  selected?: TaggedDevice;
  state?: CanvasStatePayload;
  draft: string;
  online: boolean;
  writable: boolean;
  pending: boolean;
  cancellable: boolean;
  message?: string;
}

/** Room-scoped software games. Hardware routing, permissions and executors are deliberately separate. */
export class CompanionCanvas {
  private tags: TaggedDevice[] = [];
  private selectedId?: string;
  private readonly states = new Map<string, { state: CanvasStatePayload; at: number }>();
  private readonly drafts = new Map<string, string>();
  private readonly pending = new Map<string, { id: string; type: CanvasCommandType }>();
  private readonly errors = new Map<string, string>();
  private online = false;
  private writable = false;

  constructor(private readonly send: CanvasSender, private readonly changed: () => void = () => {}) {}

  setTags(tags: TaggedDevice[]): void {
    this.tags = tags.slice(0, 64).map((tag) => ({ ...tag }));
    const ids = new Set(this.tags.map((tag) => tag.cardId));
    for (const map of [this.states, this.drafts, this.pending, this.errors]) {
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    }
    if (!this.selectedId || !ids.has(this.selectedId)) {
      this.selectedId = this.tags[0]?.cardId;
      this.refresh();
    }
    this.changed();
  }

  connection(online: boolean, writable: boolean): void {
    const wasOnline = this.online;
    const wasWritable = this.writable;
    this.online = online;
    this.writable = online && writable;
    if (!online) this.pending.clear();
    if (online && (!wasOnline || this.writable && !wasWritable)) this.refresh();
    this.changed();
  }

  select(cardId: string): void {
    if (!this.tags.some((tag) => tag.cardId === cardId) || this.selectedId === cardId) return;
    this.selectedId = cardId;
    this.refresh();
    this.changed();
  }

  setDraft(value: string): void {
    if (!this.selectedId) return;
    this.drafts.set(this.selectedId, value.slice(0, 1000));
    this.changed();
  }

  receive(message: Message): boolean {
    if (message.type !== 'canvas.state' || message.from !== 'server') return false;
    const next = message.payload;
    if (!this.tags.some((tag) => tag.cardId === next.cardId)) return false;
    if (next.document && next.document.cardId !== next.cardId) return false;
    const previous = this.states.get(next.cardId);
    if (previous && (message.ts < previous.at || next.document && previous.state.document
      && next.document.revision < previous.state.document.revision)) return false;
    const state = next.status !== 'ready' && !next.document && previous?.state.document
      ? { ...next, document: previous.state.document, game: previous.state.game } : next;
    this.states.set(next.cardId, { state: structuredClone(state), at: message.ts });
    const pending = this.pending.get(next.cardId);
    if (next.status !== 'generating' && pending && next.requestId === pending.id) {
      if (next.status === 'ready' && pending.type === 'canvas.request') this.drafts.delete(next.cardId);
      this.pending.delete(next.cardId);
    }
    this.errors.delete(next.cardId);
    while (this.states.size > 64) this.states.delete(this.states.keys().next().value!);
    this.changed();
    return true;
  }

  view(): CanvasView {
    const selected = this.tags.find((tag) => tag.cardId === this.selectedId);
    const pending = selected && this.pending.get(selected.cardId);
    const state = selected ? this.states.get(selected.cardId)?.state : undefined;
    return { tags: this.tags, selected, state,
      draft: selected ? this.drafts.get(selected.cardId) ?? '' : '', online: this.online, writable: this.writable,
      pending: !!pending, cancellable: this.writable && pending?.type === 'canvas.request',
      message: selected ? this.errors.get(selected.cardId) : undefined };
  }

  create(): boolean {
    const view = this.view();
    const prompt = view.draft.trim();
    if (!prompt || !this.canMutate(view)) return false;
    return this.dispatch('canvas.request', { requestId: newId('canvas'), cardId: view.selected!.cardId,
      prompt, ...(view.state?.document ? { baseRevision: view.state.document.revision } : {}) });
  }

  restorePrevious(): boolean {
    const view = this.view();
    const doc = view.state?.document;
    const previous = doc?.history.filter((entry) => entry.revision < doc.revision).sort((a, b) => b.revision - a.revision)[0];
    if (!this.canMutate(view) || !doc || !previous) return false;
    return this.dispatch('canvas.restore', { requestId: newId('canvas'), cardId: doc.cardId, revision: previous.revision, baseRevision: doc.revision });
  }

  action(action: PayloadOf<'canvas.action'>['action'], choiceId?: string): boolean {
    const view = this.view();
    const doc = view.state?.document;
    const game = view.state?.game;
    if (!this.canMutate(view) || !doc || !game) return false;
    const round = doc.spec.rounds[game.roundIndex];
    if (action === 'play' && game.phase !== 'preview' || action === 'choose' && (game.phase !== 'playing' || !round?.choices.some((choice) => choice.id === choiceId))
      || action === 'next' && game.phase !== 'feedback') return false;
    return this.dispatch('canvas.action', { requestId: newId('canvas'), cardId: doc.cardId, revision: doc.revision, action,
      ...(action === 'choose' || action === 'next' ? { roundId: round!.id } : {}), ...(action === 'choose' ? { choiceId } : {}) });
  }

  cancel(): boolean {
    const view = this.view();
    const pending = view.selected && this.pending.get(view.selected.cardId);
    const requestId = pending?.type === 'canvas.request' ? pending.id : undefined;
    if (!view.writable || !view.selected || !requestId || !view.cancellable) return false;
    return this.dispatch('canvas.cancel', { requestId, cardId: view.selected.cardId });
  }

  private canMutate(view: CanvasView): boolean { return !!view.selected && view.writable && !view.pending && view.state?.status !== 'generating'; }
  private refresh(): void { if (this.online && this.writable && this.selectedId) this.send('canvas.get', { cardId: this.selectedId }); }
  private dispatch<T extends Exclude<CanvasCommandType, 'canvas.get'>>(type: T, payload: PayloadOf<T>): boolean {
    if (!this.send(type, payload)) {
      this.errors.set(payload.cardId, 'Could not send. Reconnect and try again.');
      this.changed();
      return false;
    }
    this.pending.set(payload.cardId, { id: payload.requestId, type });
    this.errors.delete(payload.cardId);
    this.changed();
    return true;
  }
}

/** A playable card, rendered only when state changes. All model text remains plain DOM text. */
export class CanvasPanel {
  private readonly body = el('div', { id: 'canvas-body', className: 'canvas-body' });
  private readonly toggle: HTMLButtonElement;
  private expanded = false;
  private readonly revealedGames = new Set<string>();
  private readonly selector = el('select', { id: 'canvas-object' });
  private readonly prompt = el('textarea', { id: 'canvas-prompt' });
  private readonly submit: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly restore: HTMLButtonElement;
  private readonly status = el('p', { id: 'canvas-status', className: 'canvas-status' });
  private readonly source = el('span', { id: 'canvas-source', className: 'setup-source' });
  private readonly preview = el('div', { id: 'canvas-preview', className: 'canvas-preview' });
  private readonly hint = el('p', { id: 'canvas-hint', className: 'small dim' });
  private objectsKey = '';
  private previewKey = '';

  constructor(private readonly host: HTMLElement, private readonly model: CompanionCanvas) {
    this.toggle = button('Open Canvas', () => { this.expanded = !this.expanded; this.showBody(); });
    this.toggle.id = 'canvas-toggle';
    this.toggle.setAttribute('aria-controls', this.body.id);
    this.selector.setAttribute('aria-label', 'Canvas object');
    this.selector.addEventListener('change', () => model.select(this.selector.value));
    this.prompt.maxLength = 1000;
    this.prompt.rows = 3;
    this.prompt.addEventListener('input', () => model.setDraft(this.prompt.value));
    const promptLabel = el('label', { text: 'Describe your game or a change' });
    promptLabel.htmlFor = this.prompt.id;
    const form = el('form', { id: 'canvas-form', className: 'canvas-editor' });
    form.addEventListener('submit', (event) => { event.preventDefault(); model.create(); });
    this.submit = button('Create game', () => {} , 'primary');
    this.submit.id = 'canvas-submit';
    this.submit.type = 'submit';
    this.cancel = button('Cancel', () => { model.cancel(); });
    this.cancel.id = 'canvas-cancel';
    this.restore = button('Revert to previous revision', () => { model.restorePrevious(); }, 'ghost');
    this.restore.id = 'canvas-restore';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.preview.setAttribute('aria-label', 'Playable game');
    const objectLabel = el('label', { className: 'canvas-object-label', text: 'Tagged object' }, this.selector);
    form.append(promptLabel, this.prompt, el('div', { className: 'row' }, this.submit, this.cancel), this.status);
    host.setAttribute('aria-labelledby', 'canvas-title');
    this.body.append(objectLabel, this.hint, this.preview, form, this.restore);
    host.replaceChildren(el('header', {}, el('div', {}, el('h2', { id: 'canvas-title', text: 'Object games' }),
      el('p', { className: 'small dim', text: 'Make a game for a tagged object.' })), el('div', { className: 'row' }, this.source, this.toggle)), this.body);
    this.showBody();
  }

  private showBody(): void {
    this.body.hidden = !this.expanded;
    this.toggle.textContent = this.expanded ? 'Hide Canvas' : 'Open Canvas';
    this.toggle.setAttribute('aria-expanded', String(this.expanded));
  }

  render(view: CanvasView): void {
    const doc = view.state?.document;
    const busy = view.pending || view.state?.status === 'generating';
    // Reveal an actual game or a new generation once. Subsequent status updates respect an explicit close.
    if (view.selected && (doc || view.state?.status === 'generating') && !this.revealedGames.has(view.selected.cardId)) {
      this.revealedGames.add(view.selected.cardId);
      this.expanded = true;
    }
    this.showBody();
    this.host.dataset.cardId = view.selected?.cardId ?? '';
    this.host.dataset.state = view.state?.status ?? 'empty';
    const objectsKey = JSON.stringify(view.tags.map((tag) => [tag.cardId, tag.name, tag.label]));
    if (objectsKey !== this.objectsKey) {
      this.objectsKey = objectsKey;
      const options = view.tags.map((tag) => { const option = el('option', { text: tag.name ?? tag.label }); option.value = tag.cardId; return option; });
      this.selector.replaceChildren(...(options.length ? options : [el('option', { text: 'No tagged objects yet' })]));
    }
    this.selector.value = view.selected?.cardId ?? '';
    this.selector.disabled = !view.tags.length;
    if (this.prompt.value !== view.draft) this.prompt.value = view.draft;
    this.prompt.placeholder = doc ? 'Make the choices harder, add a round, or change the theme…' : 'Make a short adventure inspired by this object…';
    this.prompt.disabled = !view.selected || !view.writable || busy;
    this.submit.textContent = doc ? 'Update game' : 'Create game';
    this.submit.disabled = !view.selected || !view.writable || busy || !view.draft.trim();
    this.cancel.hidden = !view.cancellable;
    this.cancel.disabled = !view.writable;
    this.restore.hidden = !doc?.history.some((entry) => entry.revision < doc.revision);
    this.restore.disabled = !view.writable || busy;
    this.hint.textContent = !view.selected ? 'Tag an object in your headset, then turn it into a game here.'
      : view.selected.connection !== 'ready' ? 'Turn this object into a game. It does not need a device connection.'
        : 'Turn this object into a game. Play and revisions stay in sync with your headset.';
    this.source.textContent = doc ? `${doc.source === 'live' ? 'Live' : 'Fixture demo'}${doc.modelId && doc.modelId !== 'fixture' ? ` · ${doc.modelId}` : ''}` : 'Object games';
    this.status.textContent = !view.online ? 'Connect to your room to create and play.' : !view.writable ? 'A room owner can create and play games.'
      : view.message ?? (view.state?.status === 'generating' ? view.state.message ?? 'Muse is creating your game…'
        : view.pending ? 'Waiting for your room…' : view.state?.status === 'error' ? view.state.message ?? 'Could not update the game. Try again.' : view.state?.message ?? '');
    const previewKey = JSON.stringify([doc, view.state?.game, view.writable, busy, view.selected?.cardId]);
    if (previewKey === this.previewKey) return;
    this.previewKey = previewKey;
    if (!doc) {
      this.preview.replaceChildren(el('p', { className: 'canvas-kicker', text: 'OBJECT → PLAY' }), el('h3', { text: 'A new story starts here' }),
        el('p', { className: 'dim', text: 'Describe a challenge, a quiz, or a small adventure. Muse will make a game you can preview and revise.' }));
      return;
    }
    const game = view.state?.game;
    const children: HTMLElement[] = [el('p', { className: 'canvas-kicker', text: `${view.selected?.name ?? view.selected?.label ?? 'Object'} · Revision ${doc.revision}` }),
      el('h3', { id: 'canvas-game-title', text: doc.spec.title })];
    const action = (label: string, kind: PayloadOf<'canvas.action'>['action'], id: string, choiceId?: string) => {
      const node = button(label, () => { this.model.action(kind, choiceId); }, kind === 'restart' ? 'ghost' : 'primary');
      node.id = id; node.disabled = !view.writable || busy; return node;
    };
    if (!game || game.phase === 'preview') {
      children.push(el('p', { id: 'canvas-intro', text: doc.spec.intro }), el('p', { className: 'canvas-object-use', text: doc.spec.objectUse }),
        el('p', { className: 'small dim', text: `${doc.spec.rounds.length} ${doc.spec.rounds.length === 1 ? 'round' : 'rounds'} · Choose your way through` }), action('Play', 'play', 'canvas-play'));
    } else if (game.phase === 'finished') {
      children.push(el('p', { id: 'canvas-score', className: 'canvas-score', text: `Finished · ${game.score} / ${game.maxScore} points` }),
        el('p', { id: 'canvas-ending', text: doc.spec.ending }), action('Play again', 'restart', 'canvas-restart'));
    } else {
      const round = doc.spec.rounds[game.roundIndex];
      children.push(el('p', { id: 'canvas-score', className: 'small dim', text: `Round ${game.roundIndex + 1} / ${doc.spec.rounds.length} · ${game.score} points` }));
      if (round) {
        children.push(el('p', { id: 'canvas-question', className: 'canvas-question', text: round.prompt }));
        if (game.phase === 'playing') children.push(el('div', { id: 'canvas-choices', className: 'canvas-choices' }, ...round.choices.map((choice, index) => {
          const node = action(choice.label, 'choose', `canvas-choice-${index}`, choice.id); node.dataset.choiceId = choice.id; return node;
        })));
        else {
          children.push(el('p', { className: 'small dim', text: `You chose: ${round.choices.find((choice) => choice.id === game.choiceId)?.label ?? 'An option'}` }),
            el('p', { id: 'canvas-feedback', className: 'canvas-feedback', text: game.feedback ?? '' }), action(game.roundIndex + 1 < doc.spec.rounds.length ? 'Next round' : 'Finish', 'next', 'canvas-next'));
        }
      }
      children.push(action('Restart', 'restart', 'canvas-restart'));
    }
    this.preview.replaceChildren(...children);
  }
}
