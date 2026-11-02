import type { IncomingHttpHeaders } from 'node:http';

/** Browser pages may use either server port; native clients have no Origin. */
export function sameHostOrigin(headers: Pick<IncomingHttpHeaders, 'origin' | 'host'>): boolean {
  if (!headers.origin || !headers.host) return false;
  try {
    const origin = new URL(headers.origin);
    const host = new URL(`http://${headers.host}`);
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && origin.origin === headers.origin && origin.hostname === host.hostname;
  } catch {
    return false;
  }
}

export function allowedSocketOrigin(headers: Pick<IncomingHttpHeaders, 'origin' | 'host'>): boolean {
  return headers.origin === undefined || sameHostOrigin(headers);
}
