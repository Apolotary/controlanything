import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3, type Object3D, type WebGLRenderer } from 'three';
import type { HudFrame, ProjectView } from '../contract';
import { createHud } from './index';
import { THEME } from './theme';

function setup() {
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.6, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer });
  hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '' });
  hud.upsertTarget({ id: 'laptop', label: 'Laptop', tagged: true, connection: 'ready', status: 'verified', position: [0, 1.5, -1], confirmed: true }); hud.setLocked('laptop');
  let time = 0;
  const step = (target?: string, pinch = false) => {
    const point = target ? hud.root.getObjectByName(target)!.getWorldPosition(new Vector3()) : new Vector3(0, 1.6, -1);
    const frame: HudFrame = { time: time += 80, dt: .08, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion },
      hands: target ? { right: { controller: true, joints: {}, pinchPoint: new Vector3(10, 10, 10), ray: { origin: camera.position, dir: point.clone().sub(camera.position).normalize() }, pinching: pinch, justPinched: pinch, justReleased: !pinch } } : {} };
    hud.update(frame);
  };
  step(); const click = (name: string) => { step(name); step(name, true); step(name); };
  const node = (name: string) => hud.root.getObjectByName(name)!;
  return { hud, camera, step, click, node };
}
const view: ProjectView = { title: 'Orb', status: 'Run on Mac', projectCount: 1, actionCount: 2, ready: true, running: false, engaged: false, action: { kind: 'number', label: 'Amount', value: 50 } };

describe('Muse Canvas foreground panel', () => {
  it('removes page/back/preview targets during hand performance and restores them only after Stop', () => {
    const f = setup(), commands: string[] = [];
    const ready: ProjectView = { ...view, projectCount: 2, spatial: {
      recipe: { kind: 'orb', color: '#80eec2', actionId: 'amount' }, normalized: .5, running: true, available: true,
    } };
    f.hud.on('projectsCommand', ({ command }) => {
      commands.push(command);
      if (command === 'stop') f.hud.setProjects?.({ ...ready, running: false });
    });
    f.hud.setProjects?.({ ...ready, running: true }); f.step();
    for (const name of ['project-open-page', 'project-close', 'project-refresh', 'project-run-spatial', 'project-next-project']) {
      expect(f.node(name).visible).toBe(false); expect(f.node(name).userData.disabled).toBe(true);
      f.click(name);
    }
    expect(commands).toEqual([]);
    expect(f.node('project-stop').visible).toBe(true);
    f.click('project-stop'); expect(commands).toEqual(['stop']);
    for (const name of ['project-open-page', 'project-close', 'project-refresh', 'project-run-spatial', 'project-next-project']) {
      expect(f.node(name).visible).toBe(true); expect(f.node(name).userData.disabled).toBe(false);
    }
    f.click('project-open-page'); expect(commands).toEqual(['stop', 'open-page']);
    f.hud.dispose();
  });

  it('runs a generated native recipe in the existing panel without a second action owner', () => {
    const f = setup(), commands: string[] = [];
    f.hud.on('projectsCommand', ({ command }) => commands.push(command));
    const spatial: NonNullable<ProjectView['spatial']> = { recipe: { kind: 'ripples', color: '#40ccff', actionId: 'amount' }, normalized: .5, running: false, available: true };
    f.hud.setProjects?.({ ...view, ready: false, spatial }); f.step();
    expect(f.node('project-spatial-preview').visible).toBe(false);
    expect(f.node('project-next-action').visible).toBe(false); expect(f.node('project-open-page').visible).toBe(true);
    expect(f.node('project-run-spatial').visible).toBe(true);
    f.click('project-run-spatial'); expect(commands).toEqual(['run-spatial']);
    const anchor = f.node('project-panel').position.clone();
    f.hud.setProjects?.({ ...view, spatial: { ...spatial, running: true } }); f.step();
    expect(f.node('project-panel').position).toEqual(anchor);
    expect(f.node('project-spatial-preview').userData).toMatchObject({ kind: 'ripples', normalized: .5, rendered: true });
    expect(f.node('project-run-spatial').children[1]).toMatchObject({ text: 'Stop AR preview' });
    f.click('project-start'); expect(commands).toEqual(['run-spatial', 'start']);
    f.hud.setProjects?.({ ...view, spatial: { ...spatial, available: false } }); f.step();
    f.click('project-run-spatial'); expect(commands).toEqual(['run-spatial', 'start']);
    f.hud.dispose();
  });

  it('presents four large chord pads and dispatches one named action per pinch after explicit enable', () => {
    const f = setup(), commands: { command: string; actionId?: string }[] = [];
    const chordView: ProjectView = { ...view, title: 'Chord Garden', action: undefined, actionCount: 5,
      chordPads: [{ id: 'chord_c', label: 'Cmaj7' }, { id: 'chord_am', label: 'Am7' }, { id: 'chord_f', label: 'Fmaj7' }, { id: 'chord_g', label: 'G7' }] };
    f.hud.on('projectsCommand', event => commands.push(event));
    f.hud.setProjects?.(chordView); f.step();
    expect(f.node('project-next-action').visible).toBe(false); expect(f.node('project-trigger').visible).toBe(false);
    expect(f.node('project-open-page').visible).toBe(false);
    expect(f.node('project-start').children[1]).toMatchObject({ text: 'Enable pads' });
    const pad = f.node('project-pad-chord_am');
    expect(pad.userData.height).toBe(0.075); expect(pad.userData.disabled).toBe(true);
    f.click('project-pad-chord_am'); expect(commands).toEqual([]);
    f.click('project-start'); expect(commands).toEqual([{ command: 'start' }]);
    f.hud.setProjects?.({ ...chordView, running: true }); f.step();
    for (const name of ['project-close', 'project-refresh', 'project-next-project', 'project-run-spatial']) {
      expect(f.node(name).visible).toBe(false); expect(f.node(name).userData.disabled).toBe(true);
    }
    expect(pad.visible).toBe(true); expect(f.node('project-stop').visible).toBe(true);
    f.step('project-pad-chord_am'); f.step('project-pad-chord_am', true);
    for (let i = 0; i < 4; i++) f.step('project-pad-chord_am', true);
    f.step('project-pad-chord_am');
    expect(commands).toEqual([{ command: 'start' }, { command: 'pad', actionId: 'chord_am' }]);
    expect(f.node('project-stop').children[1]).toMatchObject({ text: 'Stop pads and sound' });
    f.hud.setProjects?.({ ...chordView, running: true, lastChord: 'chord_am' });
    expect(pad.children[1]).toMatchObject({ text: 'Am7', color: THEME.color.accent });
    f.hud.setProjects?.(view); f.step(); expect(pad.visible).toBe(false);
    expect(f.node('project-next-action').visible).toBe(true); expect(f.node('project-open-page').visible).toBe(true);
    f.hud.dispose();
  });

  it('keeps the Menu launcher above the actual Canvas plate through state changes and head turns', () => {
    const f = setup(); f.hud.setProjects?.({ ...view, ready: false, status: 'No preview is running.' }); f.step();
    const panel = f.node('project-panel'), launcher = f.node('hand-dock');
    const projected = (plate: Object3D, x: number, y: number) => {
      f.hud.root.updateMatrixWorld(true);
      const point = new Vector3(x / 2, y / 2, 0).applyMatrix4(plate.matrixWorld).sub(f.camera.position).applyQuaternion(f.camera.quaternion.clone().invert());
      return { x: point.x / -point.z, y: point.y / -point.z };
    };
    const separated = () => {
      const plate = f.node('project-hit-area').children[0]!, left = projected(plate, -1, 1), right = projected(plate, 1, 1);
      // Compare the projected top edge rather than axis-aligned bounds: a head
      // turn can slope both panels without making their visible rectangles overlap.
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const point = projected(f.node('menu-toggle').getObjectByName('button-plate')!, x, y);
        const edge = left.y + (right.y - left.y) * (point.x - left.x) / (right.x - left.x);
        expect(point.y).toBeGreaterThan(edge + 0.02);
      }
    };
    separated();
    const panelPosition = panel.position.clone(), menuPosition = launcher.position.clone();
    f.hud.setProjects?.({ ...view, title: 'New project revision', status: 'Preview ready' }); f.step(); separated();
    expect(panel.position).toEqual(panelPosition); expect(launcher.position).toEqual(menuPosition);
    f.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.35); f.camera.position.x += 0.15; f.step(); separated();
    expect(panel.position).toEqual(panelPosition); expect(launcher.position).toEqual(menuPosition);
    f.click('menu-toggle'); expect(f.node('main-menu').visible).toBe(true); expect(panel.visible).toBe(false);
    f.hud.setDeck({ open: false }); f.step(); separated();
    f.hud.setProjects?.(null); f.step();
    expect(launcher.position.y).toBeCloseTo(f.camera.position.y - 0.06 + 0.378);
    expect(panel.visible).toBe(false); f.hud.dispose();
  });

  it('shows unavailable preview controls as muted text and enables them only when ready', () => {
    const f = setup(), commands: string[] = [];
    f.hud.on('projectsCommand', ({ command }) => commands.push(command));
    f.hud.setProjects?.({ ...view, ready: false, status: 'No preview is running.' }); f.step();
    const start = f.node('project-start');
    expect(start.userData.disabled).toBe(true);
    expect(start.children[1]).toMatchObject({ text: 'Hand control unavailable', color: THEME.color.muted });
    expect(start.getObjectByName('button-plate')!.visible).toBe(false);
    f.click('project-start'); expect(commands).toEqual([]);
    f.hud.setProjects?.(view); f.step();
    expect(start.userData.disabled).toBe(false);
    expect(start.children[1]).toMatchObject({ text: 'Start hand control', color: THEME.color.text });
    expect(start.getObjectByName('button-plate')!.visible).toBe(true);
    f.click('project-start'); expect(commands).toEqual(['start']); f.hud.dispose();
  });

  it('offers headset creation and hides meaningless cycling controls in the empty state', () => {
    const f = setup(), commands: string[] = [];
    f.hud.on('projectsCommand', ({ command }) => commands.push(command));
    f.hud.setProjects?.({ title: 'Muse Canvas', status: 'Create a webpage here in your headset.', projectCount: 0, actionCount: 0, ready: false, running: false, engaged: false }); f.step();
    expect(f.node('project-next-project').visible).toBe(false); expect(f.node('project-next-action').visible).toBe(false);
    expect(f.node('project-start').visible).toBe(false);
    expect((f.node('project-open-page').children[1] as unknown as { text: string }).text).toBe('Create webpage');
    f.click('project-open-page'); expect(commands).toEqual(['open-page']); f.hud.dispose();
  });
  it('opens from the menu and gives the project panel exclusive foreground input', () => {
    const f = setup(), commands: string[] = [];
    f.hud.on('projectsOpen', () => f.hud.setProjects?.(view)); f.hud.on('projectsCommand', ({ command }) => commands.push(command));
    f.click('menu-toggle'); f.click('menu-tools'); f.click('muse-canvas');
    expect(f.node('project-panel').visible).toBe(true); expect(f.node('device-card').visible).toBe(false);
    f.click('project-start'); expect(commands).toEqual(['start']);
    f.hud.setProjects?.({ ...view, running: true }); f.step();
    expect(f.node('project-start').visible).toBe(false); expect(f.node('project-stop').visible).toBe(true);
    f.click('project-stop'); expect(commands).toEqual(['start', 'stop']); f.hud.dispose();
  });
  it('requires Stop before ordinary navigation and restores the same workspace', () => {
    const f = setup(), commands: string[] = [];
    f.hud.setProjects?.({ ...view, running: true }); f.step();
    f.hud.on('projectsCommand', ({ command }) => { commands.push(command); if (command === 'stop') f.hud.setProjects?.(view); });
    expect(f.node('hand-dock').visible).toBe(false);
    f.click('menu-toggle'); expect(f.node('main-menu').visible).toBe(false);
    f.click('project-stop'); expect(commands).toEqual(['stop']);
    expect(f.node('hand-dock').visible).toBe(true);
    const anchor = f.node('project-panel').position.clone();
    f.click('menu-toggle'); expect(f.node('main-menu').visible).toBe(true);
    f.click('project-start'); expect(commands).toEqual(['stop']);
    f.hud.setDeck({ open: false }); f.step();
    expect(f.node('project-panel').visible).toBe(true); expect(f.node('project-panel').position).toEqual(anchor);
    f.hud.dispose();
  });
  it('pauses on menu recall and keeps project actions unavailable behind navigation', () => {
    const f = setup(); let paused = 0, actions = 0;
    f.hud.setProjects?.({ ...view, running: true }); f.step();
    f.hud.on('projectsPause', () => { paused++; f.hud.setProjects?.(view); }); f.hud.on('projectsCommand', () => actions++);
    f.hud.setDeck({ open: true }); expect(paused).toBe(1); expect(f.node('project-panel').visible).toBe(false);
    f.click('project-start'); expect(actions).toBe(0);
    f.hud.setDeck({ open: false }); expect(f.node('project-panel').visible).toBe(true); f.hud.dispose();
  });
});
