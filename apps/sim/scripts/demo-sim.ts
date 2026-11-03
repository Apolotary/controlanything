/**
 * `npm run demo:sim` (repo root): the judge path. Builds what is missing, starts the server (or reuses one that
 * is already running), and prints where to click. No headset, synth, Cardputer or lamp needed.
 *
 *   npm run demo:sim                  live Meta models if MODEL_API_KEY is in .env, else FIXTURE (recorded replies)
 *   npm run demo:sim -- --fixture     force FIXTURE mode (no network, no key)
 *   npm run demo:sim -- --live        force live mode (needs MODEL_API_KEY)
 *   npm run demo:sim -- --build       rebuild the web apps first
 *   npm run demo:sim -- --open        also open the pages in the default browser
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.HTTP_PORT || 8787);
const BASE = `http://localhost:${PORT}`;

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
  if (r.status !== 0) console.log(c.red(`  ${workspace} did not build (exit ${r.status}); its page will show "not built".`));
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
  build('@ce/sim', 'apps/sim/dist');
  build('@ce/quest', 'apps/quest/dist');
  build('@ce/companion', 'apps/companion/dist');

  let h = await health();
  let child: ReturnType<typeof spawn> | undefined;
  if (h) {
    console.log(c.dim(`a server is already running on :${PORT} (${h.mode}); using it`));
  } else {
    const mode = args.has('--fixture') ? 'fixture' : args.has('--live') ? 'live' : keyInDotEnv() ? 'live' : 'fixture';
    console.log(c.dim(`starting the server in ${mode.toUpperCase()} mode …`));
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(ROOT, 'apps/server'),
      // CE_DEMO=1: the verified, silent visual synth arms itself (no Enable tap). CE_MAC_SILENT=1: the Mac stays quiet.
      env: { ...process.env, MODEL_MODE: mode, CE_TRUST_FIRST_DEVICE: process.env.CE_TRUST_FIRST_DEVICE ?? '1',
        CE_DEMO: process.env.CE_DEMO ?? '1', CE_MAC_SILENT: process.env.CE_MAC_SILENT ?? '1', CE_MAC_LOCAL: process.env.CE_MAC_LOCAL ?? '0' },
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(c.dim(d.toString())));
    child.on('exit', (code) => {
      console.log(c.red(`server exited (${code})`));
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
    `  1  the Mac    ${c.cyan(`${BASE}/sim/?mute=1`)}`,
    c.dim('             the sim room stands in for your Mac: it pairs itself (localhost) and its laptop screen runs the'),
    c.dim('             silent visual synth. Open it FIRST. (Or open the real Mac app, /companion/, which shows the visuals.)'),
    `  2  headset    ${c.cyan(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0`)}`,
    c.dim('             the Quest app in desktop emulation (IWER). Click = pinch, right-drag = look.'),
    c.dim('             Enter AR → click the laptop\'s box → setup ring → arc dials armed → drag a dial → Perform on the card.'),
    c.dim('             The wrist palette (lower right) has Visual synth · Buddy · Stop · Exit. X = Stop.'),
    '',
    c.dim(`  Replay a recorded real take: ${BASE}/sim/?take=<name>  (takes live in apps/quest/public/takes/)`),
    c.dim(`  Model calls with ids and latency: ${BASE}/api/muse/calls`),
    '',
    child ? c.dim('  Ctrl+C stops the server.') : c.dim('  (the server was already running; this script exits now)'),
    '',
  ];
  console.log(lines.join('\n'));
  if (args.has('--open')) for (const p of ['/sim/?mute=1', '/quest/?emulate=1&camera=sim&mute=1&mic=0']) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`${BASE}${p}`], { stdio: 'ignore', detached: true }).unref();
  if (!child) return;
  const stop = () => child!.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
