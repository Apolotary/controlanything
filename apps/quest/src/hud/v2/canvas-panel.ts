import { Group } from 'three';
import type { CanvasView } from '../contract';
import { assistantLines } from './assistant-panel';
import { GlassSurfaces } from './surface';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';

/** Bounded game data rendered inside the selected object's existing workspace. No authored code runs. */
export class CanvasPanel extends Group {
  readonly width = 0.4;
  readonly height = 0.56;
  readonly hitArea = new Group();
  readonly buttons: Group[] = [];
  readonly close: Group;
  readonly primary: Group;
  readonly previous: Group;
  private readonly choices: Group[] = [];
  private readonly title = makeText({ text: '', size: 0.018, weight: 600, maxWidth: 0.36, maxHeight: 0.043, anchorY: 'top' });
  private readonly caption = makeText({ text: '', size: 0.0125, color: THEME.color.accent, singleLine: true, maxWidth: 0.36 });
  private readonly body = makeText({ text: '', size: 0.014, maxWidth: 0.36, maxHeight: 0.14, anchorY: 'top' });
  private readonly secondary = makeText({ text: '', size: 0.014, maxWidth: 0.36, maxHeight: 0.11, anchorY: 'top' });

  constructor(surfaces: GlassSurfaces) {
    super(); this.name = 'object-canvas'; this.visible = false;
    const plate = surfaces.create(this.width, this.height); plate.name = 'canvas-background'; plate.position.y = -0.12;
    this.hitArea.name = 'canvas-hit-area'; this.hitArea.position.y = -0.12;
    this.title.name = 'canvas-title'; this.title.position.set(-0.18, 0.08, THEME.panel.depth);
    this.caption.name = 'canvas-caption'; this.caption.position.set(-0.18, 0.017, THEME.panel.depth);
    this.body.name = 'canvas-body'; this.body.position.set(-0.18, -0.012, THEME.panel.depth);
    this.secondary.name = 'canvas-object-use'; this.secondary.position.set(-0.18, -0.181, THEME.panel.depth);
    this.add(plate, this.hitArea, this.title, this.caption, this.body, this.secondary);
    for (let i = 0; i < 3; i++) this.choices.push(this.button(surfaces, `canvas-choice-${i}`, 0, -0.16 - i * 0.064, 0.36, 0.058, 2));
    this.primary = this.button(surfaces, 'canvas-primary', -0.12, -0.36, 0.112, 0.048); this.primary.userData.primary = true;
    this.previous = this.button(surfaces, 'canvas-previous', 0, -0.36, 0.112, 0.048);
    this.close = this.button(surfaces, 'canvas-close', 0.12, -0.36, 0.112, 0.048); this.label(this.close, 'Close');
  }

  private button(surfaces: GlassSurfaces, name: string, x: number, y: number, width: number, height: number, rows = 1): Group {
    const group = new Group(); group.name = name; group.position.set(x, y, THEME.panel.depth);
    group.userData.width = width; group.userData.height = height;
    const plate = surfaces.create(width, height, 'button', true); plate.name = 'button-plate';
    const text = makeText({ text: '', size: 0.0145, weight: 500, anchorX: 'center', maxWidth: width - 0.02, maxHeight: height - 0.014, singleLine: rows === 1 });
    text.position.z = THEME.panel.depth; group.add(plate, text); this.add(group); this.buttons.push(group); return group;
  }
  private label(group: Group, value: string): void { setText(group.children[1] as SdfText, value); }

  setState(view: CanvasView | null): void {
    this.visible = !!view; this.userData.status = view?.state.status;
    const state = view?.state, doc = state?.document, game = state?.game, phase = game?.phase ?? 'preview';
    this.userData.phase = phase; this.userData.revision = doc?.revision;
    const ready = state?.status === 'ready' && !!doc;
    const round = doc?.spec.rounds[game?.roundIndex ?? 0];
    const source = doc ? `${doc.source === 'fixture' ? 'Fixture' : 'Muse'} · v${doc.revision}` : 'Muse';
    const caption = !ready ? state?.status === 'error' ? 'Could not make this game' : 'Making your game…'
      : phase === 'preview' ? `Draft · ${source}` : `${phase === 'finished' ? 'Finished' : `Round ${(game?.roundIndex ?? 0) + 1}/${doc.spec.rounds.length}`} · ${game?.score ?? 0}/${game?.maxScore ?? 0} · ${source}`;
    setText(this.title, assistantLines(doc?.spec.title ?? 'A game for this object', 40, 2)); setText(this.caption, caption);
    let body = state?.message ?? 'Muse is building a short game inspired by your object.';
    let secondary = '';
    if (ready) {
      body = phase === 'preview' ? doc.spec.intro : phase === 'playing' ? round?.prompt ?? '' : phase === 'feedback' ? game?.feedback ?? '' : doc.spec.ending;
      secondary = phase === 'preview' ? `Use your object: ${doc.spec.objectUse}\n\nAsk Muse to change this game.` : phase === 'finished' ? 'Ask Muse for a new version, or play again.' : '';
    }
    setText(this.body, assistantLines(body, 46, ready && phase === 'preview' ? 8 : 6));
    setText(this.secondary, assistantLines(secondary, 46, 6)); this.secondary.visible = !!secondary;
    for (let i = 0; i < this.choices.length; i++) {
      const button = this.choices[i]!, choice = round?.choices[i];
      button.visible = !!ready && phase === 'playing' && !!choice;
      button.userData.canvasAction = 'choose'; button.userData.roundId = round?.id; button.userData.choiceId = choice?.id;
      this.label(button, assistantLines(choice?.label ?? '', 46, 2));
    }
    this.primary.visible = !!ready || state?.status === 'error';
    const action = !ready ? 'retry' : phase === 'preview' ? 'play' : phase === 'feedback' ? 'next' : 'restart';
    this.primary.userData.canvasAction = action; this.primary.userData.roundId = round?.id;
    this.label(this.primary, action === 'retry' ? doc ? 'Open saved' : 'Try again' : action === 'play' ? 'Play' : action === 'next' ? 'Next' : 'Restart');
    const previous = doc?.history.filter((entry) => entry.revision < doc.revision).sort((a, b) => b.revision - a.revision)[0];
    this.previous.visible = !!ready && !!previous; this.previous.userData.revision = previous?.revision;
    this.label(this.previous, previous ? `Previous v${previous.revision}` : 'Previous');
    this.close.visible = true;
  }
}
