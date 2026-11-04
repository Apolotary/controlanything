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
  cardId?: string;
  instrument?: 'musical-synth';
  wire: { phase?: string; request?: string; wiringId?: string; needsScreen?: boolean; touching?: boolean; stats?: { sent?: number } };
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
  private wired = false;
  private needsScreen = false;

  get step(): StepId | undefined { return this.finished ? undefined : STEP_IDS[this.index]; }
  restart(): void {
    this.index = 0; this.finished = false; this.boundCard = this.request = undefined;
    this.sawTouch = this.sawMenu = this.wired = this.needsScreen = false; this.playAt = undefined;
  }
  skip(): void { this.finished = true; }

  update(s: TutorialProbe, now: number): void {
    if (this.finished || !s.inXr || s.busy) return;
    if (this.boundCard && s.cardId && s.cardId !== this.boundCard && this.index >= 2 && this.index < 6) {
      this.index = 2; this.request = undefined; this.wired = this.sawTouch = false; this.playAt = undefined;
    }
    if (s.cardId) this.boundCard = s.cardId;
    if (s.wire.request && s.wire.request !== this.request && this.index >= 2 && this.index < 6) {
      this.request = s.wire.request; this.wired = this.sawTouch = false; this.playAt = undefined; this.index = 3;
    }
    if (['calibrating', 'running'].includes(s.wire.phase ?? '')) {
      this.wired = true; this.needsScreen = !!s.wire.needsScreen;
    }
    if (s.wire.phase === 'running' && s.wire.touching && (s.wire.stats?.sent ?? 0) > 0) this.sawTouch = true;
    if (this.index >= 6 && s.menuOpen) this.sawMenu = true;
    for (let count = 0; count < STEP_IDS.length; count++) {
      const done = this.step === 'look' ? s.boxes > 0 || s.selected
        : this.step === 'pinch' ? s.selected
          : this.step === 'ask' ? !!s.wire.request
            : this.step === 'wiring' ? this.wired
              : this.step === 'calibrate' ? !this.needsScreen || s.wire.phase === 'running'
                : this.step === 'touch' ? s.wire.phase === 'running' && (this.needsScreen ? this.sawTouch : (s.wire.stats?.sent ?? 0) > 1)
                  : this.step === 'menu' ? this.sawMenu
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
      case 'ask': return s.controllable
        ? { title: 'What should your hands do?', detail: s.instrument === 'musical-synth'
          ? 'Choose Play like a theremin, or hold the mic to ask Muse.' : 'Choose Touch the water, or hold the mic to ask Muse.' }
        : { title: 'Getting the device ready', detail: 'Keep the Mac in view while its controls are checked.' };
      case 'wiring': return s.wire.phase === 'failed' || s.wire.phase === 'stopped'
        ? { title: 'Try your request again', detail: 'Choose a suggestion on the device card.' }
        : { title: 'Watch Muse write the connection', detail: 'The code card shows writing, checks and readiness.' };
      case 'calibrate': return { title: 'Calibrate your screen', detail: 'Touch the corner named on the code card and hold still.' };
      case 'touch': return s.wire.phase !== 'running'
        ? { title: 'Ask Muse to start again', detail: 'Your wiring is paused. Choose a suggestion to continue.' }
        : this.needsScreen ? { title: 'Touch the water', detail: 'Bring one fingertip to your Mac screen, then move it.' }
          : { title: 'Try your new hand control', detail: 'Follow Muse’s explanation on the code card.' };
      case 'menu': return now - (this.playAt ?? now) < 5000 ? undefined
        : { title: 'Find your wrist menu', detail: 'Move away from the screen. Raise a flat left palm toward your eyes.' };
      case 'buddy': return { title: 'Try Buddy', detail: 'Choose Buddy in the wrist menu. Hold an object in its frame.' };
    }
  }
}
