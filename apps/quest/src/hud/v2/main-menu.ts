import { Group } from 'three';
import type { HomeState } from '../contract';
import { GlassSurfaces } from './surface';
import { DockHold } from './hand-dock';
import { makeText, setText } from './text';
import { THEME } from './theme';

/** A stable launcher and a separate world-placed panel. Hand poses never activate actions. */
export class MainMenu extends Group {
  readonly panel = new Group();
  readonly buttons: Group[] = [];
  readonly width = 0.32;
  readonly height = 0.052;
  readonly panelWidth = 0.44;
  readonly panelHeight = 0.74;
  private readonly hold = new DockHold();
  private toolsOpen = false;
  private home: HomeState = { mode: 'annotate', filter: 'everything', tagged: 0, status: '' };
  private canStop = false;
  private recallProgress = 0;
  private stage: 'choose' | 'prepare' | 'building' | 'review' | 'ready' | 'perform' = 'choose';
  private readonly demoHint = makeText({ text: 'Make your hands control the Mac screen', size: 0.014, color: THEME.color.muted, anchorX: 'center', maxWidth: 0.39, singleLine: true });
  private readonly launcherText = makeText({ text: '', size: 0.017, weight: 500, anchorX: 'center', singleLine: true, maxWidth: 0.30 });
  private readonly workspaceText = makeText({ text: '', size: 0.012, color: THEME.color.muted, anchorX: 'center', singleLine: true, maxWidth: 0.44 });
  private readonly countLabel = makeText({ text: '', size: THEME.font.detail, color: THEME.color.muted, anchorX: 'center', singleLine: true, maxWidth: 0.30 });
  private readonly exitText = makeText({ text: 'Exit AR · hold', size: THEME.font.label, anchorX: 'center', singleLine: true, maxWidth: 0.30 });

  constructor(surfaces: GlassSurfaces) {
    super();
    this.name = 'hand-dock'; this.panel.name = 'main-menu'; this.panel.visible = false;
    this.userData.width = this.width; this.userData.height = this.height; this.userData.open = false;
    this.panel.add(surfaces.create(this.panelWidth, this.panelHeight));
    const heading = makeText({ text: 'ControlAnything', size: 0.020, weight: 600, maxWidth: 0.29 });
    heading.name = 'app-menu-title'; heading.position.set(-0.195, 0.324, THEME.panel.depth); this.panel.add(heading);
    this.button(surfaces, this, 'menu-toggle', '', 0, 0, this.width, this.launcherText);
    this.workspaceText.name = 'workspace-stage'; this.workspaceText.position.set(0, -0.040, THEME.panel.depth); this.add(this.workspaceText);
    this.button(surfaces, this.panel, 'menu-close', 'Close', 0.155, 0.324, 0.08);
    this.button(surfaces, this.panel, 'visual-synth', 'Try visual synth', 0, 0.174, 0.39,
      makeText({ text: 'Try visual synth', size: 0.023, weight: 600, anchorX: 'center', maxWidth: 0.35, singleLine: true }), 0.078, true);
    this.demoHint.name = 'menu-demo-hint'; this.demoHint.position.set(0, 0.108, THEME.panel.depth); this.panel.add(this.demoHint);
    this.button(surfaces, this.panel, 'ask-muse-general', 'Ask Muse', 0, 0.040, 0.39);
    this.button(surfaces, this.panel, 'menu-tools', 'More tools', 0, -0.030, 0.39);
    this.button(surfaces, this.panel, 'menu-tools-back', 'Back to demo', 0, 0.210, 0.39);
    this.button(surfaces, this.panel, 'muse-canvas', 'Canvas · optional experiments', 0, 0.146, 0.39);
    this.button(surfaces, this.panel, 'mode-annotate', 'Find devices', -0.103, 0.082, 0.184);
    this.button(surfaces, this.panel, 'mode-control', 'Use devices', 0.103, 0.082, 0.184);
    this.button(surfaces, this.panel, 'change-device', 'Change device', 0.103, 0.082, 0.184);
    this.button(surfaces, this.panel, 'identify-area', 'Identify here', 0, 0.018, 0.39);
    const filters = [['everything', 'All'], ['electronics', 'Electronics']] as const;
    filters.forEach(([key, label], i) => this.button(surfaces, this.panel, `filter:${key}`, label, (i - 0.5) * 0.206, -0.046, 0.184));
    this.button(surfaces, this.panel, 'deck:panic', 'Stop controls', 0, -0.046, 0.39);
    this.button(surfaces, this.panel, 'helper-pair', 'Pair Mac / helper', -0.103, -0.110, 0.184);
    this.button(surfaces, this.panel, 'menu-recenter', 'Bring menu here', 0.103, -0.110, 0.184);
    this.button(surfaces, this.panel, 'exit-ar', '', 0, -0.234, 0.39, this.exitText);
    this.countLabel.name = 'dock-count'; this.countLabel.position.set(0, -0.136, THEME.panel.depth); this.panel.add(this.countLabel);
    const hint = makeText({ text: 'Raise open left hand · hold for Menu', size: 0.013, color: THEME.color.muted, anchorX: 'center', maxWidth: 0.39, singleLine: true });
    hint.name = 'menu-recovery-hint'; hint.position.set(0, -0.314, THEME.panel.depth); this.panel.add(hint);
  }

  private button(surfaces: GlassSurfaces, parent: Group, name: string, text: string, x: number, y: number, width: number, label = makeText({ text, size: THEME.font.label, weight: 500, anchorX: 'center', maxWidth: width - 0.012, singleLine: true }), height = this.height, primary = false): void {
    const group = new Group(); group.name = name; group.position.set(x, y, THEME.panel.depth);
    group.userData.menuButton = true; group.userData.width = width; group.userData.height = height; group.userData.primary = primary;
    const plate = surfaces.create(width, height, primary ? 'primary' : 'button', true); plate.name = 'button-plate';
    label.position.z = THEME.panel.depth;
    group.add(plate, label); parent.add(group); this.buttons.push(group);
  }

  setState(home: HomeState, canStop: boolean): void {
    this.home = home; this.canStop = canStop;
    setText(this.launcherText, 'ControlAnything · Menu');
    setText(this.countLabel, `${home.tagged} tagged · other tools are optional`);
    this.refreshButtons();
  }
  private refreshButtons(): void {
    const home = this.home;
    this.demoHint.visible = !this.toolsOpen; this.countLabel.visible = !this.toolsOpen && !this.canStop;
    this.panel.userData.toolsOpen = this.toolsOpen;
    for (const button of this.buttons) {
      const id = button.name;
      button.userData.selected = id === `mode-${home.mode}` || id === `filter:${home.filter}`;
      if (id === 'menu-toggle' || id === 'menu-close' || id === 'exit-ar') button.visible = true;
      else if (id === 'visual-synth' || id === 'ask-muse-general' || id === 'menu-tools') button.visible = !this.toolsOpen;
      else button.visible = this.toolsOpen;
      if (id.startsWith('filter:')) button.visible = this.toolsOpen && home.mode === 'annotate' && !this.canStop;
      if (id === 'mode-control') button.visible = this.toolsOpen && home.mode === 'annotate';
      if (id === 'change-device') button.visible = this.toolsOpen && home.mode === 'control';
      if (id === 'deck:panic') { button.visible = this.canStop; button.position.y = this.toolsOpen ? -0.046 : -0.106; }
    }
  }
  setTools(open: boolean): void { this.toolsOpen = open; this.refreshButtons(); }
  setOpen(open: boolean): void {
    if (!this.panel.visible || !open) this.setTools(false);
    this.panel.visible = open; this.userData.open = open;
    if (!open) this.cancelExitHold();
  }
  setRecallProgress(progress: number): void { this.recallProgress = progress; this.setWorkspace(this.stage); }
  setWorkspace(stage: 'choose' | 'prepare' | 'building' | 'review' | 'ready' | 'perform'): void {
    this.stage = stage;
    const labels = { choose: 'Start with Try visual synth', prepare: 'Prepare · ask Muse or complete setup', building: 'Muse is working · review before starting',
      review: 'Review the result before enabling it', ready: 'Ready · start hand control when you choose', perform: 'Hand control on · release fist to pause' };
    setText(this.workspaceText, this.recallProgress > 0 ? `Hold open left hand · ${Math.round(this.recallProgress * 100)}%` : labels[stage]);
  }
  beginExitHold(time: number): void { this.hold.begin(time); }
  cancelExitHold(): void { this.hold.cancel(); this.getExit().userData.holdProgress = 0; setText(this.exitText, 'Exit AR · hold'); }
  private getExit(): Group { return this.buttons.find((button) => button.name === 'exit-ar')!; }
  updateExitHold(time: number): boolean {
    const fired = this.hold.update(time);
    this.getExit().userData.holdProgress = this.hold.progress;
    setText(this.exitText, this.hold.progress > 0 ? `Hold to exit · ${Math.round(this.hold.progress * 100)}%` : 'Exit AR · hold');
    return fired;
  }
}
