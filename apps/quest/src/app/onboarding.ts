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

/** Pairing belongs to the AR session, independently of Annotate / Control. */
export class HelperOnboarding {
  state: OnboardingState = 'hidden';
  urls: string[] = [];
  pairedName?: string;
  generation = 0;
  private active = false;
  private helpers?: HelperDevice[];
  private pairedAt = 0;
  private skipped = false;

  constructor(private readonly allowSim = false) {}

  get visible(): boolean { return ['shown', 'scanning', 'paired'].includes(this.state); }
  get scanning(): boolean { return this.active && this.state === 'scanning'; }
  get online(): HelperDevice | undefined {
    return this.helpers?.find((device) => device.online && (device.kind === 'mac' || device.kind === 'laptop' || this.allowSim && device.kind === 'sim'));
  }

  enter(now: number): void {
    this.active = true;
    this.skipped = false;
    this.state = 'hidden';
    this.generation++;
    this.reconcile(now);
  }

  leave(): void {
    this.active = false;
    this.state = 'hidden';
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
  show(): void {
    if (!this.active || this.online) return;
    this.skipped = false;
    this.pairedName = undefined;
    this.state = 'shown';
    this.generation++;
  }

  scan(): void { if (this.active && this.state === 'shown') this.state = 'scanning'; }

  skip(): void {
    this.skipped = true;
    this.state = 'skipped';
    this.generation++;
  }

  tick(now: number): void {
    if (this.state === 'paired' && now - this.pairedAt >= 1500) {
      this.state = 'hidden';
      this.reconcile(now);
    }
  }

  private reconcile(now: number): void {
    if (!this.active || this.state === 'paired') return;
    const helper = this.online;
    if (helper) {
      if (this.state === 'shown' || this.state === 'scanning') {
        this.pairedName = helper.name;
        this.pairedAt = now;
        this.state = 'paired';
        this.generation++;
      } else this.state = this.skipped ? 'skipped' : 'hidden';
    } else if (!this.skipped && this.helpers && this.urls.length && !this.visible) this.show();
  }
}
