import { newId, type ProjectAction, type ProjectCatalogPayload, type ProjectDocument, type ProjectStatePayload } from '@ce/protocol';
import type { HudFrame, ProjectUiCommand, ProjectView } from '../hud/contract';
import { PostureDetector } from '../gestures/posture';

type ProjectCommand = 'project.list' | 'project.get' | 'project.action';
const CHORD_IDS = ['chord_c', 'chord_am', 'chord_f', 'chord_g'] as const;
interface Deps {
  send(type: ProjectCommand, payload: unknown): boolean;
  render(view: ProjectView | null): void;
  immersive(): boolean;
  connected(): boolean;
  openPage?(projectId?: string): void;
}

export function headsetCanvasUrl(projectId?: string): string {
  const query = new URLSearchParams({ headset: '1' });
  if (projectId) query.set('project', projectId);
  return `/companion/canvas/?${query}`;
}

/** Software-only gesture bridge. It never sends a device control.event or arms hardware. */
export class ProjectControls {
  private catalog: ProjectCatalogPayload['projects'] = [];
  private document?: ProjectDocument;
  private projectId?: string;
  private actionIndex = 0;
  private values: Record<string, number> = {};
  private sequence = -1;
  private revision = -1;
  private shown = false;
  private enabled = false;
  private engaged = false;
  private hasClutched = false;
  private status = 'Create and use a full webpage here in your headset. Opening it leaves AR; hand gestures pause.';
  private ready = false;
  private previewCount = 0;
  private spatialRunning = false;
  private serverReady = false;
  private lastSent = -Infinity;
  private lastValue?: number;
  private lastChord?: string;
  private readonly left = new PostureDetector();
  private readonly right = new PostureDetector();
  get open(): boolean { return this.shown; }
  get running(): boolean { return this.enabled; }
  constructor(private readonly d: Deps) {}

  show(projectId?: string): void {
    this.shown = true; this.stopSpatial();
    if (projectId) this.projectId = projectId;
    if (!this.d.send('project.list', {})) this.status = 'Server disconnected. Reconnect and open Muse Canvas again.';
    else if (this.projectId) this.fetch(this.projectId);
    this.render();
  }
  close(): void { this.stopSpatial(); this.shown = false; this.d.render(null); }
  disconnect(): void { this.stopSpatial('Server disconnected. Reopen Canvas after reconnecting.'); this.serverReady = false; this.ready = false; this.previewCount = 0; this.render(); }
  receiveCatalog(payload: ProjectCatalogPayload): void {
    this.catalog = payload.projects;
    if (!this.shown) return;
    const selected = this.catalog.find((project) => project.projectId === this.projectId);
    if (!selected) {
      this.stopSpatial();
      this.document = undefined; this.projectId = undefined; this.ready = false;
      if (this.catalog[0]) this.fetch(this.catalog[0].projectId);
      else this.status = 'No webpage yet. Choose Create webpage to describe an idea and run it here in your headset.';
    } else if (selected.revision > this.revision) this.fetch(selected.projectId);
    this.render();
  }
  receive(state: ProjectStatePayload): void {
    if (!this.shown || state.projectId !== this.projectId) return;
    const revision = state.document?.revision ?? state.revision;
    if (revision !== undefined && revision < this.revision) return;
    if (state.document && state.document.projectId !== this.projectId) return;
    if (revision !== undefined && revision > this.revision) {
      this.stopSpatial('Project changed. Review its controls and start again.');
      this.document = undefined; this.actionIndex = 0; this.values = {}; this.sequence = -1; this.previewCount = 0; this.revision = revision; this.lastChord = undefined;
    }
    if (state.sequence !== undefined && state.sequence < this.sequence) return;
    if (state.document) {
      this.document = state.document;
      const spatialIndex = this.document.spec.actions.findIndex(action => action.id === this.document?.spec.spatial?.actionId && action.kind === 'number');
      if (spatialIndex >= 0 && !this.isChordPreset()) this.actionIndex = spatialIndex;
    }
    if (state.sequence !== undefined) this.sequence = state.sequence;
    if (state.values) this.values = state.values;
    if (state.preview) this.previewCount = state.preview.count;
    this.serverReady = state.status === 'ready' && !!this.document;
    if (!this.serverReady) this.spatialRunning = false;
    this.ready = this.serverReady && (this.spatialRunning || this.previewCount === 1);
    if (!this.ready) this.stop();
    if (state.status === 'generating') this.status = 'Muse is updating the webpage. Hand control is paused.';
    else if (state.status === 'error') this.status = state.message ?? 'Project unavailable. Refresh to try again.';
    else if (this.spatialRecipe() && !this.enabled) this.status = this.spatialRunning ? 'AR preview running. Start hand control, then hold left fist and raise/lower your right hand.' : 'Run AR preview here, then start hand control. Full webpage is available below.';
    else if (!this.ready && this.isChordPreset()) this.status = this.previewCount > 1 ? 'More than one chord preview is open. Keep one Mac preview, then enable pads.'
      : 'On Mac: Muse Canvas → Chord Garden → Run preview → Enable sound. Keep this page visible.';
    else if (!this.ready) this.status = this.previewCount > 1 ? 'More than one preview is running. Stop the extra previews, then start hand control.'
      : 'No preview is running. Open this page on your Mac and choose Run preview for AR hand control. Or open it here to use the full webpage.';
    else if (!this.enabled) this.status = this.isChordPreset() ? 'Mac sound is enabled. Enable pads, then point and pinch a chord. Release before the next chord.'
      : 'Preview connected. Start hand control for the displayed input, or open the full webpage here.';
    this.render();
  }
  command(command: ProjectUiCommand, actionId?: string): void {
    if (!this.shown) return;
    if (command === 'open-page') {
      this.stopSpatial('Opening the webpage. AR hand gestures are paused.'); this.render();
      this.d.openPage?.(this.projectId); return;
    }
    if (command === 'run-spatial') {
      if (!this.spatialRecipe() || !this.serverReady || !this.d.connected() || !this.d.immersive()) return;
      if (this.spatialRunning) this.stopSpatial('AR preview stopped. Run it again when ready.');
      else {
        this.stop(); this.spatialRunning = true; this.ready = true;
        this.status = 'AR preview running. Start hand control, then hold left fist and raise/lower your right hand.';
      }
      this.render(); return;
    }
    if (command === 'close') { this.close(); return; }
    if (command === 'refresh') { this.show(); return; }
    if (command === 'stop') { this.stop(this.isChordPreset() ? 'Pads stopped. Enable pads when you want to play again.' : 'Hand control stopped.'); this.render(); return; }
    if (command === 'pad') {
      if (!this.isChordPreset() || !this.enabled || !this.ready || !this.d.connected() || !this.d.immersive()) return;
      const action = this.chordActions().find(action => action.id === actionId);
      if (!action) return;
      if (this.sendAction(action)) { this.lastChord = action.id; this.status = `${action.label} triggered. Point, pinch and release to play another chord.`; }
      else this.stop('Connection lost. Reconnect and enable pads again.');
      this.render(); return;
    }
    if (command === 'next-project') {
      const index = this.catalog.findIndex((project) => project.projectId === this.projectId);
      const next = this.catalog[(index + 1) % this.catalog.length]; if (next) this.fetch(next.projectId);
    } else if (command === 'next-action') {
      if (this.isChordPreset() || this.spatialRecipe()) return;
      this.stop(); this.actionIndex = (this.actionIndex + 1) % (this.document?.spec.actions.length || 1);
      this.status = 'Control selected. Start hand control for a numeric value, or Run action for a button.';
    } else if (command === 'start') {
      const action = this.action();
      if (!this.ready || (!this.isChordPreset() && action?.kind !== 'number') || !this.d.connected() || !this.d.immersive()) return;
      this.enabled = true; this.hasClutched = false; this.lastValue = undefined; this.lastSent = -Infinity;
      this.status = this.isChordPreset() ? 'Pads enabled. Point at a chord, pinch once, then release. Stop silences the instrument.'
        : 'Hold left fist, then raise/lower your right hand. Release to pause. Both palms stop.';
    } else if (command === 'trigger' && !this.isChordPreset() && this.ready && this.action()?.kind === 'trigger') this.sendAction(this.action()!);
    this.render();
  }
  stop(message?: string): void {
    const silencePads = this.enabled && this.isChordPreset();
    this.enabled = this.engaged = false; this.left.reset(); this.right.reset(); this.lastValue = undefined;
    this.lastChord = undefined;
    if (silencePads) {
      const silence = this.document?.spec.actions.find(action => action.id === 'silence' && action.kind === 'trigger');
      if (silence) this.sendAction(silence);
    }
    if (message) this.status = message;
  }
  private stopSpatial(message?: string): void {
    this.stop(message); this.spatialRunning = false; this.ready = this.serverReady && this.previewCount === 1;
  }
  pauseForNavigation(): void { if (this.enabled || this.spatialRunning) { this.stopSpatial(this.isChordPreset() ? 'Pads paused for navigation. Choose Enable pads to resume.' : this.spatialRunning ? 'AR preview paused. Run AR preview, then start hand control again.' : 'Paused for navigation. Choose Start hand control to resume.'); this.render(); } }
  update(frame: HudFrame): void {
    if (this.spatialRunning && (!this.shown || !this.d.connected() || !this.d.immersive())) {
      this.stopSpatial('AR preview paused. Run it again when ready.'); this.render(); return;
    }
    if (!this.enabled) return;
    if (!this.shown || !this.d.connected() || !this.d.immersive() || !this.ready) { this.stop('Hand control paused. Start again when ready.'); this.render(); return; }
    if (this.isChordPreset()) {
      // Pad selection uses the HUD's captured ray/pinch action, not a fist clutch.
      // One tracked hand/controller is sufficient; losing both disarms the pads.
      const tracked = [frame.hands.left, frame.hands.right].some(hand => hand && (hand.controller || hand.joints.wrist && hand.joints['index-finger-tip'])
        && Number.isFinite(hand.ray.origin.x + hand.ray.origin.y + hand.ray.origin.z + hand.ray.dir.x + hand.ray.dir.y + hand.ray.dir.z));
      if (!tracked) { this.stop('Hand tracking lost. Bring a hand into view, then enable pads again.'); this.render(); }
      return;
    }
    const lp = this.left.update(frame.hands.left, frame.time), rp = this.right.update(frame.hands.right, frame.time);
    if (!this.left.tracked || !this.right.tracked) { this.stop('Hands lost. Bring both hands into view, then Start again.'); this.render(); return; }
    // Open resting hands after pressing Start are not a Stop gesture until the clutch has been used.
    if (this.hasClutched && lp === 'open_palm' && rp === 'open_palm') { this.stop('Both palms: hand control stopped.'); this.render(); return; }
    const engaged = lp === 'fist';
    if (engaged) this.hasClutched = true;
    if (engaged !== this.engaged) { this.engaged = engaged; this.render(); }
    if (!engaged) return;
    const action = this.action(), wrist = frame.hands.right?.joints.wrist;
    if (action?.kind !== 'number' || !wrist || !Number.isFinite(wrist.position.y + frame.head.position.y)) return;
    const normalized = Math.min(1, Math.max(0, (wrist.position.y - frame.head.position.y + 0.7) / 0.8));
    const value = action.min! + normalized * (action.max! - action.min!);
    if (frame.time - this.lastSent < 1000 / 15 || this.lastValue !== undefined && Math.abs(value - this.lastValue) < (action.max! - action.min!) / 200) return;
    if (this.sendAction(action, value)) { this.lastSent = frame.time; this.lastValue = value; }
    else { this.stop('Server disconnected. Hand control stopped.'); this.render(); }
  }
  private action(): ProjectAction | undefined { return this.document?.spec.actions[this.actionIndex]; }
  private isChordPreset(): boolean { return this.document?.source === 'preset' && this.document.presetId === 'chord-garden-v1'; }
  private spatialRecipe() {
    const recipe = !this.isChordPreset() ? this.document?.spec.spatial : undefined;
    return recipe && this.document?.spec.actions.some(action => action.id === recipe.actionId && action.kind === 'number') ? recipe : undefined;
  }
  private chordActions(): ProjectAction[] { return CHORD_IDS.flatMap(id => this.document?.spec.actions.filter(action => action.id === id && action.kind === 'trigger') ?? []); }
  private sendAction(action: ProjectAction, value?: number): boolean {
    if (!this.document || !this.ready || !this.d.connected()) return false;
    return this.d.send('project.action', { requestId: newId('project'), projectId: this.document.projectId, revision: this.document.revision, actionId: action.id, requirePreview: !this.spatialRunning, ...(value === undefined ? {} : { value }) });
  }
  private fetch(projectId: string): void {
    this.stopSpatial(); this.serverReady = false; this.projectId = projectId; this.document = undefined; this.revision = -1; this.sequence = -1; this.actionIndex = 0; this.ready = false; this.previewCount = 0; this.values = {};
    this.status = 'Opening the latest project…';
    if (!this.d.send('project.get', { projectId })) this.status = 'Server disconnected. Reconnect and Refresh.';
  }
  private render(): void {
    if (!this.shown) return;
    const action = this.action(), recipe = this.spatialRecipe();
    const normalized = action?.kind === 'number' ? Math.max(0, Math.min(1, ((this.values[action.id] ?? action.initial ?? action.min!) - action.min!) / (action.max! - action.min!))) : 0;
    this.d.render({ title: this.document?.spec.title ?? 'Muse Canvas', status: this.status, projectCount: this.catalog.length,
      action: action ? { label: action.label, kind: action.kind, value: this.values[action.id] ?? action.initial ?? 0 } : undefined,
      ...(this.isChordPreset() ? { chordPads: this.chordActions().map(({ id, label }) => ({ id, label })), lastChord: this.lastChord } : {}),
      ...(recipe ? { spatial: { recipe, normalized, running: this.spatialRunning, available: this.serverReady && this.d.connected() && this.d.immersive() } } : {}),
      actionCount: this.document?.spec.actions.length ?? 0, ready: this.ready, running: this.enabled, engaged: this.engaged });
  }
}
