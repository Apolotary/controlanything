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
  private speaking = 0;
  private musicOwned = false;
  /** the output level the silent Mac pretends to have (0-100); read back by verify's volume restore and UNDO */
  private silentVolume = 50;
  constructor(
    private readonly run: Runner = execFileRunner,
    private readonly enabled: boolean = process.platform === 'darwin',
    /**
     * CE_MAC_SILENT=1 is an explicit automated-test option. Nothing audible is executed: `say` and Music are
     * not run and the volume is only kept in memory. Every ack says so; the oracles judge what they can.
     */
    readonly silent: boolean = false,
    private readonly audioMaster?: () => { volume: number; muted: boolean },
  ) {}

  get available(): boolean {
    return this.enabled;
  }

  /** The current output volume 0-100, or undefined when it cannot be read. */
  async currentVolume(): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    if (this.silent) return this.silentVolume;
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
    if (this.silent) return this.silently(op);
    const master = this.audioMaster?.();
    if (master && (master.muted || master.volume <= 0) && (op.op === 'say' || op.op === 'music' && !['pause'].includes(String(op.arg)))) {
      return { ok: false, error: 'device_error', detail: 'Master sound is muted. Unmute ControlAnything to hear this action.' };
    }
    try {
      // Standard Additions' OS speech accepts a per-utterance volume (0..1).
      // Pass text as argv; generated text never becomes AppleScript source.
      let out: string;
      if (op.op === 'say' && master) {
        this.speaking++;
        try { out = await this.run('osascript', ['-e', 'on run argv\nsay (item 1 of argv) volume ((item 2 of argv) as real)\nend run', plan.args[0]!, String(Math.max(0, Math.min(1, master.volume)))]); }
        finally { this.speaking--; }
      } else if (op.op === 'music' && master) {
        out = await this.run('osascript', ['-e', `tell application "Music" to set sound volume to ${Math.round(Math.max(0, Math.min(1, master.volume)) * 100)}`, ...plan.args]);
        this.musicOwned = String(op.arg ?? 'playpause') !== 'pause';
      } else out = await this.run(plan.file, plan.args);
      return { ok: true, detail: out || `${plan.file} ok` };
    } catch (e) {
      return { ok: false, error: 'device_error', detail: (e as Error).message.slice(0, 300) };
    }
  }

  /** Cancel our active OS speech when the shared master is muted. */
  masterChanged(): void {
    const state = this.audioMaster?.();
    if (!this.silent && this.speaking > 0 && state && (state.muted || state.volume <= 0)) {
      void this.run('osascript', ['-e', 'say "" stopping current speech true']).catch(() => {});
    }
    if (!this.silent && this.musicOwned && state) {
      const volume = state.muted ? 0 : Math.round(Math.max(0, Math.min(1, state.volume)) * 100);
      void this.run('osascript', ['-e', `tell application "Music" to set sound volume to ${volume}`,
        ...(volume === 0 ? ['-e', 'tell application "Music" to pause'] : [])]).catch(() => {});
      if (volume === 0) this.musicOwned = false;
    }
  }

  /** Silent mode: nothing runs; the ack states exactly what did not happen. */
  private silently(op: LocalOp): LocalResult {
    switch (op.op) {
      case 'volume': {
        const v = Math.round(Math.min(100, Math.max(0, Number(op.arg))));
        this.silentVolume = v;
        return { ok: true, detail: `silent mode (CE_MAC_SILENT): volume ${v} kept in memory, not applied` };
      }
      case 'say':
        return { ok: true, detail: 'silent mode (CE_MAC_SILENT): not spoken; a recorded clip stands in for the voice' };
      default:
        return { ok: true, detail: `silent mode (CE_MAC_SILENT): ${op.op} not run` };
    }
  }
}
