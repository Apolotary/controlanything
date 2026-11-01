import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MuseConfig, resolveMuseConfig } from './muse/config';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SERVER_NAME = 'controleverything-server';
export const SERVER_VERSION = '0.1.0';

export interface ListenConfig {
  host: string;
  port: number;
  enabled: boolean;
}

export interface ServerConfig {
  /** HTTPS + WSS for browsers on the LAN (Quest, phones). */
  https: ListenConfig;
  /** Plain HTTP + WS: localhost, `adb reverse`, and LAN clients without TLS (ESP32, CLI). */
  http: ListenConfig;
  /** host/IP for QR and join URLs; default = first LAN IPv4 */
  publicHost?: string;
  certDir: string;
  dataDir: string;
  staticDirs: { companion: string; quest: string };
  /** auto-approve the first device while the registry is empty */
  trustFirstDevice: boolean;
  /** treat requests from 127.0.0.1/::1 as the owner (approve, auto-pair) */
  trustLoopback: boolean;
  /** read "y"/"n" on stdin to approve pending pairings */
  consoleApprove: boolean;
  muse: MuseConfig;
}

/**
 * Load the repo-root .env (then apps/server/.env) into process.env. Real environment variables win.
 * Returns the files loaded; values are never printed.
 */
export function loadDotEnv(paths: string[] = [join(REPO_ROOT, '.env'), join(SERVER_ROOT, '.env')]): string[] {
  const loaded: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    process.loadEnvFile(p);
    loaded.push(p);
  }
  return loaded;
}

function port(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= 0 && n < 65536 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const httpsPort = port(env.HTTPS_PORT, 8443);
  const httpPort = port(env.HTTP_PORT, 8787);
  const muse = resolveMuseConfig(env);
  // recorded real responses live in the repo so the demo runs without a key (see src/muse/recorded.ts)
  const recordings = env.MUSE_RECORD_DIR?.trim() || join(SERVER_ROOT, 'fixtures/recorded');
  if (muse.mode === 'live' && env.MUSE_RECORD === '1') muse.recordDir = recordings;
  if (muse.mode === 'fixture' && env.MUSE_REPLAY !== '0') muse.replayDir = recordings;
  return {
    https: { host: env.HTTPS_HOST?.trim() || '0.0.0.0', port: httpsPort, enabled: httpsPort !== 0 },
    http: { host: env.HTTP_HOST?.trim() || '0.0.0.0', port: httpPort, enabled: httpPort !== 0 },
    publicHost: env.PUBLIC_HOST?.trim() || undefined,
    certDir: join(SERVER_ROOT, '.certs'),
    dataDir: join(SERVER_ROOT, '.data'),
    staticDirs: { companion: join(REPO_ROOT, 'apps/companion/dist'), quest: join(REPO_ROOT, 'apps/quest/dist') },
    trustFirstDevice: env.CE_TRUST_FIRST_DEVICE === '1',
    trustLoopback: env.CE_TRUST_LOOPBACK !== '0',
    consoleApprove: env.CE_CONSOLE_APPROVE !== '0',
    muse,
  };
}
