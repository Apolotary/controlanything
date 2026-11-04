import type { OnboardingView } from '../hud/contract';

export interface HelperDevice {
  deviceId: string;
  name: string;
  kind: string;
  online: boolean;
}

export interface HelperInfo {
  urls: string[];
  helpers: HelperDevice[];
}

export type OnboardingState = 'hidden' | 'shown' | 'scanning' | 'paired' | 'skipped';

/** Annotation starts immediately; only an explicit Connect/Pair action opens helper pairing. */
export class HelperOnboarding {
  state: OnboardingState = 'hidden';
  urls: string[] = [];
  pairedName?: string;
  generation = 0;
  private active = false;
  private helpers?: HelperDevice[];
  private pairedAt = 0;
  private skipped = false;
  private guideComplete = false;
  private pairingBaseline?: Set<string>;

  constructor(private readonly allowSim = false) {}

  get visible(): boolean { return ['shown', 'scanning', 'paired'].includes(this.state); }
  get scanning(): boolean { return this.active && this.state === 'scanning'; }
  get online(): HelperDevice | undefined {
    return this.helpers?.find((device) => device.online && (device.kind === 'mac' || device.kind === 'laptop' || this.allowSim && device.kind === 'sim'));
  }

  enter(now: number): void {
    this.active = true;
    this.skipped = false;
    this.guideComplete = false;
    this.pairingBaseline = undefined;
    this.state = 'hidden';
    this.generation++;
    this.reconcile(now);
  }

  leave(): void {
    this.active = false;
    this.state = 'hidden';
    this.pairingBaseline = undefined;
    this.generation++;
  }

  update(info: HelperInfo, now: number): void {
    this.urls = info.urls;
    this.updateHelpers(info.helpers, now);
  }

  updateUrls(urls: string[], now: number): void {
    this.urls = urls;
    this.reconcile(now);
  }

  updateHelpers(helpers: HelperDevice[], now: number): void {
    this.helpers = helpers;
    this.reconcile(now);
  }

  /** An explicit Pair action may reopen the card after Skip. */
  show(explicit = false): void {
    if (!this.active || this.online && !explicit) return;
    this.pairingBaseline = explicit ? new Set(this.helpers?.filter((device) => device.online).map((device) => device.deviceId)) : undefined;
    this.skipped = false;
    this.pairedName = undefined;
    this.state = 'shown';
    this.generation++;
  }

  scan(): void { if (this.active && this.state === 'shown') this.state = 'scanning'; }

  skip(): void {
    this.skipped = true;
    this.state = 'skipped';
    this.pairingBaseline = undefined;
    this.generation++;
  }

  /** Guidance is informational: only a deliberate mode choice completes it. */
  guide(tagged: number): OnboardingView | null {
    if (!this.active || this.guideComplete || this.visible) return null;
    return tagged > 0
      ? { step: 'use', title: 'Your device is tagged', message: 'Open the wrist menu and choose Control, then Set up on your device.' }
      : { step: 'tag', title: 'Look around', message: 'Boxes appear on devices. Pinch one to tag it.' };
  }

  chooseControl(): void { if (this.active) this.guideComplete = true; }

  tick(now: number): void {
    if (this.state === 'paired' && now - this.pairedAt >= 1500) {
      this.state = 'hidden';
      this.reconcile(now);
    }
  }

  private reconcile(now: number): void {
    if (!this.active || this.state === 'paired') return;
    const helper = this.pairingBaseline
      ? this.helpers?.find((device) => device.online && !this.pairingBaseline!.has(device.deviceId)
        && (device.kind === 'mac' || device.kind === 'laptop' || this.allowSim && device.kind === 'sim'))
      : this.online;
    if (helper) {
      if (this.state === 'shown' || this.state === 'scanning') {
        this.pairedName = helper.name;
        this.pairedAt = now;
        this.state = 'paired';
        this.pairingBaseline = undefined;
        this.generation++;
      } else this.state = this.skipped ? 'skipped' : 'hidden';
    }
  }
}
