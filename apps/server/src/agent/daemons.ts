/**
 * DAEMONS: persistent automations from ce.hackset/1, run by the deterministic control loop (no model).
 * "Breathe to tempo": a light's brightness follows a synth's tempo as a slow wave (<= 0.5 Hz, nothing above
 * 3 Hz anywhere), written through the light's own verified brightness control at <= max_rate_hz. Tempo comes
 * from incoming MIDI clock (device.signal clock_bpm) when a client reports it, else from a BPM set by voice or
 * the hack menu, else 120. Daemons are proposals until a pinch starts them; panic stops them all.
 */
import type { Daemon, DaemonStatusPayload, DeviceSignalPayload, UiSpecPayload } from '@ce/protocol';
import type { Hub } from '../hub';
import type { StepLog } from './steps';

export const DEFAULT_BPM = 120;
/** the slowest a "beat" cycle may be mapped: the wave never repeats faster than this */
export const MAX_WAVE_HZ = 0.5;
/** daemons that change visible light never write faster than this */
export const MAX_LIGHT_WRITE_HZ = 1;

export interface DaemonDrive {
  /** write a hack param on a device spec (through the control loop: rate limits, arm gate, step planning) */
  setParam(specId: string, hackId: string, paramId: string | undefined, value: number): boolean;
}

export interface DaemonDeps {
  hub: Pick<Hub, 'broadcast'>;
  steps: StepLog;
  drive: DaemonDrive;
  log?: (line: string) => void;
  now?: () => number;
  /** test hook: run the wave on this clock instead of wall time */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

interface Running {
  daemon: Daemon;
  specId: string;
  cardId?: string;
  /** spec that holds the target hack(s) (the light's spec) */
  targetSpecId: string;
  bpm: number;
  source: NonNullable<DaemonStatusPayload['source']>;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  writes: number;
  lastValue?: number;
  rateHz: number;
}

/** Value of the wave at `phase` (0..1) between `min` and `max`. */
export function waveValue(curve: Daemon['map'] extends infer M ? (M extends { curve: infer C } ? C : never) : never, phase: number, min: number, max: number): number {
  const t = phase - Math.floor(phase);
  let u: number;
  switch (curve) {
    case 'step':
      u = t < 0.5 ? 1 : 0;
      break;
    case 'linear':
      u = t < 0.5 ? t * 2 : 2 - t * 2; // triangle
      break;
    default:
      u = 0.5 + 0.5 * Math.sin(2 * Math.PI * t); // sine
  }
  return min + (max - min) * u;
}

/** Cycle length in ms for a tempo: period_bars bars of 4 beats, never shorter than 1 / MAX_WAVE_HZ. */
export function periodMs(bpm: number, periodBars = 2): number {
  const beat = 60_000 / Math.max(20, Math.min(300, bpm));
  return Math.max(1000 / MAX_WAVE_HZ, periodBars * 4 * beat);
}

export class DaemonRunner {
  private readonly running = new Map<string, Running>();
  private readonly tempo = new Map<string, { bpm: number; at: number }>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly d: DaemonDeps) {
    this.log = d.log ?? (() => {});
    this.now = d.now ?? Date.now;
  }

  list(): DaemonStatusPayload[] {
    return [...this.running.values()].map((r) => this.status(r, 'running'));
  }

  isRunning(daemonId: string): boolean {
    return this.running.has(daemonId);
  }

  /** A client measured a tempo (MIDI clock) for a device: running daemons that listen to it follow. */
  onSignal(p: DeviceSignalPayload, fromDeviceId: string): void {
    if (p.signal !== 'clock_bpm' || !(p.value > 20 && p.value < 300)) return;
    const keys = [p.cardId, p.deviceId ?? fromDeviceId].filter(Boolean) as string[];
    for (const k of keys) this.tempo.set(k, { bpm: p.value, at: this.now() });
    for (const r of this.running.values()) {
      const src = r.daemon.trigger.source; // "device.<cardId>.clock_bpm"
      const m = /^device\.([^.]+)\.clock_bpm$/.exec(src);
      if (m && keys.includes(m[1]) && Math.abs(r.bpm - p.value) >= 0.5) {
        r.bpm = p.value;
        r.source = 'midi-clock';
        this.d.hub.broadcast('daemon.status', this.status(r, 'running'));
      }
    }
  }

  /** Latest known tempo for a source card/device, if a client reported one in the last 20 s. */
  tempoFor(source: string): number | undefined {
    const m = /^device\.([^.]+)\.clock_bpm$/.exec(source);
    const t = m ? this.tempo.get(m[1]) : undefined;
    return t && this.now() - t.at < 20_000 ? t.bpm : undefined;
  }

  /**
   * Start a daemon. `targetSpecId` is the spec whose hack the daemon writes (the light's). The wave runs at
   * min(max_rate_hz, 1) writes per second; its cycle never exceeds 0.5 Hz.
   */
  start(daemon: Daemon, o: { specId: string; targetSpecId: string; cardId?: string; bpm?: number; source?: Running['source'] }): DaemonStatusPayload {
    this.stop(daemon.id, 'restarted', true);
    const clockBpm = this.tempoFor(daemon.trigger.source);
    const bpm = o.bpm ?? clockBpm ?? DEFAULT_BPM;
    const source: Running['source'] = o.bpm !== undefined ? (o.source ?? 'menu') : clockBpm !== undefined ? 'midi-clock' : 'default';
    const rateHz = Math.min(daemon.max_rate_hz, MAX_LIGHT_WRITE_HZ);
    const r: Running = { daemon, specId: o.specId, cardId: o.cardId, targetSpecId: o.targetSpecId, bpm, source, startedAt: this.now(), timer: undefined as never, writes: 0, rateHz };
    const tick = () => this.tick(r);
    r.timer = (this.d.setInterval ?? setInterval)(tick, Math.round(1000 / rateHz));
    this.running.set(daemon.id, r);
    tick();
    const status = this.status(r, 'running');
    this.d.hub.broadcast('daemon.status', status);
    this.d.steps.note('control', `daemon ${daemon.name} running`, { cardId: o.cardId, kind: 'proof', evidence: `${bpm} bpm (${source}) · ${rateHz}/s · cycle ${(periodMs(bpm, daemon.map?.period_bars) / 1000).toFixed(1)} s` });
    return status;
  }

  setBpm(daemonId: string, bpm: number, source: Running['source'] = 'menu'): boolean {
    const r = this.running.get(daemonId);
    if (!r) return false;
    r.bpm = Math.max(20, Math.min(300, bpm));
    r.source = source;
    this.d.hub.broadcast('daemon.status', this.status(r, 'running'));
    return true;
  }

  stop(daemonId: string, reason = 'stopped', quiet = false): boolean {
    const r = this.running.get(daemonId);
    if (!r) return false;
    (this.d.clearInterval ?? clearInterval)(r.timer);
    this.running.delete(daemonId);
    if (!quiet) {
      this.d.hub.broadcast('daemon.status', { ...this.status(r, 'stopped'), detail: reason });
      this.d.steps.note('control', `daemon ${r.daemon.name} ${reason}`, { cardId: r.cardId, kind: 'proof', evidence: `${r.writes} writes` });
    }
    return true;
  }

  stopAll(reason = 'panic'): number {
    const ids = [...this.running.keys()];
    for (const id of ids) this.stop(id, reason);
    return ids.length;
  }

  private tick(r: Running): void {
    const map = r.daemon.map ?? { curve: 'sine' as const, range: [0, 100] };
    const period = periodMs(r.bpm, map.period_bars);
    const phase = (this.now() - r.startedAt) / period;
    const [min, max] = map.range;
    const value = Math.round(waveValue(map.curve, phase, min, max));
    if (r.lastValue === value) return;
    for (const t of r.daemon.targets) {
      if (this.d.drive.setParam(r.targetSpecId, t.hack, t.param, value)) r.writes++;
    }
    r.lastValue = value;
  }

  private status(r: Running, state: DaemonStatusPayload['state']): DaemonStatusPayload {
    return { daemonId: r.daemon.id, specId: r.specId, cardId: r.cardId, name: r.daemon.name.slice(0, 40), state, bpm: r.bpm, rateHz: r.rateHz, source: r.source, at: this.now() };
  }

  close(): void {
    for (const r of this.running.values()) (this.d.clearInterval ?? clearInterval)(r.timer);
    this.running.clear();
  }
}
