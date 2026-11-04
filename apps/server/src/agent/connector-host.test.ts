import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CONNECTOR_SDK, ConnectorHost, type ConnectorOut } from './connector-host';
const dirs: string[] = [], hosts: ConnectorHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) host.stopAll('test complete'); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('runs the actual line protocol for MIDI, gimbal, logs and Stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ce-connector-test-')); dirs.push(dir);
  await writeFile(join(dir, 'ce.mjs'), CONNECTOR_SDK);
  await writeFile(join(dir, 'index.mjs'), `import {onSet,onStop,midi,gimbal,log,ready} from './ce.mjs'; onSet((id,v)=>{midi.cc('Fixture',1,74,v);gimbal.pan(v);log('set '+id);});onStop(()=>{});ready('ok');`);
  const sent: ConnectorOut[] = [];
  const host = new ConnectorHost({ send: (event, done) => { sent.push(event); done(true, 'fixture ack'); } }); hosts.push(host);
  expect((await host.deploy('card', 'index.mjs', dir, [{ id: 'cutoff', kind: 'set', label: 'Cutoff', min: 0, max: 127 }], 150)).ok).toBe(true);
  expect(host.set('card', 'missing', 1).ok).toBe(false);
  expect(host.set('card', 'cutoff', 15).ok).toBe(true);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent.map(e => e.target)).toEqual(['midi', 'gimbal']);
  expect(host.logs('card').join('\n')).toContain('→ gimbal pan 15°');
  expect(host.logs('card').join('\n')).toContain('set cutoff');
  host.stop('card'); expect(host.has('card')).toBe(false);
});
it('reports a startup crash instead of claiming a running connector', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ce-connector-crash-')); dirs.push(dir);
  await writeFile(join(dir, 'index.mjs'), 'throw new Error("fixture crash");');
  const host = new ConnectorHost({ send: () => {} }); hosts.push(host);
  const result = await host.deploy('card', 'index.mjs', dir, [], 250);
  expect(result.ok).toBe(false); expect(result.output.join('\n')).toContain('fixture crash'); expect(host.has('card')).toBe(false);
});
it('rejects malformed connector packets before dispatch and preserves valid note durations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ce-connector-packets-')); dirs.push(dir);
  const packets = [
    { type: 'midi', port: 'Fixture', op: { kind: 'local', msg: 'cc', channel: 1, number: 74, value: 64 } },
    { type: 'midi', port: 'Fixture', op: { msg: 'cc', channel: 17, number: 74, value: 64 } },
    { type: 'midi', port: 'Fixture', op: { msg: 'cc', channel: 1, number: 74, value: '$value' } },
    { type: 'midi', port: 'Fixture', op: { msg: 'cc', channel: 1, number: 128, value: 64 } },
    { type: 'gimbal', op: 'pan', arg: 'move' },
    { type: 'gimbal', op: 'tilt', arg: 500 },
    { type: 'gimbal', op: 'nudge', arg: { yaw: 5, durationMs: 10001 } },
    { type: 'midi', port: 'Fixture', op: { msg: 'note', channel: 1, number: 60, velocity: 100, durationMs: 250 } },
  ];
  await writeFile(join(dir, 'index.mjs'), `for (const p of ${JSON.stringify(packets)}) console.log(JSON.stringify(p)); setInterval(()=>{},1000);`);
  const sent: ConnectorOut[] = [];
  const host = new ConnectorHost({ send: (packet, done) => { sent.push(packet); done(true); } }); hosts.push(host);
  await host.deploy('card', 'index.mjs', dir, [], 100);
  await expect.poll(() => host.info('card')?.failures).toBe(7);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ target: 'midi', op: { kind: 'midi', msg: 'note', durationMs: 250 } });
});
it.skipIf(process.platform === 'win32')('stops forked helpers even when the connector exits immediately on Stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ce-connector-group-')); dirs.push(dir);
  await writeFile(join(dir, 'index.mjs'), `import {spawn} from 'node:child_process';
    const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(JSON.stringify({type:'log',text:'helper='+helper.pid}));
    process.stdin.on('data',()=>process.exit(0)); setInterval(()=>{},1000);`);
  const host = new ConnectorHost({ send: () => {} }); hosts.push(host);
  await host.deploy('card', 'index.mjs', dir, [], 100);
  await expect.poll(() => host.logs('card').some(line => line.startsWith('helper='))).toBe(true);
  const helper = Number(host.logs('card').find(line => line.startsWith('helper='))!.slice(7));
  const alive = () => { try { process.kill(helper, 0); return true; } catch { return false; } };
  try {
    expect(alive()).toBe(true); host.stop('card');
    await expect.poll(alive, { timeout: 2500 }).toBe(false);
  } finally { if (alive()) { try { process.kill(helper, 'SIGKILL'); } catch { /* ended */ } } }
});
