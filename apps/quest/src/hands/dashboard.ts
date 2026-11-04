/**
 * The Quest's "Now" wrist dashboard (Layer · Object · Devices · Muse + Next, hud/v2 dashboardView) and its
 * tutorial bubbles (tutorial/steps.ts TutorialSteps: the same steps and the same progression), with the words
 * changed only where the input differs: a tap on a phone, a held hand (or a click) on a webcam.
 */
import { STEP_IDS, TutorialSteps, type TutorialProbe } from '../tutorial/steps';

export type Input = 'hand' | 'touch';
export type WirePhase = 'idle' | 'working' | 'ready' | 'running' | 'failed' | 'stopped';
export interface DashboardRow { key: string; label: string; value: string; tone: 'ok' | 'busy' | 'warn' | 'off' }
export interface NowState {
  server: boolean;
  mode: 'annotate' | 'control';
  filter: string;
  tagged: number;
  detections: number;
  selected?: string;
  devices: string;
  phase: WirePhase;
  title?: string;
  phaseLine?: string;
  source?: 'live' | 'fixture' | 'template';
  input: Input;
  demo?: string;
}

export function nowView(s: NowState): { rows: DashboardRow[]; next: string } {
  const tap = s.input === 'touch' ? 'Tap' : 'Hold your hand over (or click)';
  const source = s.source === 'fixture' ? 'FIXTURE' : s.source === 'template' ? 'Template' : 'Live';
  const muse = !s.selected || s.mode !== 'control' ? { value: 'idle', tone: 'off' as const }
    : s.phase === 'working' ? { value: `writing · ${s.phaseLine || 'thinking'}`, tone: 'busy' as const }
      : s.phase === 'running' || s.phase === 'ready' ? { value: `running · ${s.title || 'controls'} · ${source}`, tone: 'ok' as const }
        : s.phase === 'failed' ? { value: `failed · ${s.phaseLine || 'try again'}`, tone: 'warn' as const }
          : s.phase === 'stopped' ? { value: 'stopped', tone: 'off' as const } : { value: 'ready to ask', tone: 'off' as const };
  const next = !s.server ? 'Reconnect: the Mac server is offline.'
    : s.mode === 'annotate'
      ? (s.tagged ? 'Choose Control above to use a tagged device.' : s.detections ? `${tap} a device’s outline to tag it.` : 'Point the camera at a device. SAM outlines what it finds.')
      : !s.selected ? `${tap} a tagged device to select it.`
        : s.phase === 'working' ? 'Watch Muse write and test the code. Stop Muse on the card anytime.'
          : s.phase === 'running' || s.phase === 'ready' ? `Use the controls${s.input === 'hand' ? ' or your hands' : ''}. Stop Muse to stop.`
            : s.phase === 'failed' || s.phase === 'stopped' ? 'Ask Muse again, in other words if needed.'
              : 'Ask Muse on the device card: tap an idea or hold the mic.';
  return {
    rows: [
      { key: 'layer', label: 'Layer', value: s.mode === 'annotate' ? `Annotate · ${s.filter}` : 'Control', tone: 'ok' },
      { key: 'object', label: 'Object', value: s.demo ? `${s.demo} (demo)` : s.selected ? s.selected : s.tagged ? `${s.tagged} tagged · none selected` : 'none yet', tone: s.selected || s.demo ? 'ok' : 'off' },
      { key: 'mac', label: 'Devices', value: !s.server ? 'server offline' : s.devices || 'Mac not connected', tone: !s.server || !s.devices ? 'warn' : 'ok' },
      { key: 'muse', label: 'Muse', ...muse },
    ],
    next,
  };
}

/** The Quest's tutorial progression, observing this page. */
export class Tutorial {
  readonly steps = new TutorialSteps();
  constructor(private readonly input: Input) {}
  update(p: TutorialProbe, now: number): { id: string; title: string; detail: string } | undefined {
    this.steps.update(p, now);
    const id = this.steps.step;
    if (!id || !p.inXr || p.busy) return undefined;
    const hand = this.input === 'hand';
    const copy: Record<(typeof STEP_IDS)[number], { title: string; detail: string } | undefined> = {
      look: { title: 'Look at a device', detail: hand ? 'SAM outlines the devices the camera sees. Keep a device in view.' : 'Point your phone at a device. SAM outlines what it sees.' },
      pinch: { title: 'Tag a device’s outline', detail: hand ? 'Hold your hand over its outline until the ring fills, or close your hand on it. You stay in Annotate.' : 'Tap its outline to tag it. You stay in Annotate.' },
      ask: p.mode === 'annotate' ? { title: 'Switch to Control', detail: 'Your device is tagged. Choose Control at the top, then select it.' }
        : !p.selected ? { title: 'Select your device', detail: hand ? 'Hold your hand over the tagged device (or click it).' : 'Tap the tagged device.' }
          : { title: ['failed', 'stopped'].includes(p.wire.phase ?? '') ? 'Ask Muse to try again' : 'Ask Muse what you want', detail: 'Tap an idea on the device card, or hold the mic and say it.' },
      wiring: p.wire.phase === 'failed' || p.wire.phase === 'stopped'
        ? { title: 'Try your request again', detail: 'Choose a suggestion on the device card.' }
        : { title: 'Watch Muse write the connection', detail: 'Muse writes, runs and tests a connector on your Mac. The code card shows each step.' },
      calibrate: undefined,
      touch: p.wire.phase !== 'running' ? { title: 'Ask Muse to start again', detail: 'Your wiring is paused. Choose a suggestion to continue.' }
        : { title: 'Try your new controls', detail: hand ? 'Move your hands, or use the controls beside the device.' : 'Use the controls beside the device.' },
      menu: { title: 'Stop just the wiring', detail: hand ? 'Press Stop Muse on the card (or Esc). Your device stays ready.' : 'Press Stop Muse on the card. Your device stays ready.' },
      buddy: { title: 'Try Buddy', detail: 'Open More, then Buddy. Show it an object.' },
    };
    const view = copy[id];
    return view ? { id, ...view } : undefined;
  }
}
