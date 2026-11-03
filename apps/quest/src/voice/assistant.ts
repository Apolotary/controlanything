import { newId, WorkspaceContext, type PayloadOf } from '@ce/protocol';
import type { AssistantView, MappingOutcome } from '../hud/contract';
import type { PushToTalk } from './ptt';

export const GENERAL_ASSISTANT_TARGET = 'muse-general';
const generalTarget = (): AssistantTarget => ({ targetId: GENERAL_ASSISTANT_TARGET, cardId: GENERAL_ASSISTANT_TARGET });
export interface AssistantTarget { targetId: string; cardId: string; specId?: string; specRevision?: number; identityRevision?: number }
interface AssistantDeps {
  ptt: PushToTalk;
  selected(): AssistantTarget | undefined;
  identity(): string | undefined;
  /** Microphone permission must already be granted before entering immersive AR. */
  microphoneError(): string | undefined;
  send(type: 'voice.text' | 'voice.confirm' | 'voice.cancel', payload: unknown): boolean;
  setup(targetId: string): boolean;
  render(view: AssistantView | null): void;
  /** Only called after the owner explicitly confirms a server-reviewed connected instrument. */
  selectTarget?(cardId: string): AssistantTarget | undefined;
  /** Called before the previous request is closed or the new conversation is rendered. */
  workspaceContext?(target: AssistantTarget): WorkspaceContext | undefined;
  requestStarted?(target: AssistantTarget, utteranceId: string): void;
  requestCancelled?(utteranceId: string): void;
}

/** One explicitly selected device and one request at a time. Late replies cannot change selection. */
export class VoiceAssistant {
  private request?: AssistantTarget & { utteranceId?: string; setupRequested?: boolean; peripheralConfirmed?: boolean; mappingRequest?: boolean; view: AssistantView };
  /** In-session result survives closing Muse; it never grants control authority. */
  private readonly mappingOutcomes = new Map<string, MappingOutcome>();
  private timer?: ReturnType<typeof setTimeout>;
  private recordingTimer?: ReturnType<typeof setTimeout>;
  private opening = false;
  readonly maxRecordingMs = 20_000;
  readonly responseTimeoutMs = 90_000;

  constructor(private readonly d: AssistantDeps) {
    d.ptt.on('listening', ({ listening, utteranceId }) => {
      if (!this.request || !this.isSelected()) return;
      this.opening = false;
      if (listening) {
        this.request.utteranceId = utteranceId;
        if (utteranceId) this.d.requestStarted?.(this.request, utteranceId);
        this.update({ state: 'listening', text: this.isGeneral ? 'Ask a question, then tap Send. No device is selected.' : 'Speak about this device, then tap Send.' });
        this.recordingTimer = setTimeout(() => this.finish(), this.maxRecordingMs);
      } else {
        clearTimeout(this.recordingTimer);
        this.update({ state: 'thinking', text: 'Transcribing your request…' });
        this.waitForReply();
      }
    });
    d.ptt.on('text', (message) => this.receive(message));
    d.ptt.on('error', (error) => this.fail(error));
  }

  get view(): AssistantView | undefined { return this.request?.view; }
  mappingOutcome(cardId: string): MappingOutcome | undefined { return this.mappingOutcomes.get(cardId); }
  forgetMappingOutcome(cardId: string): void { this.mappingOutcomes.delete(cardId); }

  get isGeneral(): boolean { return this.request?.targetId === GENERAL_ASSISTANT_TARGET; }
  toggleGeneral(): Promise<void> { return this.toggle(GENERAL_ASSISTANT_TARGET); }
  sendGeneralText(text: string): boolean { return this.sendText(text, generalTarget()); }

  async toggle(targetId: string): Promise<void> {
    const selected = targetId === GENERAL_ASSISTANT_TARGET ? generalTarget() : this.d.selected();
    if (!selected || selected.targetId !== targetId) return;
    if (this.request?.targetId === targetId && this.opening) { this.cancel(); return; }
    if (this.request?.targetId === targetId && this.d.ptt.listening) { this.finish(); return; }
    const workspace = this.contextFor(selected);
    this.begin(selected);
    const error = this.d.microphoneError();
    if (error) { this.fail(error); return; }
    this.opening = true;
    this.update({ state: 'idle', text: 'Opening microphone…' });
    await this.d.ptt.press({ cardId: selected.cardId, ...(selected.specId ? { specId: selected.specId } : {}), ...(workspace ? { workspace } : {}) });
  }

  /** Desktop accessibility/test entry; uses exactly the same server planner as a transcript. */
  sendText(text: string, context?: AssistantTarget): boolean {
    const selected = context ?? (this.isGeneral ? generalTarget() : this.d.selected());
    const trimmed = text.trim();
    if (!selected || !trimmed || trimmed.length > 2000) return false;
    const workspace = this.contextFor(selected);
    this.begin(selected);
    this.request!.utteranceId = newId('u');
    this.d.requestStarted?.(selected, this.request!.utteranceId!);
    this.update({ state: 'thinking', transcript: trimmed, text: 'Thinking…' });
    this.waitForReply();
    if (!this.d.send('voice.text', { utteranceId: this.request!.utteranceId, cardId: selected.cardId,
      ...(selected.specId ? { specId: selected.specId } : {}), ...(workspace ? { workspace } : {}), text: trimmed, final: true })) {
      this.fail('The server is disconnected. Reconnect and try again.');
      return false;
    }
    return true;
  }

  receive(message: PayloadOf<'voice.text'>): void {
    const request = this.request;
    if (!request || !this.isSelected() || message.utteranceId !== request.utteranceId || !message.utteranceId) return;
    if (message.cardId && message.cardId !== request.cardId) return;
    if (message.recipientId && message.recipientId !== this.d.identity()) return;
    if (message.assistant && (!message.recipientId || message.cardId !== request.cardId)) return;
    if (message.text) this.update({ transcript: message.text });
    const assistant = message.assistant;
    if (!assistant) return;
    clearTimeout(this.timer);
    // Track only server-classified mapping work. Ordinary Inspect/questions must not
    // replace the last control result or make a working saved mapping look unavailable.
    if (message.intent === 'gesture' || assistant.proposalKind === 'gesture' || assistant.state === 'applied') request.mappingRequest = true;
    if (request.mappingRequest) this.rememberMappingOutcome(assistant.state === 'applied' ? 'applied'
      : assistant.state === 'proposal' ? 'review' : assistant.state === 'error' ? 'failed'
        : assistant.state === 'reply' ? 'unchanged' : 'working');
    this.update({ ...assistant, objectInfo: assistant.objectInfo });
    if (assistant.selectedCardId && assistant.proposalKind === 'peripheral' && request.peripheralConfirmed && assistant.state === 'reply') {
      const selected = this.d.selectTarget?.(assistant.selectedCardId);
      if (selected) {
        // App navigation may cancel the old request. Reopen only this explicit completed confirmation.
        this.request = { ...selected, view: { ...request.view, ...assistant, targetId: selected.targetId, proposalId: undefined, mapping: undefined } };
        this.d.render(this.request.view);
      }
      return;
    }
    if (assistant.state === 'thinking') this.waitForReply();
    if (assistant.state === 'setup' && !request.setupRequested) {
      request.setupRequested = true;
      if (!this.d.setup(request.targetId)) this.update({ state: 'reply', text: 'Follow this device’s connection steps, then choose Set up control. Your gesture request is saved for this setup.' });
    }
  }

  confirm(targetId: string, proposalId: string, accept: boolean): void {
    const request = this.request;
    if (!request || !this.isSelected() || targetId !== request.targetId || proposalId !== request.view.proposalId
      || request.view.state !== 'proposal') return;
    request.peripheralConfirmed = accept && request.view.proposalKind === 'peripheral';
    if (!this.d.send('voice.confirm', { cardId: request.cardId, proposalId, accept })) {
      this.fail(`The server is disconnected. Ask for the ${request.view.proposalKind === 'identity' ? 'identity correction' : request.view.proposalKind === 'peripheral' ? 'instrument selection' : 'mapping'} again after reconnecting.`);
      return;
    }
    this.update({ state: 'thinking', proposalId: undefined, mapping: undefined, text: accept ? request.view.proposalKind === 'identity' ? 'Confirming this object’s identity…' : request.view.proposalKind === 'peripheral' ? 'Selecting the connected instrument…' : 'Applying your mapping…' : 'Dismissing the proposal…' });
    this.waitForReply();
  }

  cancel(): void {
    const request = this.request;
    if (request?.mappingRequest && ['idle', 'listening', 'thinking', 'setup', 'proposal'].includes(request.view.state)) this.rememberMappingOutcome('cancelled');
    this.request = undefined;
    this.opening = false;
    clearTimeout(this.timer); clearTimeout(this.recordingTimer);
    this.d.ptt.cancel();
    if (request?.utteranceId) this.d.requestCancelled?.(request.utteranceId);
    if (request) this.d.send('voice.cancel', { cardId: request.cardId, ...(request.utteranceId ? { utteranceId: request.utteranceId } : {}) });
    this.d.render(null);
  }

  private contextFor(target: AssistantTarget): WorkspaceContext | undefined {
    const observed = this.d.workspaceContext?.(target);
    if (!observed) return;
    const general = target.cardId === GENERAL_ASSISTANT_TARGET;
    // IDs/revisions come from the actual selected request target, not a stale visible panel.
    // General questions never carry a hidden selected object or that object's mapping state.
    const parsed = WorkspaceContext.safeParse(general ? {
      version: 1, scope: 'general', surface: observed.surface, stage: 'choose', performance: 'off',
    } : {
      ...observed, version: 1, scope: 'device', selected: { ...target },
      mappingOutcome: this.mappingOutcome(target.cardId) ?? observed.mappingOutcome,
    });
    return parsed.success ? parsed.data : undefined;
  }

  private begin(target: AssistantTarget): void {
    this.cancel();
    this.request = { ...target, view: { targetId: target.targetId, state: 'idle' } };
    this.d.render(this.request.view);
  }

  private rememberMappingOutcome(outcome: MappingOutcome): void {
    if (!this.request || this.isGeneral) return;
    this.mappingOutcomes.delete(this.request.cardId);
    this.mappingOutcomes.set(this.request.cardId, outcome);
    while (this.mappingOutcomes.size > 64) this.mappingOutcomes.delete(this.mappingOutcomes.keys().next().value!);
  }

  private finish(): void {
    clearTimeout(this.recordingTimer);
    this.d.ptt.release();
  }

  private isSelected(): boolean {
    if (this.isGeneral) return true;
    const selected = this.d.selected();
    return !!selected && selected.targetId === this.request?.targetId && selected.cardId === this.request?.cardId;
  }

  private update(view: Partial<AssistantView>): void {
    if (!this.request) return;
    this.request.view = { ...this.request.view, ...view };
    this.d.render(this.request.view);
  }

  private waitForReply(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('Muse did not respond in time. Tap Ask Muse to try again.'), this.responseTimeoutMs);
  }

  private fail(text: string): void {
    if (!this.request) return;
    if (this.request.mappingRequest) this.rememberMappingOutcome('failed');
    clearTimeout(this.timer); clearTimeout(this.recordingTimer);
    this.opening = false;
    this.d.ptt.cancel();
    if (this.request.utteranceId) this.d.requestCancelled?.(this.request.utteranceId);
    this.d.send('voice.cancel', { cardId: this.request.cardId, ...(this.request.utteranceId ? { utteranceId: this.request.utteranceId } : {}) });
    // Invalidate late responses after a microphone/network failure, retaining the useful error message.
    this.request.utteranceId = undefined;
    this.update({ state: 'error', text, proposalId: undefined, mapping: undefined, objectInfo: undefined });
  }
}
