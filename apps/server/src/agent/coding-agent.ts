/** Owned Muse Code jobs: edits and terminal work land in a retained task worktree, never auto-merge. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CallLog } from '../muse/callLog';
import { StringDecoder } from 'node:string_decoder';

const MODEL = 'muse-spark-1.3';
const PINNED_VERSION = '1.4.14-R7309.1';
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const JOB_TIMEOUT_MS = 5 * 60_000;
const CODING_TOOLS = ['read_file', 'search', 'write_file', 'edit_file', 'bash', 'bash_input'];
type JobState = 'queued' | 'preparing' | 'running' | 'completed_unverified' | 'failed' | 'cancelled';
export interface CodingJob {
  jobId: string; state: JobState; source: 'live'; requestedModel: string; observedModels: string[];
  modelEvidence: 'native run.usage'; createdAt: number; startedAt?: number; finishedAt?: number;
  workspace: string; branch: string; changedFiles: string[]; exitCode?: number | null; reason?: string;
  terminalReported?: string; lastEvent?: string; operationsObserved: string[]; modelSummary?: string;
  logsTruncated: boolean; patchTruncated: boolean; patchRedacted?: boolean; processGroupTerminated?: boolean; taskHash: string; taskCharacters: number;
  artifacts: { task: string; prompt: string; events: string; stderr: string; patch: string; metadata: string };
}
interface CodingDeps { root: string; dataDir: string; apiKey: string; baseUrl: string; binary?: string; log?: (line: string) => void; callLog?: CallLog }
interface OwnedJob { view: CodingJob; task: string; cancelled: boolean; child?: ChildProcess; done?: Promise<void> }
const terminal = (state: JobState) => ['completed_unverified', 'failed', 'cancelled'].includes(state);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const limited = (text: string, bytes: number) => Buffer.from(text).subarray(0, bytes).toString('utf8');

export function codingModelFailure(models: string[]): string | undefined {
  if (!models.length) return 'Native usage did not identify its model; no model identity was verified.';
  if (models.some(model => model !== MODEL)) return 'Native usage reported an unexpected model. Inspect retained logs and changes.';
}
export function redactCodingPatch(text: string, key: string): { text: string; redacted: boolean } {
  return key && text.includes(key) ? { text: text.split(key).join('[REDACTED META API KEY]'), redacted: true } : { text, redacted: false };
}

/** A closed host does not prove its process group is gone. Escalate until the owned group disappears. */
export async function stopCodingProcessGroup(pgid: number, opts: {
  signal?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  wait?: (ms: number) => Promise<void>; termGraceMs?: number; killGraceMs?: number;
} = {}): Promise<boolean> {
  const signal = opts.signal ?? ((pid, sig) => process.kill(pid, sig));
  const wait = opts.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const gone = () => { try { signal(-pgid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
  const settle = async (ms: number) => {
    if (gone()) return true;
    for (let i = 0; i < Math.ceil(ms / 50); i++) { await wait(50); if (gone()) return true; }
    return false;
  };
  if (gone()) return true;
  try { signal(-pgid, 'SIGTERM'); } catch { /* A failed signal is not a termination receipt. */ }
  if (await settle(opts.termGraceMs ?? 2000)) return true;
  try { signal(-pgid, 'SIGKILL'); } catch { /* Report uncertainty if the group survives or cannot be inspected. */ }
  return settle(opts.killGraceMs ?? 2000);
}

/** These observed JSONL fields are not the separate MSP SDK notification schema. */
export function codingEvent(line: string): { type: string; terminal?: string; models?: string[]; operation?: string; text?: string } | undefined {
  let value: any; try { value = JSON.parse(line); } catch { return; }
  if (typeof value?.payload_type !== 'string' || !value.payload || typeof value.payload !== 'object') return;
  const p = value.payload;
  return { type: value.payload_type,
    ...(value.payload_type.startsWith('run.terminal.') && typeof p.terminal === 'string' ? { terminal: p.terminal } : {}),
    ...(value.payload_type === 'run.usage' && Array.isArray(p.models) ? { models: p.models.map((m: any) => m?.model).filter((m: unknown): m is string => typeof m === 'string') } : {}),
    ...(value.payload_type === 'task.lifecycle.side_effect_intent' && typeof p.event?.operation === 'string' ? { operation: p.event.operation } : {}),
    ...((value.payload_type === 'run.output.delta' || value.payload_type.startsWith('run.terminal.')) && typeof p.text === 'string' ? { text: p.text } : {}),
  };
}

export function codingArgs(workspace: string, prompt: string): string[] {
  return ['exec', '--json', '--provider', 'meta', '--model', MODEL, '--api-key-stdin', '--preset', 'native-basic',
    '--workspace', workspace, '--trust-workspace', '--approval-mode', 'never', '--approval-judge', 'off',
    '--sandbox-network', 'restricted', '--disable-reminders', '--no-foreign-personal-context', '--disable-web-tools',
    '--disable-request-user-input', '--no-parallel-tool-calls', '--contributor-mode', 'off', '--reasoning-effort', 'low',
    '--max-model-steps', '18', '--max-tool-output-bytes', '12000',
    '-c', `run.toolset=${JSON.stringify(CODING_TOOLS)}`, '-c', 'local_session_messaging.enabled=false',
    '--prompt-file', prompt];
}

/** Preserve normal HOME; isolate Muse settings/data and omit provider/third-party secrets from tools. */
export function codingEnvironment(jobDir: string, source: NodeJS.ProcessEnv = process.env, workspace?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT']) if (source[key]) env[key] = source[key];
  const cache = workspace ? join(workspace, 'node_modules', '.cache') : join(jobDir, 'cache');
  return { ...env, XDG_CONFIG_HOME: join(jobDir, 'config'), XDG_DATA_HOME: join(jobDir, 'data'),
    XDG_CACHE_HOME: join(cache, 'muse'), npm_config_cache: join(cache, 'npm'),
    CLANG_MODULE_CACHE_PATH: join(cache, 'clang'), SWIFTPM_MODULECACHE_OVERRIDE: join(cache, 'swift'),
    PYTHONPYCACHEPREFIX: join(cache, 'python'), CI: '1', NO_COLOR: '1', CE_MAC_SILENT: '1', CE_DEMO: '1' };
}

async function command(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, accepted = [0]): Promise<string> {
  return new Promise((yes, no) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout = limited(stdout + b.toString(), MAX_PATCH_BYTES + 1); });
    child.stderr.on('data', b => { stderr = limited(stderr + b.toString(), 4000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', error => { clearTimeout(timeout); no(error); });
    child.once('close', code => { clearTimeout(timeout); accepted.includes(code ?? -1) ? yes(stdout) : no(new Error(`${file} failed (${code}): ${stderr.trim()}`)); });
  });
}

/** Never symlink the whole node_modules: local @ce packages must resolve inside this checkout. */
export async function seedCodingModules(root: string, workspace: string): Promise<void> {
  if (resolve(root) === resolve(workspace)) throw Error('A coding task must have its own checkout.');
  const source = join(root, 'node_modules'), modules = join(workspace, 'node_modules');
  if (!existsSync(source)) return;
  const ownDependencies = async (src: string, dst: string) => {
    // Older preparation linked whole app node_modules; unlink only that link,
    // preserving its target and all job files, before making a private directory.
    if ((await lstat(dst).catch(() => undefined))?.isSymbolicLink()) await unlink(dst);
    await mkdir(dst, { recursive: true });
    for (const entry of await readdir(src)) {
      if (entry === '@ce' || (entry.startsWith('.') && entry !== '.bin') || existsSync(join(dst, entry))) continue;
      await symlink(join(src, entry), join(dst, entry));
    }
    for (const cache of ['.vite-temp', '.vite', '.cache']) {
      const dest = join(dst, cache);
      if ((await lstat(dest).catch(() => undefined))?.isSymbolicLink()) await unlink(dest);
      await mkdir(dest, { recursive: true });
    }
  };
  await ownDependencies(source, modules);
  const ce = join(modules, '@ce');
  if ((await lstat(ce).catch(() => undefined))?.isSymbolicLink()) await unlink(ce);
  await mkdir(ce, { recursive: true });
  for (const parent of ['apps', 'packages']) {
    if (!existsSync(join(root, parent))) continue;
    for (const name of await readdir(join(root, parent))) {
      const rel = join(parent, name), manifest = join(root, rel, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { name?: string };
      if (pkg.name?.startsWith('@ce/')) {
        const link = join(modules, '@ce', pkg.name.slice(4));
        if (!existsSync(link)) await symlink(relative(dirname(link), join(workspace, rel)), link);
      }
      const local = join(root, rel, 'node_modules'), dest = join(workspace, rel, 'node_modules');
      if (existsSync(local)) {
        await ownDependencies(local, dest);
        if (existsSync(join(local, '@ce')) && !existsSync(join(dest, '@ce'))) await symlink(join(modules, '@ce'), join(dest, '@ce'));
      }
    }
  }
}

export class CodingAgentService {
  private readonly root: string;
  private readonly dataDir: string;
  private readonly binary: string;
  private readonly jobs = new Map<string, OwnedJob>();
  private active?: string;
  private version?: string;
  private stopped = false;
  private readonly stopping = new WeakMap<ChildProcess, Promise<boolean>>();
  constructor(private readonly d: CodingDeps) {
    this.root = resolve(d.root); this.dataDir = resolve(d.dataDir);
    this.binary = resolve(d.binary ?? join(this.dataDir, 'muse-code', 'bin', `muse-bin-${PINNED_VERSION}`));
  }
  status() {
    return { backend: 'muse-code', installed: existsSync(this.binary), available: existsSync(this.binary) && !!this.d.apiKey, binary: this.binary,
      pinnedVersion: PINNED_VERSION, version: this.version ?? null, requestedModel: MODEL,
      activeJobId: this.active ?? null, tools: [...CODING_TOOLS], agentHost: 'Mac native Muse Code',
      writeScope: 'Retained task worktree and OS sandbox temp; no automatic application to the main checkout',
      readScope: 'Native file tools are workspace-gated; the shell sandbox can read other permitted Mac files',
      soundEnabled: false, hardwareActuationRequested: false };
  }
  list(): CodingJob[] { return [...this.jobs.values()].map(j => this.view(j)); }
  get(id: string): CodingJob | undefined { const j = this.jobs.get(id); return j ? this.view(j) : undefined; }
  async patch(id: string): Promise<string> {
    const j = this.jobs.get(id); if (!j) throw Error('Unknown coding job.');
    const patch = redactCodingPatch(await readFile(j.view.artifacts.patch, 'utf8').catch(() => ''), this.d.apiKey);
    if (patch.redacted) { j.view.patchRedacted = true; await writeFile(j.view.artifacts.patch, patch.text, { mode: 0o600 }); }
    return j.view.patchRedacted ? '# REDACTED REVIEW COPY: not an ordinary apply-ready patch. Review the retained worktree locally.\n' + patch.text : patch.text;
  }
  private view(j: OwnedJob): CodingJob { return structuredClone(j.view); }
  private redact(text: string): string { return (this.d.apiKey ? text.split(this.d.apiKey).join('[redacted]') : text).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'); }
  private clean(text: string): string { return limited(this.redact(text), 4000); }
  private async save(j: OwnedJob) { await writeFile(j.view.artifacts.metadata, JSON.stringify(j.view, null, 2) + '\n', { mode: 0o600 }); }
  async start(input: { task: string }): Promise<CodingJob> {
    if (this.stopped) throw Error('Coding service is closed.');
    if (this.active) throw Error('A coding job is already running. Wait or cancel it first.');
    const task = input.task.trim();
    if (!task || task.length > 12_000) throw Error('A coding task must contain 1–12000 characters.');
    if (!this.d.apiKey) throw Error('Muse Code needs the Meta API key; a fixture is not substituted.');
    if (!existsSync(this.binary)) throw Error('The pinned Muse Code binary is not installed.');
    if (new URL(this.d.baseUrl).hostname !== 'api.meta.ai') throw Error('The native coding service requires the Meta API endpoint.');
    const jobId = randomUUID(), dir = join(this.dataDir, 'coding', 'jobs', jobId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Reserve before launching asynchronous setup; a second start cannot overlap this job.
    if (this.active || this.stopped) throw Error('The coding service became busy before this task started.');
    this.active = jobId;
    const j: OwnedJob = { task, cancelled: false, view: { jobId, state: 'queued', source: 'live', requestedModel: MODEL,
      observedModels: [], modelEvidence: 'native run.usage', createdAt: Date.now(),
      workspace: join(this.root, '.data', 'coding-workspaces', jobId), branch: `coding/${jobId}`, changedFiles: [],
      operationsObserved: [], logsTruncated: false, patchTruncated: false, taskHash: hash(task), taskCharacters: task.length,
      artifacts: { task: join(dir, 'task.txt'), prompt: join(dir, 'prompt.txt'), events: join(dir, 'events.jsonl'),
        stderr: join(dir, 'stderr.log'), patch: join(dir, 'gitdiff.patch'), metadata: join(dir, 'job.json') } } };
    this.jobs.set(jobId, j);
    if (this.jobs.size > 50) { const first = this.jobs.keys().next().value; if (first && first !== this.active) this.jobs.delete(first); }
    j.done = this.run(j).catch(error => { this.d.log?.(`[coding] ${jobId} finalization failed: ${this.clean(String(error))}`); });
    return this.view(j);
  }
  async cancel(id: string): Promise<CodingJob | undefined> {
    const j = this.jobs.get(id); if (!j) return;
    if (!terminal(j.view.state)) { j.cancelled = true; void this.stopGroup(j.child); await j.done; }
    return this.view(j);
  }
  async close(): Promise<void> { this.stopped = true; if (this.active) await this.cancel(this.active); }
  private stopGroup(child?: ChildProcess): Promise<boolean> {
    if (!child?.pid) return Promise.resolve(true);
    let stopping = this.stopping.get(child);
    if (!stopping) { stopping = stopCodingProcessGroup(child.pid); this.stopping.set(child, stopping); }
    return stopping;
  }
  private async run(j: OwnedJob): Promise<void> {
    const v = j.view, dir = dirname(v.artifacts.metadata), env = codingEnvironment(dir, process.env, v.workspace);
    const guard = () => { if (j.cancelled || this.stopped) throw Error('Coding job cancelled.'); };
    const git = (args: string[], cwd = this.root, accepted = [0]) => command('git', ['-c', 'core.hooksPath=/dev/null', ...args], cwd, env, accepted);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let outcome: JobState = 'failed';
    let ownedClose: Promise<{ code: number | null; error?: Error }> | undefined;
    try {
      v.state = 'preparing'; await this.save(j); guard();
      await writeFile(v.artifacts.task, j.task + '\n', { mode: 0o600 });
      await mkdir(dirname(v.workspace), { recursive: true });
      await git(['worktree', 'add', '-b', v.branch, v.workspace, 'HEAD']); guard();
      await seedCodingModules(this.root, v.workspace); guard();
      const rules = join(this.root, 'AGENTS.md');
      if (existsSync(rules) && !existsSync(join(v.workspace, 'AGENTS.md'))) await writeFile(join(v.workspace, 'AGENTS.md'), await readFile(rules));
      await mkdir(join(dir, 'config', 'muse'), { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'config', 'muse', 'settings.json'), JSON.stringify({ schema_version: 1, telemetry: { enabled: false } }), { mode: 0o600 });
      this.version = this.clean((await command(this.binary, ['--version'], v.workspace, env)).trim()); guard();
      const prompt = [
        'You are Muse Code developing ControlAnything on this Mac in an isolated task worktree.',
        'You have real read/search/write/edit and terminal tools. Inspect source and relevant logs, implement the requested code, run focused checks, and debug actual failures.',
        'Only modify this task workspace. Do not commit, merge, push, change repository visibility, delete data, alter user profiles, or edit another checkout.',
        'The owner explicitly wants audible software demos and OS/browser voices, controlled by the shared master volume/mute. Automated checks should use mute=1 to avoid overlapping sound. Do not actuate physical MIDI, Bluetooth/IR/gimbals, launch agents, or system changes without an explicit device request. Read-only USB/MIDI enumeration is allowed; mock tests must not emit to hardware.',
        'Do not call the live demo server on 8787/8443, reload the headset, or start a background service. Use separate fixture ports and stop owned temporary processes.',
        'Network from shell is restricted. Do not bypass the sandbox or invoke another AI model/agent. Missing dependencies or required permission are blockers to report, not reasons to escape the task workspace.',
        'The API key is supplied to the native host only. Never read secrets or print credentials. No filesystem/command output is proof of a physical effect.',
        'Keep changes small and preserve Muse-written glue, gesture-first controls and the audible demo with one shared master volume/mute. Describe actual changed files and exact checks/results; distinguish untested hardware. A completed turn alone does not mean the task works.',
        '\nOWNER TASK:\n' + j.task,
      ].join('\n');
      await writeFile(v.artifacts.prompt, prompt, { mode: 0o600 });
      await writeFile(v.artifacts.events, '', { mode: 0o600 }); await writeFile(v.artifacts.stderr, '', { mode: 0o600 }); guard();
      const args = [...codingArgs(v.workspace, v.artifacts.prompt), '--base-url', this.d.baseUrl];
      const child = spawn(this.binary, args, { cwd: v.workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const endedPromise = ownedClose = new Promise<{ code: number | null; error?: Error }>(yes => {
        let spawnError: Error | undefined;
        child.once('error', error => { spawnError = error; }); child.once('close', code => yes({ code, error: spawnError }));
      });
      j.child = child; v.state = 'running'; v.startedAt = Date.now();
      let pending = '', stderrPending = '', stderrTail = '', queued = Promise.resolve(), stdoutBytes = 0, stderrBytes = 0;
      let logError: Error | undefined;
      const append = (file: string, text: string, stream: 'stdout' | 'stderr') => {
        const used = stream === 'stdout' ? stdoutBytes : stderrBytes, remaining = Math.max(0, MAX_LOG_BYTES - used);
        const bytes = Buffer.byteLength(text); if (bytes > remaining) v.logsTruncated = true;
        const kept = Buffer.from(text).subarray(0, remaining).toString('utf8');
        if (stream === 'stdout') stdoutBytes += Buffer.byteLength(kept); else stderrBytes += Buffer.byteLength(kept);
        if (kept) queued = queued.then(() => appendFile(file, kept)).catch(error => {
          logError = error; v.logsTruncated = true; this.stopGroup(child);
        });
      };
      const line = (raw: string) => {
        const safe = this.redact(raw); append(v.artifacts.events, safe + '\n', 'stdout');
        const event = codingEvent(safe); if (!event) return;
        if (event.type === 'run.usage') {
          const usage = JSON.parse(safe).payload;
          for (const row of usage.models ?? []) {
            if (!Number.isSafeInteger(row.calls) || row.calls < 1) continue;
            const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
            this.d.callLog?.add({ at: v.startedAt ?? v.createdAt, label: `muse_code ${v.jobId} (native aggregate)`,
              model: typeof row.model === 'string' ? row.model : 'not-reported', source: 'live',
              ok: row.model === MODEL && usage.failed_calls === 0, callCount: row.calls,
              failureCount: row.model === MODEL ? Math.min(row.calls, count(usage.failed_calls)) : row.calls,
              latencyMs: Date.now() - (v.startedAt ?? v.createdAt), format: 'native_cli_aggregate',
              usage: { promptTokens: count(row.input_tokens), completionTokens: count(row.output_tokens),
                totalTokens: count(row.input_tokens) + count(row.output_tokens), reasoningTokens: count(row.reasoning_tokens), cachedTokens: count(row.cached_tokens) } });
          }
        }
        v.lastEvent = event.type;
        if (event.terminal) v.terminalReported = event.terminal;
        if (event.models) v.observedModels = [...new Set([...v.observedModels, ...event.models])];
        if (event.operation && !v.operationsObserved.includes(event.operation)) v.operationsObserved.push(event.operation);
        if (event.text) v.modelSummary = event.terminal ? this.clean(event.text) : this.clean((v.modelSummary ?? '') + event.text);
      };
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', bytes => {
        pending += stdoutDecoder.write(bytes); let i: number;
        while ((i = pending.indexOf('\n')) >= 0) { line(pending.slice(0, i)); pending = pending.slice(i + 1); }
        if (pending.length > MAX_LOG_BYTES) { v.logsTruncated = true; pending = ''; }
      });
      const stderrLine = (raw: string) => { const safe = this.redact(raw); stderrTail = this.clean((stderrTail + safe + '\n').slice(-4000)); append(v.artifacts.stderr, safe + '\n', 'stderr'); };
      child.stderr.on('data', bytes => {
        stderrPending += stderrDecoder.write(bytes); let i: number;
        while ((i = stderrPending.indexOf('\n')) >= 0) { stderrLine(stderrPending.slice(0, i)); stderrPending = stderrPending.slice(i + 1); }
        if (stderrPending.length > MAX_LOG_BYTES) { v.logsTruncated = true; stderrPending = ''; }
      });
      child.stdin.on('error', () => {}); child.stdin.end(this.d.apiKey + '\n');
      let timedOut = false;
      timeout = setTimeout(() => { timedOut = true; this.stopGroup(child); }, JOB_TIMEOUT_MS);
      await this.save(j);
      const ended = await endedPromise;
      v.processGroupTerminated = await this.stopGroup(child);
      j.child = undefined;
      clearTimeout(timeout); timeout = undefined; pending += stdoutDecoder.end(); stderrPending += stderrDecoder.end();
      if (pending) line(pending); if (stderrPending) stderrLine(stderrPending); await queued;
      v.exitCode = ended.code;
      if (j.cancelled || this.stopped) { outcome = 'cancelled'; v.reason = 'Owned native process stopped; no changes were applied to the main checkout.'; }
      else if (timedOut) { outcome = 'failed'; v.reason = 'Native coding job reached its five-minute limit.'; }
      else if (logError || ended.error || ended.code !== 0 || v.terminalReported !== 'completed') {
        outcome = 'failed'; v.reason = logError ? this.clean(`Native log capture failed: ${logError.message}`) : ended.error ? this.clean(ended.error.message) : this.clean(`Native job ended with exit ${ended.code}, terminal ${v.terminalReported ?? 'not reported'}. ${stderrTail.slice(-1200) || 'Inspect retained logs.'}`);
      } else if (codingModelFailure(v.observedModels)) { outcome = 'failed'; v.reason = codingModelFailure(v.observedModels); }
      else { outcome = 'completed_unverified'; v.reason = 'Muse finished its turn. File changes and checks require independent review.'; }
    } catch (error) {
      outcome = j.cancelled || this.stopped ? 'cancelled' : 'failed'; v.reason = this.clean((error as Error).message ?? String(error));
      if (j.child) { const stopped = this.stopGroup(j.child); await ownedClose; v.processGroupTerminated = await stopped; j.child = undefined; }
    } finally {
      if (timeout) clearTimeout(timeout);
      try {
        if (existsSync(join(v.workspace, '.git'))) {
          const tracked = await git(['diff', '--name-only', '-z', 'HEAD'], v.workspace);
          const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], v.workspace);
          v.changedFiles = [...new Set((tracked + untracked).split('\0').filter(Boolean))];
          let patch = await git(['diff', '--binary', 'HEAD'], v.workspace);
          for (const file of untracked.split('\0').filter(Boolean)) {
            const path = resolve(v.workspace, file);
            if (!path.startsWith(v.workspace + sep)) continue;
            patch += await git(['diff', '--no-index', '--binary', '--', '/dev/null', file], v.workspace, [0, 1]);
            if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) break;
          }
          v.patchTruncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
          const safePatch = redactCodingPatch(patch, this.d.apiKey);
          v.patchRedacted = safePatch.redacted;
          await writeFile(v.artifacts.patch, limited(safePatch.text, MAX_PATCH_BYTES), { mode: 0o600 });
        }
      } catch (error) { outcome = 'failed'; v.reason = `${v.reason ?? ''} Patch capture failed: ${this.clean((error as Error).message)}`.trim(); }
      if (j.cancelled || this.stopped) { outcome = 'cancelled'; v.reason = 'Owned native process stopped; no changes were applied to the main checkout.'; }
      if (v.processGroupTerminated === false) { if (outcome !== 'cancelled') outcome = 'failed'; v.reason = `${v.reason ?? ''} Native host closed, but termination of its full process group was not confirmed.`.trim(); }
      if (v.patchRedacted) v.reason = `${v.reason ?? ''} The patch contains credential redactions and is not an ordinary apply-ready diff.`.trim();
      v.state = outcome; v.finishedAt = Date.now(); j.child = undefined;
      try { await this.save(j); } catch (error) { this.d.log?.(`[coding] ${v.jobId} could not save job metadata: ${this.clean(String(error))}`); }
      if (this.active === v.jobId) this.active = undefined;
      this.d.log?.(`[coding] ${v.jobId} ${v.state} · ${v.changedFiles.length} changed files · main checkout not updated`);
    }
  }
}
