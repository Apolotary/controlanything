import { Group } from 'three';
import type { ProjectUiCommand, ProjectView } from '../contract';
import { GlassSurfaces } from './surface';
import { makeText, setText } from './text';
import { THEME } from './theme';
import { SpatialScene } from './spatial-scene';

/** AR controls plus optional trusted spatial recipes; generated webpage code remains sandboxed. */
export class ProjectPanel extends Group {
  readonly width = 0.46;
  readonly height = 0.64;
  readonly buttons: Group[] = [];
  readonly hitArea = new Group();
  private readonly spatial = new SpatialScene();
  private readonly title = makeText({ text: 'Muse Canvas', size: THEME.font.title, weight: 600, maxWidth: 0.41, maxHeight: 0.05 });
  private readonly subtitle = makeText({ text: 'Webpages in your headset · AR controls optional', size: 0.013, color: THEME.color.muted, maxWidth: 0.41 });
  private readonly action = makeText({ text: '', size: THEME.font.body, maxWidth: 0.41, maxHeight: 0.05 });
  private readonly status = makeText({ text: '', size: 0.015, maxWidth: 0.41, maxHeight: 0.10 });
  constructor(surfaces: GlassSurfaces) {
    super(); this.name = 'project-panel'; this.visible = false;
    this.hitArea.name = 'project-hit-area'; this.hitArea.add(surfaces.create(this.width, this.height)); this.add(this.hitArea);
    this.title.name = 'project-title'; this.title.position.set(-0.205, 0.277, THEME.panel.depth);
    this.subtitle.position.set(-0.205, 0.217, THEME.panel.depth);
    this.action.name = 'project-action'; this.action.position.set(-0.205, 0.175, THEME.panel.depth);
    this.status.name = 'project-status'; this.status.position.set(-0.205, 0.115, THEME.panel.depth);
    this.add(this.title, this.subtitle, this.action, this.status);
    this.spatial.position.set(.125, .075, THEME.panel.depth * 2); this.add(this.spatial);
    this.button(surfaces, 'open-page', 'Open webpage in headset', 0, -0.035, 0.416);
    this.button(surfaces, 'next-project', 'Next project', -0.108, -0.101, 0.20);
    this.button(surfaces, 'next-action', 'Next control', 0.108, -0.101, 0.20);
    this.button(surfaces, 'run-spatial', 'Run AR preview', 0.108, -0.101, 0.20).visible = false;
    this.button(surfaces, 'start', 'Start hand control', 0, -0.167, 0.416);
    this.button(surfaces, 'stop', 'Stop hand control', 0, -0.167, 0.416);
    this.button(surfaces, 'trigger', 'Run action', 0, -0.167, 0.416);
    this.button(surfaces, 'refresh', 'Refresh', -0.108, -0.253, 0.20);
    this.button(surfaces, 'close', 'Back', 0.108, -0.253, 0.20);
    for (const [index, id] of ['chord_c', 'chord_am', 'chord_f', 'chord_g'].entries()) {
      const pad = this.button(surfaces, 'pad', '', index % 2 ? 0.108 : -0.108, index < 2 ? 0.02 : -0.078, 0.20, 0.075);
      pad.name = `project-pad-${id}`; pad.userData.actionId = id; pad.visible = false;
    }
  }
  private button(surfaces: GlassSurfaces, command: ProjectUiCommand, label: string, x: number, y: number, width: number, height = 0.052): Group {
    const group = new Group(); group.name = `project-${command}`; group.position.set(x, y, THEME.panel.depth);
    group.userData.command = command; group.userData.width = width; group.userData.height = height;
    const plate = surfaces.create(width, height, 'button', true); plate.name = 'button-plate';
    const text = makeText({ text: label, anchorX: 'center', weight: 500, singleLine: true, size: command === 'pad' ? 0.025 : THEME.font.label, maxWidth: width - 0.018 }); text.position.z = THEME.panel.depth;
    group.add(plate, text); this.add(group); this.buttons.push(group);
    return group;
  }
  setState(view: ProjectView | null): void {
    this.visible = !!view; if (!view) { this.spatial.setState(undefined, 0, false); return; }
    const chords = !!view.chordPads;
    const spatial = !chords ? view.spatial : undefined;
    this.spatial.setState(spatial?.recipe, spatial?.normalized ?? 0, spatial?.running ?? false);
    this.status.maxWidth = spatial ? .235 : .41;
    this.status.userData.fitWidth = this.status.maxWidth;
    setText(this.title, view.title);
    setText(this.subtitle, chords ? 'Point and pinch · short chords on your Mac' : spatial ? `${spatial.recipe.kind === 'orb' ? 'Orb' : 'Ripple rings'} · native AR preview · hand height` : 'Webpages in your headset · AR controls optional');
    this.action.visible = !chords; this.status.position.y = chords ? 0.165 : 0.115;
    setText(this.action, view.action ? `${view.action.label} · ${Number(view.action.value.toFixed(2))}${view.engaged ? ' · live' : ''}` : view.projectCount ? 'This page has no shared controls' : 'Create your first webpage');
    setText(this.status, view.status);
    for (const button of this.buttons) {
      const cmd = button.userData.command as ProjectUiCommand;
      // Performance owns the hands until an explicit Stop. Remove navigation
      // targets so expressive pinches cannot open a page or change the project.
      if (view.running && cmd !== 'pad' && cmd !== 'stop') {
        button.visible = false; button.userData.disabled = true; continue;
      }
      if (cmd === 'pad') {
        const pad = view.chordPads?.find(pad => pad.id === button.userData.actionId);
        button.visible = !!pad; button.userData.disabled = !view.ready || !view.running || !pad;
        setText(button.children[1] as ReturnType<typeof makeText>, pad?.label ?? '', button.userData.disabled ? THEME.color.muted
          : view.lastChord === pad?.id ? THEME.color.accent : THEME.color.text);
        button.getObjectByName('button-plate')!.visible = !button.userData.disabled;
        continue;
      }
      if (cmd === 'run-spatial') {
        button.visible = !!spatial; button.userData.disabled = !spatial?.available;
        setText(button.children[1] as ReturnType<typeof makeText>, spatial?.running ? 'Stop AR preview' : 'Run AR preview', button.userData.disabled ? THEME.color.muted : THEME.color.text);
        button.getObjectByName('button-plate')!.visible = !button.userData.disabled; continue;
      }
      if (cmd === 'next-project') button.position.y = chords ? -0.253 : -0.101;
      if (cmd === 'open-page') setText(button.children[1] as ReturnType<typeof makeText>, view.projectCount ? 'Open webpage in headset' : 'Create webpage');
      button.visible = cmd === 'next-project' ? view.projectCount > 1 : cmd === 'next-action' ? !chords && !spatial && view.actionCount > 1 : cmd === 'start' ? (chords || view.action?.kind === 'number') && !view.running
        : cmd === 'stop' ? view.running : cmd === 'trigger' ? !chords && view.action?.kind === 'trigger' : cmd === 'open-page' ? !chords
        : cmd === 'refresh' ? !chords || view.projectCount < 2 : true;
      button.userData.disabled = cmd === 'next-project' ? view.projectCount < 2 : cmd === 'next-action' ? view.actionCount < 2
        : cmd === 'start' || cmd === 'trigger' ? !view.ready : false;
      const text = button.children[1] as ReturnType<typeof makeText>;
      const disabled = button.userData.disabled === true;
      const label = cmd === 'start' ? disabled ? chords ? 'Enable sound on Mac first' : spatial ? 'Run AR preview first' : 'Hand control unavailable' : chords ? 'Enable pads' : 'Start hand control'
        : cmd === 'stop' ? chords ? 'Stop pads and sound' : 'Stop hand control'
        : cmd === 'trigger' ? disabled ? 'Action unavailable' : 'Run action' : text.text;
      setText(text, label, disabled ? THEME.color.muted : THEME.color.text);
      // Inactive actions have no button fill/outline; the status above explains
      // how to make them available. The HUD's disabled hit guard remains in force.
      button.getObjectByName('button-plate')!.visible = !disabled;
    }
  }
  disposeSpatial(): void { this.spatial.dispose(); }
}
