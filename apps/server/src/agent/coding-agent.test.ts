import { mkdtemp, mkdir, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codingArgs, codingEnvironment, codingEvent, codingModelFailure, redactCodingPatch, seedCodingModules, stopCodingProcessGroup } from './coding-agent';
import { CallLog } from '../muse/callLog';

describe('native coding job boundaries (no model or native agent invoked)', () => {
  it('requires observed model evidence and keeps full-length patch redaction explicit', () => {
    expect(codingModelFailure([])).toMatch(/did not identify/);
    expect(codingModelFailure(['other-model'])).toMatch(/unexpected/);
    expect(codingModelFailure(['muse-spark-1.3'])).toBeUndefined();
    const original = 'x'.repeat(5000) + '\n+const key = "known-meta-key";\n' + 'y'.repeat(5000);
    const patch = redactCodingPatch(original, 'known-meta-key');
    expect(patch.redacted).toBe(true); expect(patch.text).not.toContain('known-meta-key');
    expect(patch.text.length).toBeGreaterThan(10_000); expect(patch.text).toContain('[REDACTED META API KEY]');
  });

  it('escalates an owned group that survives TERM even after its host closes', async () => {
    let descendantAlive = true;
    const sent: (NodeJS.Signals | 0)[] = [];
    const gone = await stopCodingProcessGroup(12345, {
      signal: (pid, signal) => {
        expect(pid).toBe(-12345);
        if (!descendantAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        sent.push(signal);
        if (signal === 'SIGKILL') descendantAlive = false;
      },
      wait: async () => {}, termGraceMs: 100, killGraceMs: 100,
    });
    expect(sent).toContain('SIGTERM'); expect(sent).toContain('SIGKILL'); expect(gone).toBe(true);
  });

  it('counts native aggregate calls and failures without inventing individual timing records', () => {
    const log = new CallLog(() => {});
    log.add({ at: 1, label: 'native aggregate', model: 'muse-spark-1.3', source: 'live', ok: false,
      callCount: 5, failureCount: 1, latencyMs: 100, format: 'native_cli_aggregate' });
    expect(log.list()).toHaveLength(1); expect(log.totals()).toMatchObject({ calls: 5, failures: 1 });
  });
  it('reads only actual JSONL model/terminal fields and keeps intentions distinct from proof', () => {
    const usage = codingEvent(JSON.stringify({ payload_type: 'run.usage', payload: { models: [{ model: null }, { model: 'muse-spark-1.3' }] } }));
    expect(usage?.models).toEqual(['muse-spark-1.3']); expect(usage?.terminal).toBeUndefined();
    const intent = codingEvent(JSON.stringify({ payload_type: 'task.lifecycle.side_effect_intent', payload: { event: { operation: 'tool.bash' } } }));
    expect(intent?.operation).toBe('tool.bash'); expect(intent?.terminal).toBeUndefined();
    expect(codingEvent(JSON.stringify({ payload_type: 'run.terminal.completed', payload: { terminal: 'completed', text: 'Tests pass' } }))?.terminal).toBe('completed');
    expect(codingEvent('{"method":"turn/completed","params":{"terminal":"completed"}}')).toBeUndefined();
    expect(codingEvent('noise')).toBeUndefined();
  });

  it('keeps the native sandbox, limits tools and omits inherited provider secrets', () => {
    const args = codingArgs('/task/worktree', '/task/prompt.txt');
    expect(args).toContain('--api-key-stdin'); expect(args).toContain('--disable-reminders');
    expect(args).toContain('--no-foreign-personal-context'); expect(args).not.toContain('--yolo'); expect(args).not.toContain('--disable-sandbox');
    expect(args).toContain('run.toolset=["read_file","search","write_file","edit_file","bash","bash_input"]');
    const env = codingEnvironment('/task/job', { HOME: '/Users/owner', PATH: '/bin', MODEL_API_KEY: 'private', OPENAI_API_KEY: 'other', AWS_SECRET_ACCESS_KEY: 'secret' }, '/task/worktree');
    expect(env.HOME).toBe('/Users/owner'); expect(env.MODEL_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined(); expect(env.XDG_CONFIG_HOME).toBe('/task/job/config');
    expect(env.npm_config_cache).toBe('/task/worktree/node_modules/.cache/npm');
  });

  it('keeps local workspace resolution and writable caches away from the main dependencies', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ce-coding-modules-'));
    const root = join(temp, 'main'), task = join(temp, 'task');
    try {
      for (const path of ['node_modules/lib', 'node_modules/.vite-temp', 'apps/quest/node_modules/lib', 'apps/quest/node_modules/.vite-temp']) await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, 'apps/quest/package.json'), '{"name":"@ce/quest"}');
      await mkdir(join(task, 'apps/quest'), { recursive: true });
      await seedCodingModules(root, task);
      expect(await realpath(join(task, 'node_modules/@ce/quest'))).toBe(await realpath(join(task, 'apps/quest')));
      expect((await lstat(join(task, 'apps/quest/node_modules'))).isSymbolicLink()).toBe(false);
      expect((await lstat(join(task, 'node_modules/.vite-temp'))).isSymbolicLink()).toBe(false);
      expect((await lstat(join(task, 'apps/quest/node_modules/.vite-temp'))).isSymbolicLink()).toBe(false);
      await writeFile(join(task, 'apps/quest/node_modules/.vite-temp/probe'), 'own cache');
      expect(existsSync(join(root, 'apps/quest/node_modules/.vite-temp/probe'))).toBe(false);
      expect(await realpath(join(task, 'apps/quest/node_modules/lib'))).toBe(await realpath(join(root, 'apps/quest/node_modules/lib')));
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
