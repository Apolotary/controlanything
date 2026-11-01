/**
 * Cancellation helpers for model calls.
 * Adapted from the author's own earlier prototype written during this hackathon (Oct 29–Nov 1).
 */
import type { Request, Response } from 'express';

export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled.');
    this.name = 'RequestCancelledError';
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestCancelledError();
}

/** Connect a caller's cancellation to a per-fetch controller with its own timeout. */
export function forwardCancellation(signal: AbortSignal | undefined, controller: AbortController): () => void {
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}

export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RequestCancelledError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new RequestCancelledError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Abort model work when the HTTP client goes away (but not after a normal completed response). */
export function requestCancellation(req: Request, res: Response): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', close);
  if (req.destroyed || res.destroyed) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    },
  };
}
