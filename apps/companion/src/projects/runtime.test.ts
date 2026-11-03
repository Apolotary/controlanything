import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '@ce/protocol';
import { ProjectRuntime, projectSrcdoc, validFrameAction, type RuntimeIdentity } from './runtime';

const document: ProjectDocument = { projectId: 'project-one', revision: 2, createdAt: 1, prompt: 'Orb', source: 'fixture', spec: { title: 'Orb', description: '', html: '<div id="orb"></div>', css: '', js: '', actions: [{ id: 'amount', label: 'Amount', kind: 'number', min: 0, max: 1, initial: .5 }, { id: 'shuffle', label: 'Shuffle', kind: 'trigger' }] } };
const identity: RuntimeIdentity = { projectId: document.projectId, revision: document.revision, nonce: 'random_nonce_1234' };
const message = (extra = {}) => ({ channel: 'muse-canvas', kind: 'action', ...identity, actionId: 'amount', value: .7, ...extra });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('generated page sandbox contract', () => {
  it('encodes markup and script terminators as data and permits only its explicit nonce script', () => {
    const source = projectSrcdoc({ ...document, spec: { ...document.spec, html: '</script><script>alert(1)</script>', css: '</style><img src="https://bad.invalid">', js: 'const a="</script>";' } }, identity);
    expect(source.match(/<script(?:\s|>)/g)).toHaveLength(1);
    expect(source.match(/<\/script>/g)).toHaveLength(1);
    expect(source).not.toContain('<script>alert(1)');
    expect(source).toContain("connect-src 'none'"); expect(source).toContain("frame-src 'none'"); expect(source).toContain("worker-src 'none'");
    expect(source).toContain("script-src 'nonce-random_nonce_1234'");
    expect(source).toContain("template.content.querySelectorAll('script,iframe,frame,object,embed,base,meta,link,form')");
    expect(() => projectSrcdoc(document, { ...identity, nonce: '"><script>' })).toThrow('Invalid frame nonce');
  });
  it('rejects stale/forged messages and validates declared action ranges', () => {
    expect(validFrameAction(message(), identity, document)).toEqual({ actionId: 'amount', value: .7 });
    for (const patch of [{ nonce: 'other' }, { revision: 1 }, { projectId: 'other' }, { actionId: 'constructor' }, { value: NaN }, { value: 2 }, { kind: 'execute' }]) expect(validFrameAction(message(patch), identity, document)).toBeUndefined();
    expect(validFrameAction(message(), identity, { ...document, revision: 3 })).toBeUndefined();
    expect(validFrameAction(message({ actionId: 'shuffle', value: undefined }), identity, document)).toEqual({ actionId: 'shuffle' });
    expect(validFrameAction(message({ actionId: 'shuffle', value: 2 }), identity, document)).toBeUndefined();
  });
  it('binds messages to the exact opaque frame and discards the frame on Stop or navigation', () => {
    vi.useFakeTimers();
    let listener: (event: MessageEvent) => void = () => {};
    const attributes = new Map<string, string>();
    const frame = { id: '', title: '', srcdoc: '', referrerPolicy: '', onload: () => {}, contentWindow: { postMessage: vi.fn() }, remove: vi.fn(), setAttribute: (key: string, value: string) => attributes.set(key, value) };
    vi.stubGlobal('window', { document: { createElement: () => frame }, addEventListener: (_name: string, callback: typeof listener) => { listener = callback; }, removeEventListener: vi.fn() });
    const action = vi.fn(), status = vi.fn(), preview = vi.fn();
    const runtime = new ProjectRuntime({ replaceChildren: vi.fn() } as unknown as HTMLElement, action, status, preview);
    runtime.start(document, { amount: .5, shuffle: 0 });
    expect(attributes.get('sandbox')).toBe('allow-scripts'); expect(attributes.get('allow')).toContain("midi 'none'");
    const nonce = frame.srcdoc.match(/script-src 'nonce-([^']+)'/)![1]!;
    const data = message({ nonce });
    listener({ source: frame.contentWindow, origin: 'null', data } as unknown as MessageEvent);
    expect(runtime.ready).toBe(false); expect(preview).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
    listener({ source: frame.contentWindow, origin: 'null', data: { ...data, kind: 'ready' } } as unknown as MessageEvent);
    expect(runtime.ready).toBe(true); expect(preview).toHaveBeenLastCalledWith({ ...identity, nonce });
    listener({ source: {}, origin: 'null', data } as MessageEvent); listener({ source: frame.contentWindow, origin: 'http://localhost', data } as unknown as MessageEvent);
    expect(action).not.toHaveBeenCalled();
    listener({ source: frame.contentWindow, origin: 'null', data } as unknown as MessageEvent); expect(action).toHaveBeenCalledOnce();
    runtime.stop(); listener({ source: frame.contentWindow, origin: 'null', data } as unknown as MessageEvent); expect(action).toHaveBeenCalledOnce();
    expect(runtime.ready).toBe(false); expect(preview).toHaveBeenLastCalledWith();
    expect(runtime.running).toBe(false); expect(frame.remove).toHaveBeenCalled();
    runtime.start(document, {}); frame.onload(); frame.onload(); expect(runtime.running).toBe(false); expect(status).toHaveBeenLastCalledWith('Preview stopped after a navigation attempt.', true);
    runtime.start(document, {});
    const newNonce = frame.srcdoc.match(/script-src 'nonce-([^']+)'/)![1]!;
    const failed = message({ nonce: newNonce, kind: 'error', message: 'Script failed' });
    listener({ source: frame.contentWindow, origin: 'null', data: failed } as unknown as MessageEvent);
    listener({ source: frame.contentWindow, origin: 'null', data: { ...failed, kind: 'ready' } } as unknown as MessageEvent);
    expect(runtime.running).toBe(false); expect(runtime.ready).toBe(false); expect(status).toHaveBeenLastCalledWith('Preview error: Script failed', true);
    runtime.dispose();
  });
});
