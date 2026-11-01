import { hostname, networkInterfaces } from 'node:os';

/** Non-internal IPv4 addresses, best guess for "the LAN address" first (en0/wlan, private ranges). */
export function lanIPv4(): string[] {
  const found: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, address: a.address });
    }
  }
  const score = ({ name, address }: { name: string; address: string }) =>
    (/^(en0|en1|wlan|wlp|eth0)/.test(name) ? 0 : 10) +
    (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : address.startsWith('172.') ? 2 : 5) +
    (/^(utun|bridge|docker|vbox|vmnet|awdl|llw)/.test(name) ? 50 : 0);
  return [...new Set(found.sort((a, b) => score(a) - score(b)).map((f) => f.address))];
}

export function localHostnames(): string[] {
  const h = hostname();
  const names = new Set(['localhost', h]);
  if (!h.endsWith('.local')) names.add(`${h}.local`);
  return [...names];
}

/** True for a loopback peer address (IPv4, IPv6 or IPv4-mapped IPv6). */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  return a === '::1' || a.startsWith('127.');
}
