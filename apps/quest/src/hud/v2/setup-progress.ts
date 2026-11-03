import { Group } from 'three';
import type { SetupProgressView } from '@ce/protocol';
import { GlassSurfaces } from './surface';
import { makeText, setText, type SdfText } from './text';
import { assistantLines } from './assistant-panel';
import { THEME } from './theme';

/** A bounded excerpt of actual output. No invented typing, progress percentages or placeholder code. */
export function artifactExcerpt(value: string): string {
  return assistantLines(value.replace(/\s+/g, ' '), 40, 3);
}

/** Pooled contents of the selected card. Its top and world anchor stay fixed throughout setup. */
export class SetupProgress extends Group {
  readonly width = THEME.card.width;
  readonly height = 0.50;
  readonly centerY = -0.09;
  readonly hitArea = new Group();
  readonly action = new Group();
  readonly actionWidth = 0.20;
  private readonly title = makeText({ text: '', size: THEME.font.label, color: THEME.color.accent, singleLine: true, maxWidth: 0.36 });
  private readonly detail = makeText({ text: '', size: THEME.font.detail, maxWidth: 0.36, maxHeight: 0.039, anchorY: 'top' });
  private readonly artifactLabel = makeText({ text: '', size: 0.013, weight: 600, color: THEME.color.muted, singleLine: true, maxWidth: 0.36 });
  private readonly code = makeText({ text: '', size: 0.013, mono: true, maxWidth: 0.36, maxHeight: 0.052, anchorY: 'top' });
  private readonly facts = makeText({ text: '', size: 0.014, maxWidth: 0.36, maxHeight: 0.037, anchorY: 'top' });
  private readonly source = makeText({ text: '', size: 0.0125, color: THEME.color.muted, singleLine: true, maxWidth: 0.36 });
  private readonly actionLabel = makeText({ text: '', weight: 500, anchorX: 'center', singleLine: true, maxWidth: 0.17 });
  private readonly stages: { group: Group; label: SdfText }[] = [];

  constructor(surfaces: GlassSurfaces) {
    super(); this.name = 'setup-progress'; this.visible = false;
    const background = surfaces.create(this.width, this.height); background.name = 'setup-progress-background'; background.position.y = this.centerY;
    this.hitArea.name = 'setup-progress-hit-area'; this.hitArea.position.y = this.centerY; this.add(this.hitArea);
    this.title.name = 'setup-progress-title'; this.title.position.set(-0.18, 0.067, THEME.panel.depth);
    this.detail.name = 'setup-progress-detail'; this.detail.position.set(-0.18, -0.037, THEME.panel.depth);
    this.artifactLabel.name = 'setup-artifact-label'; this.artifactLabel.position.set(-0.18, -0.09, THEME.panel.depth);
    this.code.name = 'setup-artifact-code'; this.code.position.set(-0.18, -0.109, THEME.panel.depth);
    this.facts.name = 'setup-progress-facts'; this.facts.position.set(-0.18, -0.176, THEME.panel.depth);
    this.source.name = 'setup-progress-source'; this.source.position.set(-0.18, -0.231, THEME.panel.depth);
    this.add(background, this.title, this.detail, this.artifactLabel, this.code, this.facts, this.source);
    for (let i = 0; i < 6; i++) {
      const group = new Group(); group.position.set((i % 3 - 1) * 0.123, 0.028 - Math.floor(i / 3) * 0.032, THEME.panel.depth);
      const label = makeText({ text: '', size: 0.013, anchorX: 'center', singleLine: true, maxWidth: 0.112 });
      group.add(label); this.add(group); this.stages.push({ group, label });
    }
    this.action.name = 'setup-progress-cancel'; this.action.position.set(0, -0.291, THEME.panel.depth);
    const button = surfaces.create(this.actionWidth, THEME.control.buttonHeight, 'button', true); button.name = 'button-plate';
    this.actionLabel.position.z = THEME.panel.depth; this.action.add(button, this.actionLabel); this.add(this.action);
  }

  setState(view: SetupProgressView | null, working = view?.working ?? false): void {
    this.visible = !!view;
    this.setWorking(working);
    this.userData.cardId = view?.cardId; this.userData.runId = view?.runId;
    setText(this.title, view?.title ?? '');
    setText(this.detail, assistantLines(view?.detail ?? '', 46, 2));
    for (let i = 0; i < this.stages.length; i++) {
      const slot = this.stages[i]!, stage = view?.stages[i];
      slot.group.visible = !!stage; slot.group.name = `setup-stage-${stage?.id ?? i}`;
      slot.group.userData.status = stage?.status;
      const prefix = stage?.status === 'done' ? '+ ' : stage?.status === 'active' ? '> ' : stage?.status === 'failed' ? '! ' : '';
      const color = stage?.status === 'failed' ? '#FDA4AF' : stage?.status === 'active' ? THEME.color.accent : stage?.status === 'done' ? '#A7F3D0' : THEME.color.muted;
      setText(slot.label, `${prefix}${stage?.label ?? ''}`, color);
    }
    const artifact = view?.artifact;
    setText(this.artifactLabel, artifact?.label ?? ''); setText(this.code, artifactExcerpt(artifact?.code ?? ''));
    this.artifactLabel.visible = this.code.visible = !!artifact?.code;
    setText(this.facts, assistantLines((view?.facts ?? []).slice(0, 2).join(' · '), 46, 2));
    setText(this.source, view?.source ?? '');
  }

  setWorking(working: boolean): void {
    this.userData.working = working;
    this.action.name = working ? 'setup-progress-cancel' : 'setup-progress-retry';
    setText(this.actionLabel, working ? 'Cancel' : 'Try again');
  }
}
