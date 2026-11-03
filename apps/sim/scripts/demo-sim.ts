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
      env: { ...process.env, MODEL_MODE: mode, CE_TRUST_FIRST_DEVICE: process.env.CE_TRUST_FIRST_DEVICE ?? '1' },
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
    `  1  sim room   ${c.cyan(`${BASE}/sim/`)}`,
    c.dim('             the virtual ceiling light, its IR remote and the synth. Open it FIRST and click once (enables audio).'),
    c.dim('             It pairs itself (localhost) and becomes the IR + MIDI executor and the camera + audio sensor.'),
    `  2  headset    ${c.cyan(`${BASE}/quest/`)}`,
    c.dim('             the Quest app in desktop emulation (IWER): scan, select the light, watch it link, then use the controls.'),
    `  3  console    ${c.cyan(`${BASE}/companion/`)}  ${c.dim('(optional) agent work log, evidence, approvals')}`,
    '',
    c.dim('  Without the headset page: press SCAN on the sim; the server runs SAM 3.1 on the sim camera, and the agent'),
    c.dim('  links the light by trying IR codes while the camera watches (other brands do nothing; the lamp only obeys'),
    c.dim('  its own synthetic SIM-KZ codes, so it learns them from the virtual remote when the agent asks).'),
    c.dim(`  Replay a recorded real take: ${BASE}/sim/?take=<name>  (takes live in apps/quest/public/takes/)`),
    c.dim(`  Model calls with ids and latency: ${BASE}/api/muse/calls`),
    '',
    child ? c.dim('  Ctrl+C stops the server.') : c.dim('  (the server was already running; this script exits now)'),
    '',
  ];
  console.log(lines.join('\n'));
  if (args.has('--open')) for (const p of ['/sim/', '/quest/']) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`${BASE}${p}`], { stdio: 'ignore', detached: true }).unref();
  if (!child) return;
  const stop = () => child!.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
