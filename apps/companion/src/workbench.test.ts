import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    health: vi.fn(), calls: vi.fn(), approve: vi.fn(), deny: vi.fn(), pending: vi.fn(),
    pairStart: vi.fn(), pairStatus: vi.fn(), revoke: vi.fn(),
  },
  claim: vi.fn(), attach: vi.fn(), start: vi.fn(), send: vi.fn(), permission: vi.fn(),
  midiEnable: vi.fn(), serialChoose: vi.fn(), serialReconnect: vi.fn(), serialListen: vi.fn(), micStart: vi.fn(),
  replay: vi.fn(),
  identity: vi.fn(), localPage: true, bridgeOnline: false, serialReady: false,
  leader: true, midiEnabled: false,
  visualConnected: false, visualChanged: undefined as (() => void) | undefined,
  visualOpen: vi.fn(() => true), visualUpdate: vi.fn(), visualClose: vi.fn(),
  midiPorts: [] as { id: string; kind: 'midi-out'; name: string; state: 'connected' }[],
}));

vi.mock('./api', () => ({ api: mocks.api, ApiError: class extends Error {} }));
vi.mock('./identity', () => ({
  loadIdentity: mocks.identity,
  clearIdentity: vi.fn(), saveIdentity: vi.fn(), isLocalPage: () => mocks.localPage,
  defaultDevice: () => ({ kind: 'mac', name: 'Mac' }),
}));
vi.mock('./replay', () => ({ runReplay: mocks.replay, replayArmResult: vi.fn() }));
vi.mock('./connection', () => {
  class Connection {
    static instances: Connection[] = [];
    static sameOrigin = () => 'ws://test.invalid/ws';
    open = false;
    handlers = new Map<string, ((message: unknown) => void)[]>();
    any: ((message: unknown) => void)[] = [];
    onState?: () => void;
    constructor(_url: string, readonly hello: () => { capabilities: string[]; ports: unknown[]; executor: boolean }) { Connection.instances.push(this); }
    on(type: string, handler: (message: unknown) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
    }
    onAny(handler: (message: unknown) => void) { this.any.push(handler); }
    start() { mocks.start(); this.open = true; this.onState?.(); }
    stop() { this.open = false; }
    resendHello = vi.fn();
    send = mocks.send;
    inject(message: { type: string; payload: unknown }) {
      for (const handler of this.handlers.get(message.type) ?? []) handler(message);
      for (const handler of this.any) handler(message);
    }
  }
  return { Connection, CLOSE_UNAUTHORIZED: 4001 };
});
vi.mock('./executor', () => ({
  Executor: class {
    leader = false;
    tape = [];
    onLeader?: (leader: boolean) => void;
    claim() { mocks.claim(); this.leader = mocks.leader; this.onLeader?.(this.leader); }
    attach = mocks.attach;
    panicLocal = vi.fn();
  },
}));
vi.mock('./visualPresence', () => ({ VisualSynthPresence: class {
  constructor(_owner: unknown, changed: () => void) { mocks.visualChanged = changed; }
  connected() { return mocks.visualConnected; }
} }));
vi.mock('./visualLauncher', () => ({ VisualSynthLauncher: class {
  open = mocks.visualOpen;
  update = mocks.visualUpdate;
  close = mocks.visualClose;
} }));
vi.mock('./midi', () => ({
  MidiBridge: class {
    static supported = true;
    static alreadyGranted = async () => false;
    get enabled() { return mocks.midiEnabled; }
    outputs = () => mocks.midiPorts;
    inputs = () => [];
    ports = () => mocks.midiPorts;
    enable = mocks.midiEnable;
  },
}));
vi.mock('./midiExec', () => ({ MidiExecutor: class { scheduler = { rate: () => 0 }; } }));
vi.mock('./serial/cardputer', () => ({
  CardputerLink: class {
    static supported = true;
    get ready() { return mocks.serialReady; }
    hasPort = false;
    state = 'idle';
    choose = mocks.serialChoose;
    reconnect = mocks.serialReconnect;
    listenForPlug = mocks.serialListen;
    close = vi.fn();
  },
}));
vi.mock('./serial/bridge', () => ({
  CardputerBridge: class {
    state = 'no-device';
    get online() { return mocks.bridgeOnline; }
    learned = [];
    deviceReady = vi.fn();
    deviceGone = vi.fn();
    onDeviceMessage = vi.fn();
  },
}));
vi.mock('./audio/oracle', () => ({
  AudioOracle: class {
    static supported = true;
    state = 'off';
    levels = [];
    start = mocks.micStart;
    stop = vi.fn();
  },
}));

/** Test-only browser surface: rendering uses the real DOM helpers, never hardware APIs. */
class Element {
  id = '';
  className = '';
  hidden = false;
  disabled = false;
  open = false;
  checked = false;
  value = '';
  title = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: (Element | string)[] = [];
  parentElement?: Element;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: unknown) => unknown)[]>();
  htmlWrites: string[] = [];
  constructor(readonly tagName = 'div') {}
  get textContent(): string { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(text: string) { this.replaceChildren(text); }
  set innerHTML(html: string) { this.htmlWrites.push(html); this.textContent = html; }
  get childElementCount() { return this.children.filter((child) => child instanceof Element).length; }
  get firstElementChild() { return this.children.find((child) => child instanceof Element) as Element | undefined; }
  get lastElementChild() { return this.children.findLast((child) => child instanceof Element) as Element | undefined; }
  get classList() {
    const change = (name: string, on: boolean) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    };
    return {
      add: (name: string) => change(name, true), remove: (name: string) => change(name, false),
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      toggle: (name: string, force?: boolean) => change(name, force ?? !this.className.split(/\s+/).includes(name)),
    };
  }
  append(...children: (Element | string)[]) {
    for (const child of children) { if (child instanceof Element) child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children: (Element | string)[]) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() { Object.assign(document, { activeElement: this }); }
  click() { if (!this.disabled) return this.fire('click'); }
  hasAttribute(name: string) { return name === 'open' ? this.open : this.attributes.has(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  addEventListener(type: string, callback: (event: unknown) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  async fire(type: string, detail: Record<string, unknown> = {}) {
    const event = { target: this, preventDefault: vi.fn(), ...detail };
    for (const handler of this.listeners.get(type) ?? []) await handler(event);
    return event;
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (child: Element) => selector.startsWith('#') ? child.id === selector.slice(1)
      : selector.startsWith('.') ? child.classList.contains(selector.slice(1))
      : selector.startsWith('[data-') ? selector.slice(6, -1) in child.dataset : child.tagName === selector;
    return this.children.flatMap((child) => child instanceof Element ? [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

let body: Element;
let documentListeners: Map<string, (() => void)[]>;
const byId = (id: string) => {
  const element = body.querySelector(`#${id}`);
  if (!element) throw new Error(`Missing companion element: ${id}`);
  return element;
};
const flush = () => vi.advanceTimersByTimeAsync(160);

function controlStatusAnimations(reducedMotion = false) {
  const tokens = new Map([...readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
    .matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => tokens.get(name) ?? '' }));
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  const animations: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }[] = [];
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  Object.assign(byId('status-text'), { animate });
  return { animate, animations, easing: tokens.get('--ease') };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  body = new Element('body');
  documentListeners = new Map();
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    element.id = match[2];
    element.hidden = /\bhidden(?:\s|>)/.test(match[0]);
    const className = match[0].match(/\bclass="([^"]+)"/)?.[1];
    if (className) element.className = className;
    for (const attribute of match[0].matchAll(/\b(aria-[\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    body.append(element);
  }
  byId('code-form').append(new Element('button'));
  vi.stubGlobal('document', {
    body, visibilityState: 'visible',
    addEventListener: (type: string, callback: () => void) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), callback]),
    getElementById: (id: string) => body.querySelector(`#${id}`),
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_namespace: string, tag: string) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  });
  vi.stubGlobal('location', new URL('http://localhost/companion/'));
  vi.stubGlobal('navigator', { permissions: { query: mocks.permission } });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  const sessionValues = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => sessionValues.get(key) ?? null,
    setItem: (key: string, value: string) => sessionValues.set(key, value),
    removeItem: (key: string) => sessionValues.delete(key),
  });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  mocks.permission.mockResolvedValue({ state: 'prompt' });
  mocks.identity.mockReturnValue({ deviceId: 'mac-1', deviceToken: 'owner-token', kind: 'mac', name: 'Mac' });
  mocks.localPage = true;
  mocks.bridgeOnline = false;
  mocks.serialReady = false;
  mocks.leader = true;
  mocks.midiEnabled = false;
  mocks.visualConnected = false;
  mocks.midiPorts = [];
  mocks.serialReconnect.mockResolvedValue(false);
  mocks.api.health.mockResolvedValue({ mode: 'live', models: { chat: 'meta-model' }, urls: { lan: [] } });
  mocks.api.calls.mockResolvedValue({ calls: [], totals: { calls: 0 } });
  mocks.api.pending.mockResolvedValue({ pending: [] });
  mocks.api.approve.mockResolvedValue({ pairingId: 'pair-1' });
  mocks.api.deny.mockResolvedValue({ pairingId: 'pair-1' });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot(search = '') {
  vi.stubGlobal('location', new URL(`http://localhost/companion/${search}`));
  const { bootWorkbench } = await import('./workbench');
  await bootWorkbench();
  const { Connection } = await import('./connection');
  const connection = (Connection as unknown as { instances: { inject(message: { type: string; payload: unknown }): void }[] }).instances.at(-1)!;
  await flush();
  const emit = async (type: string, payload: unknown, from = 'server', to?: string) => {
    const message = { v: 1, id: `test-${Date.now()}`, ts: Date.now(), from, to, type, payload };
    connection.inject(message); await flush();
  };
  const visibility = async (state: 'visible' | 'hidden') => {
    Object.assign(document, { visibilityState: state });
    for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
    await flush();
  };
  return { emit, visibility };
}

async function live() {
  const app = await boot();
  await app.emit('welcome', { canApprove: true, name: 'Mac', kind: 'mac', deviceId: 'mac-1' });
  return app;
}

const pairing = () => ({ pairingId: 'pair-1', code: 'K7Q4M2', display: 'K7Q-4M2', name: 'Room remote', kind: 'cardputer', expiresAt: Date.now() + 5000 });

describe('Reviewed MIDI chart editor', () => {
  const card = { cardId: 'unknown-midi', maker: 'Example', model: 'Instrument A', name: 'Example Instrument A', category: 'synthesizer',
    confidence: .9, protocols: ['midi'], requires: ['midi'], evidence: [] };
  const chart = { maker: card.maker, model: card.model, source: { title: 'Instrument A manual', url: 'https://example.com/manual', section: 'MIDI table' },
    channel: 2, parameters: [{ cc: 74, name: 'Cutoff', min: 10, max: 100 }] };
  const response = (model = card.model) => ({ card: { ...card, model }, revision: 3,
    chart: { cardId: card.cardId, revision: 3, reviewedAt: 1, reviewedBy: 'Reviewer', chart } });
  const input = (host: Element, label: string) => host.querySelectorAll('input').find(item => item.getAttribute('aria-label') === label)!;
  const consent = (host: Element) => host.querySelectorAll('input').find(item => (item as unknown as { type: string }).type === 'checkbox')!;

  it('requires a fresh review and saves only the selected chart revision without sending control messages', async () => {
    const { MidiChartPanel } = await import('./ui/midi-chart');
    const host = new Element();
    const request = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce({ ...response(), revision: 4 });
    const panel = new MidiChartPanel(host as unknown as HTMLElement, request);
    panel.update([card as never], true); await flush();
    const submit = host.querySelectorAll('button').find(item => item.textContent === 'Save reviewed chart')!;
    expect(submit.disabled).toBe(true);
    consent(host).checked = true; await consent(host).fire('change');
    expect(submit.disabled).toBe(false);
    await host.querySelector('form')!.fire('submit'); await flush();
    expect(request).toHaveBeenLastCalledWith('/api/agent/midi-charts', { cardId: card.cardId, expectedRevision: 3, reviewed: true, chart });
    expect(host.textContent).toContain('Controls remain off');
    expect(consent(host).checked).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not carry an older model’s chart into a newly identified instrument', async () => {
    const { MidiChartPanel } = await import('./ui/midi-chart');
    const host = new Element();
    const request = vi.fn().mockResolvedValue(response('Instrument B'));
    new MidiChartPanel(host as unknown as HTMLElement, request).update([{ ...card, model: 'Instrument B' } as never], true);
    await flush();
    expect(input(host, 'Source URL').value).toBe('');
    expect(input(host, 'CC number').value).toBe('');
    expect(host.textContent).toContain('previous identification');
  });

  it('ignores stale loads after the target identity changes and rejects a read-only submit', async () => {
    const { MidiChartPanel } = await import('./ui/midi-chart');
    const host = new Element(); let finishOld!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(response('Instrument B'));
    const panel = new MidiChartPanel(host as unknown as HTMLElement, request);
    panel.update([card as never], true);
    panel.update([{ ...card, model: 'Instrument B' } as never], false); await flush();
    finishOld(response()); await flush();
    expect(host.textContent).toContain('Instrument B');
    expect(input(host, 'Source URL').value).toBe('');
    consent(host).checked = true; await host.querySelector('form')!.fire('submit'); await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps a removed instrument disabled when its pending chart request finishes', async () => {
    const { MidiChartPanel } = await import('./ui/midi-chart');
    const host = new Element(); let finish!: (value: unknown) => void;
    const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const panel = new MidiChartPanel(host as unknown as HTMLElement, request);
    panel.update([card as never], true); panel.update([], true);
    finish(response()); await flush();
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(host.textContent).not.toContain('Example · Instrument A');
    consent(host).checked = true; await host.querySelector('form')!.fire('submit'); await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

const pairButton = (name: string) => {
  const button = byId('pending').querySelectorAll('button').find((candidate) => candidate.textContent === name);
  if (!button) throw new Error(`Missing pairing button: ${name}`);
  return button;
};

describe('Companion Canvas', () => {
  const document = (cardId = 'book', revision = 1) => ({ canvasId: `canvas-${cardId}`, cardId, revision, source: 'fixture', modelId: 'fixture-canvas',
    prompt: 'Make an adventure', history: revision > 1 ? [{ revision: 1, title: 'First draft' }] : [], updatedAt: revision,
    spec: { title: '<script>Book adventure</script>', intro: 'Find the missing bookmark.', objectUse: 'Use the book as inspiration.',
      rounds: [{ id: 'trail', prompt: 'Where will you look?', choices: [{ id: 'cover', label: 'Inspect the cover', points: 2, feedback: 'You found a clue.' },
        { id: 'shelf', label: 'Search the shelf', points: 0, feedback: 'No clue here.' }] }], ending: 'The bookmark is back.' } });
  const game = { phase: 'preview', roundIndex: 0, score: 0, maxScore: 2 };
  const tags = [{ cardId: 'book', label: 'Book', connection: 'offline' }, { cardId: 'lamp', label: 'Desk lamp', connection: 'ready' }];
  const paired = async (app: Awaited<ReturnType<typeof boot>>) => app.emit('presence', {
    devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] }],
  });

  it('keeps the editor collapsed until requested or a game arrives, and respects a later close', async () => {
    const app = await live(); await paired(app);
    mocks.send.mockReturnValue(true);
    await app.emit('tags.state', { tags });
    expect(byId('canvas-body').hidden).toBe(true);
    expect(byId('canvas-toggle').getAttribute('aria-expanded')).toBe('false');
    await byId('canvas-toggle').click();
    expect(byId('canvas-body').hidden).toBe(false);
    await byId('canvas-toggle').click();
    await app.emit('canvas.state', { cardId: 'book', status: 'generating', requestId: 'quest-game' });
    expect(byId('canvas-body').hidden).toBe(false);
    await byId('canvas-toggle').click();
    await app.emit('canvas.state', { cardId: 'book', status: 'ready', document: document(), game });
    expect(byId('canvas-body').hidden).toBe(true);
    await byId('canvas-toggle').click();
    expect(byId('canvas-game-title').textContent).toContain('Book adventure');
  });

  it('renders plain text, waits for Play, and follows only authoritative shared game state', async () => {
    const app = await live();
    await paired(app);
    mocks.send.mockReturnValue(true);
    await app.emit('tags.state', { tags });
    expect(byId('canvas-hint').textContent).toContain('does not need a device connection');
    expect(mocks.send).toHaveBeenCalledWith('canvas.get', { cardId: 'book' }, { to: 'server' });
    await app.emit('canvas.state', { cardId: 'book', status: 'ready', document: document(), game });
    expect(byId('canvas-game-title').textContent).toBe('<script>Book adventure</script>');
    expect(byId('canvas-game-title').htmlWrites).toEqual([]);
    expect(byId('canvas-preview').querySelector('script')).toBeNull();
    expect(byId('canvas-preview').textContent).not.toContain('You found a clue.');
    expect(byId('canvas-preview').querySelector('#canvas-choices')).toBeNull();
    expect(byId('canvas-source').textContent).toBe('Fixture demo · fixture-canvas');
    mocks.send.mockClear();
    await byId('canvas-play').click(); await flush();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('canvas.action', expect.objectContaining({ cardId: 'book', revision: 1, action: 'play' }), { to: 'server' });
    expect(byId('canvas-play').disabled).toBe(true);
    expect(byId('canvas-preview').querySelector('#canvas-choices')).toBeNull();
    await app.emit('canvas.state', { cardId: 'book', requestId: mocks.send.mock.calls.at(-1)![1].requestId, status: 'ready', document: document(), game: { ...game, phase: 'playing' } });
    expect(byId('canvas-choices').querySelectorAll('button')).toHaveLength(2);
    expect(byId('canvas-preview').textContent).not.toContain('You found a clue.');
    await byId('canvas-choice-0').click(); await flush();
    expect(mocks.send).toHaveBeenLastCalledWith('canvas.action', expect.objectContaining({ action: 'choose', roundId: 'trail', choiceId: 'cover' }), { to: 'server' });
    await app.emit('canvas.state', { cardId: 'book', requestId: mocks.send.mock.calls.at(-1)![1].requestId, status: 'ready', document: document(), game: { ...game, phase: 'feedback', choiceId: 'cover', score: 2, feedback: 'You found a clue.' } });
    expect(byId('canvas-feedback').textContent).toBe('You found a clue.');
    await byId('canvas-next').click(); await flush();
    expect(mocks.send).toHaveBeenLastCalledWith('canvas.action', expect.objectContaining({ action: 'next', roundId: 'trail' }), { to: 'server' });
    expect(mocks.midiEnable).not.toHaveBeenCalled(); expect(mocks.micStart).not.toHaveBeenCalled();
  });

  it('scopes edits and restore to the chosen object, disables generation actions, and removes forgotten games', async () => {
    const app = await live();
    await paired(app);
    mocks.send.mockReturnValue(true);
    await app.emit('tags.state', { tags });
    await app.emit('canvas.state', { cardId: 'book', status: 'ready', document: document('book', 2), game });
    await app.emit('canvas.state', { cardId: 'lamp', status: 'ready', document: document('lamp', 1), game });
    byId('canvas-object').value = 'lamp'; await byId('canvas-object').fire('change'); await flush();
    expect(byId('object-canvas').dataset.cardId).toBe('lamp');
    expect(byId('canvas-restore').hidden).toBe(true);
    byId('canvas-prompt').value = 'Make this a mystery'; await byId('canvas-prompt').fire('input'); await flush();
    await byId('canvas-form').fire('submit'); await flush();
    expect(mocks.send).toHaveBeenLastCalledWith('canvas.request', expect.objectContaining({ cardId: 'lamp', baseRevision: 1, prompt: 'Make this a mystery' }), { to: 'server' });
    expect(byId('canvas-play').disabled).toBe(true);
    byId('canvas-object').value = 'book'; await byId('canvas-object').fire('change'); await flush();
    expect(byId('canvas-prompt').value).toBe('');
    expect(byId('canvas-restore').hidden).toBe(false);
    await byId('canvas-restore').click(); await flush();
    expect(mocks.send).toHaveBeenLastCalledWith('canvas.restore', expect.objectContaining({ cardId: 'book', revision: 1, baseRevision: 2 }), { to: 'server' });
    await app.emit('tags.state', { tags: [] });
    expect(byId('canvas-preview').querySelector('#canvas-game-title')).toBeNull();
    expect(byId('canvas-submit').disabled).toBe(true);
    await app.emit('canvas.state', { cardId: 'book', status: 'ready', document: document(), game });
    expect(byId('canvas-preview').querySelector('#canvas-game-title')).toBeNull();
  });

  it('shows a read-only shared preview with disabled actions and no foreign Cancel or forbidden requests', async () => {
    mocks.localPage = false;
    const app = await boot();
    await app.emit('welcome', { canApprove: false, name: 'Viewer', kind: 'web', deviceId: 'viewer' });
    await paired(app);
    await app.emit('tags.state', { tags });
    await app.emit('canvas.state', { cardId: 'book', status: 'ready', document: document('book', 2), game });
    expect(byId('canvas-game-title').textContent).toContain('Book adventure');
    expect(byId('canvas-prompt').disabled).toBe(true);
    expect(byId('canvas-submit').disabled).toBe(true);
    expect(byId('canvas-play').disabled).toBe(true);
    expect(byId('canvas-restore').disabled).toBe(true);
    expect(byId('canvas-status').textContent).toContain('A room owner');
    await app.emit('canvas.state', { cardId: 'book', status: 'generating', requestId: 'quest-request', document: document('book', 2), game });
    expect(byId('canvas-cancel').hidden).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('Calm companion behavior', () => {
  const workspaceDriver = (cardId = 'visual', deviceId = 'mac-1', label = 'Warp') => ({
    cardId, driverId: `driver-${cardId}`, transport: 'midi', executor: { deviceId, port: 'ce-visual-synth' },
    source: 'live', modelId: 'muse-test', provenance: [], actions: [{ actionId: 'warp', label, kind: 'set',
      range: { min: 0, max: 127 }, encode: { kind: 'midi', msg: 'cc', channel: 1, number: 71, value: '$value' } }],
  });
  const openWorkspace = async () => {
    const app = await live();
    await app.emit('presence', { devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] }] });
    await app.emit('target.status', { cardId: 'visual', runId: 'run-1', state: 'driving', since: 0, executorDeviceId: 'mac-1' });
    return app;
  };

  it('shows real definitions and six stages on Home and Activity using text-only rendering', async () => {
    const app = await openWorkspace();
    const label = '</code><script>untrusted()</script>';
    await app.emit('driver.spec', workspaceDriver('visual', 'mac-1', label));
    expect(byId('setup-workspace').hidden).toBe(false);
    expect(byId('setup-workspace-artifact-label').textContent).toBe('Generated driver');
    expect(byId('setup-workspace-code').textContent).toContain('"number": 71');
    expect(byId('setup-workspace-code').textContent).toContain(label);
    expect(byId('setup-workspace-code').htmlWrites).toEqual([]);
    expect(byId('setup-workspace').querySelector('script')).toBeNull();
    expect(byId('setup-workspace-stages').querySelectorAll('li')).toHaveLength(6);
    expect(byId('setup-workspace-source').textContent).toContain('Live');
    const contents = byId('setup-workspace-code');
    await app.emit('driver.spec', workspaceDriver('visual', 'mac-1', label));
    expect(byId('setup-workspace-code')).toBe(contents); // no unchanged DOM rebuild
    await byId('nav-activity').fire('click'); await flush();
    expect(byId('setup-workspace').hidden).toBe(true);
    expect(byId('activity-workspace').hidden).toBe(false);
    expect(byId('activity-workspace-code').textContent).toContain('"number": 71');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not replace this Mac’s workspace with another executor or a client-origin claim', async () => {
    const app = await openWorkspace();
    await app.emit('driver.spec', workspaceDriver());
    await app.emit('target.status', { cardId: 'other', runId: 'run-other', state: 'driving', since: 0, executorDeviceId: 'another-mac' });
    await app.emit('driver.spec', workspaceDriver('other', 'another-mac', 'Other device'));
    await app.emit('target.status', { cardId: 'spoof', runId: 'run-spoof', state: 'driving', since: 0, executorDeviceId: 'mac-1' }, 'another-client');
    expect(byId('setup-workspace').dataset.cardId).toBe('visual');
    expect(byId('setup-workspace-code').textContent).toContain('Warp');
    expect(byId('setup-workspace-code').textContent).not.toContain('Other device');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('renders streamed interface definitions only when visible and clears cancelled work', async () => {
    const app = await openWorkspace();
    await app.emit('driver.spec', workspaceDriver());
    await app.visibility('hidden');
    await app.emit('ui.partial', { cardId: 'visual', runId: 'run-1', specId: 'partial-interface', seq: 1 });
    expect(byId('setup-workspace-artifact-label').textContent).toBe('Generated driver');
    await app.visibility('visible');
    expect(byId('setup-workspace-artifact-label').textContent).toBe('Generated interface');
    expect(byId('setup-workspace-code').textContent).toContain('partial-interface');
    mocks.send.mockReturnValue(true);
    await byId('setup-stop').fire('click'); await flush();
    expect(byId('setup-workspace').hidden).toBe(true);
    await app.emit('driver.spec', workspaceDriver());
    expect(byId('setup-workspace').hidden).toBe(true);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('control.cancel', { cardId: 'visual', runId: 'run-1' }, { to: 'server' });
  });

  it('opens the short pairing page directly into a QR and code without waiting for health', async () => {
    mocks.identity.mockReturnValue(undefined);
    vi.stubGlobal('location', new URL('http://localhost/companion/?pair=1'));
    let healthReady!: (result: unknown) => void;
    mocks.api.health.mockReturnValue(new Promise((resolve) => { healthReady = resolve; }));
    mocks.api.pairStart.mockResolvedValue({ status: 'pending', pairingId: 'p1', code: 'K7Q4M2', display: 'K7Q-4M2', qr: 'https://localhost/p/p1#K7Q4M2', pollSecret: 'secret', expiresAt: Date.now() + 30_000 });
    const { bootWorkbench } = await import('./workbench');
    const booting = bootWorkbench();
    await flush();
    expect(mocks.api.pairStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requireApproval: true }));
    expect(byId('app-header').hidden).toBe(true);
    expect(byId('workbench').classList.contains('pair-only')).toBe(true);
    expect(byId('onboarding').dataset.state).toBe('pairing');
    expect(byId('onboarding-next').textContent).toBe('Scan this QR code with your Quest 3, or enter the code in your headset.');
    expect(byId('self-code').textContent).toBe('K7Q-4M2');
    expect(byId('self-qr').htmlWrites[0]).toContain('<svg');
    for (const id of ['connection-steps', 'headset-open', 'enable-midi', 'paired-summary']) expect(byId(id).hidden).toBe(true);
    healthReady({ mode: 'live', models: { chat: 'meta-model' }, urls: { lan: [] } });
    await booting;
    expect(mocks.api.pairStart).toHaveBeenCalledOnce();
  });

  it('shows pairing confirmation immediately after approval without starting USB onboarding', async () => {
    mocks.identity.mockReturnValue(undefined);
    mocks.api.pairStart.mockResolvedValue({ status: 'pending', pairingId: 'p1', code: 'K7Q4M2', display: 'K7Q-4M2', qr: 'https://localhost/p/p1#K7Q4M2', pollSecret: 'secret', expiresAt: Date.now() + 30_000 });
    mocks.api.pairStatus.mockResolvedValue({ status: 'approved', deviceId: 'mac-1', deviceToken: 'saved-token' });
    await boot('?pair=1');
    await vi.advanceTimersByTimeAsync(600);
    expect(byId('pairscreen').hidden).toBe(true);
    expect(byId('paired-summary').hidden).toBe(false);
    expect(byId('onboarding-title').textContent).toBe('Waiting for Quest 3');
    expect(byId('app-header').hidden).toBe(false);
    const { saveIdentity } = await import('./identity');
    expect(saveIdentity).toHaveBeenCalledWith({ deviceId: 'mac-1', deviceToken: 'saved-token', kind: 'mac', name: 'Mac' });
    const { Connection } = await import('./connection');
    const connection = (Connection as unknown as { instances: { inject(message: { type: string; payload: unknown }): void }[] }).instances.at(-1)!;
    connection.inject({ type: 'presence', payload: { devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] }] } });
    await flush();
    expect(byId('paired-summary').hidden).toBe(false);
    expect(byId('onboarding').dataset.state).toBe('paired');
    expect(byId('onboarding-next').textContent).toContain('opens here automatically');
    expect(byId('paired-next').textContent).toContain('set up and enable controls in Quest');
    expect(byId('enable-midi').hidden).toBe(true);
    expect(byId('connection-steps').hidden).toBe(true);
    expect(byId('setup-activity').hidden).toBe(true);
    expect(mocks.midiEnable).not.toHaveBeenCalled();
  });

  it('reuses the saved token when reloading the short pairing page', async () => {
    const app = await boot('?pair=1');
    const { clearIdentity } = await import('./identity');
    expect(clearIdentity).not.toHaveBeenCalled();
    expect(mocks.api.pairStart).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(byId('pairscreen').hidden).toBe(true);
    await app.emit('presence', { devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] }] });
    expect(byId('paired-summary').hidden).toBe(false);
    expect(byId('enable-midi').hidden).toBe(true);
  });

  it('shows a QR for a new Mac joining an existing room and refreshes it after expiry despite poll errors', async () => {
    mocks.identity.mockReturnValue(undefined);
    mocks.api.health.mockResolvedValue({ mode: 'live', models: { chat: 'meta-model' }, urls: { lan: [] }, space: { pairedDevices: 1 } });
    const request = { status: 'pending', pairingId: 'p1', code: 'K7Q4M2', display: 'K7Q-4M2', qr: 'https://localhost/p/p1#K7Q4M2', pollSecret: 'secret', expiresAt: Date.now() + 1000 };
    mocks.api.pairStart.mockResolvedValueOnce(request).mockResolvedValue({ ...request, pairingId: 'p2', code: 'ABC234', display: 'ABC-234', expiresAt: Date.now() + 30_000 });
    mocks.api.pairStatus.mockRejectedValue(new Error('server restarting'));
    await boot();
    expect(mocks.api.pairStart).toHaveBeenCalledWith(expect.objectContaining({ requireApproval: true }));
    expect(byId('onboarding').dataset.state).toBe('pairing');
    expect(byId('self-code').textContent).toBe('K7Q-4M2');
    expect(byId('self-qr').htmlWrites[0]).toContain('<svg');
    expect(byId('self-expiry').textContent).toContain('Expires in');
    await vi.advanceTimersByTimeAsync(1100);
    expect(mocks.api.pairStart).toHaveBeenCalledTimes(2);
    expect(byId('self-code').textContent).toBe('ABC-234');
  });

  it('does not reopen an explicitly declined pairing request', async () => {
    mocks.identity.mockReturnValue(undefined);
    mocks.api.pairStart.mockResolvedValue({ status: 'pending', pairingId: 'p1', code: 'K7Q4M2', display: 'K7Q-4M2', qr: 'https://localhost/p/p1#K7Q4M2', pollSecret: 'secret', expiresAt: Date.now() + 5000 });
    mocks.api.pairStatus.mockResolvedValue({ status: 'denied' });
    await boot();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.api.pairStart).toHaveBeenCalledOnce();
    expect(byId('self-code').textContent).toBe('No active code');
    expect(byId('self-retry').hidden).toBe(false);
  });

  it('keeps pairing neutral across USB changes, then offers USB help after an explicit setup attempt', async () => {
    const app = await live();
    expect(byId('onboarding').dataset.state).toBe('headset');
    const quest = { deviceId: 'quest', name: 'Quest 3', kind: 'quest', online: true, capabilities: [], ports: [] };
    await app.emit('presence', { devices: [quest] });
    expect(byId('onboarding').dataset.state).toBe('paired');
    expect(byId('enable-midi').hidden).toBe(true);
    await app.emit('device.card', { cardId: 'synth', name: 'OP-1 Field', protocols: ['midi'], category: 'synthesizer' });
    expect(byId('onboarding').dataset.state).toBe('paired');
    mocks.midiEnable.mockImplementation(async () => { mocks.midiEnabled = true; });
    await byId('details-open').fire('click');
    await byId('bridge-midi').fire('click');
    await flush();
    await byId('details-close').fire('click');
    expect(byId('onboarding').dataset.state).toBe('paired');
    mocks.midiPorts = [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }];
    await app.emit('presence', { devices: [quest] });
    expect(byId('onboarding-title').textContent).toBe('Paired with Quest 3');
    expect(byId('synth-status').textContent).toBe('OP-1 Field on USB');
    mocks.midiPorts = [];
    await app.emit('presence', { devices: [quest] });
    expect(byId('onboarding').dataset.state).toBe('paired');
    await app.emit('agent.step', { stepId: 'link-synth', cardId: 'synth', phase: 'link', status: 'fail', title: 'Plug the synth into your Mac' });
    expect(byId('onboarding').dataset.state).toBe('usb');
    expect(byId('connection-steps').hidden).toBe(false);
    await app.emit('mode.state', { mode: 'annotate' });
    expect(byId('onboarding').dataset.state).toBe('paired');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('shows only this Mac’s setup activity and stops the matching run', async () => {
    mocks.midiEnabled = true;
    mocks.midiPorts = [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }];
    const app = await live();
    await app.emit('presence', { devices: [{ deviceId: 'quest', name: 'Quest 3', kind: 'quest', online: true, capabilities: [], ports: [] }] });
    await app.emit('target.status', { cardId: 'other', executorDeviceId: 'mac-2', state: 'verifying', since: 0 });
    expect(byId('setup-activity').hidden).toBe(true);
    await app.emit('target.status', { cardId: 'synth', executorDeviceId: 'mac-1', state: 'verifying', runId: 'run-1', sentence: 'Listening through the headset mic…', since: 0 });
    expect(byId('setup-activity').hidden).toBe(false);
    expect(byId('setup-activity-text').textContent).toBe('Quest is checking OP-1 Field: listening through the headset mic…');
    mocks.send.mockReturnValue(true);
    await byId('setup-stop').fire('click');
    expect(mocks.send).toHaveBeenCalledWith('control.cancel', { cardId: 'synth', runId: 'run-1' }, { to: 'server' });
  });

  it('requests MIDI access only for a synth setup, never for tagging or visual synth setup', async () => {
    const app = await live();
    await app.emit('presence', { devices: [{ deviceId: 'quest', name: 'Quest 3', kind: 'quest', online: true, capabilities: [], ports: [] }] });
    await app.emit('device.card', { cardId: 'visuals', name: 'ControlAnything Visual Synth', protocols: ['midi'], category: 'computer' });
    await app.emit('agent.step', { stepId: 'link-visuals', cardId: 'visuals', phase: 'link', status: 'running', title: 'Connecting to the visual synth' });
    await app.emit('target.status', { cardId: 'visuals', executorDeviceId: 'mac-1', state: 'verifying', runId: 'visual-run', since: 0 });
    expect(byId('onboarding').dataset.state).toBe('paired');
    expect(byId('enable-midi').hidden).toBe(true);
    expect(byId('home-devices').textContent).toContain('ControlAnything Visual Synth');

    await app.emit('device.card', { cardId: 'synth', name: 'OP-1 Field', protocols: ['midi'], category: 'synthesizer' });
    expect(byId('enable-midi').hidden).toBe(true);
    await app.emit('agent.step', { stepId: 'link-synth', cardId: 'synth', phase: 'link', status: 'fail', title: 'Plug the synth into your Mac' });
    expect(byId('onboarding').dataset.state).toBe('midi-permission');
    expect(byId('enable-midi').hidden).toBe(false);
    expect(mocks.midiEnable).not.toHaveBeenCalled();

    await app.emit('mode.state', { mode: 'annotate' });
    expect(byId('onboarding').dataset.state).toBe('paired');
    expect(byId('enable-midi').hidden).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps Open visuals discoverable after selection and explains explicit headset setup and Perform', async () => {
    const opened = vi.fn().mockReturnValue(null); vi.stubGlobal('window', { open: opened });
    const app = await live();
    await app.emit('device.card', { cardId: 'visuals', name: 'ControlAnything Visual Synth', maker: 'ControlAnything', model: 'Visual Synth', protocols: ['midi'], category: 'synthesizer' });
    expect(byId('home-devices').querySelectorAll('button').filter((button) => button.textContent === 'Open visuals')).toHaveLength(1);
    await app.emit('link.result', { cardId: 'visuals', verdict: 'consistent', channel: 'midi', executorDeviceId: 'mac-1', port: { id: 'ce-visual-synth', name: 'ControlAnything Visual Synth' }, evidence: [] });
    const home = byId('home-devices');
    expect(home.textContent).toContain('Try visual synth'); expect(home.textContent).toContain('Perform'); expect(home.textContent).toContain('left fist');
    const open = home.querySelectorAll('button').find((button) => button.textContent === 'Open visuals')!;
    expect(open).toBeDefined(); await open.click();
    expect(opened).not.toHaveBeenCalled();
    expect(mocks.visualOpen).toHaveBeenCalledOnce();
    await flush();
    expect(home.textContent).toContain('Opening visuals…');
    expect(home.textContent).not.toContain('No visual screen was detected');
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.midiEnable).not.toHaveBeenCalled();
  });

  it('shows only this browser’s canonical visual synth on Home while retaining other cards in Details', async () => {
    const app = await live();
    const visual = { maker: 'ControlAnything', model: 'Visual Synth', protocols: ['midi'], category: 'synthesizer' };
    await app.emit('device.card', { ...visual, cardId: 'visual-synth-current', name: 'Current visual synth', notes: 'virtual:visual-synth:mac-1' });
    await app.emit('device.card', { ...visual, cardId: 'legacy-visual', name: 'Legacy visual synth' });
    await app.emit('link.result', { cardId: 'legacy-visual', executorDeviceId: 'mac-1', verdict: 'consistent', channel: 'midi', port: { id: 'ce-visual-synth' }, evidence: [] });
    await app.emit('device.card', { ...visual, cardId: 'visual-synth-other', name: 'Other visual synth', notes: 'virtual:visual-synth:mac-2' });
    const home = byId('home-devices');
    expect(home.querySelectorAll('button').filter((button) => button.textContent === 'Open visuals')).toHaveLength(1);
    expect(home.textContent).toContain('Current visual synth');
    expect(home.textContent).not.toContain('Legacy visual synth');
    expect(home.textContent).not.toContain('Other visual synth');
    await byId('details-open').click(); await flush();
    expect(byId('device-card').textContent).toContain('Other visual synth');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('opens in-page only for an addressed server request and waits for the renderer heartbeat', async () => {
    const app = await live();
    await app.emit('visual.open', { requestId: 'wrong-sender' }, 'other-client', 'mac-1');
    await app.emit('visual.open', { requestId: 'wrong-owner' }, 'server', 'mac-2');
    expect(mocks.visualOpen).not.toHaveBeenCalled();
    await app.emit('visual.open', { requestId: 'valid' }, 'server', 'mac-1');
    expect(mocks.visualOpen).toHaveBeenCalledOnce();
    expect(byId('home-devices').textContent).toContain('Opening visuals');
    expect(byId('home-devices').textContent).not.toContain('Visuals ready');
    mocks.visualConnected = true; mocks.visualChanged?.(); await flush();
    await app.emit('visual.open', { requestId: 'duplicate' }, 'server', 'mac-1');
    expect(mocks.visualOpen).toHaveBeenCalledOnce();
    expect(mocks.midiEnable).not.toHaveBeenCalled();
  });

  it('does not present another browser’s selected visual synth as this browser’s available instrument', async () => {
    const app = await live();
    await app.emit('device.card', { cardId: 'visual-synth-other', name: 'Other visual synth', maker: 'ControlAnything', model: 'Visual Synth', protocols: ['midi'], category: 'synthesizer', notes: 'virtual:visual-synth:mac-2' });
    await app.emit('target.status', { cardId: 'visual-synth-other', executorDeviceId: 'mac-2', state: 'armed', since: 0 });
    const home = byId('home-devices');
    expect(home.textContent).not.toContain('Other visual synth');
    expect(home.textContent).toContain('Visual synth · Virtual screen · Available');
    expect(home.querySelectorAll('button').filter((button) => button.textContent === 'Open visuals')).toHaveLength(1);
  });

  it('withdraws enabled visual controls from Home when their actual renderer disappears', async () => {
    const app = await live();
    const cardId = 'visual-synth-current';
    await app.emit('device.card', { cardId, name: 'Current visual synth', maker: 'ControlAnything', model: 'Visual Synth', protocols: ['midi'], category: 'synthesizer', notes: 'virtual:visual-synth:mac-1' });
    await app.emit('ui.spec', { specId: 'visual-ui', cardId, title: 'Visual controls', widgets: [], gen3d: { controls: [{ id: 'warp', armed: true }], parts: [] } });
    await app.emit('target.status', { cardId, executorDeviceId: 'mac-1', state: 'armed', since: 0 });
    mocks.visualConnected = true; mocks.visualChanged?.(); await flush();
    expect(byId('home-devices').textContent).toContain('Controls enabled');
    mocks.visualConnected = false; mocks.visualChanged?.(); await flush();
    expect(byId('home-devices').textContent).toContain('Unavailable');
    expect(byId('home-devices').textContent).not.toContain('Controls enabled');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('explains a missing renderer heartbeat, recovers when one arrives, and withdraws readiness when it disappears', async () => {
    vi.stubGlobal('window', { open: vi.fn().mockReturnValue(null) });
    await live();
    const home = byId('home-devices');
    await home.querySelectorAll('button').find((button) => button.textContent === 'Open visuals')!.click();
    await flush();
    expect(home.textContent).toContain('Opening visuals…');
    expect(home.textContent).not.toContain('Visuals ready');
    await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(home.textContent).toContain('No visual screen was detected');
    expect(home.textContent).toContain('Bring this paired companion tab to the front');
    expect(home.textContent).toContain('graphics failed');
    mocks.visualConnected = true; mocks.visualChanged?.(); await flush();
    expect(home.textContent).toContain('Visuals ready');
    expect(home.textContent).not.toContain('No visual screen was detected');
    mocks.visualConnected = false; mocks.visualChanged?.(); await flush();
    expect(home.textContent).toContain('Visuals paused');
    expect(home.textContent).not.toContain('Visuals ready');
    expect(home.textContent).toContain('Bring it to the front');
    const { Connection } = await import('./connection');
    const connection = (Connection as unknown as { instances: { open: boolean }[] }).instances.at(-1)!;
    connection.open = false;
    mocks.visualConnected = true; mocks.visualChanged?.(); await flush();
    expect(home.textContent).toContain('Reconnect this companion to your room');
    expect(home.textContent).not.toContain('Visuals ready');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('clears the pending visual-open timeout when the companion page leaves', async () => {
    let pagehide: (() => void) | undefined;
    vi.stubGlobal('addEventListener', (type: string, callback: () => void) => { if (type === 'pagehide') pagehide = callback; });
    vi.stubGlobal('window', { open: vi.fn().mockReturnValue(null) });
    const app = await live();
    const home = byId('home-devices');
    await home.querySelectorAll('button').find((button) => button.textContent === 'Open visuals')!.click();
    await flush();
    expect(home.textContent).toContain('Opening visuals…');
    expect(pagehide).toBeDefined(); pagehide!();
    await app.visibility('visible');
    await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(home.textContent).not.toContain('Opening visuals…');
    expect(home.textContent).not.toContain('No visual screen was detected');
  });

  it('advertises the virtual output connected only while this companion owns a visible renderer', async () => {
    await live();
    const { Connection } = await import('./connection');
    const connection = (Connection as unknown as { instances: { hello(): { ports: unknown[] }; resendHello: ReturnType<typeof vi.fn> }[] }).instances.at(-1)!;
    expect(connection.hello().ports).toContainEqual(expect.objectContaining({ id: 'ce-visual-synth', state: 'disconnected' }));
    mocks.visualConnected = true; mocks.visualChanged?.(); await flush();
    expect(connection.hello().ports).toContainEqual(expect.objectContaining({ id: 'ce-visual-synth', state: 'connected' }));
    expect(connection.resendHello).toHaveBeenCalled(); expect(byId('home-devices').textContent).toContain('Visuals ready');
    mocks.visualConnected = false; mocks.visualChanged?.(); await flush();
    expect(connection.hello().ports).toContainEqual(expect.objectContaining({ id: 'ce-visual-synth', state: 'disconnected' }));
  });

  it('does not call an armed Mac playback panel ready when its visible controls are unverified', async () => {
    const app = await live();
    await app.emit('device.card', { cardId: 'laptop', name: 'Apple MacBook', maker: 'Apple', model: 'MacBook', protocols: ['other'], category: 'computer' });
    await app.emit('target.status', { cardId: 'laptop', executorDeviceId: 'mac-1', state: 'armed', since: 0 });
    await app.emit('tags.state', { tags: [{ cardId: 'laptop', label: 'MacBook', connection: 'offline', hint: 'Mac audio is disabled in this demo. Playback and speech do not run.' }] });
    expect(byId('home-devices').textContent).toContain('Mac audio is disabled');
    expect(byId('home-devices').textContent).toContain('Unavailable');
    expect(byId('home-devices').textContent).not.toContain('Controls enabled');
  });

  it('shows same-Mac ports in a standby tab while keeping MIDI access disabled', async () => {
    mocks.leader = false;
    const app = await live();
    await app.emit('presence', { devices: [
      { deviceId: 'quest', name: 'Quest 3', kind: 'quest', online: true, capabilities: [], ports: [] },
      { deviceId: 'mac-1', name: 'Mac', kind: 'mac', online: true, capabilities: ['midi'], ports: [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }] },
    ] });
    expect(byId('onboarding').dataset.state).toBe('paired');
    expect(byId('synth-status').textContent).toBe('OP-1 Field on USB');
    expect(byId('enable-midi').hidden).toBe(true);
    expect(mocks.midiEnable).not.toHaveBeenCalled();
  });

  it('shares pairing between a stale-token reconnect and the initial health response', async () => {
    let healthReady!: (result: unknown) => void;
    let paired!: (result: unknown) => void;
    mocks.api.health.mockReturnValue(new Promise((resolve) => { healthReady = resolve; }));
    mocks.api.pairStart.mockReturnValue(new Promise((resolve) => { paired = resolve; }));
    const { bootWorkbench } = await import('./workbench');
    const booting = bootWorkbench();
    const { Connection } = await import('./connection');
    const connection = (Connection as unknown as { instances: { onState(state: string, info: { code: number }): void }[] }).instances.at(-1)!;
    connection.onState('closed', { code: 4001 });
    expect(mocks.api.pairStart).toHaveBeenCalledOnce();
    healthReady({ mode: 'live', models: { chat: 'meta-model' }, urls: { lan: [] } });
    await booting;
    expect(mocks.api.pairStart).toHaveBeenCalledOnce();
    paired({ status: 'approved', deviceId: 'mac-2', deviceToken: 'new-token' });
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('retries initial health failure and pairs a fresh browser when the server returns', async () => {
    mocks.identity.mockReturnValue(undefined);
    mocks.api.health.mockRejectedValueOnce(new Error('offline'));
    mocks.api.pairStart.mockResolvedValue({ status: 'approved', deviceId: 'mac-1', deviceToken: 'new-token' });
    const { bootWorkbench } = await import('./workbench');
    await bootWorkbench();
    expect(mocks.api.health).toHaveBeenCalledTimes(1);
    expect(mocks.api.pairStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.api.health).toHaveBeenCalledTimes(2);
    expect(mocks.api.pairStart).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('advertises IR only after the attached Cardputer is approved and identifies the executor tab', async () => {
    await live();
    mocks.serialReady = true;
    const { Connection } = await import('./connection');
    const connection = (Connection as unknown as { instances: { hello(): { capabilities: string[]; ports: unknown[]; executor: boolean } }[] }).instances.at(-1)!;
    expect(connection.hello()).toMatchObject({ executor: true, ports: [{ id: 'ce-visual-synth', kind: 'midi-out', name: 'ControlAnything Visual Synth' }] });
    expect(connection.hello().capabilities).not.toContain('ir');
    mocks.bridgeOnline = true;
    expect(connection.hello().capabilities).toContain('ir');
    expect(connection.hello().ports).toHaveLength(2);
    expect(connection.hello().ports).toContainEqual(expect.objectContaining({ kind: 'serial' }));
    mocks.bridgeOnline = false;
    expect(connection.hello().capabilities).not.toContain('ir');
  });
  it('keeps replay display-only, including disabled bridge and approval actions', async () => {
    mocks.identity.mockReturnValue(undefined);
    const app = await boot('?replay=1');
    expect(byId('onboarding-title').textContent).toBe('Recorded setup demo');
    expect(byId('onboarding-next').textContent).toContain('display-only demo');
    expect(byId('home-title').textContent).toBe('Recorded setup demo');
    for (const id of ['pairscreen', 'headset-open', 'approve-panel', 'enable-midi', 'connection-steps', 'paired-summary']) expect(byId(id).hidden).toBe(true);
    await app.emit('welcome', { canApprove: true });
    await app.emit('pair.pending', pairing());
    for (const id of ['bridge-midi', 'bridge-serial', 'bridge-mic']) {
      expect(byId(id).disabled).toBe(true);
      await byId(id).fire('click');
    }
    byId('code-input').value = 'K7Q-4M2';
    await byId('code-form').fire('submit');
    expect(byId('pair-sheet').open).toBe(false);
    expect(mocks.replay).toHaveBeenCalledOnce();
    for (const operation of [mocks.claim, mocks.attach, mocks.start, mocks.api.health, mocks.api.calls, mocks.api.pending, mocks.api.approve, mocks.permission, mocks.midiEnable, mocks.serialChoose, mocks.serialReconnect, mocks.serialListen, mocks.micStart]) expect(operation).not.toHaveBeenCalled();
  });

  it('claims live execution and renders online and offline presence as safe text', async () => {
    const app = await live();
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    await app.emit('presence', { devices: [
      { deviceId: 'remote-1', name: '<img src=x onerror=alert(1)>', kind: 'cardputer', online: true, capabilities: [], ports: [] },
      { deviceId: 'quest-1', name: 'Quest', kind: 'quest', online: false, capabilities: [], ports: [] },
    ] });
    const rows = byId('device-dots').querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(rows[0].classList.contains('online')).toBe(true);
    expect(rows[1].classList.contains('online')).toBe(false);
    expect(rows[1].getAttribute('aria-label')).toBe('Quest, offline');
    expect(byId('device-dots').querySelector('img')).toBeNull();
    await app.emit('presence', { devices: [] });
    expect(byId('device-dots').children).toHaveLength(0);
  });

  it('updates the plain status and working dot from server progress in stage mode', async () => {
    const app = await boot('?stage=1');
    expect(body.classList.contains('stage')).toBe(true);
    await app.emit('agent.step', { stepId: 'scan-1', phase: 'scan', status: 'running', title: 'Internal scan detail', model: 'meta-model' });
    expect(byId('status-text').textContent).toBe('Scanning the room');
    expect(byId('status-dot').classList.contains('working')).toBe(true);
    await app.emit('target.status', { cardId: 'light', state: 'verified' });
    expect(byId('status-text').textContent).toBe('Checks complete');
    expect(byId('status-dot').classList.contains('working')).toBe(false);
  });

  it('finishes the status exit before replacing the sentence and entering', async () => {
    const app = await live();
    const host = byId('status-text');
    const previous = host.textContent;
    const { animate, animations, easing } = controlStatusAnimations();

    await app.emit('target.status', { cardId: 'light', state: 'verified' });
    expect(host.children).toEqual([previous]);
    expect(animate).toHaveBeenCalledExactlyOnceWith([
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(-4px)' },
    ], { duration: 120, easing, fill: 'forwards' });

    animations[0].onfinish?.();
    expect(host.children).toEqual(['Checks complete']);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenNthCalledWith(2, [
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 160, easing });

    animations[1].onfinish?.();
    await app.emit('target.status', { cardId: 'light', state: 'verifying' });
    expect(animate).toHaveBeenCalledTimes(3);
    expect(host.children).toEqual(['Checks complete']);
  });

  it.each(['exit', 'entry'])('shows the latest status immediately during %s and ignores stale finishes', async (phase) => {
    const app = await live();
    const host = byId('status-text');
    const { animate, animations } = controlStatusAnimations();
    await app.emit('target.status', { cardId: 'light', state: 'verifying' });
    const staleExit = animations[0].onfinish;
    if (phase === 'entry') staleExit?.();
    const active = animations.at(-1)!;
    const staleFinish = active.onfinish;
    const started = animations.length;

    await app.emit('target.status', { cardId: 'light', state: 'verified' });
    expect(host.children).toEqual(['Checks complete']);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.onfinish).toBeNull();
    expect(animate).toHaveBeenCalledTimes(started);
    staleExit?.();
    staleFinish?.();
    expect(host.children).toEqual(['Checks complete']);
    expect(animate).toHaveBeenCalledTimes(started);

    await app.emit('target.status', { cardId: 'light', state: 'forging' });
    const next = animations.at(-1)!;
    staleExit?.();
    staleFinish?.();
    await app.emit('target.status', { cardId: 'light', state: 'forged' });
    expect(next.cancel).toHaveBeenCalledOnce();
    expect(host.children).toEqual(['Controls ready: open Details']);
    expect(animate).toHaveBeenCalledTimes(started + 1);
  });

  it.each(['exit', 'entry'])('keeps the %s running when the desired status repeats', async (phase) => {
    const app = await live();
    const host = byId('status-text');
    const { animate, animations } = controlStatusAnimations();
    await app.emit('target.status', { cardId: 'light', state: 'verifying' });
    if (phase === 'entry') animations[0].onfinish?.();
    const active = animations.at(-1)!;
    const text = host.textContent;
    const started = animations.length;

    await app.emit('target.status', { cardId: 'light', state: 'verifying' });
    expect(host.children).toEqual([text]);
    expect(active.cancel).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(started);
  });

  it('swaps status instantly with reduced motion even when animations are available', async () => {
    const app = await live();
    const { animate } = controlStatusAnimations(true);
    await app.emit('target.status', { cardId: 'light', state: 'verified' });
    expect(byId('status-text').children).toEqual(['Checks complete']);
    expect(animate).not.toHaveBeenCalled();
  });

  it('restores pending requests when an owner reconnects', async () => {
    mocks.api.pending.mockResolvedValue({ pending: [pairing()] });
    await live();
    expect(mocks.api.pending).toHaveBeenCalledWith('owner-token');
    expect(byId('pair-sheet').open).toBe(true);
    expect(byId('pending').textContent).toContain('Room remote');
  });

  it.each(['pair.approved', 'pair.denied'])('ignores a stale pending snapshot after %s', async (type) => {
    const request = pairing();
    let resolve!: (result: { pending: typeof request[] }) => void;
    mocks.api.pending.mockReturnValue(new Promise((done) => { resolve = done; }));
    const app = await live();
    await app.emit('pair.pending', request);
    expect(byId('pair-sheet').open).toBe(true);
    await app.emit(type, { pairingId: request.pairingId, name: request.name, kind: request.kind, reason: 'denied' });
    expect(byId('pair-sheet').open).toBe(false);

    resolve({ pending: [request] });
    await flush();

    expect(byId('pair-sheet').open).toBe(false);
    expect(mocks.api.approve).not.toHaveBeenCalled();
    expect(mocks.api.deny).not.toHaveBeenCalled();
  });

  it('enables each live bridge from its permission pill', async () => {
    await live();
    expect(mocks.midiEnable).not.toHaveBeenCalled();
    expect(mocks.serialChoose).not.toHaveBeenCalled();
    expect(mocks.micStart).not.toHaveBeenCalled();
    for (const id of ['bridge-midi', 'bridge-serial', 'bridge-mic']) {
      expect(byId(id).disabled).toBe(false);
      await byId(id).fire('click');
    }
    expect(mocks.midiEnable).toHaveBeenCalledOnce();
    expect(mocks.serialChoose).toHaveBeenCalledOnce();
    expect(mocks.micStart).toHaveBeenCalledOnce();
  });

  it('opens a pairing sheet and approves its exact code and request', async () => {
    const app = await live();
    await app.emit('pair.pending', pairing());
    expect(byId('pair-sheet').open).toBe(true);
    expect(byId('pending').textContent).toContain('Pair Room remote?');
    expect(byId('pending').textContent).toContain('K7Q-4M2');
    await pairButton('Approve').fire('click');
    await flush();
    expect(mocks.api.approve).toHaveBeenCalledWith('K7Q4M2', 'owner-token', 'pair-1');
    expect(byId('pair-sheet').open).toBe(false);
    expect(byId('code-msg').textContent).toBe('Device paired.');
  });

  it('keeps failed approvals visible and lets the user retry', async () => {
    mocks.api.approve.mockRejectedValueOnce(new Error('Server unavailable'));
    const app = await live();
    await app.emit('pair.pending', pairing());
    await pairButton('Approve').fire('click');
    await flush();
    expect(byId('pair-sheet').open).toBe(true);
    expect(byId('pair-error').textContent).toContain('Server unavailable');
    expect(pairButton('Approve').disabled).toBe(false);
    await pairButton('Approve').fire('click');
    await flush();
    expect(byId('pair-sheet').open).toBe(false);
  });

  it('prevents duplicate approvals while a request is in flight', async () => {
    let resolve!: (result: { pairingId: string }) => void;
    mocks.api.approve.mockReturnValue(new Promise((done) => { resolve = done; }));
    const app = await live();
    await app.emit('pair.pending', pairing());
    await pairButton('Approve').fire('click');
    await pairButton('Approve').fire('click');
    await flush();
    expect(mocks.api.approve).toHaveBeenCalledOnce();
    expect(pairButton('Approve').disabled).toBe(true);
    expect(pairButton('Deny').disabled).toBe(true);
    resolve({ pairingId: 'pair-1' });
    await flush();
    expect(byId('pair-sheet').open).toBe(false);
  });

  it('reports a denied request failure and closes the sheet after a successful retry', async () => {
    mocks.api.deny.mockRejectedValueOnce(new Error('Try again'));
    const app = await live();
    await app.emit('pair.pending', pairing());
    await pairButton('Deny').fire('click');
    await flush();
    expect(byId('pair-error').textContent).toBe('Could not deny: Try again');
    expect(byId('pair-sheet').open).toBe(true);
    await pairButton('Deny').fire('click');
    await flush();
    expect(mocks.api.deny).toHaveBeenLastCalledWith('pair-1', 'owner-token');
    expect(byId('pair-sheet').open).toBe(false);
  });

  it('expires a pairing sheet without approving it', async () => {
    const app = await live();
    await app.emit('pair.pending', { ...pairing(), expiresAt: Date.now() + 300 });
    expect(byId('pair-sheet').open).toBe(true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(byId('pair-sheet').open).toBe(false);
    expect(mocks.api.approve).not.toHaveBeenCalled();
  });

  it('validates typed codes and clears the field only after approval succeeds', async () => {
    await live();
    byId('code-input').value = 'bad';
    await byId('code-form').fire('submit');
    expect(mocks.api.approve).not.toHaveBeenCalled();
    expect(byId('code-msg').textContent).toContain('6 characters');
    byId('code-input').value = 'K7Q-4M2';
    await byId('code-form').fire('submit');
    expect(mocks.api.approve).toHaveBeenCalledWith('K7Q-4M2', 'owner-token', undefined);
    expect(byId('code-input').value).toBe('');
  });

  it('opens and closes Details with an accessible expanded state', async () => {
    await live();
    await byId('details-open').fire('click');
    expect(byId('drawer').hidden).toBe(false);
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('true');
    await byId('details-close').fire('click');
    expect(byId('drawer').hidden).toBe(true);
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('false');
  });

  it('switches Home, Devices, Activity and Details without dropping a live task', async () => {
    const app = await live();
    await app.emit('presence', { devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: ['mic'], ports: [] }] });
    await app.emit('target.status', { cardId: 'light', executorDeviceId: 'mac-1', state: 'verifying', runId: 'run-1', since: 0 });
    await byId('nav-devices').fire('click');
    await flush();
    expect(byId('nav-devices').getAttribute('aria-current')).toBe('page');
    expect(byId('home-view').hidden).toBe(false);
    expect(byId('setup-activity').hidden).toBe(true);

    await byId('nav-activity').fire('click');
    await flush();
    expect(byId('activity-view').hidden).toBe(false);
    expect(byId('home-view').hidden).toBe(true);
    expect(byId('status-text').textContent).toBe('Checking your device');
    expect(byId('nav-devices').getAttribute('aria-current')).toBe('false');

    await byId('details-open').fire('click');
    expect(byId('activity-view').hidden).toBe(true);
    expect(byId('drawer').hidden).toBe(false);
    await byId('nav-home').fire('click');
    await flush();
    expect(byId('drawer').hidden).toBe(true);
    expect(byId('home-view').hidden).toBe(false);
    expect(byId('setup-activity').hidden).toBe(false);
    expect(byId('setup-stop').hidden).toBe(false);
    expect(byId('nav-home').getAttribute('aria-current')).toBe('page');
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('false');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('only shows connection chips for connected USB outputs and an online headset mic', async () => {
    const app = await live();
    expect(byId('home-chips').textContent).toBe('');
    const quest = { deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] };
    await app.emit('presence', { devices: [quest] });
    expect(byId('home-chips').textContent).toBe('');
    mocks.midiPorts = [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }];
    await app.emit('presence', { devices: [{ ...quest, capabilities: ['mic'] }] });
    expect(byId('home-chips').textContent).toContain('USB MIDI connected');
    expect(byId('home-chips').textContent).toContain('Headset mic active');
    mocks.midiPorts = [];
    await app.emit('presence', { devices: [{ ...quest, online: false, capabilities: ['mic'] }] });
    expect(byId('home-chips').textContent).toBe('');
  });

  it('withdraws live headset status on server disconnect without discarding saved pairing', async () => {
    const app = await live();
    const quest = { deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: ['mic'], ports: [] };
    await app.emit('presence', { devices: [quest] });
    expect(byId('home-title').textContent).toBe('Connected to Quest 3');
    expect(byId('home-chips').textContent).toContain('Headset mic active');
    const { Connection } = await import('./connection');
    const connection = (Connection as unknown as { instances: { open: boolean; onState(state: string): void }[] }).instances.at(-1)!;
    connection.open = false; connection.onState('closed'); await flush();
    expect(byId('paired-summary').hidden).toBe(false);
    expect(byId('home-title').textContent).toBe('Waiting for your headset');
    expect(byId('headset-status').classList.contains('connected')).toBe(false);
    expect(byId('home-chips').textContent).not.toContain('Headset mic active');
    expect(byId('paired-next').textContent).toContain('when the server is ready');
    connection.open = true; connection.onState('open');
    await app.emit('presence', { devices: [quest] });
    expect(byId('home-title').textContent).toBe('Connected to Quest 3');
    expect(mocks.api.pairStart).not.toHaveBeenCalled();
  });

  it('stops a local target’s active run and hides Stop when its controls are ready', async () => {
    const app = await live();
    await app.emit('presence', { devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] }] });
    await app.emit('device.card', { cardId: 'laptop', name: 'MacBook', protocols: ['local'], category: 'computer' });
    await app.emit('link.result', { linkId: 'link-laptop', cardId: 'laptop', channel: 'local', verdict: 'confirmed', evidence: [] });
    await app.emit('target.status', { cardId: 'laptop', executorDeviceId: 'server', runId: 'run-laptop', state: 'verifying', since: 0 });
    expect(byId('setup-stop').hidden).toBe(false);
    expect(byId('setup-progress').hidden).toBe(false);
    mocks.send.mockReturnValue(true);
    await byId('setup-stop').fire('click');
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('control.cancel', { cardId: 'laptop', runId: 'run-laptop' }, { to: 'server' });
    await app.emit('target.status', { cardId: 'laptop', executorDeviceId: 'server', state: 'armed', since: 0 });
    expect(byId('setup-stop').hidden).toBe(true);
    expect(byId('setup-progress').hidden).toBe(true);
    await app.emit('target.status', { cardId: 'laptop', executorDeviceId: 'server', state: 'controlling', since: 0 });
    expect(byId('setup-stop').hidden).toBe(true);
    expect(byId('setup-progress').hidden).toBe(true);
  });

  it('shows and stops the active local target while a MIDI target is already ready', async () => {
    mocks.midiEnabled = true;
    mocks.midiPorts = [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }];
    const app = await live();
    await app.emit('presence', { devices: [{ deviceId: 'quest', kind: 'quest', name: 'Quest 3', online: true, capabilities: [], ports: [] }] });
    await app.emit('device.card', { cardId: 'synth', name: 'OP-1 Field', protocols: ['midi'], category: 'synthesizer' });
    await app.emit('target.status', { cardId: 'synth', executorDeviceId: 'mac-1', state: 'armed', since: 0 });
    await app.emit('device.card', { cardId: 'laptop', name: 'MacBook', protocols: ['local'], category: 'computer' });
    await app.emit('link.result', { linkId: 'link-laptop', cardId: 'laptop', channel: 'local', verdict: 'confirmed', evidence: [] });
    await app.emit('target.status', { cardId: 'laptop', executorDeviceId: 'server', runId: 'run-laptop', state: 'verifying', since: 0 });
    expect(byId('setup-activity-text').textContent).toBe('Checking MacBook…');
    expect(byId('setup-stop').hidden).toBe(false);
    mocks.send.mockReturnValue(true);
    await byId('setup-stop').fire('click');
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('control.cancel', { cardId: 'laptop', runId: 'run-laptop' }, { to: 'server' });
  });

  it('clears corrected-object controls and evidence across reconnect snapshots while preserving other devices', async () => {
    const app = await live();
    const oldDriver = { driverId: 'keyboard-driver', cardId: 'object', name: 'Keyboard controls', transport: 'local',
      executor: { deviceId: 'mac-1' }, provenance: [], actions: [{ actionId: 'play', label: 'Start playback', kind: 'trigger', encode: { kind: 'local', op: 'play' }, verified: 'pass' }] };
    const oldSpec = { specId: 'keyboard-ui', cardId: 'object', driverId: oldDriver.driverId, title: 'Keyboard controls', widgets: [] };
    const oldLink = { linkId: 'keyboard-link', cardId: 'object', channel: 'local', verdict: 'confirmed', evidence: [] };
    const oldEvidence = { evidenceId: 'keyboard-evidence', cardId: 'object', driverId: oldDriver.driverId, actionId: 'play', execId: 'old-send', attempt: 1,
      sent: { op: { kind: 'local', op: 'play' }, at: Date.now() }, expected: { sense: 'ack', effect: 'any' },
      observed: { sense: 'ack', metric: 'ack', before: 0, after: 1, delta: 1, threshold: 1 }, pass: true };
    await app.emit('device.card', { cardId: 'object', name: 'External wired keyboard', maker: 'Unknown', model: 'Keyboard', protocols: ['local'], category: 'computer' });
    await app.emit('driver.spec', oldDriver); await app.emit('ui.spec', oldSpec);
    await app.emit('link.result', oldLink); await app.emit('verify.result', oldEvidence);
    await app.emit('driver.status', { driverId: oldDriver.driverId, cardId: 'object', phase: 'disarmed', actions: [{ actionId: 'play', verified: 'pass' }] });
    await app.emit('device.card', { cardId: 'other', name: 'Other synth', maker: 'Example', model: 'Other', protocols: ['midi'], category: 'synthesizer' });
    await app.emit('driver.spec', { driverId: 'other-driver', cardId: 'other', name: 'Other synth', transport: 'midi', executor: { deviceId: 'mac-1' }, provenance: [], actions: [] });
    await app.emit('ui.spec', { specId: 'other-ui', cardId: 'other', title: 'Other synth controls', widgets: [] });
    const otherTag = { cardId: 'other', label: 'Other synth', identityRevision: 0, connection: 'setup', specId: 'other-ui' };
    await app.emit('tags.state', { tags: [{ cardId: 'object', label: 'Keyboard', identityRevision: 0, connection: 'setup', specId: oldSpec.specId }, otherTag] });
    const select = async (name: string) => {
      const row = byId('home-devices').querySelectorAll('.device-row').find((candidate) => candidate.textContent.includes(name))!;
      await row.querySelector('button')!.fire('click'); await flush();
    };
    await select('External wired keyboard');
    expect(byId('code').textContent).toContain(oldDriver.driverId);
    expect(byId('spec').textContent).toContain(oldSpec.specId);
    expect(byId('evidence').querySelectorAll('.ev')).toHaveLength(1);
    await app.emit('device.card', { cardId: 'object', name: 'OP-1 Field', maker: 'Teenage Engineering', model: 'OP-1 Field', protocols: ['midi'], category: 'synthesizer' });
    await app.emit('target.status', { cardId: 'object', runId: 'corrected-run', state: 'identified', since: Date.now() });
    const correctedTag = { cardId: 'object', label: 'OP-1 Field', identityRevision: 1, connection: 'setup', hint: 'Review an incoming MIDI chart before setup.' };
    await app.emit('tags.state', { tags: [correctedTag, otherTag] });
    expect(byId('device-card').textContent).toContain('OP-1 Field');
    expect(byId('device-card').textContent).toContain('Owner-confirmed identity');
    expect(byId('device-card').textContent).not.toContain('Seen by camera');
    expect(byId('device-card').textContent).not.toContain('Local connected');
    expect(byId('code').textContent).toContain('No driver yet');
    expect(byId('spec').textContent).not.toContain(oldSpec.specId);
    expect(byId('evidence').querySelectorAll('.ev')).toHaveLength(0);
    expect(byId('home-devices').textContent).toContain('OP-1 Field · USB MIDI · Needs setup');

    // A reconnect and delayed old artifacts cannot restore the previous UI or lower the revision.
    await app.emit('welcome', { canApprove: true, name: 'Mac', kind: 'mac', deviceId: 'mac-1' });
    await app.emit('driver.spec', oldDriver); await app.emit('ui.spec', oldSpec);
    await app.emit('link.result', oldLink); await app.emit('verify.result', oldEvidence);
    await app.emit('tags.state', { tags: [{ cardId: 'object', label: 'Keyboard', identityRevision: 0, connection: 'ready', specId: oldSpec.specId }, otherTag] });
    expect(byId('code').textContent).toContain('No driver yet');
    expect(byId('spec').textContent).not.toContain(oldSpec.specId);
    expect(byId('evidence').querySelectorAll('.ev')).toHaveLength(0);
    expect(byId('home-devices').textContent).toContain(correctedTag.hint);
    await select('Other synth');
    expect(byId('code').textContent).toContain('other-driver');
    expect(byId('spec').textContent).toContain('other-ui');
    await select('OP-1 Field');
    await app.emit('driver.spec', { ...oldDriver, driverId: 'corrected-driver', name: 'Reviewed Field controls', transport: 'midi', actions: [] });
    await app.emit('ui.spec', { ...oldSpec, specId: 'corrected-ui', driverId: 'corrected-driver', title: 'Reviewed Field controls' });
    await app.emit('tags.state', { tags: [{ ...correctedTag, specId: 'corrected-ui' }, otherTag] });
    expect(byId('code').textContent).toContain('corrected-driver');
    expect(byId('spec').textContent).toContain('corrected-ui');
    // Snapshot/focus changes may fetch a saved Canvas; correction never starts controls or setup.
    expect(mocks.send.mock.calls.map(([type]) => type).filter((type) => type !== 'canvas.get')).toEqual([]);
  });

  it('keeps the selected device’s driver, spec and checks separate when action IDs are reused', async () => {
    const app = await live();
    const result = (cardId: string, value: number) => ({
      evidenceId: `e-${cardId}`, cardId, driverId: `driver-${cardId}`, actionId: 'level', execId: `x-${cardId}`, attempt: 1,
      sent: { op: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value }, at: Date.now() },
      expected: { sense: 'audio', effect: 'tone-up' },
      observed: { sense: 'audio', metric: 'centroid', before: 400, after: 800, delta: 400, threshold: 0.3 },
      pass: true,
    });
    for (const [cardId, name, value] of [['synth-a', 'First synth', 40], ['synth-b', 'Second synth', 90]] as const) {
      const model = cardId === 'synth-a' ? 'muse-spark-1.3' : 'muse-wonder-1.0';
      await app.emit('device.card', { cardId, name, maker: 'Maker', model: name, category: 'synthesizer', protocols: ['midi'] });
      await app.emit('agent.step', { stepId: `write-${cardId}`, cardId, phase: 'drive', status: 'ok', title: `Driver ready for ${name}`, model, latencyMs: 2000 });
      await app.emit('driver.spec', {
        driverId: `driver-${cardId}`, cardId, name, modelId: model, transport: 'midi', executor: { deviceId: 'mac-1', port: cardId }, provenance: [],
        actions: [{ actionId: 'level', label: `${name} level`, kind: 'set', encode: { kind: 'midi', msg: 'cc', channel: 1, number: 46, value: '$value' }, verified: 'pass' }],
      });
      await app.emit('ui.spec', { specId: `spec-${cardId}`, cardId, title: `${name} controls`, widgets: [] });
      await app.emit('verify.result', result(cardId, value));
    }
    const row = byId('home-devices').querySelectorAll('.device-row').find((candidate) => candidate.textContent.includes('First synth'))!;
    await row.querySelector('button')!.fire('click');
    await flush();
    expect(byId('drawer').hidden).toBe(false);
    expect(byId('device-card').textContent).toContain('First synth');
    expect(byId('device-card').textContent).not.toContain('Second synth');
    expect(byId('code').textContent).toContain('driver-synth-a');
    expect(byId('code').textContent).not.toContain('driver-synth-b');
    expect(byId('gen-chip').textContent).toContain('muse-spark-1.3');
    await app.emit('agent.step', { stepId: 'rewrite-synth-b', cardId: 'synth-b', phase: 'drive', status: 'running', title: 'Updating the second driver', model: 'muse-wonder-1.0' });
    await app.emit('device.card', { cardId: 'synth-b', name: 'Second synth updated', protocols: ['midi'], category: 'synthesizer' });
    await app.emit('driver.spec', { driverId: 'driver-synth-b-new', cardId: 'synth-b', name: 'Second synth updated', modelId: 'muse-wonder-1.0', transport: 'midi', executor: { deviceId: 'mac-1', port: 'synth-b' }, provenance: [], actions: [] });
    expect(byId('device-card').textContent).toContain('First synth');
    expect(byId('code').textContent).toContain('driver-synth-a');
    expect(byId('code').textContent).not.toContain('driver-synth-b');
    expect(byId('gen-chip').textContent).toContain('muse-spark-1.3');
    expect(byId('gen-chip').textContent).not.toContain('muse-wonder-1.0');
    expect(byId('spec').textContent).toContain('spec-synth-a');
    expect(byId('spec').textContent).not.toContain('spec-synth-b');
    expect(byId('evidence').querySelectorAll('.ev')).toHaveLength(1);
    expect(byId('evidence').textContent).toContain('Sent CC 46 → 40');
    expect(byId('evidence').textContent).not.toContain('Sent CC 46 → 90');
    expect(byId('evidence').querySelectorAll('.step-pill').map((pill) => [pill.textContent, pill.classList.contains('done')])).toEqual([
      ['Generated', true], ['Checked', true], ['Sent', true], ['Heard', true],
    ]);
    const details = byId('evidence').querySelector('details')!;
    details.open = true;
    await app.emit('verify.result', { ...result('synth-a', 41), evidenceId: 'e-new', attempt: 2 });
    expect(byId('evidence').querySelector('details')!.open).toBe(true);
    expect(byId('evidence').textContent).toContain('Sent CC 46 → 41');
    expect(byId('evidence').querySelector('svg')!.getAttribute('width')).toBe('76');
    expect(byId('evidence').querySelector('svg')!.getAttribute('height')).toBe('26');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('supports keyboard navigation of the code tabs', async () => {
    await live();
    const event = await byId('tab-code').fire('keydown', { key: 'ArrowRight' });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(byId('tab-tape').getAttribute('aria-selected')).toBe('true');
    expect(byId('tape').hidden).toBe(false);
    expect(byId('code').hidden).toBe(true);
    expect(document.activeElement).toBe(byId('tab-tape'));
    await byId('tab-tape').fire('keydown', { key: 'End' });
    expect(byId('tab-spec').getAttribute('aria-selected')).toBe('true');
    expect(byId('spec').hidden).toBe(false);
    expect(document.activeElement).toBe(byId('tab-spec'));
  });

  it('renders agent steps as a readable table with model latency and current wording', async () => {
    const app = await live();
    await app.emit('agent.step', { stepId: 'make-1', phase: 'forge', status: 'ok', title: 'Hack set ready: 5 hacks (2 controls)', model: 'muse-spark-1.3', effort: 'low', latencyMs: 16_000 });
    expect(byId('worklog').querySelectorAll('th').map((heading) => heading.textContent)).toEqual(['Time', 'Step', 'Message', 'Model']);
    expect(byId('worklog').textContent).toContain('Making controls');
    expect(byId('worklog').textContent).toContain('Control set ready: 5 controls (2 sliders)');
    expect(byId('worklog').textContent).toContain('muse-spark-1.3 · low · 16 s');
  });
});
