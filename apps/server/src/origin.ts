import type { IncomingHttpHeaders } from 'node:http';
import { networkInterfaces } from 'node:os';
import { localHostnames } from './net';

/** Reject DNS rebinding before a loopback connection can acquire owner privileges. */
export function trustedServerHost(host: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!host || /[\s/@\\?#]/.test(host)) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '');
    if (hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;
    const hosts = [...localHostnames(), ...extraHosts];
    for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) hosts.push(address.address);
    return hosts.some((value) => value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') === hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

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

/** The bridge's HTTP and HTTPS ports share ownership; unrelated pages on other local ports do not. */
export function sameBridgeOrigin(headers: Pick<IncomingHttpHeaders, 'origin' | 'host'>, ports: readonly number[]): boolean {
  if (!sameHostOrigin(headers)) return false;
  const origin = new URL(headers.origin!);
  return ports.includes(Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)));
}

export function allowedSocketOrigin(headers: Pick<IncomingHttpHeaders, 'origin' | 'host'>, ports?: readonly number[]): boolean {
  return headers.origin === undefined || (ports ? sameBridgeOrigin(headers, ports) : sameHostOrigin(headers));
}
