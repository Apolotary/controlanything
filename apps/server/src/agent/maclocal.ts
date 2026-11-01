/**
 * The Mac itself as a device: a local executor inside the server (deviceId "mac-local") that runs LocalOps
 * with osascript / say. Nothing here takes free text into a shell: every call is execFile with arguments.
 */
import { execFile } from 'node:child_process';
import type { ExecOp, LocalOp } from '@ce/protocol';

export const MAC_LOCAL_ID = 'mac-local';
export const MAC_LOCAL_NAME = 'This Mac';
export const MAC_LOCAL_CAPABILITIES = ['local', 'speaker'] as const;

export interface LocalResult {
  ok: boolean;
  detail?: string;
  error?: 'unsupported' | 'bad_args' | 'device_error';
}

export type Runner = (file: string, args: string[]) => Promise<string>;

export const execFileRunner: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve(stdout.toString().trim());
    });
  });

const MUSIC_COMMANDS: Record<string, string> = {
  play: 'play',
  pause: 'pause',
  playpause: 'playpause',
  next: 'next track',
  prev: 'previous track',
  previous: 'previous track',
};

/** The osascript / say invocation for a LocalOp, or an error. Pure, so it can be tested without a Mac. */
export function planLocal(op: LocalOp): { file: string; args: string[] } | LocalResult {
  switch (op.op) {
    case 'volume': {
      const v = typeof op.arg === 'number' ? op.arg : typeof op.arg === 'string' ? Number(op.arg) : NaN;
      if (!Number.isFinite(v)) return { ok: false, error: 'bad_args', detail: 'volume needs a number 0-100' };
      return { file: 'osascript', args: ['-e', `set volume output volume ${Math.round(Math.min(100, Math.max(0, v)))}`] };
    }
    case 'music': {
      const cmd = MUSIC_COMMANDS[String(op.arg ?? 'playpause').toLowerCase()];
      if (!cmd) return { ok: false, error: 'bad_args', detail: `music arg must be one of ${Object.keys(MUSIC_COMMANDS).join(', ')}` };
      return { file: 'osascript', args: ['-e', `tell application "Music" to ${cmd}`] };
    }
    case 'say': {
      const text = typeof op.arg === 'string' ? op.arg : typeof op.arg === 'object' && op.arg && 'text' in op.arg ? String((op.arg as Record<string, unknown>).text) : '';
      if (!text.trim()) return { ok: false, error: 'bad_args', detail: 'say needs text' };
      return { file: 'say', args: [text.slice(0, 500)] };
    }
    default:
      return { ok: false, error: 'unsupported', detail: `the Mac cannot do "${op.op}" (volume, music, say)` };
  }
}

export class MacLocalExecutor {
  readonly deviceId = MAC_LOCAL_ID;
  constructor(
    private readonly run: Runner = execFileRunner,
    private readonly enabled: boolean = process.platform === 'darwin',
  ) {}

  get available(): boolean {
    return this.enabled;
  }

  /** The current output volume 0-100, or undefined when it cannot be read. */
  async currentVolume(): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    try {
      const out = await this.run('osascript', ['-e', 'output volume of (get volume settings)']);
      const v = Number(out.trim());
      return Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async exec(op: ExecOp, dryRun = false): Promise<LocalResult> {
    if (op.kind !== 'local') return { ok: false, error: 'unsupported', detail: `mac-local only runs local ops, not ${op.kind}` };
    const plan = planLocal(op);
    if ('ok' in plan) return plan;
    if (dryRun) return { ok: true, detail: `dry run: ${plan.file} ${plan.args.join(' ')}` };
    if (!this.enabled) return { ok: false, error: 'unsupported', detail: 'local execution is only available on macOS' };
    try {
      const out = await this.run(plan.file, plan.args);
      return { ok: true, detail: out || `${plan.file} ok` };
    } catch (e) {
      return { ok: false, error: 'device_error', detail: (e as Error).message.slice(0, 300) };
    }
  }
}
