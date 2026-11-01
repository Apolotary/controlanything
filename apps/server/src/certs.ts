/**
 * Self-signed development certificate for HTTPS/WSS on the LAN (Quest Browser and phones need a
 * secure context for WebXR, camera, mic and Web MIDI). Generated on first run into apps/server/.certs/
 * (gitignored) and regenerated when the LAN addresses change or it is about to expire.
 * Browsers still warn once per host: open the https URL and accept it, then the WebSocket works too.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export interface DevCert {
  key: string;
  cert: string;
  altNames: string[];
  regenerated: boolean;
}

interface CertMeta {
  altNames: string[];
  notAfter: number;
}

const DAY = 86_400_000;

export async function ensureDevCert(dir: string, hosts: { ips: string[]; dns: string[] }): Promise<DevCert> {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const metaPath = join(dir, 'meta.json');
  const wanted = [...hosts.dns.map((d) => `DNS:${d}`), ...['127.0.0.1', '::1', ...hosts.ips].map((ip) => `IP:${ip}`)];

  if (existsSync(keyPath) && existsSync(certPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CertMeta;
      const covered = wanted.every((n) => meta.altNames.includes(n));
      if (covered && meta.notAfter - Date.now() > 7 * DAY) {
        return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), altNames: meta.altNames, regenerated: false };
      }
    } catch {
      // unreadable meta: regenerate below
    }
  }

  const notBeforeDate = new Date(Date.now() - DAY);
  const notAfterDate = new Date(Date.now() + 365 * DAY);
  const pems = await generate([{ name: 'commonName', value: 'ControlEverything dev server' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...hosts.dns.map((value) => ({ type: 2 as const, value })),
          ...['127.0.0.1', '::1', ...hosts.ips].map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  writeFileSync(certPath, pems.cert);
  const meta: CertMeta = { altNames: wanted, notAfter: notAfterDate.getTime() };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { key: pems.private, cert: pems.cert, altNames: wanted, regenerated: true };
}
