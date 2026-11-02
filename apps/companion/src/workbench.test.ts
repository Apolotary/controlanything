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
}));

vi.mock('./api', () => ({ api: mocks.api, ApiError: class extends Error {} }));
vi.mock('./identity', () => ({
  loadIdentity: () => ({ deviceId: 'mac-1', deviceToken: 'owner-token', kind: 'mac', name: 'Mac' }),
  clearIdentity: vi.fn(), saveIdentity: vi.fn(), isLocalPage: () => true,
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
    constructor() { Connection.instances.push(this); }
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
    claim() { mocks.claim(); this.leader = true; this.onLeader?.(true); }
    attach = mocks.attach;
    panicLocal = vi.fn();
  },
}));
vi.mock('./midi', () => ({
  MidiBridge: class {
    static supported = true;
    static alreadyGranted = async () => false;
    enabled = false;
    outputs = () => [];
    inputs = () => [];
    ports = () => [];
    enable = mocks.midiEnable;
  },
}));
vi.mock('./midiExec', () => ({ MidiExecutor: class { scheduler = { rate: () => 0 }; } }));
vi.mock('./serial/cardputer', () => ({
  CardputerLink: class {
    static supported = true;
    ready = false;
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
  hasAttribute(name: string) { return name === 'open' ? this.open : this.attributes.has(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  addEventListener(type: string, callback: (event: unknown) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  async fire(type: string) {
    const event = { target: this, preventDefault: vi.fn() };
    for (const handler of this.listeners.get(type) ?? []) await handler(event);
    return event;
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (child: Element) => selector.startsWith('#') ? child.id === selector.slice(1)
      : selector.startsWith('[data-') ? selector.slice(6, -1) in child.dataset : child.tagName === selector;
    return this.children.flatMap((child) => child instanceof Element ? [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

let body: Element;
const byId = (id: string) => {
  const element = body.querySelector(`#${id}`);
  if (!element) throw new Error(`Missing companion element: ${id}`);
  return element;
};
const flush = () => vi.advanceTimersByTimeAsync(160);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  body = new Element('body');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    element.id = match[2];
    body.append(element);
  }
  byId('code-form').append(new Element('button'));
  vi.stubGlobal('document', {
    body, visibilityState: 'visible',
    getElementById: (id: string) => body.querySelector(`#${id}`),
    createElement: (tag: string) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  });
  vi.stubGlobal('location', new URL('http://localhost/companion/'));
  vi.stubGlobal('navigator', { permissions: { query: mocks.permission } });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  mocks.permission.mockResolvedValue({ state: 'prompt' });
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
  const emit = async (type: string, payload: unknown) => { connection.inject({ type, payload }); await flush(); };
  return { emit };
}

async function live() {
  const app = await boot();
  await app.emit('welcome', { canApprove: true, name: 'Mac', kind: 'mac', deviceId: 'mac-1' });
  return app;
}

const pairing = () => ({ pairingId: 'pair-1', code: 'K7Q4M2', display: 'K7Q-4M2', name: 'Room remote', kind: 'cardputer', expiresAt: Date.now() + 5000 });
const pairButton = (name: string) => {
  const button = byId('pending').querySelectorAll('button').find((candidate) => candidate.textContent === name);
  if (!button) throw new Error(`Missing pairing button: ${name}`);
  return button;
};

describe('Calm companion behavior', () => {
  it('keeps replay display-only, including disabled bridge and approval actions', async () => {
    const app = await boot('?replay=1');
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
    expect(byId('status-text').textContent).toBe('Testing complete');
    expect(byId('status-dot').classList.contains('working')).toBe(false);
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
    expect(byId('drawer').open).toBe(true);
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('true');
    const event = await byId('drawer').fire('cancel');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(byId('drawer').open).toBe(false);
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('false');
  });
});
