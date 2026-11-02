import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, ShaderMaterial, Vector3, Vector4 } from 'three';
import type { HomeState, HudFrame } from '../contract';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';
import { DockHold, type FingerMenuFinger } from './hand-dock';

type Icon = 'tag' | 'sliders' | 'grid' | 'bulb' | 'plug' | 'stop' | 'exit';
type Point = readonly [number, number];
function textOpacity(label: SdfText, opacity: number): void {
  (label as SdfText & { fillOpacity: number }).fillOpacity = opacity;
}
interface ButtonSpec { name: string; label: string; icon: Icon; finger?: FingerMenuFinger }
const DIAMETER = 0.032, GAP = 0.012, GLYPH_SCALE = 0.009;
const FINGER_DIAMETER = 0.024;
const MAX_PARTS = 7; // Six buttons including Exit, and the count badge.
const EXIT_BUTTON: ButtonSpec = { name: 'exit-ar', label: 'Exit AR (hold)', icon: 'exit' };
const MODE_BUTTONS: ButtonSpec[] = [
  { name: 'mode-annotate', label: 'Annotate', icon: 'tag' },
  { name: 'mode-control', label: 'Control', icon: 'sliders' },
];
const FILTER_BUTTONS: ButtonSpec[] = [
  { name: 'filter:everything', label: 'All devices', icon: 'grid' },
  { name: 'filter:lights', label: 'Lights', icon: 'bulb' },
  { name: 'filter:electronics', label: 'Electronics', icon: 'plug' },
];

/** Small line icons triangulated once, with no font or canvas dependency. */
function iconVertices(icon: Icon): number[] {
  const vertices: number[] = [];
  const stroke = (points: readonly Point[], closed = false, width = 0.13) => {
    for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
      const [ax, ay] = points[i]!, [bx, by] = points[(i + 1) % points.length]!;
      const length = Math.hypot(bx - ax, by - ay), x = -(by - ay) / length * width / 2, y = (bx - ax) / length * width / 2;
      vertices.push(ax + x, ay + y, 0, ax - x, ay - y, 0, bx + x, by + y, 0,
        bx + x, by + y, 0, ax - x, ay - y, 0, bx - x, by - y, 0);
    }
  };
  const ring = (x: number, y: number, radius: number, segments = 16) => stroke(Array.from({ length: segments }, (_, i): Point => [x + Math.cos(i / segments * Math.PI * 2) * radius, y + Math.sin(i / segments * Math.PI * 2) * radius]), true);
  const rect = (x: number, y: number, w: number, h: number) => stroke([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
  switch (icon) {
    case 'tag':
      stroke([[-0.78, 0.12], [-0.78, 0.7], [-0.2, 0.7], [0.78, -0.28], [0.16, -0.9]], true);
      ring(-0.45, 0.38, 0.1, 10);
      break;
    case 'sliders':
      stroke([[-0.82, 0.42], [-0.48, 0.42]]); stroke([[-0.12, 0.42], [0.82, 0.42]]);
      stroke([[-0.82, -0.42], [0.12, -0.42]]); stroke([[0.48, -0.42], [0.82, -0.42]]);
      rect(-0.48, 0.14, 0.36, 0.56); rect(0.12, -0.7, 0.36, 0.56);
      break;
    case 'grid':
      for (const x of [-0.72, 0.17]) for (const y of [-0.72, 0.17]) rect(x, y, 0.55, 0.55);
      break;
    case 'bulb': {
      const arc = Array.from({ length: 19 }, (_, i): Point => {
        const angle = -Math.PI / 5 + i / 18 * Math.PI * 1.4;
        return [Math.cos(angle) * 0.63, 0.25 + Math.sin(angle) * 0.63];
      });
      stroke([[0.24, -0.5], ...arc, [-0.24, -0.5], [0.24, -0.5]]);
      stroke([[-0.22, -0.73], [0.22, -0.73]]); stroke([[-0.13, -0.9], [0.13, -0.9]]);
      break;
    }
    case 'plug':
      stroke([[-0.34, 0.88], [-0.34, 0.32]]); stroke([[0.34, 0.88], [0.34, 0.32]]);
      stroke([[-0.64, 0.3], [0.64, 0.3]]);
      stroke([[-0.53, 0.3], [-0.53, -0.1], [-0.3, -0.42], [0.3, -0.42], [0.53, -0.1], [0.53, 0.3]]);
      stroke([[0, -0.42], [0, -0.84]]);
      break;
    case 'stop':
      stroke(Array.from({ length: 8 }, (_, i): Point => [Math.cos(Math.PI / 8 + i * Math.PI / 4) * 0.87, Math.sin(Math.PI / 8 + i * Math.PI / 4) * 0.87]), true);
      break;
    case 'exit':
      stroke([[0.1, 0.83], [-0.72, 0.83], [-0.72, -0.83], [0.1, -0.83]]);
      stroke([[-0.22, 0], [0.9, 0]]);
      stroke([[0.48, 0.42], [0.9, 0], [0.48, -0.42]]);
      break;
  }
  return vertices;
}

const ICONS = Object.fromEntries(['tag', 'sliders', 'grid', 'bulb', 'plug', 'stop', 'exit'].map((icon) => [icon, iconVertices(icon as Icon)])) as Record<Icon, number[]>;
const vertexShader = `
  attribute float part;
  uniform vec4 transforms[${MAX_PARTS}];
  uniform vec3 states[${MAX_PARTS}];
  uniform float holdProgress, holdPart;
  varying vec2 local;
  varying vec3 state;
  varying float hold;
  void main() {
    int i = int(part);
    vec4 transform = transforms[i];
    local = uv * 2.0 - 1.0;
    state = states[i];
    hold = abs(part - holdPart) < 0.5 ? holdProgress : 0.0;
    vec3 p = position * transform.w + transform.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

/** Two batched meshes draw the icons; finger labels stay visible beside their targets. */
export class DockIcons extends Group {
  readonly buttons: Group[] = [];
  readonly wrist = new Group();
  get height(): number { return this.fingerMenu ? FINGER_DIAMETER : DIAMETER; }
  fingerMenu = false;
  private readonly transforms = Array.from({ length: MAX_PARTS }, () => new Vector4());
  private readonly states = Array.from({ length: MAX_PARTS }, () => new Vector3());
  private readonly discGeometry = new BufferGeometry();
  private readonly glyphGeometry = new BufferGeometry();
  private readonly discMaterial = this.material(`
    float d = length(local) - 1.0;
    float aa = max(fwidth(d), 0.0001);
    float cover = 1.0 - smoothstep(-aa, 0.0, d);
    float badge = step(1.5, state.x);
    float selected = step(0.5, state.x);
    float highlight = max(state.y, state.z);
    vec3 fill = mix(plate, accent, selected);
    fill = mix(fill, accent, highlight * 0.45);
    float fillAlpha = mix(0.84, 0.18, selected);
    fillAlpha = mix(fillAlpha, 0.48, state.z);
    fillAlpha = mix(fillAlpha, 1.0, badge);
    float edgeAlpha = mix(0.16, 1.0, highlight);
    float border = smoothstep(-0.038 - aa, -0.038, d) * edgeAlpha;
    float angle = fract(atan(local.x, local.y) / 6.2831853 + 1.0);
    float progressRing = smoothstep(-0.13 - aa, -0.13, d) * step(angle, hold) * step(0.00001, hold);
    border = max(border, progressRing);
    float alpha = fillAlpha + border * (1.0 - fillAlpha);
    vec3 edge = mix(white, accent, max(max(selected, highlight), progressRing));
    vec3 color = (fill * fillAlpha * (1.0 - border) + edge * border) / max(alpha, 0.00001);
    gl_FragColor = vec4(color, alpha * cover * opacity);
  `);
  private readonly glyphMaterial = this.material('gl_FragColor = vec4(mix(white, accent, max(step(0.5, state.x), state.z)), opacity);');
  private readonly discs = new Mesh(this.discGeometry, this.discMaterial);
  private readonly glyphs = new Mesh(this.glyphGeometry, this.glyphMaterial);
  private readonly hoverLabel = makeText({ text: '', size: 0.011, anchorX: 'center', singleLine: true, maxWidth: 0.15 });
  private readonly badge = makeText({ text: '', size: 0.007, color: THEME.color.plate, weight: 600, tabular: true, anchorX: 'center', singleLine: true, maxWidth: 0.011 });
  private readonly wristMaterial = new MeshBasicMaterial({ color: THEME.color.text, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false });
  private readonly wristLabel = makeText({ text: 'Annotate', size: 0.011, anchorX: 'center', singleLine: true, maxWidth: 0.075 });
  private readonly fingerHint = makeText({ text: 'Touch your thumb to a finger', size: 0.011, anchorX: 'center', singleLine: true, maxWidth: 0.19 });
  private hintShown = false;
  private hintUntil = 0;
  private session: XRSession | undefined;
  private readonly fingerPositions = new Map<FingerMenuFinger, Vector3>();
  private readonly destination = new Vector3();
  private readonly direction = new Vector3();
  private readonly wristGlyph = new Mesh(new BufferGeometry(), this.wristMaterial);
  private structure = '';
  private wristMode = '';
  private taggedCount = 0;
  private opacity = 1;
  private readonly exitHold = new DockHold();
  private exitButton: Group | undefined;

  constructor() {
    super();
    this.name = 'hand-dock'; this.wrist.name = 'wrist-mode';
    this.discs.name = 'dock-discs'; this.glyphs.name = 'dock-glyphs';
    this.hoverLabel.name = 'dock-label'; this.badge.name = 'dock-count';
    this.discs.renderOrder = THEME.render.plates;
    this.glyphs.renderOrder = this.wristGlyph.renderOrder = THEME.render.text;
    this.discs.frustumCulled = this.glyphs.frustumCulled = false;
    this.hoverLabel.position.set(0, 0.03, 0.003);
    this.badge.position.z = 0.003;
    this.add(this.discs, this.glyphs, this.hoverLabel, this.badge);
    this.wristLabel.name = 'wrist-mode-label';
    this.wristLabel.position.set(0, -0.016, 0.002);
    this.wrist.add(this.wristGlyph, this.wristLabel);
    this.fingerHint.name = 'finger-menu-hint';
    this.fingerHint.visible = false;
    this.add(this.fingerHint);
    this.wristGlyph.scale.setScalar(0.0068);
    this.discGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(MAX_PARTS * 18), 3));
    this.discGeometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(MAX_PARTS * 12), 2));
    this.discGeometry.setAttribute('part', new Float32BufferAttribute(new Float32Array(MAX_PARTS * 6), 1));
    const glyphVertices = Object.values(ICONS).reduce((sum, icon) => sum + icon.length / 3, 0);
    this.glyphGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(glyphVertices * 3), 3));
    this.glyphGeometry.setAttribute('part', new Float32BufferAttribute(new Float32Array(glyphVertices), 1));
    this.glyphGeometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(glyphVertices * 2), 2));
    this.setWrist('annotate', 0);
    this.setState({ mode: 'annotate', filter: 'everything', tagged: 0, status: '' }, false);
  }

  get width(): number { return this.buttons.length * (DIAMETER + GAP) - GAP; }

  private material(fragment: string): ShaderMaterial {
    return new ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: {
        transforms: { value: this.transforms }, states: { value: this.states }, opacity: { value: 1 },
        holdProgress: { value: 0 }, holdPart: { value: -1 },
        white: { value: new Color(THEME.color.text) }, accent: { value: new Color(THEME.color.accent) }, plate: { value: new Color(THEME.color.plate) },
      },
      vertexShader,
      fragmentShader: `varying vec2 local; varying vec3 state; varying float hold; uniform vec3 white, accent, plate; uniform float opacity;
        void main() { ${fragment} \n #include <colorspace_fragment> \n }`,
    });
  }

  setState(home: HomeState, canStop: boolean, fingerMenu = this.fingerMenu): void {
    if (fingerMenu !== this.fingerMenu) this.fingerPositions.clear();
    this.fingerMenu = fingerMenu;
    const stop = home.mode === 'control' && canStop;
    const structure = `${fingerMenu}/${home.mode}/${stop}/${fingerMenu ? home.filter : ''}`;
    this.taggedCount = home.tagged;
    if (structure !== this.structure) {
      this.structure = structure;
      this.cancelExitHold();
      const previous = new Map(this.buttons.map((button) => [button.userData.finger, button]));
      for (const button of this.buttons) {
        const label = button.children[0] as SdfText | undefined;
        label?.dispose(); this.remove(button);
      }
      this.buttons.length = 0;
      this.exitButton = undefined;
      const specs: ButtonSpec[] = fingerMenu ? [
        { ...MODE_BUTTONS[home.mode === 'annotate' ? 1 : 0]!, finger: 'middle' },
        ...(home.mode === 'annotate' ? [{
          name: `filter:${home.filter === 'everything' ? 'lights' : home.filter === 'lights' ? 'electronics' : 'everything'}`,
          label: home.filter === 'everything' ? 'All' : home.filter === 'lights' ? 'Lights' : 'Electronics',
          icon: FILTER_BUTTONS.find((spec) => spec.name === `filter:${home.filter}`)!.icon, finger: 'ring' as const,
        }] : stop ? [{ name: 'deck:panic', label: 'Stop', icon: 'stop' as const, finger: 'ring' as const }] : []),
        { ...EXIT_BUTTON, label: 'Hold to exit', finger: 'pinky' },
      ] : [...MODE_BUTTONS, ...(home.mode === 'annotate' ? FILTER_BUTTONS : []), ...(stop ? [{ name: 'deck:panic', label: 'Stop everything', icon: 'stop' as const }] : []), EXIT_BUTTON];
      for (const finger of this.fingerPositions.keys()) {
        if (!specs.some((spec) => spec.finger === finger)) this.fingerPositions.delete(finger);
      }
      for (const [index, spec] of specs.entries()) {
        const button = new Group();
        button.name = spec.name;
        button.position.x = (index - (specs.length - 1) / 2) * (DIAMETER + GAP);
        button.userData = { dockIcon: true, label: spec.label, finger: spec.finger };
        if (spec.finger) {
          const old = previous.get(spec.finger);
          button.visible = old?.visible ?? false;
          if (old) { button.position.copy(old.position); button.scale.copy(old.scale); button.userData.near = old.userData.near; }
          const label = makeText({ text: spec.label, size: 0.008, anchorX: 'center', singleLine: true, maxWidth: 0.062 });
          label.name = `finger-label:${spec.finger}`;
          label.position.set(0, 0.022, 0.002);
          button.add(label);
        }
        this.buttons.push(button); this.add(button);
        if (spec.name === 'exit-ar') {
          this.exitButton = button;
          button.userData.holdProgress = 0;
          this.discMaterial.uniforms.holdPart!.value = index;
        }
      }
      this.rebuildGeometry(specs);
    }
    for (const button of this.buttons) {
      button.userData.selected = !fingerMenu && (button.name === `mode-${home.mode}` || button.name === `filter:${home.filter}`);
      if (!fingerMenu && button.name === 'mode-control') button.userData.label = home.tagged > 0 ? `Control · ${home.tagged}` : 'Control';
    }
    setText(this.badge, home.tagged > 99 ? '99+' : String(home.tagged));
    this.updateFeedback(this.opacity);
  }

  private rebuildGeometry(specs: ButtonSpec[]): void {
    const discs: number[] = [], discParts: number[] = [], uv: number[] = [], glyphs: number[] = [], glyphParts: number[] = [];
    for (let index = 0; index <= specs.length; index++) {
      const radius = index === specs.length ? 0.0055 : (this.fingerMenu ? FINGER_DIAMETER : DIAMETER) / 2;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
        discs.push(x! * radius, y! * radius, index === specs.length ? 0.002 : 0);
        uv.push((x! + 1) / 2, (y! + 1) / 2); discParts.push(index);
      }
      const spec = specs[index];
      if (spec) for (let i = 0; i < ICONS[spec.icon].length; i += 3) {
        glyphs.push(ICONS[spec.icon][i]! * GLYPH_SCALE * (this.fingerMenu ? 0.75 : 1), ICONS[spec.icon][i + 1]! * GLYPH_SCALE * (this.fingerMenu ? 0.75 : 1), 0.001);
        glyphParts.push(index);
      }
    }
    for (const [geometry, name, values] of [
      [this.discGeometry, 'position', discs], [this.discGeometry, 'uv', uv], [this.discGeometry, 'part', discParts],
      [this.glyphGeometry, 'position', glyphs], [this.glyphGeometry, 'part', glyphParts],
    ] as const) {
      const attribute = geometry.getAttribute(name);
      attribute.array.set(values); attribute.needsUpdate = true;
    }
    this.discGeometry.setDrawRange(0, discs.length / 3);
    this.glyphGeometry.setDrawRange(0, glyphs.length / 3);
  }

  updateFeedback(opacity: number): void {
    this.opacity = Math.min(1, Math.max(0, opacity));
    this.discMaterial.uniforms.opacity!.value = this.glyphMaterial.uniforms.opacity!.value = this.opacity;
    let hover: Group | undefined;
    for (let index = 0; index < this.buttons.length; index++) {
      const button = this.buttons[index]!;
      const { selected, hovered, pressed } = button.userData;
      this.transforms[index]!.set(button.position.x, button.position.y, button.position.z, button.visible ? button.scale.x : 0);
      const label = button.children[0] as SdfText | undefined;
      if (label) textOpacity(label, this.opacity);
      this.states[index]!.set(Number(!!selected), Number(!!hovered || !!button.userData.near), Number(!!pressed));
      if (hovered) hover = button;
    }
    const control = this.buttons[1]!;
    const badgeX = control.position.x + 0.012, badgeY = control.position.y + 0.012;
    this.transforms[this.buttons.length]!.set(badgeX, badgeY, 0, !this.fingerMenu && this.taggedCount > 0 ? control.scale.x : 0);
    this.states[this.buttons.length]!.set(2, 0, 0);
    this.badge.position.set(badgeX, badgeY, 0.003);
    this.badge.visible = !this.fingerMenu && this.taggedCount > 0 && this.opacity > 0;
    this.hoverLabel.visible = !this.fingerMenu && !!hover && this.opacity > 0;
    if (hover) {
      setText(this.hoverLabel, hover.userData.label as string);
      this.hoverLabel.position.x = hover.position.x;
    }
    textOpacity(this.hoverLabel, this.opacity);
    textOpacity(this.badge, this.opacity);
  }

  /** Targets remain on the live fingertips, even during a poke or a thumb contact. */
  updateFingers(frame: HudFrame, side: 'left' | 'right', open: boolean): void {
    const session = frame.frame?.session;
    if (session !== this.session) {
      this.session = session; this.hintShown = false; this.hintUntil = 0;
    }
    this.fingerHint.visible = false;
    if (!this.fingerMenu) return;
    const hand = frame.hands[side], wrist = hand?.joints.wrist;
    if (open && !this.hintShown) { this.hintShown = true; this.hintUntil = frame.time + 3000; }
    this.updateWorldMatrix(true, false);
    for (const button of this.buttons) {
      const finger = button.userData.finger as FingerMenuFinger;
      const tip = hand?.joints[`${finger}-finger-tip`];
      button.visible = !!tip && !!wrist;
      if (!tip || !wrist) { this.fingerPositions.delete(finger); continue; }
      this.direction.subVectors(tip.position, wrist.position).normalize();
      this.destination.copy(tip.position).addScaledVector(this.direction, 0.02);
      let position = this.fingerPositions.get(finger);
      if (!position) { position = this.destination.clone(); this.fingerPositions.set(finger, position); }
      else position.lerp(this.destination, 1 - Math.exp(-Math.max(0, frame.dt) / 0.08));
      button.position.copy(position);
      this.worldToLocal(button.position);
    }
    // Lift colliding labels into separate rows; the icons still follow their own fingertips.
    for (let index = 0; index < this.buttons.length; index++) {
      const button = this.buttons[index]!, label = button.children[0] as SdfText;
      if (!button.visible) continue;
      let y = button.position.y + 0.022;
      const width = String(button.userData.label).length * 0.005 + 0.004;
      for (let pass = 0; pass < index; pass++) for (let before = 0; before < index; before++) {
        const other = this.buttons[before]!;
        if (!other.visible) continue;
        const otherLabel = other.children[0] as SdfText;
        const otherY = other.position.y + otherLabel.position.y * other.scale.y;
        const otherWidth = String(other.userData.label).length * 0.005 + 0.004;
        if (Math.abs(button.position.x - other.position.x) < (width + otherWidth) / 2 && Math.abs(y - otherY) < 0.014) y = otherY + 0.014;
      }
      label.position.y = (y - button.position.y) / button.scale.y;
    }
    if (wrist) {
      this.fingerHint.position.copy(wrist.position);
      this.worldToLocal(this.fingerHint.position);
      this.fingerHint.position.y -= 0.055;
      this.fingerHint.position.z += 0.004;
    }
    this.fingerHint.visible = open && !!wrist && frame.time < this.hintUntil;
    textOpacity(this.fingerHint, this.opacity);
  }

  beginExitHold(time: number): void { this.exitHold.begin(time); }

  cancelExitHold(): void {
    this.exitHold.cancel();
    this.discMaterial.uniforms.holdProgress!.value = 0;
    if (this.exitButton) this.exitButton.userData.holdProgress = 0;
  }

  /** Updates the existing disc shader: progress adds no geometry or draw call. */
  updateExitHold(time: number): boolean {
    const complete = this.exitHold.update(time);
    this.discMaterial.uniforms.holdProgress!.value = this.exitHold.progress;
    if (this.exitButton) this.exitButton.userData.holdProgress = this.exitHold.progress;
    return complete;
  }

  setWrist(mode: HomeState['mode'], opacity: number): void {
    if (mode !== this.wristMode) {
      this.wristMode = mode;
      setText(this.wristLabel, mode === 'annotate' ? 'Annotate' : 'Control');
      this.wristGlyph.geometry.setAttribute('position', new Float32BufferAttribute(ICONS[mode === 'annotate' ? 'tag' : 'sliders'], 3));
    }
    this.wrist.visible = opacity > 0;
    this.wristMaterial.opacity = Math.min(0.6, Math.max(0, opacity));
    textOpacity(this.wristLabel, this.wristMaterial.opacity);
  }

  override dispose(): void {
    this.discGeometry.dispose(); this.glyphGeometry.dispose(); this.wristGlyph.geometry.dispose();
    this.discMaterial.dispose(); this.glyphMaterial.dispose(); this.wristMaterial.dispose();
    this.removeFromParent(); this.wrist.removeFromParent();
  }
}
