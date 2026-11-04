/** Builds every server part from a config, without listening (tests use this directly). */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Express } from 'express';
import { ensureDevCert } from './certs';
import { SERVER_NAME, SERVER_VERSION, type ServerConfig } from './config';
import { Hub } from './hub';
import { CallLog, createMuseChat, createTranscriber, DEFAULT_FIXTURES, type FixtureValue, type MuseChat, type Transcriber } from './muse';
import { isLoopback, lanIPv4, localHostnames } from './net';
import { PairingManager } from './pairing/manager';
import { DeviceRegistry } from './pairing/registry';
import { createProjects } from './projects';

export interface PublicUrls {
  /** host used in QR codes and join links */
  host: string;
  https?: string;
  http?: string;
  /** for the Mac itself and `adb reverse tcp:8787 tcp:8787` */
  local?: string;
  lan: string[];
}

export interface ServerContext {
  config: ServerConfig;
  registry: DeviceRegistry;
  pairing: PairingManager;
  hub: Hub;
  muse: MuseChat;
  transcriber: Transcriber;
  /** every Meta model call (chat and transcription): model id, latency, tokens */
  calls: CallLog;
  isLocal: (address: string | undefined) => boolean;
  urls: () => PublicUrls;
  /** actual ports after listen (differ from config when it asked for port 0) */
  bound: { https?: number; http?: number };
  startedAt: number;
  log: (line: string) => void;
  projects: ReturnType<typeof createProjects>;
}

export interface ContextDeps {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  isLocal?: (address: string | undefined) => boolean;
  now?: () => number;
  /** null = keep the registry in memory only */
  registryFile?: string | null;
  fixtures?: Record<string, FixtureValue>;
  heartbeatMs?: number;
  projectsFile?: string | null;
}

export function createContext(config: ServerConfig, deps: ContextDeps = {}): ServerContext {
  const log = deps.log ?? ((line: string) => console.log(line));
  const registryFile = deps.registryFile === null ? undefined : (deps.registryFile ?? join(config.dataDir, 'space.json'));
  const registry = new DeviceRegistry(registryFile, deps.now);
  const bound: ServerContext['bound'] = {};
  const urls = (): PublicUrls => {
    const lan = lanIPv4();
    const host = config.publicHost ?? lan[0] ?? 'localhost';
    const httpsPort = bound.https ?? config.https.port;
    const httpPort = bound.http ?? config.http.port;
    const out: PublicUrls = { host, lan };
    if (config.https.enabled) out.https = `https://${host}:${httpsPort}`;
    if (config.http.enabled) {
      out.http = `http://${host}:${httpPort}`;
      out.local = `http://localhost:${httpPort}`;
    }
    return out;
  };
  const isLocal = deps.isLocal ?? ((a: string | undefined) => config.trustLoopback && isLoopback(a));
  const pairing = new PairingManager(registry, {
    now: deps.now,
    qrBase: () => {
      const u = urls();
      return u.https ?? u.http ?? 'http://localhost';
    },
    trustFirstDevice: config.trustFirstDevice,
  });
  const hub = new Hub({
    registry,
    pairing,
    mode: config.muse.mode,
    serverName: `${SERVER_NAME}@${SERVER_VERSION}`,
    isLocal,
    publicHost: config.publicHost,
    originPorts: () => [config.http.enabled ? bound.http ?? config.http.port : 0, config.https.enabled ? bound.https ?? config.https.port : 0].filter((port) => port > 0),
    log,
    heartbeatMs: deps.heartbeatMs,
  });
  const calls = new CallLog(log);
  const muse = createMuseChat(config.muse, { fetchImpl: deps.fetchImpl, log, fixtures: { ...DEFAULT_FIXTURES, ...deps.fixtures }, callLog: calls });
  const transcriber = createTranscriber(config.muse, { fetchImpl: deps.fetchImpl, callLog: calls });
  const ctx = { config, registry, pairing, hub, muse, transcriber, calls, isLocal, urls, bound, startedAt: Date.now(), log } as ServerContext;
  ctx.projects = createProjects(ctx, deps.projectsFile === null || deps.registryFile === null && deps.projectsFile === undefined
    ? undefined : deps.projectsFile ?? join(config.dataDir, 'projects.json'));
  return ctx;
}

export interface RunningServers {
  http?: HttpServer;
  https?: HttpsServer;
  certAltNames?: string[];
  certRegenerated?: boolean;
  close(): Promise<void>;
}

function listen(server: HttpServer | HttpsServer, port: number, host: string, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE' ? new Error(`${label} port ${port} on ${host} is already in use (another server running?)`) : e);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Start plain HTTP and HTTPS listeners (each with the WebSocket hub on /ws). */
export async function startServers(ctx: ServerContext, app: Express): Promise<RunningServers> {
  const out: RunningServers = { close: async () => {} };
  const { http, https } = ctx.config;
  if (http.enabled) {
    const s = createHttpServer(app);
    ctx.hub.attach(s);
    ctx.bound.http = await listen(s, http.port, http.host, 'HTTP');
    out.http = s;
  }
  if (https.enabled) {
    const cert = await ensureDevCert(ctx.config.certDir, { ips: lanIPv4(), dns: localHostnames() });
    const s = createHttpsServer({ key: cert.key, cert: cert.cert }, app);
    ctx.hub.attach(s);
    ctx.bound.https = await listen(s, https.port, https.host, 'HTTPS');
    out.https = s;
    out.certAltNames = cert.altNames;
    out.certRegenerated = cert.regenerated;
  }
  out.close = async () => {
    ctx.projects.close();
    ctx.hub.close();
    ctx.registry.flush();
    await Promise.all(
      [out.http, out.https].filter(Boolean).map(
        (s) =>
          new Promise<void>((resolve) => {
            s!.closeAllConnections?.();
            s!.close(() => resolve());
          }),
      ),
    );
  };
  return out;
}
