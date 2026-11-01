/**
 * Replays a recorded take through the live pipeline (format agreed with quest-io):
 *
 *   <take>/session.jsonl   line 1 {kind:'meta', v:1, take, startedAt, app, device, camera, space}
 *                          then {t, dir:'out'|'in', msg:<envelope>} (+ {t, kind:'pose'|'input'} lines, skipped here)
 *   <take>/frames/<id>.jpg payload.jpeg moved out as payload.jpegFile (also inside sense.result.frame)
 *
 * 'out' lines (what the headset sent) are re-sent through /ws at their recorded times, from this paired sim;
 * a live sense.request is answered with the next recorded sense.result of the same kind (its senseId rewritten).
 * 'in' lines (what the headset received) are counted per type and compared with what arrives live.
 */
import type { AnyMessage, SenseRequestPayload } from '@ce/protocol';

export interface TakeLine {
  t: number;
  dir?: 'out' | 'in';
  kind?: string;
  msg?: Record<string, unknown> & { type?: string; payload?: Record<string, unknown> };
}

export interface Take {
  name: string;
  meta?: Record<string, unknown>;
  lines: TakeLine[];
  /** frame file -> base64 jpeg */
  frames: Map<string, string>;
  /** how to fetch frames that are not loaded yet */
  baseUrl?: string;
}

export function parseSession(text: string, name = 'take'): Take {
  const lines: TakeLine[] = [];
  let meta: Record<string, unknown> | undefined;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    let o: TakeLine & Record<string, unknown>;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.kind === 'meta') {
      meta = o;
      continue;
    }
    if (typeof o.t === 'number') lines.push(o);
  }
  lines.sort((a, b) => a.t - b.t);
  return { name: String(meta?.take ?? name), meta, lines, frames: new Map() };
}

function toBase64(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function loadTakeFromUrl(url: string): Promise<Take> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const take = parseSession(await res.text(), url.split('/').slice(-2, -1)[0] ?? 'take');
  take.baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
  return take;
}

export async function loadTakeFromFiles(files: FileList | File[]): Promise<Take> {
  const list = [...files];
  const session = list.find((f) => f.name.endsWith('.jsonl'));
  if (!session) throw new Error('pick the take\'s session.jsonl (and its frames/*.jpg)');
  const take = parseSession(await session.text(), session.name.replace(/\.jsonl$/, ''));
  for (const f of list) if (/\.jpe?g$/i.test(f.name)) take.frames.set(`frames/${f.name}`, toBase64(new Uint8Array(await f.arrayBuffer())));
  return take;
}

async function frameData(take: Take, file: string): Promise<string | undefined> {
  const have = take.frames.get(file) ?? take.frames.get(`frames/${file.split('/').pop()}`);
  if (have) return have;
  if (!take.baseUrl) return undefined;
  const res = await fetch(take.baseUrl + file);
  if (!res.ok) return undefined;
  const b64 = toBase64(new Uint8Array(await res.arrayBuffer()));
  take.frames.set(file, b64);
  return b64;
}

/** Put recorded JPEGs back into a payload (payload.jpegFile and payload.frame.jpegFile). */
async function inflate(take: Take, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const p = structuredClone(payload);
  const fix = async (o: Record<string, unknown> | undefined) => {
    if (!o || typeof o.jpegFile !== 'string') return;
    const data = await frameData(take, o.jpegFile);
    if (data) o.jpeg = data;
    delete o.jpegFile;
  };
  await fix(p);
  await fix(p.frame as Record<string, unknown> | undefined);
  return p;
}

export interface PlayerHooks {
  /** send an envelope through the live connection (returns false when offline) */
  send: (m: Record<string, unknown>) => boolean;
  log: (text: string, cls?: string) => void;
}

export class TakePlayer {
  playing = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private senseQueue: TakeLine[] = [];
  private recordedIn = new Map<string, number>();
  private liveIn = new Map<string, number>();

  constructor(
    readonly take: Take,
    private readonly hooks: PlayerHooks,
  ) {}

  summary(): string {
    const out = this.take.lines.filter((l) => l.dir === 'out').length;
    const inn = this.take.lines.filter((l) => l.dir === 'in').length;
    const dur = this.take.lines.length ? (this.take.lines.at(-1)!.t - this.take.lines[0]!.t) / 1000 : 0;
    return `${this.take.name}: ${out} sent / ${inn} received messages over ${dur.toFixed(1)} s`;
  }

  play(speed = 1): void {
    this.stop();
    this.playing = true;
    const lines = this.take.lines;
    const t0 = lines[0]?.t ?? 0;
    this.senseQueue = lines.filter((l) => l.dir === 'out' && l.msg?.type === 'sense.result');
    this.recordedIn = new Map();
    this.liveIn = new Map();
    for (const l of lines) if (l.dir === 'in' && l.msg?.type) this.recordedIn.set(l.msg.type, (this.recordedIn.get(l.msg.type) ?? 0) + 1);
    const outs = lines.filter((l) => l.dir === 'out' && l.msg?.type && l.msg.type !== 'sense.result' && l.msg.type !== 'hello');
    this.hooks.log(`replaying ${outs.length} messages at ${speed}×`, 'k-scan');
    for (const l of outs) {
      const at = (l.t - t0) / speed;
      this.timers.push(
        setTimeout(async () => {
          if (!this.playing) return;
          const m = l.msg!;
          const payload = await inflate(this.take, (m.payload ?? {}) as Record<string, unknown>);
          const env: Record<string, unknown> = { v: 1, type: m.type, id: `rp${Math.random().toString(36).slice(2, 10)}`, ts: Date.now(), from: '', payload };
          if (m.to) env.to = m.to;
          const ok = this.hooks.send(env);
          this.hooks.log(`${ok ? '→' : '× offline'} ${m.type} (t+${((l.t - t0) / 1000).toFixed(1)} s)`);
        }, at),
      );
    }
    const end = ((lines.at(-1)?.t ?? t0) - t0) / speed + 1500;
    this.timers.push(setTimeout(() => this.finish(), end));
  }

  /** A live sense.request while playing: answer with the next recorded result of that kind. */
  async answer(req: SenseRequestPayload): Promise<boolean> {
    if (!this.playing) return false;
    const i = this.senseQueue.findIndex((l) => (l.msg?.payload as { kind?: string } | undefined)?.kind === req.kind);
    if (i < 0) {
      this.hooks.log(`no recorded ${req.kind} left for sense.request ${req.senseId.slice(-6)}`, 'k-warn');
      return false;
    }
    const [line] = this.senseQueue.splice(i, 1);
    const payload = await inflate(this.take, (line!.msg!.payload ?? {}) as Record<string, unknown>);
    payload.senseId = req.senseId;
    if (payload.frame && typeof payload.frame === 'object') (payload.frame as Record<string, unknown>).senseId = req.senseId;
    payload.at = Date.now();
    const ok = this.hooks.send({ v: 1, type: 'sense.result', id: `rp${Math.random().toString(36).slice(2, 10)}`, ts: Date.now(), from: '', to: 'server', payload });
    this.hooks.log(`↩ recorded ${req.kind} answers sense.request ${req.senseId.slice(-6)}${ok ? '' : ' (offline)'}`, 'k-sense');
    return true;
  }

  /** Count live messages for the recorded-vs-live comparison. */
  observe(m: AnyMessage): void {
    if (!this.playing) return;
    this.liveIn.set(m.type, (this.liveIn.get(m.type) ?? 0) + 1);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.playing = false;
  }

  private finish(): void {
    if (!this.playing) return;
    this.playing = false;
    const types = new Set([...this.recordedIn.keys(), ...this.liveIn.keys()]);
    const interesting = [...types].filter((t) => !['presence', 'log', 'welcome'].includes(t)).sort();
    this.hooks.log('done · received live vs recorded:', 'k-scan');
    for (const t of interesting) {
      const r = this.recordedIn.get(t) ?? 0;
      const l = this.liveIn.get(t) ?? 0;
      this.hooks.log(`  ${t.padEnd(14)} live ${l} · recorded ${r}`, l === r ? 'v-ok' : '');
    }
  }
}
