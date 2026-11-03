/**
 * DJI Osmo Mobile hardware check, run from Terminal (macOS asks it for Bluetooth once):
 *
 *   npx tsx apps/server/scripts/osmo.ts scan                 list nearby BLE advertisers (never connects)
 *   npx tsx apps/server/scripts/osmo.ts test                 connect, listen 4 s, print what the gimbal reports (no motion)
 *   npx tsx apps/server/scripts/osmo.ts test --move          the same, then a small, slow sweep after a 3 s countdown:
 *                                                            pan +20°, pan −20°, center, tilt +10°, center
 *   options: --link ble|web|mock (default ble) · --address <uuid> · --name <prefix> · --out <file.json>
 *
 * Every move goes through the same clamps as the server (OsmoController): ≤ 90°/s, pan ±120°, tilt ±45°.
 * Ctrl-C at any point holds the gimbal where it is and disconnects.
 */
import { writeFileSync } from 'node:fs';
import { OsmoController } from '../src/devices/osmo/bridge';
import { createLink, type LinkKind, scanBle, WebBluetoothGimbalLink } from '../src/devices/osmo/links';
import type { Attitude } from '../src/devices/osmo/om';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cmd = argv[0] ?? 'help';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmt = (a?: Attitude) => (a ? `pan ${a.yaw.toFixed(1)}° tilt ${a.pitch.toFixed(1)}° roll ${a.roll.toFixed(1)}°` : 'no report');
const fmtRep = (a?: Attitude & { at: number }) => (a ? `${fmt(a)} (${Date.now() - a.at} ms ago)` : 'no angle report');

async function scan(): Promise<void> {
  console.log('Scanning 8 s (no connection is made)…');
  const { results, error } = await scanBle(Number(opt('seconds') ?? 8));
  if (error) console.log(`! ${error}`);
  const sorted = results.sort((a, b) => Number(b.gimbal) - Number(a.gimbal) || b.rssi - a.rssi);
  for (const r of sorted.slice(0, 25)) console.log(`${r.gimbal ? '★' : ' '} ${String(r.rssi).padStart(4)} dBm  ${r.name || '(no name)'}  ${r.address}${r.dji ? '  [DJI manufacturer data]' : ''}`);
  console.log(sorted.some((r) => r.gimbal) ? '★ = looks like a DJI gimbal' : 'No DJI gimbal seen. Is it switched on, and disconnected from the DJI Mimo app?');
}

async function test(): Promise<void> {
  const kind = (opt('link') ?? 'ble') as LinkKind;
  const link = createLink(kind, { address: opt('address'), name: opt('name'), log: (l) => console.log(l) });
  const c = new OsmoController(link, { log: (l) => console.log(l) });
  let stopping = false;
  const finish = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await c.hold().catch(() => {});
    await sleep(300);
    const out = opt('out') ?? `osmo-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(out, JSON.stringify({ link: kind, name: c.state.name, state: c.state, tx: c.tx, rx: c.rx.slice(0, 200) }, null, 2));
    console.log(`\nlog written to ${out}`);
    await c.close();
    setTimeout(() => process.exit(code), 500);
  };
  process.on('SIGINT', () => {
    console.log('\nCtrl-C: holding and disconnecting');
    void finish(130);
  });
  if (link instanceof WebBluetoothGimbalLink) console.log(`Open ${link.url} in Chrome and press "Connect gimbal".`);
  console.log(`Connecting (${kind})…`);
  try {
    await c.open();
  } catch (e) {
    console.log(`! not connected: ${(e as Error).message}`);
    return finish(1);
  }
  console.log('Connected. Listening 4 s to what the gimbal reports…');
  await sleep(4000);
  const pushes = Object.entries(c.state.pushes).map(([k, n]) => `${k}×${n}`).join(' ');
  console.log(`  notifications by cmd set/id: ${pushes || 'none'}`);
  console.log(`  attitude: ${fmtRep(c.state.reported)}`);
  console.log(`  battery:  ${c.state.battery ? `${c.state.battery.percent}%${c.state.battery.charging ? ' charging' : ''}` : 'no report'}`);
  if (!flag('move')) {
    console.log('\nRead-only check done. Add --move for the small sweep.');
    return finish(0);
  }
  for (let s = 3; s > 0; s--) {
    console.log(`Moving in ${s}… (Ctrl-C to cancel)`);
    await sleep(1000);
    if (stopping) return;
  }
  const steps: [string, Attitude][] = [
    ['pan +20°', { yaw: 20, pitch: 0, roll: 0 }],
    ['pan -20°', { yaw: -20, pitch: 0, roll: 0 }],
    ['center', { yaw: 0, pitch: 0, roll: 0 }],
    ['tilt +10°', { yaw: 0, pitch: 10, roll: 0 }],
    ['center', { yaw: 0, pitch: 0, roll: 0 }],
  ];
  for (const [label, a] of steps) {
    if (stopping) return;
    const r = await c.aim(a, 1000);
    console.log(`→ ${label.padEnd(10)} sent ${c.tx[c.tx.length - 1]?.hex} (${r.durationMs} ms)`);
    await sleep(r.durationMs + 600);
    console.log(`  gimbal says ${fmtRep(c.state.reported)}`);
  }
  console.log('\nSweep done. Did the phone turn right/left and tip? Tell the agent which direction "+pan" went.');
  return finish(0);
}

if (cmd === 'scan') await scan();
else if (cmd === 'test') await test();
else console.log('usage: osmo.ts scan | test [--move] [--link ble|web|mock] [--address A] [--name P] [--out file.json]');
