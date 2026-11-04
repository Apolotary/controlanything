/**
 * Shared bits of the companion's Chrome checks: an own silent fixture server (never reuses a running one, no
 * hardware, no Muse credits), a paired Mac identity, and system Chrome through playwright-core (no download).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const freePort = (port) => new Promise((yes, no) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); no(Error(`Port ${port} is occupied; stop its owner first.`)); });
  socket.once('error', (error) => error.code === 'ECONNREFUSED' ? yes() : no(error));
  socket.setTimeout(1500, () => { socket.destroy(); no(Error(`Port ${port} probe timeout`)); });
});

/** Starts `node --import tsx apps/server/src/index.ts` in fixture mode on `port`; `stop()` ends it and removes its data. */
export async function startFixtureServer(port, label = 'companion-e2e') {
  await freePort(port);
  const base = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), `ce-${label}-`));
  let log = '';
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(ROOT, 'apps/server'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HTTP_PORT: String(port), HTTPS_PORT: '0', HTTP_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
    CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0', CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
    CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0', MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '', FIXTURE_DELAY_MS: '100', GEN3D_SKIN: '0', VITEST: '',
  } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => { log = (log + data).slice(-200_000); });
  const until = async (what, probe, timeout = 30_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (server.exitCode !== null || server.signalCode !== null) throw Error(`Fixture server exited: ${log.slice(-1500)}`);
      const result = await probe(); if (result) return result;
      await delay(100);
    }
    throw Error(`Timed out: ${what}`);
  };
  await until('server', () => log.includes('ControlAnything server '));
  const json = async (path, body) => {
    const response = await fetch(`${base}${path}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }
      : { signal: AbortSignal.timeout(3000) });
    assert(response.ok, `${path}: ${response.status}`); return response.json();
  };
  assert.equal((await json('/api/health')).mode, 'fixture');
  return {
    base, until, json, log: () => log,
    async stop() {
      if (server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise((done) => server.once('exit', done)), delay(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A paired Mac identity, as the companion's localStorage holds it. */
export async function pairMac(fixture, name = 'Companion e2e Mac') {
  const start = await fixture.json('/api/pair/start', { kind: 'mac', name });
  const status = start.deviceToken ? start : await fixture.json(`/api/pair/status?pairingId=${encodeURIComponent(start.pairingId)}&pollSecret=${encodeURIComponent(start.pollSecret)}`);
  assert.equal(status.status, 'approved');
  return { deviceId: status.deviceId, deviceToken: status.deviceToken, kind: 'mac', name };
}

/** System Chrome with this identity in storage and every audio constructor made to throw (the checks are silent). */
export async function openMacBrowser(identity, viewport = { width: 1440, height: 900 }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(30_000);
  await context.addInitScript((id) => {
    localStorage.setItem('ce.device', JSON.stringify(id));
    window.__audioAttempts = 0;
    for (const key of ['AudioContext', 'webkitAudioContext']) if (window[key]) window[key] = class { constructor() { window.__audioAttempts++; throw Error('Audio is forbidden here'); } };
  }, identity);
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    return page;
  };
  return { browser, context, errors, newPage: async () => watch(await context.newPage()) };
}
