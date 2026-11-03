import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { initialCanvasGame, reduceCanvasGame, type CanvasDocument, type CanvasStatePayload } from '@ce/protocol';
import type { HandState, Hud, HudFrame } from '../contract';
import { createHud } from './index';

const document: CanvasDocument = { canvasId: 'game', cardId: 'book', revision: 2, prompt: 'A game', source: 'fixture', updatedAt: 2,
  history: [{ revision: 1, title: 'First draft' }], spec: { title: 'Book explorer', intro: 'Explore the book in front of you.', objectUse: 'Look at the cover for clues.',
    rounds: [{ id: 'cover', prompt: 'What would you inspect first?', choices: [
      { id: 'title', label: 'The title', points: 2, feedback: 'A useful clue.' }, { id: 'spine', label: 'The spine', points: 1, feedback: 'Another clue.' },
      { id: 'color', label: 'The cover color', points: 0, feedback: 'A visual clue.' },
    ] }], ending: 'You explored this object.' } };
const ready = (): CanvasStatePayload => ({ cardId: 'book', status: 'ready', document, game: initialCanvasGame(document.spec) });
const instances: Hud[] = [];
function setup(connection: 'offline' | 'setup' | 'ready' = 'offline') {
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.6, 0); camera.updateMatrixWorld();
  const hud = createHud({ scene: new Scene(), camera, renderer: {} as WebGLRenderer }); instances.push(hud); let time = 0;
  const step = (hand?: Partial<HandState>, elapsed = 20) => {
    const frame: HudFrame = { time: time += elapsed, dt: elapsed / 1000, pointer: 'mouse', head: { position: camera.position, quaternion: camera.quaternion },
      hands: hand ? { right: { controller: true, joints: {}, pinchPoint: new Vector3(10, 10, 10), ray: { origin: camera.position.clone(), dir: new Vector3(0, 0, -1) }, pinching: false, justPinched: false, justReleased: false, ...hand } } : {} }; hud.update(frame);
  };
  const node = (name: string) => hud.root.getObjectByName(name)!;
  const text = (name: string) => (node(name) as Object3D & { text: string }).text;
  const click = (name: string) => { step(undefined, 300); const ray = { origin: camera.position.clone(), dir: node(name).getWorldPosition(new Vector3()).sub(camera.position).normalize() };
    step({ ray }); step({ ray, pinching: true, justPinched: true }); step({ ray, justReleased: true }); };
  hud.setHome?.({ mode: 'control', filter: 'everything', tagged: 1, status: '' });
  hud.upsertTarget({ id: 'target-book', label: 'Book', tagged: true, connection, status: 'scanned', position: [0, 1.4, -1], confirmed: true });
  hud.setLocked('target-book'); hud.setDeviceState?.({ targetId: 'target-book', connection }); step(undefined, 300);
  const show = (state = ready()) => { hud.setCanvas?.({ targetId: 'target-book', state }); step(); };
  return { hud, camera, node, text, click, step, show };
}
afterEach(() => instances.splice(0).forEach((hud) => hud.dispose()));

describe('object canvas in the selected workspace', () => {
  it('keeps game actions in a reachable foreground workspace independent of a distant book anchor', () => {
    const f = setup(); f.hud.upsertTarget({ id: 'target-book', label: 'Book', tagged: true, connection: 'offline', status: 'scanned', position: [0, 0.3, -2.5], confirmed: true });
    f.show();
    const play = f.node('canvas-primary').getWorldPosition(new Vector3());
    expect(play.distanceTo(f.camera.position)).toBeLessThan(0.75);
    expect(play.y).toBeGreaterThan(f.camera.position.y - 0.33);
    expect(f.node('target-label:target-book').visible).toBe(false);
    const action = vi.fn(); f.hud.on('canvasAction', action); f.click('canvas-primary'); expect(action).toHaveBeenCalledOnce();
  });
  it.each(['offline', 'setup', 'ready'] as const)('offers Make a game for a selected %s object without starting physical setup', (connection) => {
    const f = setup(connection), create = vi.fn(), setupPhysical = vi.fn(), control = vi.fn();
    f.hud.on('canvasCreate', create); f.hud.on('setup', setupPhysical); f.hud.on('control', control);
    f.click('canvas-create'); expect(create).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-book' });
    expect(setupPhysical).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
    f.hud.setDeviceState?.({ targetId: 'target-book', connection, busy: true }); f.step(); expect(f.node('canvas-create').visible).toBe(false);
  });

  it('plays choices, feedback, final score and restart through canvas-only events at a fixed anchor', () => {
    const f = setup(), control = vi.fn(); let state = ready(); f.show(state);
    const panel = f.node('object-canvas'), nodes = [...panel.children], card = f.node('device-card'), position = card.position.clone();
    f.hud.on('control', control);
    f.hud.on('canvasAction', (event) => {
      expect(event.revision).toBe(2); const next = reduceCanvasGame(document.spec, state.game!, event); expect(next.ok).toBe(true);
      state = { ...state, game: next.state }; f.hud.setCanvas?.({ targetId: 'target-book', state });
    });
    expect(f.text('canvas-caption')).toContain('Draft'); expect(f.text('canvas-object-use')).toContain('cover');
    f.click('canvas-primary'); expect(state.game?.phase).toBe('playing'); expect(f.node('canvas-choice-2').visible).toBe(true);
    f.click('canvas-choice-0'); expect(state.game?.phase).toBe('feedback'); expect(f.text('canvas-body')).toBe('A useful clue.');
    f.click('canvas-primary'); expect(state.game?.phase).toBe('finished'); expect(f.text('canvas-caption')).toContain('2/2');
    f.camera.position.x += 0.15; f.click('canvas-primary'); expect(state.game?.phase).toBe('playing'); expect(state.game?.score).toBe(0);
    expect(panel.children).toEqual(nodes); expect(card.position).toEqual(position); expect(control).not.toHaveBeenCalled();
  });

  it('gives Ask Muse the foreground and restores revision-bound game actions after dismissal', () => {
    const f = setup(), restore = vi.fn(), talk = vi.fn(); f.show(); f.hud.on('canvasRestore', restore); f.hud.on('assistantTalk', talk);
    f.hud.setAssistant?.({ targetId: 'target-book', state: 'reply', text: 'Tell me how to change this game.' }); f.step();
    const card = f.node('device-card'), assistant = f.node('assistant-panel');
    expect(card.visible).toBe(false); expect(assistant.visible).toBe(true);
    f.click('canvas-previous'); expect(restore).not.toHaveBeenCalled();
    f.hud.on('assistantDismiss', () => f.hud.setAssistant?.(null)); f.click('assistant-dismiss');
    f.click('canvas-previous'); expect(restore).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-book', revision: 1, baseRevision: 2 });
    f.click('assistant-talk'); expect(talk).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-book' });
  });

  it('hides playable actions during generation and keeps Close usable without changing selection', () => {
    const f = setup(), close = vi.fn(), action = vi.fn(); f.hud.on('canvasClose', close); f.hud.on('canvasAction', action);
    f.show({ ...ready(), status: 'generating', message: 'Muse is editing this game.' });
    expect(f.node('canvas-primary').visible).toBe(false); expect(f.node('canvas-choice-0').visible).toBe(false); expect(f.node('canvas-previous').visible).toBe(false);
    f.click('canvas-close'); expect(close).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-book' }); expect(action).not.toHaveBeenCalled();
    f.hud.setCanvas?.(null); f.step(); expect(f.node('object-canvas').visible).toBe(false); expect(f.node('device-card').visible).toBe(true);
    expect(f.node('device-status').visible).toBe(true); expect(f.node('canvas-create').visible).toBe(true);
  });

  it('labels recovery as Open saved when the failed operation retained a document', () => {
    const f = setup(); f.show({ ...ready(), status: 'error', message: 'Could not load the saved game.' });
    expect((f.node('canvas-primary').getObjectByName('sdf') as Object3D & { text: string }).text).toBe('Open saved');
    expect(f.text('canvas-body')).toBe('Could not load the saved game.');
  });

  it('suspends input for Menu and dialogs and clears the canvas on selection or mode changes', () => {
    const f = setup(), action = vi.fn(); f.hud.on('canvasAction', action); f.show(); f.hud.setDeck({ open: true }); f.step();
    expect(f.node('object-canvas').visible).toBe(false); f.click('canvas-primary'); expect(action).not.toHaveBeenCalled();
    f.hud.setDeck({ open: false }); f.hud.showConfirm({ id: 'confirm', kind: 'forget', title: 'Forget book?' }); f.step();
    expect(f.node('object-canvas').visible).toBe(false); f.hud.showConfirm(null); f.step(); expect(f.node('object-canvas').visible).toBe(true);
    f.hud.setLocked(null); f.hud.setLocked('target-book'); f.step(); expect(f.node('object-canvas').visible).toBe(false);
    f.show(); f.hud.setHome?.({ mode: 'annotate', filter: 'everything', tagged: 1, status: '' }); f.step(); expect(f.node('object-canvas').visible).toBe(false);
  });
});
