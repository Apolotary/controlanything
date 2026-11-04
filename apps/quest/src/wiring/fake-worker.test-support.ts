import vm from 'node:vm';

/** A Worker stand-in that runs the real worker script in a vm context with the dangerous globals present. */
export function fakeWorkerFactory(log: { posted: unknown[]; scope?: Record<string, unknown> } = { posted: [] }, options: { reply?: boolean } = {}) {
  return (source: string): Worker => {
    const worker: Record<string, unknown> = { onmessage: null, onerror: null, terminated: false };
    const scope: Record<string, unknown> = {
      performance, console,
      fetch: () => 'network', XMLHttpRequest: class {}, WebSocket: class {}, indexedDB: {}, caches: {}, importScripts: () => {}, Worker: class {},
      postMessage: (data: unknown) => { log.posted.push(data); queueMicrotask(() => (worker.onmessage as ((e: unknown) => void) | null)?.({ data })); },
    };
    scope.self = scope; log.scope = scope;
    vm.createContext(scope);
    vm.runInContext(source, scope);
    worker.postMessage = (m: unknown) => {
      if (options.reply === false && (m as { type: string }).type === 'tick') return; // a worker that never answers (a hot loop)
      queueMicrotask(() => (scope.onmessage as (e: unknown) => void)({ data: m }));
    };
    worker.terminate = () => { worker.terminated = true; };
    return worker as unknown as Worker;
  };
}

