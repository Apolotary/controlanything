/** Tutorial progress observes the real app. It never starts setup, wiring or controls. */
export const TUTORIAL_KEY = 'ce.tutorial.wire.v1';
export const STEP_IDS = ['look', 'pinch', 'ask', 'wiring', 'calibrate', 'touch', 'menu', 'buddy'] as const;
export type StepId = typeof STEP_IDS[number];
export interface TutorialProbe {
  inXr: boolean;
  busy: boolean;
  boxes: number;
  selected: boolean;
  controllable: boolean;
  needsEnable?: boolean;
  /** Explicit full Stop observed by the app before the selected wiring is discarded. */
  fullStopRequestId?: string;
  cardId?: string;
  instrument?: 'musical-synth';
  wire: { phase?: string; request?: string; requestId?: string; wiringId?: string; needsScreen?: boolean; touching?: boolean; stats?: { sent?: number } };
  menuOpen: boolean;
  buddyOpen: boolean;
}
export interface TutorialView { title: string; detail: string; pinch?: boolean }
export class TutorialSteps {
  index = 0;
  finished = false;
  private boundCard?: string;
  private request?: string;
  private sawTouch = false;
  private playAt?: number;
  private sawMenu = false;
  private sawStop = false;
  private sawFullStop = false;
  private wired = false;
  private needsScreen = false;

  get step(): StepId | undefined { return this.finished ? undefined : STEP_IDS[this.index]; }
  restart(): void {
    this.index = 0; this.finished = false; this.boundCard = this.request = undefined;
    this.sawTouch = this.sawMenu = this.sawStop = this.sawFullStop = this.wired = this.needsScreen = false; this.playAt = undefined;
  }
  skip(): void { this.finished = true; }

  update(s: TutorialProbe, now: number): void {
    if (this.finished || !s.inXr || s.busy) return;
    if (this.boundCard && s.cardId && s.cardId !== this.boundCard && this.index >= 2 && this.index <= 6) {
      this.index = 2; this.request = undefined; this.wired = this.sawTouch = this.sawStop = this.sawFullStop = this.sawMenu = false; this.playAt = undefined;
    }
    if (s.cardId) this.boundCard = s.cardId;
    const request = s.wire.requestId ?? s.wire.request;
    const terminal = ['failed', 'stopped', 'idle'].includes(s.wire.phase ?? 'idle');
    if (this.index >= 3 && this.index < 6 && (!s.selected || terminal)) {
      this.index = s.selected ? 2 : 1;
      this.wired = this.sawTouch = this.sawStop = this.sawFullStop = this.sawMenu = this.needsScreen = false;
      this.playAt = undefined;
    }
    if (request && !terminal && request !== this.request && this.index <= 6) {
      this.request = request; this.wired = this.sawTouch = this.sawStop = this.sawFullStop = this.sawMenu = false; this.playAt = undefined;
      if (this.index >= 2) this.index = 3;
    }
    if (['calibrating', 'running'].includes(s.wire.phase ?? '')) {
      this.wired = true; this.needsScreen = !!s.wire.needsScreen;
    }
    if (s.wire.phase === 'running' && s.wire.touching && (s.wire.stats?.sent ?? 0) > 0) this.sawTouch = true;
    if (this.index === 6 && s.controllable && s.cardId === this.boundCard && request === this.request
      && (s.wire.phase === 'stopped' || s.wire.phase === 'failed')) this.sawStop = true;
    if (this.index === 6 && !!this.request && s.fullStopRequestId === this.request) this.sawStop = this.sawFullStop = true;
    if (this.index >= 6 && this.sawStop && s.menuOpen) this.sawMenu = true;
    for (let count = 0; count < STEP_IDS.length; count++) {
      const done = this.step === 'look' ? s.boxes > 0 || s.selected
        : this.step === 'pinch' ? s.selected
          : this.step === 'ask' ? !!request && !terminal
            : this.step === 'wiring' ? this.wired
              : this.step === 'calibrate' ? !this.needsScreen || s.wire.phase === 'running'
                : this.step === 'touch' ? s.wire.phase === 'running' && (this.needsScreen ? this.sawTouch : (s.wire.stats?.sent ?? 0) > 1)
                  : this.step === 'menu' ? this.sawStop && this.sawMenu
                    : this.step === 'buddy' ? s.buddyOpen : false;
      if (!done) break;
      if (this.step === 'touch') this.playAt = now;
      this.index++;
      if (this.index >= STEP_IDS.length) { this.finished = true; break; }
    }
  }

  view(s: TutorialProbe, now: number): TutorialView | undefined {
    if (this.finished || !s.inXr || s.busy) return;
    switch (this.step) {
      case 'look': return { title: 'Look at your Mac', detail: 'SAM will outline the devices it sees.' };
      case 'pinch': return { title: 'Pinch the Mac’s box', detail: 'Aim, then tap thumb to index.', pinch: true };
      case 'ask': return s.needsEnable
        ? { title: 'Enable this device', detail: 'Press Enable controls on the confirmation, then ask Muse.' }
        : s.controllable
        ? { title: ['failed', 'stopped'].includes(s.wire.phase ?? '') ? 'Ask Muse to try again' : 'What should your hands do?', detail: s.instrument === 'musical-synth'
          ? 'Choose Play like a theremin, or hold the mic to ask Muse.' : 'Choose Touch the water, or hold the mic to ask Muse.' }
        : { title: 'Getting the device ready', detail: 'Keep the Mac in view while its controls are checked.' };
      case 'wiring': return s.wire.phase === 'failed' || s.wire.phase === 'stopped'
        ? { title: 'Try your request again', detail: 'Choose a suggestion on the device card.' }
        : { title: 'Watch Muse write the connection', detail: 'The code card shows writing, checks and readiness.' };
      case 'calibrate': return { title: 'Calibrate your screen', detail: 'Move your fingertip to the named corner, then hold still.' };
      case 'touch': return s.wire.phase !== 'running'
        ? { title: 'Ask Muse to start again', detail: 'Your wiring is paused. Choose a suggestion to continue.' }
        : this.needsScreen ? { title: 'Touch the water', detail: 'Bring one fingertip to your Mac screen, then move it.' }
          : { title: 'Try your new hand control', detail: 'Follow Muse’s explanation on the code card.' };
      case 'menu': return !this.sawStop
        ? now - (this.playAt ?? now) < 5000 ? undefined
          : { title: 'Stop just the wiring', detail: 'Show both palms outward. Your Mac stays ready for another request.' }
        : this.sawFullStop
          ? { title: 'Everything is stopped', detail: 'Raise a flat left palm toward your eyes and hold to open the menu.' }
          : { title: 'Ask again, or open the menu', detail: 'Lower your right hand. Raise a flat left palm toward your eyes and hold.' };
      case 'buddy': return { title: 'Try Buddy', detail: 'Choose Buddy in the wrist menu. Hold an object in its frame.' };
    }
  }
}
