import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_ALPHABET, isValidCode, PAIRING_TTL_MS } from '@ce/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { generateCode, safeEqual } from './crypto';
import { PairingError, PairingManager } from './manager';
import { RateLimiter } from './rateLimit';
import { DeviceRegistry } from './registry';

function setup(opts: { trustFirstDevice?: boolean } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const registry = new DeviceRegistry(undefined, clock.now);
  const pairing = new PairingManager(registry, { now: clock.now, qrBase: () => 'https://192.168.1.20:8443', ...opts });
  const events: string[] = [];
  pairing.on('pending', (p) => events.push(`pending:${p.name}`));
  pairing.on('approved', (e) => events.push(`approved:${e.device.name}`));
  pairing.on('denied', (e) => events.push(`denied:${e.reason}`));
  return { clock, registry, pairing, events };
}

const cardputer = { name: 'Cardputer', kind: 'cardputer' as const, capabilities: ['ir' as const, 'display' as const] };

function pairedMac(registry: DeviceRegistry) {
  return registry.add({ name: 'MacBook', kind: 'mac', capabilities: ['midi'] });
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PairingError) return e.code;
    throw e;
  }
  return 'no error';
}

describe('codes and secrets', () => {
  it('generates 6-char codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateCode();
      expect(c).toHaveLength(6);
      expect(isValidCode(c)).toBe(true);
      expect(c).not.toMatch(/[01OIL]/);
    }
    expect(generateCode(() => 0)).toBe(CODE_ALPHABET[0].repeat(6));
  });

  it('compares in constant time regardless of length', () => {
    expect(safeEqual('K7Q4M2', 'K7Q4M2')).toBe(true);
    expect(safeEqual('K7Q4M2', 'K7Q4M3')).toBe(false);
    expect(safeEqual('K7Q4M2', 'K7Q4M2-longer')).toBe(false);
  });
});

describe('PairingManager', () => {
  it('starts a pending request with a QR URL, display code and expiry, and tells approvers', () => {
    const { pairing, events } = setup();
    const r = pairing.start(cardputer, { origin: '192.168.1.33' });
    expect(r.status).toBe('pending');
    expect(r.display).toBe(`${r.code.slice(0, 3)}-${r.code.slice(3)}`);
    expect(r.qr).toBe(`https://192.168.1.20:8443/p/${r.pairingId}#${r.code}`);
    expect(r.expiresAt - 1_000_000).toBe(PAIRING_TTL_MS);
    expect(r.deviceToken).toBeUndefined();
    expect(events).toEqual(['pending:Cardputer']);
    expect(pairing.listPending()[0]).toMatchObject({ pairingId: r.pairingId, kind: 'cardputer', origin: '192.168.1.33', code: r.code });
  });

  it('approves by code (any case, with a dash) and hands the token out exactly once', () => {
    const { pairing, registry, events } = setup();
    const mac = pairedMac(registry);
    const r = pairing.start(cardputer, { origin: 'a' });
    expect(pairing.status(r.pairingId, r.pollSecret).status).toBe('pending');
    const approved = pairing.approve({ code: r.display.toLowerCase() }, { type: 'device', deviceId: mac.device.deviceId });
    expect(approved.device).toMatchObject({ kind: 'cardputer', canApprove: false, capabilities: ['ir', 'display'] });
    expect(approved.approvedBy).toBe('MacBook');
    const first = pairing.status(r.pairingId, r.pollSecret);
    expect(first).toMatchObject({ status: 'approved', deviceId: approved.device.deviceId });
    expect(first.deviceToken).toBeTruthy();
    expect(registry.authenticate(first.deviceToken)?.deviceId).toBe(approved.device.deviceId);
    const second = pairing.status(r.pairingId, r.pollSecret);
    expect(second.status).toBe('approved');
    expect(second.deviceToken).toBeUndefined();
    expect(events).toEqual(['pending:Cardputer', 'approved:Cardputer']);
  });

  it('is single use: the same code cannot approve twice', () => {
    const { pairing } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    pairing.approve({ code: r.code }, { type: 'local' });
    expect(errCode(() => pairing.approve({ code: r.code }, { type: 'local' }))).toBe('bad_code');
  });

  it('expires after 5 minutes and is then forgotten', () => {
    const { pairing, clock, events } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    clock.advance(PAIRING_TTL_MS - 1);
    expect(pairing.status(r.pairingId, r.pollSecret).status).toBe('pending');
    clock.advance(1);
    expect(pairing.status(r.pairingId, r.pollSecret)).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(errCode(() => pairing.approve({ code: r.code }, { type: 'local' }))).toBe('bad_code');
    expect(events).toContain('denied:expired');
    clock.advance(3 * 60_000);
    expect(errCode(() => pairing.status(r.pairingId, r.pollSecret))).toBe('not_found');
  });

  it('rejects a wrong poll secret', () => {
    const { pairing } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    expect(errCode(() => pairing.status(r.pairingId, 'guess'))).toBe('bad_secret');
  });

  it('enforces approval rights from the registry, not the client', () => {
    const { pairing, registry } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    const devterm = registry.add({ name: 'DevTerm', kind: 'devterm' });
    const quest = registry.add({ name: 'Quest 3', kind: 'quest' });
    const iphone = registry.add({ name: 'iPhone', kind: 'iphone' });
    expect(pairing.canApprove({ type: 'device', deviceId: devterm.device.deviceId })).toBe(false);
    expect(pairing.canApprove({ type: 'device', deviceId: 'made-up' })).toBe(false);
    expect(pairing.canApprove({ type: 'device', deviceId: iphone.device.deviceId })).toBe(true);
    expect(pairing.canApprove({ type: 'local' })).toBe(true);
    expect(pairing.canApprove({ type: 'console' })).toBe(true);
    expect(errCode(() => pairing.approve({ code: r.code }, { type: 'device', deviceId: devterm.device.deviceId }))).toBe('forbidden');
    expect(pairing.approve({ code: r.code }, { type: 'device', deviceId: quest.device.deviceId }).device.kind).toBe('cardputer');
  });

  it('rate-limits wrong codes per approver', () => {
    const { pairing, clock } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    const wrong = r.code === '222222' ? '333333' : '222222';
    for (let i = 0; i < 5; i++) expect(errCode(() => pairing.approve({ code: wrong }, { type: 'local', address: 'x' }))).toBe('bad_code');
    expect(errCode(() => pairing.approve({ code: r.code }, { type: 'local', address: 'x' }))).toBe('rate_limited');
    expect(pairing.approve({ code: r.code }, { type: 'console' }).device.name).toBe('Cardputer');
    clock.advance(60_000);
    expect(errCode(() => pairing.approve({ code: wrong }, { type: 'local', address: 'x' }))).toBe('bad_code');
  });

  it('cancels a request after too many wrong codes aimed at it', () => {
    const { pairing, events } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    const wrong = r.code === '222222' ? '333333' : '222222';
    for (let i = 0; i < 5; i++) errCode(() => pairing.approve({ code: wrong, pairingId: r.pairingId }, { type: 'console' }));
    expect(pairing.status(r.pairingId, r.pollSecret)).toMatchObject({ status: 'denied', reason: 'too_many_attempts' });
    expect(events).toContain('denied:too_many_attempts');
  });

  it('rate-limits pair/start per origin', () => {
    const { pairing } = setup();
    for (let i = 0; i < 10; i++) pairing.start(cardputer, { origin: '10.0.0.9' });
    expect(errCode(() => pairing.start(cardputer, { origin: '10.0.0.9' }))).toBe('rate_limited');
    expect(pairing.start(cardputer, { origin: '10.0.0.10' }).status).toBe('pending');
  });

  it('needs the headset to approve a localhost helper once a headset owns the room', () => {
    const ctx = setup();
    expect(ctx.pairing.start({ name: 'Quest 3', kind: 'quest' }, { origin: '127.0.0.1', autoApprove: true })).toMatchObject({ status: 'approved' });
    const mac = ctx.pairing.start({ name: 'Mac companion', kind: 'mac' }, { origin: '127.0.0.1', autoApprove: true });
    expect(mac).toMatchObject({ status: 'pending' });
    expect(mac.deviceToken).toBeUndefined();
  });

  it('auto-approves localhost and (optionally) the first device', () => {
    const local = setup().pairing.start({ name: 'Mac', kind: 'mac' }, { origin: '127.0.0.1', autoApprove: true });
    expect(local).toMatchObject({ status: 'approved' });
    expect(local.deviceToken).toBeTruthy();

    const first = setup({ trustFirstDevice: true });
    const a = first.pairing.start({ name: 'Quest', kind: 'quest' }, { origin: 'q' });
    expect(a.status).toBe('approved');
    expect(first.registry.get(a.deviceId!)?.canApprove).toBe(true);
    expect(first.pairing.start(cardputer, { origin: 'c' }).status).toBe('pending');
  });

  it('denies by id or code, only for approvers', () => {
    const { pairing, registry } = setup();
    const r = pairing.start(cardputer, { origin: 'a' });
    const devterm = registry.add({ name: 'DevTerm', kind: 'devterm' });
    expect(errCode(() => pairing.deny({ pairingId: r.pairingId }, { type: 'device', deviceId: devterm.device.deviceId }))).toBe('forbidden');
    expect(pairing.deny({ pairingId: r.pairingId }, { type: 'local' })).toEqual({ pairingId: r.pairingId, reason: 'denied' });
    expect(pairing.status(r.pairingId, r.pollSecret).status).toBe('denied');
  });
});

describe('RateLimiter', () => {
  it('allows `limit` hits per window per key', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.hit('a')).toBe(true);
    expect(rl.hit('a')).toBe(true);
    expect(rl.hit('a')).toBe(false);
    expect(rl.blocked('a')).toBe(true);
    expect(rl.hit('b')).toBe(true);
    t = 1000;
    expect(rl.hit('a')).toBe(true);
  });
});

describe('DeviceRegistry', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('persists devices with hashed tokens and authenticates after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ce-space-'));
    dirs.push(dir);
    const file = join(dir, 'space.json');
    const a = new DeviceRegistry(file);
    const { device, token } = a.add({ name: 'Quest 3', kind: 'quest', capabilities: ['camera', 'mic', 'hands'] });
    expect(device.canApprove).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(device.tokenHash);

    const b = new DeviceRegistry(file);
    expect(b.spaceId).toBe(a.spaceId);
    expect(b.authenticate(token)?.name).toBe('Quest 3');
    expect(b.authenticate('wrong')).toBeUndefined();
    expect(b.authenticate(undefined)).toBeUndefined();
    expect(b.remove(device.deviceId)).toBe(true);
    expect(new DeviceRegistry(file).authenticate(token)).toBeUndefined();
  });
});
