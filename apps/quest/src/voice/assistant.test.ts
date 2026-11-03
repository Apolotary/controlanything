import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectInformation, PayloadOf } from '@ce/protocol';
import { Emitter } from '../app/emitter';
import { VoiceAssistant, type AssistantTarget } from './assistant';
import type { PttEvents, PushToTalk } from './ptt';

function harness(extra: Partial<ConstructorParameters<typeof VoiceAssistant>[0]> = {}) {
  let selected: AssistantTarget | undefined = { targetId: 'tag:synth', cardId: 'synth' };
  const ptt = Object.assign(new Emitter<PttEvents>(), {
    listening: false, press: vi.fn(async () => {}), release: vi.fn(), cancel: vi.fn(),
  });
  const selectTarget = vi.fn((cardId: string) => { selected = { targetId: `tag:${cardId}`, cardId }; return selected; });
  const send = vi.fn((_type: string, _payload: unknown) => true), setup = vi.fn((_targetId: string) => true), render = vi.fn();
  let micError: string | undefined;
  const assistant = new VoiceAssistant({ ptt: ptt as unknown as PushToTalk, selected: () => selected,
    identity: () => 'quest', microphoneError: () => micError, send, setup, render, selectTarget, ...extra });
  const reply = (state: NonNullable<PayloadOf<'voice.text'>['assistant']>['state'], overrides: Partial<PayloadOf<'voice.text'>> = {}) => {
    const sent = send.mock.calls.findLast(([type]) => type === 'voice.text');
    assistant.receive({ ...sent?.[1] as PayloadOf<'voice.text'>, recipientId: 'quest',
      assistant: { state, text: 'Here is the next step.', ...(state === 'proposal' ? { proposalId: 'proposal', mapping: ['Right hand height → Filter'] } : {}) }, ...overrides });
  };
  return { assistant, ptt, send, setup, render, reply, selectTarget, select: (target?: AssistantTarget) => { selected = target; }, micError: (error: string) => { micError = error; } };
}

afterEach(() => vi.useRealTimers());

describe('selected device voice assistant', () => {
  it('freezes presentation before opening Muse and stamps the actual selected target', () => {
    const observed = { version: 1 as const, scope: 'device' as const, surface: 'device' as const,
      stage: 'ready' as const, performance: 'off' as const,
      selected: { targetId: 'stale-target', cardId: 'mac' } };
    const h = harness({ workspaceContext: () => observed });
    h.select({ targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 2, identityRevision: 1 });
    h.assistant.sendText('What can I control?');
    const sent = h.send.mock.calls.at(-1)![1] as PayloadOf<'voice.text'>;
    expect(sent.workspace).toMatchObject({ stage: 'ready', selected: { targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 2, identityRevision: 1 } });
    observed.selected.cardId = 'later-device';
    expect(sent.workspace?.selected?.cardId).toBe('synth');
    expect(h.assistant.view?.state).toBe('thinking');
  });

  it('scrubs device observations for general chat through both typed and microphone routes', async () => {
    const h = harness({ workspaceContext: () => ({ version: 1, scope: 'device', surface: 'menu', stage: 'perform', performance: 'live',
      selected: { targetId: 'tag:synth', cardId: 'synth' }, pending: { kind: 'gesture', state: 'review' }, mappingOutcome: 'applied' }) });
    h.assistant.sendGeneralText('What can I do?');
    const expected = { version: 1, scope: 'general', surface: 'menu', stage: 'choose', performance: 'off' };
    expect((h.send.mock.calls.at(-1)![1] as PayloadOf<'voice.text'>).workspace).toEqual(expected);
    await h.assistant.toggleGeneral();
    expect(h.ptt.press).toHaveBeenLastCalledWith({ cardId: 'muse-general', workspace: expected });
  });

  it('retains a server-classified unsupported mapping outcome after dismissal and ordinary questions', () => {
    const h = harness(); h.assistant.sendText('Make ripples from hand depth');
    h.reply('reply', { intent: 'gesture', assistant: { state: 'reply', text: 'Hand depth is unsupported. No new mapping was applied.' } });
    expect(h.assistant.mappingOutcome('synth')).toBe('unchanged');
    h.assistant.cancel(); expect(h.assistant.view).toBeUndefined();
    expect(h.assistant.mappingOutcome('synth')).toBe('unchanged');
    h.assistant.sendText('What does Warp do?'); h.reply('reply', { intent: 'question' }); h.assistant.cancel();
    expect(h.assistant.mappingOutcome('synth')).toBe('unchanged');
    expect(h.assistant.mappingOutcome('other')).toBeUndefined();
  });

  it('records mapping cancellation, failure and successful Apply independently from the conversation', () => {
    vi.useFakeTimers(); const h = harness();
    h.assistant.sendText('Map height to Warp'); h.reply('thinking', { intent: 'gesture' });
    expect(h.assistant.mappingOutcome('synth')).toBe('working');
    h.assistant.cancel(); expect(h.assistant.mappingOutcome('synth')).toBe('cancelled');
    h.assistant.sendText('Map height to Warp'); h.reply('thinking', { intent: 'gesture' });
    vi.advanceTimersByTime(h.assistant.responseTimeoutMs + 1);
    expect(h.assistant.mappingOutcome('synth')).toBe('failed');
    h.assistant.cancel(); expect(h.assistant.mappingOutcome('synth')).toBe('failed');
    h.assistant.sendText('Map height to Warp'); h.reply('proposal', { intent: 'gesture' });
    expect(h.assistant.mappingOutcome('synth')).toBe('review');
    h.assistant.confirm('tag:synth', 'proposal', true); h.reply('applied', { intent: 'gesture' }); h.assistant.cancel();
    expect(h.assistant.mappingOutcome('synth')).toBe('applied');
    h.assistant.forgetMappingOutcome('synth'); expect(h.assistant.mappingOutcome('synth')).toBeUndefined();
  });

  it('uses explicit general microphone and typed context without a selected target', async () => {
    const h = harness(); h.select(undefined);
    await h.assistant.toggleGeneral();
    expect(h.ptt.press).toHaveBeenCalledWith({ cardId: 'muse-general' });
    h.assistant.cancel();
    expect(h.assistant.sendGeneralText('What can Muse do?')).toBe(true);
    expect(h.send).toHaveBeenLastCalledWith('voice.text', expect.objectContaining({ cardId: 'muse-general' }));
    h.reply('reply'); expect(h.assistant.view?.state).toBe('reply'); expect(h.assistant.isGeneral).toBe(true);
    expect(h.setup).not.toHaveBeenCalled(); h.assistant.cancel();
  });
  it('selects a connected instrument only after explicit matching peripheral confirmation', () => {
    const h = harness(); h.assistant.sendText('Control the OP-1 Field connected to this laptop.');
    h.reply('reply', { assistant: { state: 'reply', text: 'Unexpected selection', proposalKind: 'peripheral', selectedCardId: 'connected-op1' } });
    expect(h.selectTarget).not.toHaveBeenCalled();
    h.reply('proposal', { assistant: { state: 'proposal', proposalId: 'peripheral', proposalKind: 'peripheral', text: 'Choose instrument', mapping: ['OP-1 Field'] } });
    h.assistant.confirm('tag:synth', 'peripheral', true);
    expect(h.assistant.view?.text).toContain('Selecting the connected instrument');
    h.reply('reply', { assistant: { state: 'reply', text: 'Instrument selected. Controls off.', proposalKind: 'peripheral', selectedCardId: 'connected-op1' } });
    expect(h.selectTarget).toHaveBeenCalledExactlyOnceWith('connected-op1');
    expect(h.assistant.view?.targetId).toBe('tag:connected-op1');
    expect(h.setup).not.toHaveBeenCalled(); h.assistant.cancel();
  });

  it('uses identity-specific progress after explicit identity confirmation', () => {
    const h = harness(); h.assistant.sendText('This is an OP-1 Field.');
    h.reply('proposal', { assistant: { state: 'proposal', proposalKind: 'identity', proposalId: 'identity', text: 'Review identity', mapping: ['OP-1 Field'] } });
    h.assistant.confirm('tag:synth', 'identity', true);
    expect(h.assistant.view?.text).toBe('Confirming this object’s identity…');
    expect(h.setup).not.toHaveBeenCalled(); h.assistant.cancel();
  });
  it('keeps structured object information scoped to the request without starting control setup', () => {
    const h = harness(); h.assistant.sendText('Inspect this object: description, dimensions, weight and current price, with sources.');
    const objectInfo: ObjectInformation = { title: 'Book', identityStatus: 'uncertain', identityNote: 'Edition unknown.',
      description: { value: 'A book', sourceIds: ['1'] }, dimensions: { value: null, sourceIds: [] }, weight: { value: null, sourceIds: [] }, price: null,
      sources: [{ id: '1', title: 'Publisher', url: 'https://example.com/book' }], researchedAt: 1, source: 'fixture', cached: false };
    h.reply('reply', { cardId: 'other', assistant: { state: 'reply', text: 'About', objectInfo } });
    expect(h.assistant.view?.objectInfo).toBeUndefined();
    h.reply('reply', { assistant: { state: 'reply', text: 'About', objectInfo } });
    expect(h.assistant.view?.objectInfo).toEqual(objectInfo); expect(h.setup).not.toHaveBeenCalled();
    h.reply('error', { assistant: { state: 'error', text: 'Research unavailable' } });
    expect(h.assistant.view?.objectInfo).toBeUndefined();
    h.assistant.cancel();
  });
  it('carries one combined request through setup and a separately confirmed mapping', () => {
    const h = harness();
    expect(h.assistant.sendText('Connect this synth and map right hand height to its filter')).toBe(true);
    h.reply('thinking'); h.reply('setup'); h.reply('setup');
    expect(h.setup).toHaveBeenCalledExactlyOnceWith('tag:synth');
    h.reply('proposal');
    expect(h.send.mock.calls.filter(([type]) => type === 'voice.confirm')).toHaveLength(0);
    h.assistant.confirm('tag:synth', 'wrong', true);
    expect(h.assistant.view?.state).toBe('proposal');
    h.assistant.confirm('tag:synth', 'proposal', true);
    expect(h.send).toHaveBeenLastCalledWith('voice.confirm', { cardId: 'synth', proposalId: 'proposal', accept: true });
    h.reply('applied');
    expect(h.assistant.view?.state).toBe('applied');
    h.assistant.cancel();
  });

  it('ignores another client, device, and superseded utterance', () => {
    const h = harness(); h.assistant.sendText('Connect this');
    h.reply('setup', { recipientId: 'another-quest' });
    h.reply('setup', { cardId: 'lamp' });
    h.reply('setup', { utteranceId: 'old-request' });
    h.reply('setup', { recipientId: undefined });
    expect(h.setup).not.toHaveBeenCalled();
    h.assistant.cancel(); h.reply('setup');
    expect(h.setup).not.toHaveBeenCalled();
  });

  it('never starts setup or applies a proposal after selection changes', () => {
    const h = harness(); h.assistant.sendText('Connect this'); h.reply('proposal');
    h.select({ targetId: 'tag:lamp', cardId: 'lamp' });
    h.reply('setup'); h.assistant.confirm('tag:synth', 'proposal', true);
    expect(h.setup).not.toHaveBeenCalled();
    expect(h.send.mock.calls.filter(([type]) => type === 'voice.confirm')).toHaveLength(0);
    h.assistant.cancel();
    expect(h.send).toHaveBeenLastCalledWith('voice.cancel', expect.objectContaining({ cardId: 'synth' }));
  });

  it('requires a selected device, explains microphone permissions, and reports disconnection', async () => {
    const h = harness(); h.select();
    expect(h.assistant.sendText('Connect this')).toBe(false);
    await h.assistant.toggle('tag:synth'); expect(h.ptt.press).not.toHaveBeenCalled();
    h.select({ targetId: 'tag:synth', cardId: 'synth' });
    h.micError('Exit AR and enable the microphone.');
    await h.assistant.toggle('tag:synth');
    expect(h.assistant.view).toMatchObject({ state: 'error', text: 'Exit AR and enable the microphone.' });
    expect(h.ptt.press).not.toHaveBeenCalled();
    h.send.mockReturnValue(false); expect(h.assistant.sendText('Connect this')).toBe(false);
    expect(h.assistant.view?.state).toBe('error');
    h.assistant.cancel();
  });

  it('tap-to-talk sends on the second tap and automatically stops long recordings', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.assistant.toggle('tag:synth');
    h.ptt.listening = true; h.ptt.emit('listening', { listening: true, utteranceId: 'recording' });
    expect(h.assistant.view?.state).toBe('listening');
    await h.assistant.toggle('tag:synth'); expect(h.ptt.release).toHaveBeenCalledOnce();
    h.ptt.emit('listening', { listening: false, utteranceId: 'recording' });
    expect(h.assistant.view?.state).toBe('thinking');
    h.assistant.cancel();
    h.ptt.listening = false;
    await h.assistant.toggle('tag:synth');
    h.ptt.listening = true; h.ptt.emit('listening', { listening: true, utteranceId: 'second' });
    await vi.advanceTimersByTimeAsync(h.assistant.maxRecordingMs);
    expect(h.ptt.release).toHaveBeenCalledTimes(2);
    h.assistant.cancel();
  });

  it('cancels a pending microphone open when tapped again', async () => {
    const h = harness(); let resolve!: () => void;
    h.ptt.press.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const opening = h.assistant.toggle('tag:synth');
    await h.assistant.toggle('tag:synth'); resolve(); await opening;
    expect(h.assistant.view).toBeUndefined();
    expect(h.ptt.cancel).toHaveBeenCalled();
  });

  it('expires a stalled request and refuses its late setup response', async () => {
    vi.useFakeTimers(); const h = harness(); h.assistant.sendText('Connect this');
    await vi.advanceTimersByTimeAsync(h.assistant.responseTimeoutMs);
    expect(h.assistant.view?.state).toBe('error'); h.reply('setup');
    expect(h.setup).not.toHaveBeenCalled();
    h.assistant.cancel();
  });
});
