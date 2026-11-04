/**
 * Muse Code as the agent (CE_AGENT_ENGINE=muse-code).
 *
 * Instead of our own tool loop calling muse-spark-1.3, Meta's official coding agent (the `muse` CLI, headless
 * `muse exec`) does the work with its full tools (shell, files, search, web) in the Muse workspace. ControlAnything's
 * device tools reach it through MCP: a loopback streamable-HTTP server, one per run, behind a random bearer token,
 * registered in the run's private `$XDG_CONFIG_HOME/muse/settings.json` (`mcpServers`). The device tools (say,
 * open_visuals, deploy_connector, test_action, finish) run through MuseAgent.build() as an AgentDriver, so they get
 * exactly the same checks, transcript and result as the built-in loop. `look` returns the snapshot and context.
 *
 * Muse Code's JSONL events (commands, files, prose) stream into the AR code card. When finish is accepted the run
 * ends and the Muse Code process group is stopped. If the binary is missing, or Muse Code stops before calling any
 * device tool, the built-in loop runs instead (same request, same card).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CallLog } from '../muse/callLog';
import { RequestCancelledError } from '../muse/cancellation';
import { stopCodingProcessGroup } from './coding-agent';
import { AGENT_LIMITS, AGENT_MODEL, AGENT_SYSTEM, AGENT_TOOLS, type AgentContext, type AgentDriver, type AgentWritten, type MuseAgent } from './muse-agent';
import type { WireEmit } from './wire';

export const MUSE_CODE_VERSION = '1.4.14-R7309.1';
/** The device tools Muse Code gets over MCP (its own shell/file tools replace ours). */
const DEVICE_TOOLS = ['say', 'open_visuals', 'deploy_connector', 'test_action', 'finish'] as const;
const MCP_NAME = 'controlanything';

// --- MCP over streamable HTTP (JSON responses), loopback only ---------------------------------------------------------

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpContent { type: 'text'; text: string }
export interface McpImage { type: 'image'; data: string; mimeType: string }
export interface McpCallResult { content: (McpContent | McpImage)[]; isError?: boolean }

export interface McpServerHandle { url: string; token: string; close(): Promise<void> }

/**
 * A minimal MCP server: initialize, tools/list, tools/call, ping. Answers each JSON-RPC request with one JSON body
 * (allowed by the streamable-HTTP transport), 202 for notifications, 405 for the optional GET stream.
 */
export function startMcpServer(o: { tools: McpTool[]; call: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>; log?: (line: string) => void }): Promise<McpServerHandle> {
  const token = randomBytes(24).toString('hex');
  const path = `/mcp/${randomBytes(8).toString('hex')}`;
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== path || req.headers.authorization !== `Bearer ${token}`) { send(res, 401, { error: 'unauthorized' }); return; }
    if (req.method === 'DELETE') { send(res, 200); return; }
    if (req.method !== 'POST') { send(res, 405, undefined, { allow: 'POST' }); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) { send(res, 413); return; } }
    let msg: { jsonrpc?: string; id?: string | number; method?: string; params?: any };
    try { msg = JSON.parse(raw); } catch { send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    if (msg.id === undefined || msg.id === null) { send(res, 202); return; } // notifications/initialized etc.
    const ok = (result: unknown, headers?: Record<string, string>) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result }, headers);
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_NAME, version: '1.0.0' },
          instructions: 'ControlAnything device tools: look at the selected object, speak to the wearer, deploy and test the connector, finish with AR controls.' },
        { 'mcp-session-id': randomUUID() });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: o.tools });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments as Record<string, unknown> : {};
        if (!o.tools.some((t) => t.name === name)) return ok({ content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true });
        try { return ok(await o.call(name, args)); }
        catch (e) { return ok({ content: [{ type: 'text', text: `Tool error: ${(e as Error).message}` }], isError: true }); }
      }
      default: return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  };
  const server: Server = createServer((req, res) => { handle(req, res).catch((e) => { o.log?.(`[muse-code] mcp: ${(e as Error).message}`); if (!res.headersSent) send(res, 500); }); });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      done({ url: `http://127.0.0.1:${port}${path}`, token, close: () => new Promise<void>((closed) => { server.closeAllConnections?.(); server.close(() => closed()); }) });
    });
  });
}

/** The MCP tool list: `look` plus MuseAgent's device tools with their own descriptions and JSON schemas. */
export function museCodeTools(): McpTool[] {
  const device = AGENT_TOOLS.filter((t) => (DEVICE_TOOLS as readonly string[]).includes(t.function.name))
    .map((t) => ({ name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters as Record<string, unknown> }));
  return [{ name: 'look', description: 'See the selected object: the headset camera snapshot plus the full context (request, device, Mac companion, MIDI outputs, synth manifests, gimbal, NOTES.md).', inputSchema: { type: 'object', properties: {} } }, ...device];
}

// --- Muse Code's JSONL events -> AR transcript --------------------------------------------------------------------------

/** One readable transcript entry from a Muse Code JSONL event, or undefined to skip it. */
export function describeMuseEvent(ev: any, kinds: Map<string, string>, ws: string): { line?: string; status?: string; file?: string; prose?: string; terminal?: { state: string; text?: string; reason?: string }; models?: string[] } | undefined {
  const type = ev?.payload_type, p = ev?.payload;
  if (typeof type !== 'string' || !p || typeof p !== 'object') return;
  if (type === 'run.output.delta' && typeof p.text === 'string') return { prose: p.text };
  if (type.startsWith('run.terminal.')) return { terminal: { state: String(p.terminal ?? type.slice(13)), ...(typeof p.text === 'string' ? { text: p.text } : {}), ...(p.reason ? { reason: String(typeof p.reason === 'string' ? p.reason : JSON.stringify(p.reason)) } : {}) } };
  if (type === 'run.usage' && Array.isArray(p.models)) return { models: p.models.map((m: any) => m?.model).filter((m: unknown): m is string => typeof m === 'string') };
  const kind = typeof p.task_id === 'string' ? kinds.get(p.task_id) : undefined;
  if (type === 'task.lifecycle.proposed' && typeof p.event?.task_kind === 'string') {
    kinds.set(p.task_id, p.event.task_kind);
    const tool = p.event.task_kind.replace(/^tool\./, '');
    if (!p.event.task_kind.startsWith('tool.') || tool.startsWith(`mcp__${MCP_NAME}__`)) return;
    return { status: tool === 'bash' ? 'Muse Code is running a command…' : tool === 'write_file' || tool === 'edit_file' ? 'Muse Code is writing code…' : `Muse Code: ${tool.replace(/_/g, ' ')}…` };
  }
  if (type !== 'task.lifecycle.output' || !kind?.startsWith('tool.') || typeof p.event?.chunk !== 'string') return;
  const tool = kind.slice(5), chunk: string = p.event.chunk;
  if (tool.startsWith('mcp__')) return; // our own tools write their own transcript lines
  const first = chunk.split('\n')[0]!.slice(0, 140);
  if (tool === 'bash') {
    try {
      const r = JSON.parse(chunk) as { command?: string; exit_code?: number; output?: string };
      const out = String(r.output ?? '').trim().split('\n').slice(-6).map((l) => `  ${l.slice(0, 110)}`).join('\n');
      return { line: `$ ${String(r.command ?? '').split('\n')[0]!.slice(0, 200)}${out.trim() ? `\n${out}` : ''}${r.exit_code ? `\n  ✗ exit ${r.exit_code}` : ''}` };
    } catch { return { line: `$ ${first}` }; }
  }
  if (tool === 'write_file' || tool === 'edit_file') {
    // "wrote 812 bytes to /…/connectors/x/index.mjs": find the first path-like token inside the workspace.
    const abs = [...chunk.slice(0, 600).matchAll(/[`'"]?((?:\/|\.{0,2}[A-Za-z0-9_-]+\/)[^\s`'"]*\.[A-Za-z0-9]+)/g)]
      .map((m) => (isAbsolute(m[1]!) ? m[1]! : resolve(ws, m[1]!))).find((x) => x.startsWith(ws + sep));
    if (abs && (abs === ws || abs.startsWith(ws + sep))) return { file: abs, line: `// ${tool === 'edit_file' ? 'edited' : 'wrote'} ${relative(ws, abs)}` };
    // edit_file answers "edited / changed lines: … / unified diff": show the new lines, like the built-in agent does.
    const where = /changed lines:\s*([^\n]+)/.exec(chunk)?.[1];
    const added = chunk.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).slice(0, 12);
    return { line: `// ${tool === 'edit_file' ? `edit${where ? ` (${where.trim()})` : ''}` : first}${added.length ? `\n${added.join('\n')}` : ''}` };
  }
  if (tool === 'read_file') {
    const path = /`([^`]+)`/.exec(first)?.[1] ?? first;
    return { line: `$ cat ${(path.startsWith(ws + sep) ? relative(ws, path) : path).slice(0, 120)}` };
  }
  return { line: `[${tool}] ${first}` };
}

// --- the engine -----------------------------------------------------------------------------------------------------

interface EngineDeps {
  agent: MuseAgent;
  workspace: string;
  dataDir: string;
  apiKey: string;
  baseUrl: string;
  binary?: string;
  callLog?: CallLog;
  log?: (line: string) => void;
}

export interface EngineRun { engine: 'muse-code' | 'built-in'; cardId: string; ok: boolean; ms: number; deviceCalls: number; fellBack?: string; reason?: string; models: string[]; at: number }

type Pending = { id: string; name: string; arguments: string; answer: (r: McpCallResult) => void };

const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];

/**
 * Muse Code's process environment: no secrets (the key goes over stdin). Settings (with the MCP token) are private to
 * the run; Muse's data/cache (bundled skills, model catalog) are shared between runs so startup stays fast.
 */
export function museCodeEnv(runDir: string, source: NodeJS.ProcessEnv = process.env, home: string = runDir): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV) if (source[k]) env[k] = source[k];
  return { ...env, XDG_CONFIG_HOME: join(runDir, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    npm_config_cache: join(home, 'cache', 'npm'), CI: '1', NO_COLOR: '1', npm_config_fund: 'false', npm_config_audit: 'false' };
}

export function museCodeArgs(o: { workspace: string; prompt: string; baseUrl: string; image?: string; web: boolean; effort: string; steps: number }): string[] {
  return ['exec', '--json', '--provider', 'meta', '--model', AGENT_MODEL, '--api-key-stdin', '--preset', 'native-basic',
    '--workspace', o.workspace, '--trust-workspace', '--approval-mode', 'never', '--approval-judge', 'off',
    // The shell is sandboxed: writes stay in the workspace/temp and it has no network (the live server's ports included).
    '--sandbox-network', 'restricted', '--disable-reminders', '--no-foreign-personal-context', '--disable-request-user-input',
    '--no-parallel-tool-calls', '--contributor-mode', 'off', '--reasoning-effort', o.effort, '--max-model-steps', String(o.steps),
    '--max-tool-output-bytes', '12000', '--no-session-log', ...(o.web ? [] : ['--disable-web-tools']),
    ...(o.image ? ['--image', o.image] : []), '--base-url', o.baseUrl, '--prompt-file', o.prompt];
}

export function museCodePrompt(ws: string, contextText: string): string {
  return [
    'ENGINE: you are Muse Code (Meta\'s coding agent) acting as Muse inside ControlAnything. You have your own full tools (shell, read/write/edit files, search, web) rooted in the Muse workspace below. Write and edit the connector with your file tools; run quick checks with the shell (e.g. `node --check connectors/x/index.mjs`).',
    `ControlAnything's device tools come from the "${MCP_NAME}" MCP server: look (snapshot + context), say, open_visuals, deploy_connector, test_action, finish. Only these reach the device and the headset. Their rules below refer to them by these names.`,
    'The task is complete ONLY when the finish tool returns ok. If it returns issues, fix them and call finish again. Never end with a prose answer.',
    'Do not start background services yourself (no `node … &`, nohup, launchctl): deploy_connector runs the connector so Stop can reach it. Never contact localhost ports 8787/8443/8799, read .env files or credentials, or kill processes. The shell has no network.',
    'Be fast: the wearer is waiting with the headset on. Aim for under 10 tool calls and about 2 minutes.',
    '',
    AGENT_SYSTEM,
    '',
    '--- CONTEXT ---',
    contextText,
    '',
    `Workspace root for your tools: ${ws}`,
  ].join('\n\n');
}

export class MuseCodeEngine {
  readonly binary: string;
  private last?: EngineRun;

  constructor(private readonly d: EngineDeps & { repoRoot?: string }) {
    // CE_MUSE_CODE_BIN, else the pinned binary in the data dir, else the checkout's own install (test data dirs).
    const pinned = (dir: string) => join(dir, 'muse-code', 'bin', `muse-bin-${MUSE_CODE_VERSION}`);
    const candidates = [d.binary, process.env.CE_MUSE_CODE_BIN?.trim(), pinned(d.dataDir), d.repoRoot ? pinned(join(d.repoRoot, 'apps', 'server', '.data')) : undefined].filter((x): x is string => !!x);
    this.binary = resolve(candidates.find((x) => existsSync(x)) ?? candidates[0]!);
  }

  available(): { ok: boolean; reason?: string } {
    if (this.d.agent.mode !== 'live') return { ok: false, reason: 'fixture mode (no Meta key)' };
    if (!this.d.apiKey) return { ok: false, reason: 'no Meta API key' };
    if (!existsSync(this.binary)) return { ok: false, reason: `Muse Code is not installed at ${this.binary}` };
    try { if (new URL(this.d.baseUrl).hostname !== 'api.meta.ai') return { ok: false, reason: 'Muse Code runs only against api.meta.ai' }; } catch { return { ok: false, reason: 'bad Meta base URL' }; }
    return { ok: true };
  }

  status() {
    const a = this.available();
    return { engine: a.ok ? 'muse-code' as const : 'built-in' as const, requested: 'muse-code' as const, ...(a.reason ? { fallbackReason: a.reason } : {}), binary: this.binary, model: AGENT_MODEL, lastRun: this.last ?? null };
  }

  /** Same contract as MuseAgent.build: streams the transcript through emit, resolves with the finished instrument. */
  async build(cardId: string, ctx: AgentContext, request: string, emit: WireEmit, opts: { signal?: AbortSignal } = {}): Promise<AgentWritten> {
    const log = this.d.log ?? (() => {});
    const started = Date.now();
    const avail = this.available();
    if (!avail.ok) {
      log(`[muse-code] ${cardId}: ${avail.reason}; using the built-in agent`);
      const built = await this.d.agent.build(cardId, ctx, request, emit, opts);
      this.last = { engine: 'built-in', cardId, ok: built.ok, ms: Date.now() - started, deviceCalls: 0, fellBack: avail.reason, models: [], at: started };
      return built;
    }

    await this.d.agent.init();
    const ws = await realpath(this.d.workspace);
    const runsDir = join(this.d.dataDir, 'muse-code-runs');
    const runDir = join(runsDir, `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);
    await mkdir(join(runDir, 'config', 'muse'), { recursive: true, mode: 0o700 });
    void this.prune(runsDir);

    // The device-tool queue between the MCP server (Muse Code's calls) and MuseAgent.build (the checks).
    const queue: Pending[] = [];
    const waiters: ((p: Pending | { end: string }) => void)[] = [];
    const answers = new Map<string, Pending>();
    let ended: string | undefined;
    let deviceCalls = 0;
    let io: { line: (t: string) => void; status: (t: string) => void } | undefined;
    const early: string[] = [];
    const show = (t: string) => { if (io) io.line(t); else early.push(t); };
    const endWith = (reason: string) => {
      if (ended) return;
      ended = reason;
      for (const w of waiters.splice(0)) w({ end: reason });
    };
    const driver: AgentDriver = {
      attach: (x) => { io = x; for (const t of early.splice(0)) x.line(t); },
      next: (signal) => new Promise((done, fail) => {
        if (signal.aborted) { fail(new RequestCancelledError()); return; }
        const p = queue.shift();
        if (p) { done(p); return; }
        if (ended) { done({ end: ended }); return; }
        const onAbort = () => { const i = waiters.indexOf(take); if (i >= 0) waiters.splice(i, 1); fail(new RequestCancelledError()); };
        const take = (x: Pending | { end: string }) => { signal.removeEventListener('abort', onAbort); done(x); };
        signal.addEventListener('abort', onAbort, { once: true });
        waiters.push(take);
      }),
      result: (id, result) => {
        const p = answers.get(id); answers.delete(id);
        const failed = !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false;
        p?.answer({ content: [{ type: 'text', text: JSON.stringify(result).slice(0, 16_000) }], ...(failed ? { isError: true } : {}) });
      },
    };

    const snapshot = ctx.observation?.jpeg ? join(runDir, 'snapshot.jpg') : undefined;
    if (snapshot) await writeFile(snapshot, Buffer.from(ctx.observation!.jpeg, 'base64'), { mode: 0o600 });
    const contextText = await this.d.agent.contextText(ctx, request);
    const mcp = await startMcpServer({ tools: museCodeTools(), log,
      call: async (name, args) => {
        if (name === 'look') {
          show('[look] snapshot + context');
          return { content: [...(ctx.observation?.jpeg ? [{ type: 'image' as const, data: ctx.observation.jpeg, mimeType: 'image/jpeg' }] : []), { type: 'text' as const, text: contextText }] };
        }
        if (ended) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `This run is over: ${ended}` }) }], isError: true };
        deviceCalls++;
        return new Promise<McpCallResult>((answer) => {
          const p: Pending = { id: `mc-${deviceCalls}`, name, arguments: JSON.stringify(args), answer };
          answers.set(p.id, p);
          const w = waiters.shift();
          if (w) w(p); else queue.push(p);
        });
      } });

    // Hold a 'failed' from a run that never reached a device tool: the built-in agent may still answer. Once build()
    // has its result nothing more goes to the card (Muse Code may still be wrapping up after an accepted finish).
    let heldFailure: Parameters<WireEmit> | undefined;
    let settled = false;
    const runEmit: WireEmit = (phase, extra) => {
      if (settled) return;
      if (phase === 'failed' && deviceCalls === 0) { heldFailure = [phase, extra]; return; }
      emit(phase, extra);
    };

    const promptFile = join(runDir, 'prompt.txt');
    await writeFile(promptFile, museCodePrompt(ws, contextText), { mode: 0o600 });
    await writeFile(join(runDir, 'config', 'muse', 'settings.json'), JSON.stringify({ schema_version: 1, telemetry: { enabled: false },
      mcpServers: { [MCP_NAME]: { type: 'streamable-http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, mode: 'optional' } } }, null, 2), { mode: 0o600 });

    const signal = opts.signal;
    let child: ChildProcess | undefined;
    let graceful = false;
    let exitedNow: () => void = () => {};
    const exited = new Promise<void>((r) => { exitedNow = r; });
    const models = new Set<string>();
    let terminal: { state: string; text?: string; reason?: string } | undefined;
    let stderrTail = '';
    let usage: { models?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; cached_tokens?: number; calls?: number }[]; failed_calls?: number } | undefined;
    const redact = (s: string) => (this.d.apiKey ? s.split(this.d.apiKey).join('[redacted]') : s);
    const built = this.d.agent.build(cardId, ctx, request, runEmit, { ...(signal ? { signal } : {}), driver });
    // A rejected build (Stop Muse) is handled below; never leave it unobserved.
    built.catch(() => {});
    try {
      show('// engine: Muse Code (muse exec · muse-spark-1.3) with ControlAnything MCP tools');
      const effort = process.env.CE_MUSE_CODE_EFFORT?.trim() || 'low';
      const args = museCodeArgs({ workspace: ws, prompt: promptFile, baseUrl: this.d.baseUrl, ...(snapshot ? { image: snapshot } : {}), web: process.env.CE_MUSE_CODE_WEB !== '0', effort, steps: 40 });
      child = spawn(this.binary, args, { cwd: ws, env: museCodeEnv(runDir, process.env, join(this.d.dataDir, 'muse-code-home')), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const events = join(runDir, 'events.jsonl');
      let pending = '', prose = '', proseShown = 0, writes = Promise.resolve();
      const kinds = new Map<string, string>();
      const decoder = new StringDecoder('utf8');
      const onLine = (raw: string) => {
        if (!raw.trim()) return;
        const safe = redact(raw);
        writes = writes.then(() => appendFile(events, `${safe}\n`)).catch(() => {});
        let ev: unknown; try { ev = JSON.parse(safe); } catch { return; }
        const r = describeMuseEvent(ev, kinds, ws);
        if (!r) return;
        if (r.prose !== undefined) {
          prose += r.prose;
          const last = prose.trim().split('\n').pop();
          if (last && Date.now() - proseShown > 300) { proseShown = Date.now(); io?.status(last.slice(0, 160)); }
          return;
        }
        if (prose.trim()) { show(`# ${prose.trim().split('\n')[0]!.slice(0, 110)}`); prose = ''; }
        if (r.models) { for (const m of r.models) models.add(m); usage = (ev as { payload?: typeof usage }).payload; }
        if (r.terminal) terminal = r.terminal;
        if (r.status) io?.status(r.status);
        if (r.file) {
          // Show the file the way the built-in agent does: the whole code in the card.
          const file = r.file;
          writes = writes.then(async () => {
            const text = await readFile(file, 'utf8').catch(() => undefined);
            show(text === undefined ? r.line! : `\n// ${relative(ws, file)}\n${text.trimEnd().slice(0, 6000)}\n// ✓ ${r.line!.replace(/^\/\/ /, '')} (${text.split('\n').length} lines)`);
          });
        } else if (r.line) show(r.line);
      };
      child.stdout!.on('data', (b: Buffer) => {
        pending += decoder.write(b); let i: number;
        while ((i = pending.indexOf('\n')) >= 0) { onLine(pending.slice(0, i)); pending = pending.slice(i + 1); }
      });
      child.stderr!.on('data', (b: Buffer) => { stderrTail = redact(stderrTail + b.toString()).slice(-4000); });
      child.stdin!.on('error', () => {});
      child.stdin!.end(`${this.d.apiKey}\n`);
      child.once('error', (e) => { exitedNow(); endWith(`Muse Code could not start: ${e.message}`); });
      child.once('close', (code) => {
        exitedNow();
        if (pending) onLine(pending);
        void writes.then(() => writeFile(join(runDir, 'stderr.log'), stderrTail).catch(() => {}));
        const why = terminal?.reason ?? terminal?.text?.trim().split('\n').pop()?.slice(0, 160) ?? stderrTail.trim().split('\n').pop()?.slice(0, 160) ?? '';
        endWith(`Muse Code stopped (exit ${code}${terminal ? `, ${terminal.state}` : ''}) without a finished instrument${why ? `: ${why}` : ''}. Ask again.`);
      });

      let result: AgentWritten;
      try { result = await built; }
      catch (e) {
        settled = true;
        log(`[muse-code] ${cardId} stopped by the wearer after ${((Date.now() - started) / 1000).toFixed(1)} s · ${deviceCalls} device calls`);
        this.last = { engine: 'muse-code', cardId, ok: false, ms: Date.now() - started, deviceCalls, reason: 'stopped', models: [...models], at: started };
        throw e;
      }
      settled = true;
      // Any call still waiting (a finish that was accepted ends build() before its answer) gets its reply.
      for (const p of answers.values()) p.answer({ content: [{ type: 'text', text: JSON.stringify(result.ok ? { ok: true, finished: true, note: 'The wearer has the instrument now. Stop here.' } : { ok: false, error: result.issues[0] ?? 'stopped' }) }], ...(result.ok ? {} : { isError: true }) });
      answers.clear();
      endWith(result.ok ? 'finished' : result.issues[0] ?? 'failed');

      // Muse Code stopped before touching a device tool (auth, crash, sandbox): let the built-in loop answer instead.
      const budgetLeft = AGENT_LIMITS.budgetMs - (Date.now() - started);
      if (!result.ok && deviceCalls === 0 && !signal?.aborted && budgetLeft > 90_000) {
        const why = result.issues[0] ?? 'no result';
        log(`[muse-code] ${cardId}: ${why} · falling back to the built-in agent`);
        await this.stop(child);
        const fb = await this.d.agent.build(cardId, ctx, request, emit, opts);
        this.last = { engine: 'built-in', cardId, ok: fb.ok, ms: Date.now() - started, deviceCalls: 0, fellBack: why, models: [...models], at: started };
        return fb;
      }
      if (heldFailure) emit(...heldFailure);
      log(`[muse-code] ${cardId} ${result.ok ? `finished "${result.title}"` : `failed: ${result.issues[0] ?? ''}`} in ${((Date.now() - started) / 1000).toFixed(1)} s · ${deviceCalls} device calls`);
      this.last = { engine: 'muse-code', cardId, ok: result.ok, ms: Date.now() - started, deviceCalls, ...(result.ok ? {} : { reason: result.issues[0] }), models: [...models], at: started };
      graceful = result.ok;
      return { ...result, latencyMs: Date.now() - started };
    } finally {
      endWith('the run ended');
      const run = this.last;
      // After an accepted finish Muse Code gets its answer and ends its turn by itself (that reports run.usage, the
      // model receipt); the wearer already has the controls. Otherwise (fail, Stop) stop it now.
      const cleanup = async () => {
        await this.stop(child);
        await mcp.close();
        const seen = [...models];
        if (run?.cardId === cardId && run.at === started) run.models = seen;
        const unexpected = seen.filter((m) => m !== AGENT_MODEL);
        log(`[muse-code] ${cardId} process ended · models ${seen.join(',') || 'not reported'}${unexpected.length ? ` · UNEXPECTED ${unexpected.join(',')}` : ''}`);
        const sum = (k: 'input_tokens' | 'output_tokens' | 'reasoning_tokens' | 'cached_tokens') => (usage?.models ?? []).reduce((n, m) => n + (Number(m[k]) || 0), 0);
        // The model receipt for the call log: Muse Code's own run.usage (absent when it never reached the model).
        if (usage) this.d.callLog?.add({ at: started, label: 'muse-code agent (native aggregate)', model: seen.length ? seen.join(',') : AGENT_MODEL, source: 'live', ok: !!run?.ok && !unexpected.length,
          latencyMs: Date.now() - started, format: 'native_cli_aggregate', callCount: (usage.models ?? []).reduce((n, m) => n + (Number(m.calls) || 0), 0),
          usage: { promptTokens: sum('input_tokens'), completionTokens: sum('output_tokens'), totalTokens: sum('input_tokens') + sum('output_tokens'), reasoningTokens: sum('reasoning_tokens'), cachedTokens: sum('cached_tokens') } });
      };
      if (graceful) void Promise.race([exited, new Promise((r) => setTimeout(r, 12_000))]).then(cleanup).catch(() => {});
      else await cleanup();
    }
  }

  /** Stop Muse Code's whole process group (it may have shells or test processes running). */
  private async stop(child?: ChildProcess): Promise<void> {
    if (child?.pid) await stopCodingProcessGroup(child.pid, { termGraceMs: 1500, killGraceMs: 1500 }).catch(() => false);
  }

  /** Keep the last 20 run folders (prompt, events.jsonl, stderr.log; ~300 KB each) for debugging. */
  private async prune(runsDir: string): Promise<void> {
    const names = (await readdir(runsDir).catch(() => [] as string[])).sort();
    for (const n of names.slice(0, Math.max(0, names.length - 20))) await rm(join(runsDir, n), { recursive: true, force: true }).catch(() => {});
  }
}

