/**
 * `npm run demo:sim` (repo root): the judge path. Builds what is missing, starts the server (or reuses one that
 * is already running), and prints where to click. No headset, synth, Cardputer or lamp needed.
 *
 *   npm run demo:sim                  live Meta models if MODEL_API_KEY is in .env, else FIXTURE (recorded replies)
 *   npm run demo:sim -- --fixture     force FIXTURE mode (no network, no key)
 *   npm run demo:sim -- --live        force live mode (needs MODEL_API_KEY)
 *   npm run demo:sim -- --build       rebuild the web apps first
 *   npm run demo:sim -- --open        also open the pages in the default browser
 *   npm run demo:sim -- --mute        mute unattended playback (attended demos use sound)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.error(`ControlAnything needs Node 22.12 or newer (you have v${process.versions.node}). https://nodejs.org`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.HTTP_PORT || 8787);
const BASE = `http://localhost:${PORT}`;
const muted = args.has('--mute');
const simPath = `/sim/${muted ? '?mute=1' : ''}`;
const questPath = `/quest/?emulate=1&camera=sim&mic=0${muted ? '&mute=1' : ''}`;

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[96m${s}\x1b[0m`,
  volt: (s: string) => `\x1b[93m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[91m${s}\x1b[0m`,
};

async function health(): Promise<{ mode: string; keyConfigured?: boolean; urls?: { https?: string; lan?: string[] } } | undefined> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { mode: string }) : undefined;
  } catch {
    return undefined;
  }
}

function build(workspace: string, dist: string): void {
  if (!args.has('--build') && existsSync(join(ROOT, dist, 'index.html'))) return;
  console.log(c.dim(`building ${workspace} …`));
  const r = spawnSync('npm', ['run', 'build', '-w', workspace], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${workspace} did not build (exit ${r.status}); fix the build before starting the demo.`);
}

function keyInDotEnv(): boolean {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return Boolean(process.env.MODEL_API_KEY);
  const before = process.env.MODEL_API_KEY;
  try {
    process.loadEnvFile(f);
    return Boolean(process.env.MODEL_API_KEY?.trim());
  } finally {
    if (before === undefined) delete process.env.MODEL_API_KEY; // the server reads .env itself; keep it out of our env
  }
}

async function main(): Promise<void> {
  let h = await health();
  const requestedMode = args.has('--fixture') ? 'fixture' : args.has('--live') ? 'live' : undefined;
  if (h && requestedMode && h.mode !== requestedMode) throw new Error(`The server on :${PORT} is ${h.mode}, not requested ${requestedMode}. Use a different HTTP_PORT or stop that server first.`);
  if (h && args.has('--build')) throw new Error('A server is already serving these builds. Stop it before --build, or use scripts/deploy-live.sh to preserve loaded chunks.');
  if (!h) {
    build('@ce/sim', 'apps/sim/dist');
    build('@ce/quest', 'apps/quest/dist');
    build('@ce/companion', 'apps/companion/dist');
  }
  let child: ReturnType<typeof spawn> | undefined;
  if (h) {
    console.log(c.dim(`a server is already running on :${PORT} (${h.mode}); using it`));
  } else {
    const mode = args.has('--fixture') ? 'fixture' : args.has('--live') ? 'live' : keyInDotEnv() ? 'live' : 'fixture';
    console.log(c.dim(`starting the server in ${mode.toUpperCase()} mode …`));
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(ROOT, 'apps/server'),
      // The wearer still explicitly asks Muse to write the connector. --mute is only for unattended checks.

      env: { ...process.env, MODEL_MODE: mode, CE_TRUST_FIRST_DEVICE: process.env.CE_TRUST_FIRST_DEVICE ?? '1',
        CE_DEMO: process.env.CE_DEMO ?? '1', ...(muted ? { CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0' } : {}) },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let errTail = '';
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(c.dim(d.toString())));
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d);
      errTail = (errTail + d.toString()).slice(-4000);
    });
    child.on('exit', (code) => {
      console.log(c.red(`server exited (${code})`));
      if (!h) {
        // the server says "HTTP port 8787 on 0.0.0.0 is already in use (another server running?)"
        const busy = /(HTTPS?) port (\d+) on \S+ is already in use/.exec(errTail);
        const alt = busy && (busy[1] === 'HTTP' ? (busy[2] === '8796' ? 8797 : 8796) : Number(busy[2]) + 1);
        console.log(busy
          ? c.red(`Port ${busy[2]} is already in use by another program. Stop that program, or start on a free port: `) + c.b(`${busy[1]}_PORT=${alt} npm run demo:sim`)
          : c.red('The server stopped before it was ready. Its last lines are just above.'));
      }
      process.exit(code ?? 1);
    });
    for (let i = 0; i < 60 && !h; i++) {
      await new Promise((r) => setTimeout(r, 500));
      h = await health();
    }
    if (!h) {
      console.log(c.red('the server did not come up on time; see its output above'));
      child.kill();
      process.exit(1);
    }
  }

  const live = h.mode === 'live';
  const lines = [
    '',
    c.b('ControlAnything · JUDGE PATH (no hardware)'),
    `  models     ${live ? c.cyan('LIVE Meta Model API') + c.dim(' (sam-3.1, muse-spark-1.3, muse-wonder-1.0, …)') : c.volt('FIXTURE') + c.dim(' (recorded real responses, labelled FIXTURE; add MODEL_API_KEY to .env for live)')}`,
    '',
    `  1  the Mac    ${c.cyan(`${BASE}${simPath}`)}`,
    c.dim('             the sim room stands in for your Mac: it pairs itself (localhost) and its laptop screen runs the'),
    c.dim('             visual synth. Open it FIRST. (Or open the real Mac app, /companion/, which shows the visuals.)'),
    `  2  headset    ${c.cyan(`${BASE}${questPath}`)}`,
    c.dim('             the Quest app in desktop emulation (IWER). Click = pinch, right-drag = look.'),
    c.dim('             Enter AR → tag the laptop → choose Control → Ask Muse → use its generated instrument → Stop.'),
    c.dim('             The wrist palette has Annotate / Control, More, Stop all and Exit. X = Stop.'),
    '',
    `  Phone/webcam ${c.cyan(`${BASE}/quest/hands.html${muted ? '?mute=1' : ''}`)}`,
    c.dim('             The same path on a webcam or phone: Start AR → tag an object → Control → ask Muse. Buddy-first page: /quest/reviewer.html?buddy=1'),
    c.dim(`  Synthetic replay fixtures: ${BASE}/sim/?take=<name>. New uploaded takes stay private in CE_DATA_DIR/takes.`),
    c.dim(`  Model calls with ids and latency: ${BASE}/api/muse/calls`),
    '',
    child ? c.dim('  Ctrl+C stops the server.') : c.dim('  (the server was already running; this script exits now)'),
    '',
  ];
  console.log(lines.join('\n'));
  if (args.has('--open')) for (const p of [simPath, questPath]) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`${BASE}${p}`], { stdio: 'ignore', detached: true }).unref();
  if (!child) return;
  const stop = () => child!.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
