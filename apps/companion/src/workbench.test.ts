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
  identity: vi.fn(), bridgeOnline: false, serialReady: false,
  leader: true, midiEnabled: false,
  midiPorts: [] as { id: string; kind: 'midi-out'; name: string; state: 'connected' }[],
}));

vi.mock('./api', () => ({ api: mocks.api, ApiError: class extends Error {} }));
vi.mock('./identity', () => ({
  loadIdentity: mocks.identity,
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
  mocks.bridgeOnline = false;
  mocks.serialReady = false;
  mocks.leader = true;
  mocks.midiEnabled = false;
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
    expect(byId('onboarding-next').textContent).toBe('Look at this QR code with your Quest 3.');
    expect(byId('self-code').textContent).toBe('K7Q-4M2');
    expect(byId('self-qr').htmlWrites[0]).toContain('<svg');
    for (const id of ['connection-steps', 'headset-open', 'enable-midi', 'paired-summary']) expect(byId(id).hidden).toBe(true);
    healthReady({ mode: 'live', models: { chat: 'meta-model' }, urls: { lan: [] } });
    await booting;
    expect(mocks.api.pairStart).toHaveBeenCalledOnce();
  });

  it('shows pairing confirmation immediately after approval, then keeps the USB steps', async () => {
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
    expect(byId('onboarding').dataset.state).toBe('midi-permission');
    expect(byId('enable-midi').hidden).toBe(false);
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
    expect(byId('enable-midi').hidden).toBe(false);
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
    expect(byId('self-expiry').textContent).toContain('expires in');
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

  it('updates the primary panel on headset connection, USB appearance and unplug', async () => {
    const app = await live();
    expect(byId('onboarding').dataset.state).toBe('headset');
    const quest = { deviceId: 'quest', name: 'Quest 3', kind: 'quest', online: true, capabilities: [], ports: [] };
    await app.emit('presence', { devices: [quest] });
    expect(byId('onboarding').dataset.state).toBe('midi-permission');
    expect(byId('enable-midi').hidden).toBe(false);
    mocks.midiEnable.mockImplementation(async () => { mocks.midiEnabled = true; });
    await byId('enable-midi').fire('click');
    await flush();
    expect(byId('onboarding').dataset.state).toBe('usb');
    mocks.midiPorts = [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }];
    await app.emit('presence', { devices: [quest] });
    expect(byId('onboarding-title').textContent).toBe('Set it up from the headset');
    expect(byId('synth-status').textContent).toBe('OP-1 Field on USB');
    mocks.midiPorts = [];
    await app.emit('presence', { devices: [quest] });
    expect(byId('onboarding').dataset.state).toBe('usb');
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
    expect(byId('setup-activity-text').textContent).toBe('Quest is testing OP-1 Field: listening through the headset mic…');
    mocks.send.mockReturnValue(true);
    await byId('setup-stop').fire('click');
    expect(mocks.send).toHaveBeenCalledWith('control.cancel', { cardId: 'synth', runId: 'run-1' }, { to: 'server' });
  });

  it('shows same-Mac ports in a standby tab while keeping MIDI access disabled', async () => {
    mocks.leader = false;
    const app = await live();
    await app.emit('presence', { devices: [
      { deviceId: 'quest', name: 'Quest 3', kind: 'quest', online: true, capabilities: [], ports: [] },
      { deviceId: 'mac-1', name: 'Mac', kind: 'mac', online: true, capabilities: ['midi'], ports: [{ id: 'op1', kind: 'midi-out', name: 'OP-1 Field', state: 'connected' }] },
    ] });
    expect(byId('onboarding').dataset.state).toBe('setup');
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
    expect(connection.hello()).toMatchObject({ executor: true, ports: [] });
    expect(connection.hello().capabilities).not.toContain('ir');
    mocks.bridgeOnline = true;
    expect(connection.hello().capabilities).toContain('ir');
    expect(connection.hello().ports).toHaveLength(1);
    mocks.bridgeOnline = false;
    expect(connection.hello().capabilities).not.toContain('ir');
  });
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
    expect(host.children).toEqual(['Testing complete']);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenNthCalledWith(2, [
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 160, easing });

    animations[1].onfinish?.();
    await app.emit('target.status', { cardId: 'light', state: 'verifying' });
    expect(animate).toHaveBeenCalledTimes(3);
    expect(host.children).toEqual(['Testing complete']);
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
    expect(host.children).toEqual(['Testing complete']);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.onfinish).toBeNull();
    expect(animate).toHaveBeenCalledTimes(started);
    staleExit?.();
    staleFinish?.();
    expect(host.children).toEqual(['Testing complete']);
    expect(animate).toHaveBeenCalledTimes(started);

    await app.emit('target.status', { cardId: 'light', state: 'forging' });
    const next = animations.at(-1)!;
    staleExit?.();
    staleFinish?.();
    await app.emit('target.status', { cardId: 'light', state: 'forged' });
    expect(next.cancel).toHaveBeenCalledOnce();
    expect(host.children).toEqual(['Controls created: open Details']);
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
    expect(byId('status-text').children).toEqual(['Testing complete']);
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
    expect(byId('drawer').open).toBe(true);
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('true');
    const event = await byId('drawer').fire('cancel');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(byId('drawer').open).toBe(false);
    expect(byId('details-open').getAttribute('aria-expanded')).toBe('false');
  });
});
