import { CircleGeometry, Group, Mesh, MeshBasicMaterial, Shape, ShapeGeometry } from 'three';
import type { HelperPairingView, HudFrame } from '../contract';
import { GlassSurfaces } from './surface';
import { makeText, setText } from './text';
import { THEME } from './theme';
import { WorldPanel } from './world-panel';

export const HELPER_PAIRING_TARGET = '__helper__';

export function pairingUrlText(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** A single world anchor stays still while the wearer looks between the card and laptop. */
export class HelperPairingCard extends Group {
  readonly typeCode: Group;
  readonly skip: Group;
  readonly width = 0.52;
  readonly height = 0.35;
  readonly buttonWidth = 0.19;
  private readonly placement = new WorldPanel({ distance: 0.85, height: -0.08 });
  private readonly heading = makeText({ text: 'Pair a helper device', size: THEME.font.title, weight: 600, anchorX: 'center', maxWidth: 0.47, singleLine: true });
  private readonly body = makeText({ text: 'On your laptop, open', anchorX: 'center', color: THEME.color.muted });
  private readonly url = makeText({ text: '', size: 0.025, mono: true, anchorX: 'center', maxWidth: 0.47, singleLine: true });
  private readonly alternative = makeText({ text: '', size: THEME.font.detail, color: THEME.color.muted, anchorX: 'center', maxWidth: 0.47, singleLine: true });
  private readonly status = makeText({ text: 'Looking for the QR code…', size: THEME.font.body, anchorX: 'center', maxWidth: 0.44, singleLine: true });
  private readonly pulseMaterial = new MeshBasicMaterial({ color: THEME.color.accent, transparent: true, depthWrite: false, toneMapped: false });
  private readonly pulseGeometry = new CircleGeometry(0.003, 16);
  private readonly pulse = new Mesh(this.pulseGeometry, this.pulseMaterial);
  private readonly checkGeometry: ShapeGeometry;
  private readonly check: Mesh;
  private state: HelperPairingView | null = null;

  constructor(surfaces: GlassSurfaces) {
    super();
    this.name = 'helper-pairing';
    this.visible = false;
    this.heading.name = 'helper-pairing-title'; this.heading.position.set(0, 0.125, THEME.panel.depth);
    this.body.name = 'helper-pairing-body'; this.body.position.set(0, 0.076, THEME.panel.depth);
    this.url.name = 'helper-pairing-url'; this.url.position.set(0, 0.035, THEME.panel.depth);
    this.alternative.name = 'helper-pairing-alternative'; this.alternative.position.set(0, -0.005, THEME.panel.depth);
    this.status.name = 'helper-pairing-status'; this.status.position.set(0.006, -0.056, THEME.panel.depth);
    this.pulse.name = 'helper-pairing-pulse'; this.pulse.position.set(-0.126, -0.056, THEME.panel.depth);
    this.pulse.renderOrder = THEME.render.text;
    const shape = new Shape();
    shape.moveTo(-0.011, 0); shape.lineTo(-0.003, -0.008); shape.lineTo(0.014, 0.011);
    shape.lineTo(0.011, 0.014); shape.lineTo(-0.003, -0.002); shape.lineTo(-0.008, 0.003);
    this.checkGeometry = new ShapeGeometry(shape);
    this.check = new Mesh(this.checkGeometry, this.pulseMaterial);
    this.check.name = 'helper-pairing-check'; this.check.position.set(0, 0.045, THEME.panel.depth);
    this.check.renderOrder = THEME.render.text;
    const step = makeText({ text: '1 of 3 · Pair or skip', size: 0.012, anchorX: 'center', color: THEME.color.muted });
    step.name = 'helper-pairing-step'; step.position.set(0, -0.158, THEME.panel.depth); this.add(step);
    this.typeCode = this.button(surfaces, 'helper-type-code', 'Type code', -0.105);
    this.skip = this.button(surfaces, 'helper-skip', 'Skip for now', 0.105);
    this.add(surfaces.create(this.width, this.height), this.heading, this.body, this.url, this.alternative, this.status, this.pulse, this.check, this.typeCode, this.skip);
  }

  private button(surfaces: GlassSurfaces, name: string, text: string, x: number): Group {
    const button = new Group();
    button.name = name; button.position.set(x, -0.122, THEME.panel.depth);
    const plate = surfaces.create(this.buttonWidth, THEME.control.buttonHeight, 'button', true);
    plate.name = 'button-plate';
    const label = makeText({ text, weight: 500, anchorX: 'center', maxWidth: this.buttonWidth - 0.02, singleLine: true });
    label.position.z = THEME.panel.depth;
    button.add(plate, label);
    return button;
  }

  setState(state: HelperPairingView | null): void {
    if (state && !this.state) this.placement.reset();
    this.state = state;
    this.visible = !!state;
    if (!state) return;
    const paired = !!state.pairedName;
    this.userData.phase = paired ? 'paired' : 'scanning';
    setText(this.heading, paired ? `Paired with ${state.pairedName}` : 'Pair a helper device');
    setText(this.url, pairingUrlText(state.urls[0] ?? ''));
    setText(this.alternative, state.urls[1] ? `or ${pairingUrlText(state.urls[1])}` : '');
    for (const object of [this.body, this.url, this.alternative, this.status, this.pulse, this.typeCode, this.skip]) object.visible = !paired;
    this.check.visible = paired;
    this.pulseMaterial.opacity = 1;
  }

  update(frame: Pick<HudFrame, 'head' | 'time'>): void {
    if (!this.visible) return;
    this.placement.update(this, frame.head, frame.time);
    if (!this.state?.pairedName) this.pulseMaterial.opacity = 0.48 + 0.25 * (1 + Math.sin(frame.time / 650));
  }

  override dispose(): void {
    this.pulseGeometry.dispose(); this.checkGeometry.dispose(); this.pulseMaterial.dispose();
  }
}
