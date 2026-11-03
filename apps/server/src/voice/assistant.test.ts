import { describe, expect, it, vi } from 'vitest';
import type { GestureMap, VoiceTextPayload } from '@ce/protocol';
import type { Forge } from '../gen3d/forge';
import { FixtureMuse, type MuseChat } from '../muse/adapter';
import { AskMapping, AskPlan, DeviceAssistant, registerAssistantFixtures, type AssistantDevice } from './assistant';
import { InteractionMemory } from '../knowledge/interactions';
import type { WebResearch, WebSearcher } from '../research/websearch';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = { utteranceId: 'utterance', cardId: 'synth', text: 'Connect this device and make raising my right hand control warp', final: true };
function harness(initial: 'ready' | 'setup' | 'offline' = 'ready', replacement?: MuseChat, memory = new InteractionMemory(), extra: Partial<ConstructorParameters<typeof DeviceAssistant>[0]> = {}) {
  let device: AssistantDevice | undefined = {
    cardId: 'synth', name: 'Visual synth', mode: 'control', connection: initial,
    hint: initial === 'offline' ? 'Pair a MIDI helper' : 'Set up controls', armed: initial === 'ready', setupRunning: false,
    verification: { warp: 'pass' },
    driver: { cardId: 'synth', driverId: 'driver', transport: 'midi', maxRateHz: 20,
      actions: [{ actionId: 'warp', label: 'Warp', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', number: 71 } }] },
    spec: { specId: 'spec', cardId: 'synth', driverId: 'driver', rev: 1 },
  };
  const fixture = new FixtureMuse({ log: () => {} }); registerAssistantFixtures(fixture);
  const muse = replacement ?? fixture;
  const messages: VoiceTextPayload[] = [];
  const command = vi.fn(() => true), edit = vi.fn(async () => true), canvas = vi.fn(async (_text: string, _cardId: string, _sender: string, _requestId: string, _signal: AbortSignal) => true);
  const applyGestureMap = vi.fn((_id: string, map: unknown) => {
    device!.spec = { ...device!.spec!, rev: device!.spec!.rev! + 1, gestureMap: map as GestureMap };
    assistant.refresh();
    return device!.spec;
  });
  const assistant = new DeviceAssistant({ muse, memory, device: (id) => device?.cardId === id ? device : undefined,
    forge: () => ({ applyGestureMap }) as unknown as Forge, broadcast: (p) => messages.push(p), command, edit, canvas, ...extra });
  return { assistant, muse, memory, messages, command, edit, canvas, applyGestureMap, get device() { return device!; }, forget() { device = undefined; },
    ready() { device!.connection = 'ready'; device!.armed = true; assistant.refresh(); },
    last: () => messages.at(-1)!, proposal: () => messages.findLast((p) => p.assistant?.state === 'proposal')! };
}

describe('selected-device Ask Muse', () => {
  it('maps the exact forward/back water request to verified CC21, replacing old height/Warp only after Apply', async () => {
    const h = harness();
    h.device.driver!.executor = { deviceId: 'mac', port: 'ce-visual-synth' };
    h.device.driver!.actions.push({ actionId: 'cc21', label: 'Water ripples', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', number: 21 }, expect: { sense: 'camera', effect: 'any' } });
    h.device.verification.cc21 = 'pass';
    await h.assistant.ask(request, 'quest'); h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest');
    expect(h.device.spec?.gestureMap?.axes[0]?.axis).toBe('right_height');
    const oldMap = h.device.spec?.gestureMap;
    await h.assistant.ask({ ...request, utteranceId: 'water-request', text: 'Can you update the visual synth so pushing my hand backwards and forwards creates water ripples?' }, 'quest');
    expect(h.last().assistant).toMatchObject({ state: 'proposal', mapping: [expect.stringContaining('Push/pull')] });
    expect(h.last().assistant?.text).toContain('Mac visual synth'); expect(h.canvas).not.toHaveBeenCalled();
    expect(h.device.spec?.gestureMap).toEqual(oldMap);
    const proposal = h.last().assistant!.proposalId!;
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: proposal, accept: true }, 'other')).toBe(false);
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: proposal, accept: true }, 'quest')).toBe(true);
    expect(h.device.spec?.gestureMap?.axes).toEqual([expect.objectContaining({ axis: 'right_depth', actionId: 'cc21' })]);
    expect(h.device.spec?.gestureMap?.postures).toEqual([]);
    expect(h.last().assistant?.text).toContain('Water ripple mapping applied');
    expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled();
  });
  it('waits for an upgraded, verified and enabled legacy visual driver instead of claiming the old map is ready', async () => {
    const h = harness();
    h.device.driver!.executor = { deviceId: 'mac', port: 'ce-visual-synth' };
    await h.assistant.ask({ ...request, text: 'Make water ripples from forward/back hand movement' }, 'quest');
    expect(h.last().assistant?.state).toBe('setup'); expect(h.last().assistant?.text).toContain('Updating');
    h.assistant.refresh(); expect(h.proposal()).toBeUndefined();
    h.device.driver!.actions.push({ actionId: 'cc21', label: 'Water ripples', kind: 'set', range: { min: 0, max: 127, step: 1 }, encode: { kind: 'midi', msg: 'cc', number: 21 } });
    h.device.verification.cc21 = 'pending'; h.assistant.refresh(); expect(h.proposal()).toBeUndefined();
    h.device.verification.cc21 = 'pass'; h.device.armed = false; h.assistant.refresh(); expect(h.proposal()).toBeUndefined();
    h.ready(); await flush(); expect(h.proposal()?.assistant?.mapping).toEqual([expect.stringContaining('Water ripples')]);
    expect(h.applyGestureMap).not.toHaveBeenCalled(); expect(h.canvas).not.toHaveBeenCalled();
  });

  it('grounds a question in browser observations and the current server mapping without granting control', async () => {
    const h = harness(); const chat = vi.spyOn(h.muse, 'chatJson');
    const workspace = { version: 1 as const, scope: 'device' as const, surface: 'device' as const, stage: 'ready' as const, performance: 'off' as const,
      selected: { targetId: 'tag:synth', cardId: 'synth', specId: 'spec', specRevision: 1, identityRevision: 0 } };
    await h.assistant.ask({ ...request, specId: 'spec', text: 'Tell me about these controls', workspace }, 'quest');
    const modelInput = JSON.parse(chat.mock.calls[0]![0][1]!.content as string);
    expect(modelInput.workspace).toMatchObject({ observedAtRequestStart: { source: 'requesting-client', surface: 'device', performance: 'off' },
      selectedDevice: { source: 'server', cardId: 'synth', name: 'Visual synth' }, currentControls: { source: 'server', specId: 'spec', revision: 1 } });
    expect(h.command).not.toHaveBeenCalled(); expect(h.applyGestureMap).not.toHaveBeenCalled();
  });
  it.each(['target', 'revision', 'identity', 'general'])('rejects stale or crossed workspace %s before planning or proposing a peripheral', async (kind) => {
    const proposePeripheral = vi.fn(); const h = harness('ready', undefined, undefined, { proposePeripheral });
    const chat = vi.spyOn(h.muse, 'chatJson');
    const workspace = { version: 1 as const, scope: 'device' as const, surface: 'device' as const, stage: 'ready' as const, performance: 'off' as const,
      selected: { targetId: 'tag:synth', cardId: kind === 'target' ? 'mac' : 'synth', specId: 'spec', specRevision: kind === 'revision' ? 0 : 1, identityRevision: kind === 'identity' ? 2 : 0 } };
    const out = await h.assistant.ask({ ...request, cardId: kind === 'general' ? 'muse-general' : 'synth', specId: 'spec', text: 'Control the OP-1 Field connected to this laptop', workspace }, 'quest');
    expect(out.assistant?.state).toBe('error'); expect(out.assistant?.text).toContain('No controls were changed');
    expect(chat).not.toHaveBeenCalled(); expect(proposePeripheral).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled();
  });

  it.each(['I have a synthesizer OP-1 Field connected to this laptop. Can you create gesture control for it?', 'This is my MacBook with an OP-1 Field connected to it. Create gesture control.'])('routes a connected OP-1 through a silent Mac without relabelling the host: %s', async (text) => {
    const proposePeripheral = vi.fn(async () => ({ ok: true as const, proposalId: 'peripheral', text: 'Choose the connected OP-1 Field. Laptop unchanged.', summary: ['OP-1 Field'] }));
    const confirmPeripheral = vi.fn(() => ({ ok: true, text: 'Instrument selected. Controls off.', selectedCardId: 'connected-op1' }));
    const proposeIdentity = vi.fn();
    const h = harness('offline', undefined, undefined, { proposePeripheral, confirmPeripheral, proposeIdentity });
    h.device.name = 'Apple MacBook laptop'; h.device.hint = 'Mac audio is disabled in this demo.'; h.device.identity = { category: 'computer' };
    const chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask({ ...request, text }, 'quest');
    expect(h.last().assistant).toMatchObject({ state: 'proposal', proposalKind: 'peripheral' });
    expect(chat).not.toHaveBeenCalled(); expect(proposeIdentity).not.toHaveBeenCalled(); expect(h.last().assistant?.text).not.toContain('Mac audio');
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: 'peripheral', accept: true }, 'other')).toBe(false);
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: 'peripheral', accept: true }, 'quest')).toBe(true);
    expect(h.last().assistant).toMatchObject({ state: 'reply', selectedCardId: 'connected-op1', proposalKind: 'peripheral' });
    expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.applyGestureMap).not.toHaveBeenCalled();
  });
  it('does not reuse an accepted mapping when the current instrument needs a reviewed chart', async () => {
    const h = harness();
    await h.assistant.ask(request, 'quest');
    h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest');
    const count = h.applyGestureMap.mock.calls.length;
    h.device.setupBlocked = 'Confirm firmware and review the incoming MIDI chart.';
    await h.assistant.ask({ ...request, utteranceId: 'blocked' }, 'quest');
    expect(h.last().assistant).toMatchObject({ state: 'reply', text: expect.stringContaining('incoming MIDI chart') });
    expect(h.applyGestureMap).toHaveBeenCalledTimes(count);
  });
  it('answers general questions without inventing a selected object or authorizing device actions', async () => {
    const h = harness();
    await h.assistant.ask({ ...request, cardId: 'muse-general', text: 'What can I do here?' }, 'quest');
    expect(h.last()).toMatchObject({ cardId: 'muse-general', intent: 'question', assistant: { state: 'reply' } });
    expect(h.last().assistant?.text).toContain('general questions');
    expect(h.command).not.toHaveBeenCalled(); expect(h.applyGestureMap).not.toHaveBeenCalled(); expect(h.canvas).not.toHaveBeenCalled();
  });
  it.each(['Create a fluid physics simulator with new code', 'Rewrite the visual synth to add particles'])('does not substitute a familiar old mapping for unsupported change: %s', async (text) => {
    const h = harness(); const chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask({ ...request, text }, 'quest');
    expect(h.last().assistant?.state).toBe('reply');
    expect(h.last().assistant?.text).toContain('unchanged');
    expect(chat).not.toHaveBeenCalled(); expect(h.proposal()).toBeUndefined(); expect(h.edit).not.toHaveBeenCalled();
  });

  it('inspects an offline object in Annotate without planning, control or Canvas side effects', async () => {
    const web: WebSearcher = { mode: 'fixture', research: vi.fn(async () => ({ text: 'No live search.', citations: [], model: 'fixture', source: 'fixture' as const, latencyMs: 0, effort: 'low' })) };
    const h = harness('offline', undefined, undefined, { web }); h.device.mode = 'annotate'; h.device.name = 'Blue book';
    const chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask({ ...request, text: 'Inspect this object: description, dimensions, weight and current price, with sources.' }, 'quest');
    expect(h.last()).toMatchObject({ intent: 'inspect', recipientId: 'quest', assistant: { state: 'reply', objectInfo: { title: 'Blue book', identityStatus: 'uncertain', price: null } } });
    expect(h.last().assistant?.text).toContain('Dimensions: Unknown');
    expect(chat).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.canvas).not.toHaveBeenCalled();
  });

  it.each(['Tell me about these controls', 'Tell me about the gesture mapping', 'Describe this connection'])('answers control explanations without researching objects or acting: %s', async (text) => {
    const web: WebSearcher = { mode: 'fixture', research: vi.fn() };
    const h = harness('ready', undefined, undefined, { web });
    // A misclassified plan still cannot turn an explanation into a command.
    const original = h.muse.chatJson.bind(h.muse);
    vi.spyOn(h.muse, 'chatJson').mockImplementation(async (...args) => {
      const r = await original(...args); if (args[1] === AskPlan) (r.data as any).kind = 'command'; return r;
    });
    await h.assistant.ask({ ...request, text }, 'quest');
    expect(h.last().intent).toBe('question'); expect(h.last().assistant?.state).toBe('reply');
    expect(web.research).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.canvas).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'forget', 'identity-change'])('suppresses a late object-search reply after %s', async (change) => {
    let resolve!: (value: WebResearch) => void;
    const search = vi.fn<WebSearcher['research']>(() => new Promise((done) => { resolve = done; }));
    const h = harness('offline', undefined, undefined, { web: { mode: 'live', research: search } }); h.device.mode = 'annotate';
    const pending = h.assistant.ask({ ...request, text: 'What is its weight?' }, 'quest');
    h.assistant.refresh(); expect(search.mock.calls[0][1]?.signal?.aborted).toBe(false);
    if (change === 'cancel') h.assistant.cancel('quest', 'synth', request.utteranceId);
    if (change === 'forget') { h.forget(); h.assistant.refresh(); }
    if (change === 'identity-change') { h.device.identity = { model: 'Different model' }; h.assistant.refresh(); }
    const count = h.messages.length;
    resolve({ text: '{}', citations: [], model: 'test', source: 'live', latencyMs: 1, effort: 'low' }); await pending;
    expect(h.messages).toHaveLength(count); expect(h.command).not.toHaveBeenCalled(); expect(h.canvas).not.toHaveBeenCalled();
  });

  it.each(['External wired keyboard', 'Apple MacBook laptop'])('preserves a direct instrument identity correction even when selected as %s', async (name) => {
    const proposeIdentity = vi.fn(async () => ({ ok: true as const, proposalId: 'identity-1', text: 'Confirm the identity; firmware remains unknown.', summary: ['OP-1 Field', 'No controls will start'] }));
    const confirmIdentity = vi.fn(() => ({ ok: true, text: 'Identity confirmed. Set up and verify controls separately.' }));
    const h = harness('offline', undefined, undefined, { proposeIdentity, confirmIdentity });
    h.device.name = name; h.device.hint = 'HID keyboard unsupported';
    h.device.identity = { model: 'External wired keyboard' };
    const chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask({ ...request, text: 'This is an OP-1 Field connected to my Mac. Set up hand control.' }, 'quest');
    expect(h.last()).toMatchObject({ intent: 'identity', assistant: { state: 'proposal', proposalKind: 'identity', proposalId: 'identity-1' } });
    expect(chat).not.toHaveBeenCalled(); expect(h.last().assistant?.text).not.toContain('HID');
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: 'identity-1', accept: true }, 'someone-else')).toBe(false);
    expect(confirmIdentity).not.toHaveBeenCalled();
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: 'identity-1', accept: true }, 'quest')).toBe(true);
    expect(confirmIdentity).toHaveBeenCalledExactlyOnceWith('identity-1', 'synth', 'quest', true);
    h.ready(); await flush();
    expect(h.last().assistant?.state).toBe('reply'); expect(h.last().assistant?.text).toContain('separately');
    expect(h.applyGestureMap).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled(); expect(h.canvas).not.toHaveBeenCalled();
  });

  it('dismisses or cancels an identity proposal without gesture application', async () => {
    const proposeIdentity = vi.fn(async () => ({ ok: true as const, proposalId: 'identity-1', text: 'Review correction', summary: ['OP-1 Field'] }));
    const confirmIdentity = vi.fn(() => ({ ok: true, text: 'Dismissed. Identity unchanged.' }));
    const h = harness('offline', undefined, undefined, { proposeIdentity, confirmIdentity });
    await h.assistant.ask({ ...request, text: 'This is an OP-1 Field' }, 'quest');
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: 'identity-1', accept: false }, 'quest')).toBe(true);
    expect(confirmIdentity).toHaveBeenCalledWith('identity-1', 'synth', 'quest', false);
    await h.assistant.ask({ ...request, text: 'This is an OP-1 Field' }, 'quest'); h.assistant.cancel('quest', 'synth');
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: 'identity-1', accept: true }, 'quest')).toBe(false);
    expect(h.applyGestureMap).not.toHaveBeenCalled();
  });

  it('does not publish a late identity proposal after cancellation', async () => {
    let resolve!: (value: { ok: true; proposalId: string; text: string; summary: string[] }) => void;
    const proposeIdentity = vi.fn(() => new Promise<{ ok: true; proposalId: string; text: string; summary: string[] }>((done) => { resolve = done; }));
    const h = harness('offline', undefined, undefined, { proposeIdentity, confirmIdentity: () => ({ ok: true, text: 'ok' }) });
    const pending = h.assistant.ask({ ...request, text: 'This is an OP-1 Field' }, 'quest');
    h.assistant.cancel('quest', 'synth'); const count = h.messages.length;
    resolve({ ok: true, proposalId: 'late', text: 'Late result', summary: [] }); await pending;
    expect(h.messages).toHaveLength(count); expect(h.proposal()).toBeUndefined();
  });

  it('creates software for an offline book before physical connection gates and correlates the voice request', async () => {
    const h = harness('offline'); h.device.name = 'Blue book'; h.device.driver = undefined; h.device.spec = undefined;
    await h.assistant.ask({ ...request, text: 'Create a game with this book' }, 'quest');
    expect(h.canvas).toHaveBeenCalledWith('Create a game with this book', 'synth', 'quest', 'utterance', expect.any(AbortSignal));
    expect(h.last().assistant).toMatchObject({ state: 'reply', text: expect.stringContaining('Choose Play') });
    expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled(); expect(h.applyGestureMap).not.toHaveBeenCalled();
  });
  it('routes existing game edits to canvas and aborts in-progress generation when cancelled', async () => {
    const h = harness('offline'); h.device.canvas = { title: 'Book game', revision: 1 };
    let release!: (ok: boolean) => void;
    h.canvas.mockImplementation(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const pending = h.assistant.ask({ ...request, text: 'Make it harder' }, 'quest');
    await flush(); expect(h.canvas).toHaveBeenCalledTimes(1);
    const signal = h.canvas.mock.calls[0][4]; h.assistant.refresh(); expect(signal.aborted).toBe(false);
    h.assistant.cancel('quest', 'synth', 'utterance'); expect(signal.aborted).toBe(true);
    const count = h.messages.length; release(true); await pending; expect(h.messages).toHaveLength(count);
  });
  it('requires Control mode even for an offline software canvas', async () => {
    const h = harness('offline'); h.device.mode = 'annotate';
    await h.assistant.ask({ ...request, text: 'Make a game' }, 'quest');
    expect(h.canvas).not.toHaveBeenCalled(); expect(h.last().assistant!.text).toContain('Switch to Control');
  });
  it('reuses an accepted request without model calls, but still requires a fresh Apply', async () => {
    const h = harness(), chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask(request, 'quest');
    expect(chat).toHaveBeenCalledTimes(2);
    h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest');
    const first = h.proposal().assistant!.proposalId;
    chat.mockClear();
    await h.assistant.ask({ ...request, utteranceId: 'again' }, 'quest');
    expect(chat).not.toHaveBeenCalled();
    expect(h.proposal().assistant!.proposalId).not.toBe(first);
    expect(h.proposal().assistant!.text).toContain('Reusing your saved mapping');
    expect(h.proposal().source).toBe('fixture');
    expect(h.applyGestureMap).toHaveBeenCalledTimes(1);
    h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest');
    expect(h.applyGestureMap).toHaveBeenCalledTimes(2);
  });

  it('does not restore an unrelated binding removed since accepting a complete map', async () => {
    const h = harness();
    h.device.driver!.actions.push({ ...structuredClone(h.device.driver!.actions[0]), actionId: 'zoom', label: 'Zoom', encode: { kind: 'midi', msg: 'cc', number: 72 } });
    h.device.verification.zoom = 'pass';
    const original = h.muse.chatJson.bind(h.muse);
    let first = true;
    const chat = vi.spyOn(h.muse, 'chatJson').mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1] === AskMapping && first) {
        first = false;
        const map = (response.data as any).mapping as GestureMap;
        map.axes = [map.axes.find((binding) => binding.actionId === 'warp')!];
        map.axes.push({ ...map.axes[0], axis: 'right_roll', actionId: 'zoom', label: 'Zoom' });
      }
      return response;
    });
    await h.assistant.ask(request, 'quest');
    expect(h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest')).toBe(true);
    h.device.spec!.gestureMap!.axes = h.device.spec!.gestureMap!.axes.filter((binding) => binding.actionId !== 'zoom');
    chat.mockClear();
    await h.assistant.ask({ ...request, utteranceId: 'after-removal' }, 'quest');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(h.proposal().assistant!.text).not.toContain('Reusing');
    expect(h.proposal().assistant!.mapping).toHaveLength(1);
  });

  it('does not learn a dismissed proposal', async () => {
    const h = harness(), chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask(request, 'quest');
    h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: false }, 'quest');
    chat.mockClear();
    await h.assistant.ask({ ...request, utteranceId: 'again' }, 'quest');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(h.proposal().assistant!.text).not.toContain('Reusing');
  });

  it('grounds a related new request in accepted examples while keeping the explicit request', async () => {
    const h = harness(), chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask(request, 'quest');
    h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest');
    chat.mockClear();
    const changed = { ...request, utteranceId: 'change', text: 'Make my right hand control warp with wrist roll instead' };
    await h.assistant.ask(changed, 'quest');
    const context = JSON.parse(String(chat.mock.calls.find((call) => call[1] === AskMapping)![0].at(-1)!.content));
    expect(context.request).toBe(changed.text);
    expect(context.references).toHaveLength(1);
    expect(context.references[0].request).toBe(request.text);
    expect(context.device.spec.gestureMap).toEqual(h.device.spec!.gestureMap);
    expect(h.applyGestureMap).toHaveBeenCalledTimes(1);
  });

  it.each(['contract', 'verification', 'current-map', 'forget'])('does not take the exact shortcut after %s changes', async (change) => {
    const h = harness(), chat = vi.spyOn(h.muse, 'chatJson');
    await h.assistant.ask(request, 'quest');
    h.assistant.confirm({ cardId: 'synth', proposalId: h.proposal().assistant!.proposalId!, accept: true }, 'quest');
    if (change === 'contract') h.device.driver!.actions[0].encode!.number = 74;
    if (change === 'verification') h.device.verification.warp = 'fail';
    if (change === 'current-map') h.device.spec!.gestureMap!.axes[0].axis = 'right_roll';
    if (change === 'forget') h.memory.forget('synth');
    chat.mockClear();
    await h.assistant.ask({ ...request, utteranceId: 'again' }, 'quest');
    expect(chat).toHaveBeenCalled();
    expect(h.last().assistant!.text).not.toContain('Reusing');
    expect(h.applyGestureMap).toHaveBeenCalledTimes(1);
  });

  it('uses structured Muse planning; acknowledges before planning and never chooses an implicit device', async () => {
    const h = harness(); const chat = vi.spyOn(h.muse, 'chatJson');
    const pending = h.assistant.ask(request, 'quest');
    expect(h.messages[0]).toMatchObject({ ...request, recipientId: 'quest', assistant: { state: 'thinking' } });
    await pending;
    expect(chat.mock.calls[0][1]).toBe(AskPlan);
    expect(chat.mock.calls[1][1]).toBe(AskMapping);
    expect(h.proposal().assistant?.text).toContain('[FIXTURE]');
    expect(h.proposal().assistant?.mapping?.every((line) => line.length <= 40)).toBe(true);
    expect(h.applyGestureMap).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled();
    await h.assistant.ask({ text: 'connect it', final: true }, 'quest');
    expect(h.last().assistant?.text).toContain('Select a tagged device');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('requests shell setup, waits for Enable, then requires the same sender and explicit confirmation', async () => {
    const h = harness('setup');
    await h.assistant.ask(request, 'quest');
    expect(h.last().assistant?.state).toBe('setup');
    expect(h.proposal()).toBeUndefined(); expect(h.applyGestureMap).not.toHaveBeenCalled();
    h.device.connection = 'ready'; h.assistant.refresh(); await flush();
    expect(h.proposal()).toBeUndefined(); // connection alone is not the owner's Enable controls
    h.ready(); await flush();
    const proposalId = h.proposal().assistant!.proposalId!;
    expect(h.assistant.confirm({ cardId: 'synth', proposalId, accept: true }, 'another-owner')).toBe(false);
    expect(h.assistant.confirm({ cardId: 'other-device', proposalId, accept: true }, 'quest')).toBe(false);
    expect(h.applyGestureMap).not.toHaveBeenCalled();
    expect(h.assistant.confirm({ cardId: 'synth', proposalId, accept: true }, 'quest')).toBe(true);
    expect(h.applyGestureMap).toHaveBeenCalledExactlyOnceWith('spec', expect.objectContaining({ axes: [expect.objectContaining({ axis: 'right_height', actionId: 'warp', maxRateHz: 20 })] }), { driverId: 'driver', rev: 1 });
    expect(h.last().assistant?.state).toBe('applied');
    expect(h.assistant.confirm({ cardId: 'synth', proposalId, accept: true }, 'quest')).toBe(false);
  });

  it('keeps the combined request while missing a helper and resumes with the original utterance', async () => {
    const h = harness('offline');
    await h.assistant.ask(request, 'quest');
    expect(h.last().assistant?.state).toBe('reply'); expect(h.last().assistant?.text).toContain('Pair a MIDI helper');
    h.assistant.refresh(); expect(h.messages).toHaveLength(2);
    h.device.connection = 'setup'; h.assistant.refresh();
    expect(h.last()).toMatchObject({ utteranceId: request.utteranceId, cardId: 'synth', recipientId: 'quest', assistant: { state: 'setup' } });
    h.ready(); await flush(); expect(h.proposal()).toBeDefined();
  });

  it.each(['rev', 'driver', 'verification', 'mode', 'forget', 'cancel', 'decline'])('rejects obsolete proposals after %s', async (change) => {
    const h = harness(); await h.assistant.ask(request, 'quest');
    const proposalId = h.proposal().assistant!.proposalId!;
    if (change === 'rev') h.device.spec!.rev = 2;
    if (change === 'driver') h.device.driver!.driverId = 'replacement';
    if (change === 'verification') h.device.verification.warp = 'fail';
    if (change === 'mode') h.device.mode = 'annotate';
    if (change === 'forget') h.forget();
    if (change === 'cancel') h.assistant.cancel('quest', 'synth', 'utterance');
    if (change === 'decline') expect(h.assistant.confirm({ cardId: 'synth', proposalId, accept: false }, 'quest')).toBe(true);
    expect(h.assistant.confirm({ cardId: 'synth', proposalId, accept: true }, 'quest')).toBe(false);
    expect(h.applyGestureMap).not.toHaveBeenCalled();
  });

  it('aborts in-flight planning and discards late results after cancellation or supersession', async () => {
    const h = harness();
    let resolve!: (r: any) => void;
    const real = h.muse.chatJson.bind(h.muse);
    vi.spyOn(h.muse, 'chatJson').mockImplementationOnce((...args) => new Promise((done, reject) => { resolve = () => { void real(args[0], args[1], { ...args[2], signal: undefined }).then(done, reject); }; }));
    const pending = h.assistant.ask(request, 'quest');
    h.assistant.cancel('quest', 'synth', 'wrong-id');
    await h.assistant.ask({ ...request, utteranceId: 'new', text: 'what is this device?' }, 'quest');
    const count = h.messages.length;
    resolve(undefined); await pending;
    expect(h.messages).toHaveLength(count); expect(h.proposal()).toBeUndefined();
    expect(h.command).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled();
  });

  it.each(['action', 'range', 'rate', 'gesture', 'unverified'])('rejects model mapping with unsafe %s', async (bad) => {
    const h = harness();
    const original = h.muse.chatJson.bind(h.muse);
    vi.spyOn(h.muse, 'chatJson').mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1] === AskMapping) {
        const map = (response.data as any).mapping as GestureMap;
        if (bad === 'action') map.axes[0].actionId = 'arbitrary.command';
        if (bad === 'range') map.axes[0].outMax = 128;
        if (bad === 'rate') map.axes[0].maxRateHz = 30;
        if (bad === 'gesture') (map.axes[0] as any).axis = 'finger_snap';
        if (bad === 'unverified') h.device.verification.warp = 'fail';
      }
      return response;
    });
    await h.assistant.ask(request, 'quest');
    expect(h.proposal()).toBeUndefined(); expect(h.last().assistant?.state).toBe('error');
    expect(h.applyGestureMap).not.toHaveBeenCalled();
  });

  it('truthfully declines unsupported fixture gestures and provides factual questions without acting', async () => {
    const h = harness();
    await h.assistant.ask({ ...request, text: 'Map snapping my fingers to warp' }, 'quest');
    expect(h.proposal()).toBeUndefined();
    await h.assistant.ask({ ...request, utteranceId: 'q2', text: 'What controls does this device support?' }, 'quest');
    expect(h.last().assistant?.state).toBe('reply'); expect(h.last().assistant?.text).toContain('[FIXTURE]');
    expect(h.command).not.toHaveBeenCalled(); expect(h.applyGestureMap).not.toHaveBeenCalled();
  });

  it('cancels deferred helper work on context abandonment', async () => {
    const h = harness('offline'); await h.assistant.ask(request, 'quest');
    h.assistant.cancel('quest', 'synth', request.utteranceId);
    const count = h.messages.length; h.ready(); await flush();
    expect(h.messages).toHaveLength(count); expect(h.applyGestureMap).not.toHaveBeenCalled();
  });
});
