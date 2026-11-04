import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FreshConnectorGenerator, freshConnectorArgs, type FreshContract } from './fresh-connector';

const contract: FreshContract = {
  cardId: 'fake-card', deviceName: 'Mock only', request: 'Build a connector and map right push.', portHint: 'mock-id',
  ports: [{ id: 'mock-id', name: 'Mock only' }],
  actions: [{ actionId: 'cc50', label: 'Mock filter', kind: 'set', channel: 1, cc: 50, min: 16, max: 64 }],
  signalsApi: 'right.push is 0..1', hints: [],
};

/** A test process, not Muse: no network/model calls or MIDI output. */
async function fixture(mode: 'repair' | 'wrong-model' | 'wait') {
  const dir = await mkdtemp(join(tmpdir(), 'ce-fresh-host-check-')), binary = join(dir, 'fake-native.cjs');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
 const args = process.argv.slice(2), cwd = args[args.indexOf('--workspace')+1];
 const prompt = fs.readFileSync(args[args.indexOf('--prompt-file')+1], 'utf8');
 const before = fs.readdirSync(cwd).sort();
 fs.writeFileSync(cwd + '/initial-' + (fs.existsSync(cwd+'/connector.js') ? 'repair' : 'first') + '.json', JSON.stringify(before));
 if (${JSON.stringify(mode)} === 'wait') { setInterval(()=>{}, 1000); return; }
 const repair = prompt.includes('ACTUAL errors');
 fs.writeFileSync(cwd+'/connector.js', repair ? 'return {bytes:[176,50,40]};' : 'return {bytes:[176,50,99]};');
 fs.writeFileSync(cwd+'/gesture.js', 'if (s.right) out.set("cc50",16+s.right.push*48);');
 fs.writeFileSync(cwd+'/manifest.json', JSON.stringify({title:'Mock gesture',explanation:'Push your right hand forward.',needs:['right']}));
 const event = (payload_type,payload)=>process.stdout.write(JSON.stringify({payload_type,payload})+'\\n');
 event('run.usage',{failed_calls:0,models:[{model:${JSON.stringify(mode === 'wrong-model' ? 'not-meta' : 'muse-spark-1.3')},calls:1,input_tokens:1,output_tokens:1}]});
 event('run.terminal.completed',{terminal:'completed',text:'This fixture prose is not proof.'});
});
`, { mode: 0o700 });
  const generator = new FreshConnectorGenerator({ dataDir: dir, apiKey: 'test-key-only', baseUrl: 'https://api.meta.ai/v1', binary });
  return { dir, generator };
}

describe('fresh connector host boundary (fake native executable; no Muse or device)', () => {
  it('exposes file tools only and keeps the native sandbox and Meta request', () => {
    const args = freshConnectorArgs('/new/workspace', '/job/prompt', 'https://api.meta.ai/v1');
    expect(args).toContain('run.toolset=["read_file","search","write_file","edit_file"]');
    expect(args.join(' ')).not.toContain('bash');
    expect(args).toContain('--sandbox-network'); expect(args).toContain('restricted');
    expect(args).toContain('--api-key-stdin'); expect(args).toContain('muse-spark-1.3');
  });
  it('begins without implementations, repairs actual check errors, and returns hashes of the new files', async () => {
    const f = await fixture('repair'); const previews: string[] = [];
    try {
      let checks = 0;
      const result = await f.generator.generate(contract, { onProgress: (_, code) => { if (code) previews.push(code); },
        check: a => { checks++; return a.connector.includes(',99]') ? ['Actual mock packet exceeded the reviewed maximum.'] : []; } });
      expect(checks).toBe(2); expect(result.connector).toBe('return {bytes:[176,50,40]};');
      expect(result.hashes.connector).toMatch(/^[a-f0-9]{64}$/); expect(result.observedModels).toEqual(['muse-spark-1.3']);
      expect(JSON.parse(await readFile(join(result.workspace, 'initial-first.json'), 'utf8'))).toEqual(['contract.json', 'request.txt']);
      const receipt = JSON.parse(await readFile(join(result.workspace, '..', 'receipt.json'), 'utf8'));
      expect(receipt.implementationPresentInitially).toBe(false); expect(receipt.state).toBe('checked');
      expect(receipt.checks[0].issues).toEqual(['Actual mock packet exceeded the reviewed maximum.']);
      expect(previews.some(code => code.includes('176,50,40'))).toBe(true);
      expect(f.generator.status().active).toBe(false);
    } finally { await f.generator.close(); await rm(f.dir, { recursive: true, force: true }); }
  });
  it('refuses successful prose/files without an approved actual native model identity', async () => {
    const f = await fixture('wrong-model'); let checked = false;
    try {
      await expect(f.generator.generate(contract, { check: () => { checked = true; return []; } })).rejects.toThrow(/unexpected model/);
      expect(checked).toBe(false);
    } finally { await f.generator.close(); await rm(f.dir, { recursive: true, force: true }); }
  });
  it('cancels the owned writer and never checks or returns its late artifacts', async () => {
    const f = await fixture('wait'), controller = new AbortController(); let checked = false;
    try {
      const result = f.generator.generate(contract, { signal: controller.signal, check: () => { checked = true; return []; } });
      // Attach rejection handling before aborting so Node never observes an unhandled promise.
      const outcome = result.then(() => 'unexpected success', e => String(e));
      let writerStarted = false;
      for (let i = 0; i < 200; i++) {
        const ids = await readdir(join(f.dir, 'fresh-connectors')).catch(() => []);
        if (ids[0] && await readFile(join(f.dir, 'fresh-connectors', ids[0], 'workspace', 'initial-first.json'), 'utf8').catch(() => '')) { writerStarted = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(writerStarted).toBe(true);
      controller.abort(Error('Owner stopped this request.'));
      expect(await outcome).toMatch(/Owner stopped|cancelled/); expect(checked).toBe(false);
      expect(f.generator.status().active).toBe(false);
    } finally { await f.generator.close(); await rm(f.dir, { recursive: true, force: true }); }
  });
});
