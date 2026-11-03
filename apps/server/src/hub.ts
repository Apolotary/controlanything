/**
 * WebSocket hub at /ws: one space, many paired devices.
 *
 * - A socket starts unauthenticated. It may send `hello {deviceToken}` (then gets `welcome` + `presence`),
 *   or `pair.start` / `pair.status` to pair over the socket. Anything else is refused with a `log` error.
 * - Authenticated messages are validated and relayed to every other connection (or only to `to`), with
 *   `from` stamped to the sender's deviceId. `to: "server"` means "for the server only, do not relay".
 * - control.event and snapshot are dropped for a receiver whose socket is backed up (latest wins).
 * - Server code (the agent loop) subscribes with hub.onMessage() and talks back with send/broadcast.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import {
  type AnyMessage,
  DEFAULT_ROLE,
  type DeviceInfo,
  DROPPABLE_TYPES,
  encodeMessage,
  type LogPayload,
  type MessageType,
  newId,
  parseMessage,
  type PayloadOf,
  type Port,
  PROTOCOL_VERSION,
  type PresencePayload,
  type Role,
  SERVER_ID,
  SERVER_ONLY_TYPES,
} from '@ce/protocol';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { type Approver, PairingError, type PairingManager } from './pairing/manager';
import type { DeviceRecord, DeviceRegistry } from './pairing/registry';
import { allowedSocketOrigin, sameHostOrigin } from './origin';

export const WS_PATH = '/ws';
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** above this many queued bytes a receiver misses droppable messages */
export const BACKPRESSURE_BYTES = 1024 * 1024;
const DROPPABLE = new Set<string>(DROPPABLE_TYPES);

export const CLOSE_UNAUTHORIZED = 4401;

export interface Connection {
  readonly clientId: string;
  readonly ws: WebSocket;
  readonly address?: string;
  readonly local: boolean;
  alive: boolean;
  deviceId?: string;
  role?: Role;
  ports?: Port[];
  capabilities?: DeviceInfo['capabilities'];
  executor?: boolean;
  app?: string;
  /** pairing requests started or watched on this socket */
  watching: Set<string>;
  connectedAt: number;
}

export interface HubMessageEvent {
  message: AnyMessage;
  device: DeviceRecord;
  connection: Connection;
}

export interface HubOptions {
  registry: DeviceRegistry;
  pairing: PairingManager;
  mode: 'live' | 'fixture';
  serverName: string;
  isLocal: (address: string | undefined) => boolean;
  log?: (line: string) => void;
  heartbeatMs?: number;
}

export class Hub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  private readonly conns = new Map<string, Connection>();
  private readonly messageListeners = new Set<(e: HubMessageEvent) => void>();
  private readonly presenceListeners = new Set<(p: PresencePayload) => void>();
  private readonly log: (line: string) => void;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly unsubscribe: (() => void)[] = [];
  dropped = 0;

  constructor(private readonly o: HubOptions) {
    this.log = o.log ?? ((line) => console.log(line));
    this.heartbeat = setInterval(() => this.ping(), o.heartbeatMs ?? 15_000);
    this.heartbeat.unref?.();
    this.unsubscribe.push(
      o.pairing.on('pending', (p) => this.toApprovers('pair.pending', p)),
      o.pairing.on('approved', (e) => this.onApproved(e.pairingId, e.device, e.approvedBy)),
      o.pairing.on('denied', (e) => {
        this.toApprovers('pair.denied', { pairingId: e.pairingId, reason: e.reason });
        for (const c of this.conns.values()) if (c.watching.has(e.pairingId)) this.send(c, 'pair.denied', { pairingId: e.pairingId, reason: e.reason });
      }),
    );
  }

  /** Accept WebSocket upgrades on /ws from this HTTP(S) server. */
  attach(server: HttpServer | HttpsServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== WS_PATH) {
        socket.destroy();
        return;
      }
      if (!allowedSocketOrigin(req.headers)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
  }

  /** Server-side subscribers (agent loop, loggers). Returns an unsubscribe function. */
  onMessage(fn: (e: HubMessageEvent) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  /** Includes hello/port updates, disconnects, pairing and revocation. */
  onPresence(fn: (p: PresencePayload) => void): () => void {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  }

  /** Send from the server to every connection of one device. Returns the number of sockets reached. */
  sendToDevice<T extends MessageType>(deviceId: string, type: T, payload: PayloadOf<T>): number {
    const json = encodeMessage(type, payload, { from: SERVER_ID, to: deviceId });
    let n = 0;
    for (const c of this.authed()) if (c.deviceId === deviceId && this.sendRaw(c, json, type)) n++;
    return n;
  }

  /** Send from the server to every authenticated connection (optionally except one device). */
  broadcast<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { exceptDeviceId?: string } = {}): number {
    const json = encodeMessage(type, payload, { from: SERVER_ID });
    let n = 0;
    for (const c of this.authed()) if (c.deviceId !== opts.exceptDeviceId && this.sendRaw(c, json, type)) n++;
    return n;
  }

  /** Close every socket of a revoked device and tell the others. */
  disconnectDevice(deviceId: string, reason = 'revoked'): void {
    for (const c of this.conns.values()) {
      if (c.deviceId !== deviceId) continue;
      c.deviceId = undefined;
      c.ws.close(CLOSE_UNAUTHORIZED, reason);
    }
    this.broadcastPresence('revoked', deviceId);
  }

  devices(): DeviceInfo[] {
    const conns = this.authed();
    return this.o.registry.list().map((d) => {
      const mine = conns.filter((c) => c.deviceId === d.deviceId);
      const latest = mine.findLast((c) => c.executor === true)
        ?? mine.findLast((c) => c.executor !== false);
      const info: DeviceInfo = {
        deviceId: d.deviceId,
        name: d.name,
        kind: d.kind,
        role: latest?.role ?? DEFAULT_ROLE[d.kind],
        capabilities: latest?.capabilities ?? (mine.length ? [] : d.capabilities),
        canApprove: d.canApprove,
        online: mine.length > 0,
        connections: mine.length,
        pairedAt: d.pairedAt,
      };
      if (latest?.ports) info.ports = latest.ports;
      if (latest?.app) info.app = latest.app;
      if (d.lastSeen !== undefined) info.lastSeen = d.lastSeen;
      return info;
    });
  }

  stats(): { connections: number; authenticated: number; devicesOnline: number; byRole: Record<string, number> } {
    const authed = this.authed();
    const byRole: Record<string, number> = {};
    const online = new Set<string>();
    for (const c of authed) {
      if (!c.deviceId || online.has(c.deviceId)) continue;
      online.add(c.deviceId);
      const role = c.role ?? 'device';
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
    return { connections: this.conns.size, authenticated: authed.length, devicesOnline: online.size, byRole };
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const u of this.unsubscribe) u();
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }

  // --- connection lifecycle ---------------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const address = req.socket.remoteAddress;
    const c: Connection = {
      clientId: newId('c'),
      ws,
      address,
      local: this.o.isLocal(address) && sameHostOrigin(req.headers),
      alive: true,
      watching: new Set(),
      connectedAt: Date.now(),
    };
    this.conns.set(c.clientId, c);
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('message', (data, isBinary) => this.onData(c, data, isBinary));
    ws.on('error', (e) => this.log(`[ws] ${c.clientId} error: ${e.message}`));
    ws.on('close', () => this.onClose(c));
  }

  private onClose(c: Connection): void {
    this.conns.delete(c.clientId);
    if (!c.deviceId) return;
    this.o.registry.touch(c.deviceId);
    this.broadcastPresence('leave', c.deviceId);
  }

  private ping(): void {
    for (const c of this.conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // socket already closing
      }
    }
  }

  // --- inbound ----------------------------------------------------------------------------

  private onData(c: Connection, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendLog(c, { level: 'error', code: 'binary_unsupported', message: 'Binary frames are not supported; send JSON text.' });
      return;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const text = buf.toString('utf8');
    const parsed = parseMessage(text);
    if (!parsed.ok) {
      this.sendLog(c, { level: 'error', code: 'invalid_message', message: `Dropped message: ${parsed.error}`, ref: parsed.id, issues: parsed.issues });
      return;
    }
    const m = parsed.message;
    if (!parsed.experimental) {
      const k = parsed.message;
      try {
        switch (k.type) {
          case 'hello':
            return this.onHello(c, k.payload, k.id);
          case 'pair.start':
            return this.onPairStart(c, k.payload);
          case 'pair.status':
            return this.onPairStatus(c, k.payload, k.id);
          case 'pair.approve':
          case 'pair.deny': {
            const approver = this.approverFor(c);
            if (!approver) {
              this.sendLog(c, { level: 'error', code: 'forbidden', message: 'Only a paired quest, mac or iphone (or localhost) may approve devices.', ref: k.id });
              return;
            }
            if (k.type === 'pair.approve') this.o.pairing.approve(k.payload, approver);
            else if (!k.payload.pairingId && !k.payload.code) this.sendLog(c, { level: 'error', code: 'bad_request', message: 'pair.deny needs pairingId or code.', ref: k.id });
            else this.o.pairing.deny(k.payload, approver);
            return;
          }
        }
      } catch (e) {
        if (e instanceof PairingError) {
          this.sendLog(c, { level: 'error', code: e.code, message: e.message, ref: k.id });
          return;
        }
        throw e;
      }
    }

    if (!c.deviceId) {
      this.sendLog(c, { level: 'error', code: 'not_authenticated', message: 'Send hello {deviceToken} first (or pair.start to pair this device).', ref: m.id });
      return;
    }
    if ((SERVER_ONLY_TYPES as readonly string[]).includes(m.type)) {
      this.sendLog(c, { level: 'error', code: 'server_only', message: `${m.type} is sent by the server only.`, ref: m.id });
      return;
    }
    this.relay(c, m, parsed.raw);
  }

  private onHello(c: Connection, p: PayloadOf<'hello'>, ref: string): void {
    const device = this.o.registry.authenticate(p.deviceToken);
    if (!device) {
      this.sendLog(c, { level: 'error', code: 'unauthorized', message: 'Unknown or revoked device token; pair this device again.', ref });
      c.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const first = c.deviceId !== device.deviceId;
    c.deviceId = device.deviceId;
    c.role = p.role ?? DEFAULT_ROLE[device.kind];
    if (p.ports) c.ports = p.ports;
    if (p.app) c.app = p.app;
    if (p.executor !== undefined) c.executor = p.executor;
    c.capabilities = p.capabilities ?? c.capabilities ?? device.capabilities;
    if (p.capabilities && c.executor !== false) this.o.registry.update(device.deviceId, { capabilities: p.capabilities });
    this.o.registry.touch(device.deviceId);
    if (first) {
      this.send(c, 'welcome', {
        clientId: c.clientId,
        deviceId: device.deviceId,
        name: device.name,
        kind: device.kind,
        role: c.role,
        canApprove: device.canApprove || c.local,
        spaceId: this.o.registry.spaceId,
        protocol: PROTOCOL_VERSION,
        server: this.o.serverName,
        mode: this.o.mode,
      });
      if (this.isApproverConn(c)) for (const p of this.o.pairing.listPending()) this.send(c, 'pair.pending', p);
    }
    this.broadcastPresence(first ? 'join' : 'update', device.deviceId);
  }

  private onPairStart(c: Connection, p: PayloadOf<'pair.start'>): void {
    const r = this.o.pairing.start(p, { origin: c.address, autoApprove: c.local });
    c.watching.add(r.pairingId);
    this.send(c, 'pair.status', {
      pairingId: r.pairingId,
      status: r.status,
      code: r.code,
      display: r.display,
      qr: r.qr,
      expiresAt: r.expiresAt,
      pollSecret: r.pollSecret,
    });
    if (r.status === 'approved' && r.deviceId && r.deviceToken) {
      const d = this.o.registry.get(r.deviceId);
      if (d) this.send(c, 'pair.approved', this.approvedPayload(r.pairingId, d, 'localhost', r.deviceToken));
    }
  }

  private onPairStatus(c: Connection, p: PayloadOf<'pair.status'>, ref: string): void {
    if (!p.pollSecret) {
      this.sendLog(c, { level: 'error', code: 'bad_request', message: 'pair.status needs pairingId and pollSecret.', ref });
      return;
    }
    const s = this.o.pairing.status(p.pairingId, p.pollSecret);
    c.watching.add(p.pairingId);
    this.send(c, 'pair.status', { pairingId: s.pairingId, status: s.status, expiresAt: s.expiresAt });
    if (s.deviceToken && s.deviceId) {
      const d = this.o.registry.get(s.deviceId);
      if (d) this.send(c, 'pair.approved', this.approvedPayload(s.pairingId, d, undefined, s.deviceToken));
    }
  }

  private onApproved(pairingId: string, device: DeviceRecord, approvedBy: string): void {
    for (const c of this.conns.values()) {
      if (!c.watching.has(pairingId)) continue;
      const token = this.o.pairing.takeToken(pairingId);
      if (token) this.send(c, 'pair.approved', this.approvedPayload(pairingId, device, approvedBy, token));
    }
    this.toApprovers('pair.approved', this.approvedPayload(pairingId, device, approvedBy));
    this.broadcastPresence('paired', device.deviceId);
  }

  private approvedPayload(pairingId: string, d: DeviceRecord, approvedBy?: string, deviceToken?: string): PayloadOf<'pair.approved'> {
    const p: PayloadOf<'pair.approved'> = { pairingId, deviceId: d.deviceId, name: d.name, kind: d.kind, canApprove: d.canApprove };
    if (approvedBy) p.approvedBy = approvedBy;
    if (deviceToken) p.deviceToken = deviceToken;
    return p;
  }

  private approverFor(c: Connection): Approver | null {
    if (c.deviceId && this.o.registry.get(c.deviceId)?.canApprove) return { type: 'device', deviceId: c.deviceId };
    if (c.local) return { type: 'local', address: c.address };
    return null;
  }

  private isApproverConn(c: Connection): boolean {
    return Boolean(c.deviceId) && (c.local || Boolean(this.o.registry.get(c.deviceId!)?.canApprove));
  }

  // --- relay ------------------------------------------------------------------------------

  private relay(c: Connection, m: AnyMessage, raw: Record<string, unknown>): void {
    const device = this.o.registry.get(c.deviceId!);
    if (!device) {
      c.ws.close(CLOSE_UNAUTHORIZED, 'revoked');
      return;
    }
    // Generated-app operations are always server-bound, including a missing/forged `to`.
    // In particular, prompts and unvalidated action values must never reach a preview peer.
    if (m.to !== SERVER_ID && !m.type.startsWith('project.')) {
      const json = JSON.stringify({ ...raw, from: device.deviceId });
      const targets = m.to ? this.authed().filter((t) => t.deviceId === m.to) : this.authed().filter((t) => t !== c);
      if (m.to && !targets.length) {
        this.sendLog(c, { level: 'warn', code: 'unknown_target', message: `No online device "${m.to}"; message not delivered.`, ref: m.id });
      }
      for (const t of targets) this.sendRaw(t, json, m.type);
    }
    for (const fn of this.messageListeners) {
      try {
        fn({ message: m, device, connection: c });
      } catch (e) {
        this.log(`[hub] message listener failed: ${(e as Error).message}`);
      }
    }
  }

  // --- outbound helpers -------------------------------------------------------------------

  private authed(): Connection[] {
    return [...this.conns.values()].filter((c) => c.deviceId && c.ws.readyState === WebSocket.OPEN);
  }

  private toApprovers<T extends MessageType>(type: T, payload: PayloadOf<T>): void {
    const json = encodeMessage(type, payload, { from: SERVER_ID });
    for (const c of this.authed()) if (this.isApproverConn(c)) this.sendRaw(c, json, type);
  }

  private broadcastPresence(reason: NonNullable<PresencePayload['reason']>, deviceId?: string): void {
    const payload: PresencePayload = { spaceId: this.o.registry.spaceId, devices: this.devices(), reason };
    if (deviceId) payload.deviceId = deviceId;
    this.broadcast('presence', payload);
    for (const fn of this.presenceListeners) fn(payload);
  }

  private send<T extends MessageType>(c: Connection, type: T, payload: PayloadOf<T>): void {
    this.sendRaw(c, encodeMessage(type, payload, { from: SERVER_ID }), type);
  }

  private sendLog(c: Connection, payload: LogPayload): void {
    this.send(c, 'log', payload);
  }

  private sendRaw(c: Connection, json: string, type: string): boolean {
    if (c.ws.readyState !== WebSocket.OPEN) return false;
    if (DROPPABLE.has(type) && c.ws.bufferedAmount > BACKPRESSURE_BYTES) {
      this.dropped++;
      return false;
    }
    c.ws.send(json);
    return true;
  }
}
