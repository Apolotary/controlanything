/** A fresh Muse Code workspace: contract data in, newly authored connector and hand program out. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CallLog } from '../muse/callLog';
import { codingArgs, codingEnvironment, codingEvent, codingModelFailure, stopCodingProcessGroup } from './coding-agent';

const MODEL = 'muse-spark-1.3' as const;
const VERSION = '1.4.14-R7309.1';
const FILE_TOOLS = ['read_file', 'search', 'write_file', 'edit_file'];
const BUDGET_MS = 180_000;
const MAX_FILE = 64 * 1024;
const MAX_LOG = 2 * 1024 * 1024;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export interface FreshContract {
  cardId: string; deviceName: string; request: string; portHint: string;
  ports: { id: string; name?: string; state?: string }[];
  actions: { actionId: string; label: string; kind: 'set' | 'trigger'; channel: number; cc?: number; program?: number; min: number; max: number; effect?: string }[];
  signalsApi: string; hints: string[];
}
export interface FreshArtifacts {
  /** BODY of connector(input), executed on the Mac host. */
  connector: string;
  /** BODY of wire(s, out, mem), executed by the existing Quest Worker. */
  gesture: string;
  title: string; explanation: string; needs: ('right' | 'left' | 'screen')[];
}
export interface FreshGenerated extends FreshArtifacts {
  jobId: string; model: typeof MODEL; source: 'live'; workspace: string;
  hashes: { connector: string; gesture: string }; createdAt: number; finishedAt: number; observedModels: string[];
}
export interface FreshGeneratorDeps {
  dataDir: string; apiKey: string; baseUrl: string; binary?: string;
  log?: (line: string) => void; callLog?: CallLog;
}
export interface FreshGenerateOptions {
  signal?: AbortSignal; onProgress?: (note: string, code?: string) => void;
  /** The host executes independent checks. Actual errors are returned to Muse for one repair. */
  check: (artifacts: FreshArtifacts) => string[];
}

/** File tools enforce the native workspace boundary; no shell can read the existing repository. */
export function freshConnectorArgs(workspace: string, prompt: string, baseUrl: string): string[] {
  const args = codingArgs(workspace, prompt);
  const toolset = args.findIndex(arg => arg.startsWith('run.toolset='));
  if (toolset < 0) throw Error('Native coding toolset configuration is missing.');
  args[toolset] = `run.toolset=${JSON.stringify(FILE_TOOLS)}`;
  return [...args, '--base-url', baseUrl];
}

function promptFor(repair?: string[]): string {
  return [
    'You are Muse Code creating a NEW device connector and a matching Quest hand program during the owner\'s demo.',
    'This workspace initially contains ONLY contract.json and request.txt. No implementation or template exists. Write the three requested files from scratch using the contract DATA. Do not search outside this workspace, reuse repository code, call other models, or claim physical execution.',
    'Read contract.json and request.txt, then write exactly connector.js, gesture.js, manifest.json. Do not create dependencies or run commands. The host independently executes the checks after you finish. No Markdown fences.',
    'connector.js is ONLY the BODY of a synchronous pure function connector(input), without a function header, export, import, or module wrapper.',
    'For input.kind === "bind": input has ports [{id,name?,state?}] and hint. Return {portId} for the exact ID or UNIQUE exact case-insensitive name matching hint, considering only connected ports. No ambiguous matching, no substring guessing. With no hint choose only when exactly one connected port exists; otherwise throw Error.',
    'For input.kind === "encode": input has actionId and value. Encode ONLY a listed contract action using its channel and CC/program number. Return {bytes:[...]} containing a standard CC or program-change MIDI packet. Channel is 1-based in the contract, status byte channels are zero-based. Set values must be finite, rounded and clamped to the action\'s OWN min/max, not just 0..127. Trigger actions use their listed program number. Reject unknown actions, invalid kind, and nonnumeric values. Never implement SysEx, hardware setup, audio unlock, arbitrary MIDI, or transport itself.',
    'OS USB/WebMIDI and paired generic raw send already exist as transport infrastructure. YOUR connector must perform actual port binding and packet encoding; it will be loaded automatically only after host validation.',
    'gesture.js is ONLY the BODY of synchronous function wire(s,out,mem), with no function header/export/import. Use the Signals API and action descriptions in contract.json. out.set("literal-action-id", rawValue) and out.trigger("literal-action-id") are the only outputs. mem is persistent state. Read only requested signals. All hand/screen signals may be null. Keep it small and match the request exactly. Explain how to use it truthfully. Do not add an unrequested fist clutch.',
    'For screen touch, emit X and Y before pressure while inside; pressure is zero when outside/lifted/lost. For musical gate send zero on loss/release. For forward/back movement use push, never height. Hints describe capability data, not prewritten code.',
    'Allowed globals: Math, Number, Boolean, Array, Object, isFinite, isNaN, parseFloat, Error. Forbidden: imports, require, fetch, XMLHttpRequest, WebSocket, eval, Function, constructor, prototype, __proto__, globalThis, self, process, document, window, this, Reflect, Proxy, promises, async, timers, regular-expression literals, Unicode-escape identifiers, computed property names built from strings. Never read/write files from generated programs.',
    'manifest.json is {"title":"short wearer-facing name","explanation":"one sentence describing the actual gesture and stop/release","needs":["right","left","screen"]}. Include only signals actually used. Title <=60 characters, explanation <=200. Both code files must be shorter than 40 lines where practical.',
    'This pure connector must not open audio devices, actuate hardware, launch/reload browsers, read secrets, start background processes, edit repositories, use git or external network. The application provides audible feedback through its shared audio master; do not mute it or replace its sound engine. Finish after writing the files; your prose is not execution evidence.',
    ...(repair ? ['The independent host rejected the previous files. Read the existing files and repair these ACTUAL errors, then finish:', ...repair.map(issue => `- ${issue.slice(0, 600)}`)] : []),
  ].join('\n');
}

/** Read only ordinary, bounded output files: native file tools must not smuggle a symlink into hot-load. */
async function outputFile(workspace: string, name: string): Promise<string> {
  const path = join(workspace, name), st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > MAX_FILE) throw Error(`${name} must be an ordinary nonempty file smaller than ${MAX_FILE} bytes.`);
  return readFile(path, 'utf8');
}

async function readArtifacts(workspace: string): Promise<FreshArtifacts> {
  const [connector, gesture, manifestText] = await Promise.all(['connector.js', 'gesture.js', 'manifest.json'].map(name => outputFile(workspace, name)));
  const manifest: unknown = JSON.parse(manifestText);
  if (!manifest || typeof manifest !== 'object') throw Error('manifest.json must contain an object.');
  const m = manifest as Record<string, unknown>;
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 60) throw Error('Manifest title must have 1–60 characters.');
  if (typeof m.explanation !== 'string' || !m.explanation.trim() || m.explanation.length > 200) throw Error('Manifest explanation must have 1–200 characters.');
  if (!Array.isArray(m.needs) || m.needs.length > 3 || m.needs.some(need => !['right', 'left', 'screen'].includes(need as string))) throw Error('Manifest needs may contain only right, left and screen.');
  return { connector, gesture, title: m.title, explanation: m.explanation, needs: [...new Set(m.needs)] as FreshArtifacts['needs'] };
}

export class FreshConnectorGenerator {
  private readonly binary: string;
  private active?: { controller: AbortController; done: Promise<unknown> };
  private closed = false;
  constructor(private readonly d: FreshGeneratorDeps) {
    this.binary = resolve(d.binary ?? join(d.dataDir, 'muse-code', 'bin', `muse-bin-${VERSION}`));
  }
  status() {
    return { available: existsSync(this.binary) && !!this.d.apiKey, active: !!this.active, model: MODEL,
      backend: 'muse-code-fresh', tools: [...FILE_TOOLS], startsWithImplementation: false, hotLoadRequiresChecks: true };
  }
  async generate(contract: FreshContract, opts: FreshGenerateOptions): Promise<FreshGenerated> {
    if (this.closed) throw Error('Fresh connector generation is closed.');
    if (this.active) throw Error('Muse is already writing a fresh connector. Wait or stop that request.');
    if (!this.d.apiKey || !existsSync(this.binary)) throw Error('Fresh connector generation needs the installed native Muse Code binary and Meta API key. No template is substituted.');
    if (new URL(this.d.baseUrl).hostname !== 'api.meta.ai') throw Error('Fresh connector generation requires the Meta API endpoint.');
    if (!contract.request.trim() || contract.request.length > 12_000 || !contract.actions.length) throw Error('A fresh connector needs an explicit request and reviewed device actions.');
    const controller = new AbortController();
    const relay = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', relay, { once: true });
    if (opts.signal?.aborted) relay();
    const timer = setTimeout(() => controller.abort(Error('Fresh connector generation reached its three-minute limit.')), BUDGET_MS);
    const done = this.run(contract, opts, controller.signal);
    this.active = { controller, done };
    try { return await done; }
    finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', relay); if (this.active?.done === done) this.active = undefined; }
  }
  async close(): Promise<void> {
    this.closed = true;
    const active = this.active; if (!active) return;
    active.controller.abort(Error('Server is closing.'));
    await active.done.catch(() => {});
  }
  private redact(text: string): string {
    return (this.d.apiKey ? text.split(this.d.apiKey).join('[redacted]') : text).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }
  private async run(contract: FreshContract, opts: FreshGenerateOptions, signal: AbortSignal): Promise<FreshGenerated> {
    const jobId = randomUUID(), createdAt = Date.now();
    const dir = resolve(this.d.dataDir, 'fresh-connectors', jobId), workspace = join(dir, 'workspace');
    const observedModels = new Set<string>();
    const receipt: Record<string, unknown> = { jobId, cardId: contract.cardId, createdAt, source: 'live', requestedModel: MODEL,
      workspace, taskHash: sha(contract.request), initialFiles: ['contract.json', 'request.txt'], implementationPresentInitially: false, state: 'writing', checks: [] };
    const contractText = JSON.stringify(contract, null, 2) + '\n', requestText = contract.request + '\n';
    receipt.contractHash = sha(contractText);
    const guard = () => { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : Error('Fresh connector generation cancelled.'); };
    const save = () => writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    try {
      guard(); await mkdir(workspace, { recursive: true, mode: 0o700 });
      await writeFile(join(workspace, 'contract.json'), contractText, { mode: 0o600 });
      await writeFile(join(workspace, 'request.txt'), requestText, { mode: 0o600 });
      receipt.initialFiles = await readdir(workspace);
      await mkdir(join(dir, 'config', 'muse'), { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'config', 'muse', 'settings.json'), JSON.stringify({ schema_version: 1, telemetry: { enabled: false } }), { mode: 0o600 });
      await save();
      let issues: string[] | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        guard(); opts.onProgress?.(attempt === 1 ? 'Muse is creating a new connector and hand program…' : 'Muse is repairing the files against the actual check results…');
        await this.attempt({ dir, workspace, jobId, attempt, issues, signal, observedModels, onProgress: opts.onProgress });
        guard();
        let artifacts: FreshArtifacts | undefined;
        try {
          if (await outputFile(workspace, 'contract.json') !== contractText || await outputFile(workspace, 'request.txt') !== requestText) throw Error('The device contract and owner request are immutable input data. Restore their original contents.');
          artifacts = await readArtifacts(workspace);
          if (this.d.apiKey && JSON.stringify(artifacts).includes(this.d.apiKey)) throw Error('Generated artifacts contained a credential and cannot be loaded.');
          issues = opts.check(artifacts).slice(0, 12).map(issue => String(issue).slice(0, 1000));
        } catch (error) { issues = [(error as Error).message]; }
        (receipt.checks as unknown[]).push({ attempt, at: Date.now(), issues });
        await save(); guard();
        if (artifacts && !issues.length) {
          const result: FreshGenerated = { ...artifacts, jobId, model: MODEL, source: 'live', workspace,
            hashes: { connector: sha(artifacts.connector), gesture: sha(artifacts.gesture) }, createdAt, finishedAt: Date.now(), observedModels: [...observedModels] };
          Object.assign(receipt, { state: 'checked', finishedAt: result.finishedAt, hashes: result.hashes, observedModels: result.observedModels,
            checksMean: 'Host program checks only. Runtime activation and physical effect require separate receipts.' });
          await save();
          opts.onProgress?.('New connector and hand program passed host checks.', `// Connector · runs on the Mac\n${artifacts.connector}\n\n// Hand program · runs on the Quest\n${artifacts.gesture}`);
          return result;
        }
      }
      throw Error(`Muse's fresh connector failed host checks: ${(issues ?? []).join('; ')}`);
    } catch (error) {
      Object.assign(receipt, { state: signal.aborted ? 'cancelled' : 'failed', finishedAt: Date.now(), observedModels: [...observedModels], reason: this.redact((error as Error).message) });
      await save().catch(() => {}); throw error;
    }
  }
  private async attempt(o: {
    dir: string; workspace: string; jobId: string; attempt: number; issues?: string[]; signal: AbortSignal;
    observedModels: Set<string>; onProgress?: FreshGenerateOptions['onProgress'];
  }): Promise<void> {
    const prompt = join(o.dir, `prompt-${o.attempt}.txt`), events = join(o.dir, `events-${o.attempt}.jsonl`), stderr = join(o.dir, `stderr-${o.attempt}.log`);
    await writeFile(prompt, promptFor(o.issues), { mode: 0o600 });
    await writeFile(events, '', { mode: 0o600 }); await writeFile(stderr, '', { mode: 0o600 });
    if (o.signal.aborted) throw Error('Fresh connector generation cancelled.');
    const child = spawn(this.binary, freshConnectorArgs(o.workspace, prompt, this.d.baseUrl), {
      cwd: o.workspace, env: codingEnvironment(o.dir), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const startedAt = Date.now(), models = new Set<string>();
    let stopping: Promise<boolean> | undefined;
    const stop = () => stopping ??= child.pid ? stopCodingProcessGroup(child.pid) : Promise.resolve(true);
    const onAbort = () => { void stop(); };
    o.signal.addEventListener('abort', onAbort, { once: true });
    if (o.signal.aborted) onAbort();
    let queued = Promise.resolve(), stdoutUsed = 0, stderrUsed = 0, pending = '', stderrPending = '', terminal: string | undefined, spawnError: Error | undefined, logError: Error | undefined;
    const decoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const append = (path: string, text: string, stream: 'stdout' | 'stderr') => {
      const used = stream === 'stdout' ? stdoutUsed : stderrUsed;
      const safe = Buffer.from(this.redact(text)).subarray(0, Math.max(0, MAX_LOG - used)).toString('utf8');
      if (stream === 'stdout') stdoutUsed += Buffer.byteLength(safe); else stderrUsed += Buffer.byteLength(safe);
      if (safe) queued = queued.then(() => appendFile(path, safe)).catch(error => { logError = error; void stop(); });
    };
    const line = (raw: string) => {
      append(events, raw + '\n', 'stdout');
      const event = codingEvent(raw); if (!event) return;
      if (event.terminal) terminal = event.terminal;
      for (const model of event.models ?? []) { models.add(model); o.observedModels.add(model); }
      if (event.type === 'run.usage') {
        const usage = JSON.parse(raw).payload;
        const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
        for (const row of usage.models ?? []) {
          if (!Number.isSafeInteger(row.calls) || row.calls < 1) continue;
          this.d.callLog?.add({ at: startedAt, label: `fresh_connector ${o.jobId} attempt ${o.attempt} (native aggregate)`, model: row.model,
            source: 'live', ok: row.model === MODEL && usage.failed_calls === 0, callCount: row.calls,
            failureCount: row.model === MODEL ? Math.min(row.calls, count(usage.failed_calls)) : row.calls,
            latencyMs: Date.now() - startedAt, format: 'native_cli_aggregate',
            usage: { promptTokens: count(row.input_tokens), completionTokens: count(row.output_tokens), totalTokens: count(row.input_tokens) + count(row.output_tokens), reasoningTokens: count(row.reasoning_tokens), cachedTokens: count(row.cached_tokens) } });
        }
      }
    };
    child.stdout.on('data', bytes => {
      pending += decoder.write(bytes); let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) { line(pending.slice(0, nl)); pending = pending.slice(nl + 1); }
      if (pending.length > MAX_LOG) { logError = Error('Native output line exceeded the capture limit.'); pending = ''; void stop(); }
    });
    child.stderr.on('data', bytes => {
      stderrPending += stderrDecoder.write(bytes); let nl: number;
      while ((nl = stderrPending.indexOf('\n')) >= 0) { append(stderr, stderrPending.slice(0, nl) + '\n', 'stderr'); stderrPending = stderrPending.slice(nl + 1); }
      if (stderrPending.length > MAX_LOG) { logError = Error('Native stderr line exceeded the capture limit.'); stderrPending = ''; void stop(); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(this.d.apiKey + '\n');
    // Snapshot real file contents. A complete write may appear at once; no artificial typing or model-prose preview.
    let snapshotBusy = false, previous = '';
    const snapshot = async () => {
      if (snapshotBusy || o.signal.aborted) return; snapshotBusy = true;
      try {
        const [connector, gesture] = await Promise.all(['connector.js', 'gesture.js'].map(name => outputFile(o.workspace, name).catch(() => '')));
        const code = `${connector ? `// Connector · runs on the Mac\n${connector}` : ''}${gesture ? `\n\n// Hand program · runs on the Quest\n${gesture}` : ''}`;
        if (code.trim() && code !== previous) { previous = code; o.onProgress?.('Muse wrote these files; host checks are still pending.', this.redact(code)); }
      } finally { snapshotBusy = false; }
    };
    const poll = setInterval(() => { void snapshot(); }, 500); poll.unref();
    let terminated = false;
    try {
      const code = await new Promise<number | null>(yes => {
        child.once('error', error => { spawnError = error; }); child.once('close', yes);
      });
      terminated = await stop();
      pending += decoder.end(); if (pending) line(pending);
      stderrPending += stderrDecoder.end(); if (stderrPending) append(stderr, stderrPending, 'stderr');
      await queued; await snapshot();
      if (o.signal.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : Error('Fresh connector generation cancelled.');
      if (spawnError || logError) throw spawnError ?? logError;
      if (!terminated) throw Error('Native connector writer closed, but process-group termination was not confirmed.');
      if (code !== 0 || terminal !== 'completed') throw Error(`Muse connector writer ended with exit ${code}, terminal ${terminal ?? 'not reported'}.`);
      const modelError = codingModelFailure([...models]); if (modelError) throw Error(modelError);
    } finally {
      clearInterval(poll); o.signal.removeEventListener('abort', onAbort);
      if (!terminated) await stop();
      this.d.log?.(`[fresh] ${o.jobId} attempt ${o.attempt} native writer ended; model ${[...models].join(',') || 'unreported'}`);
    }
  }
}
