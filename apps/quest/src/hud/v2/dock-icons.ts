import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, ShaderMaterial, Vector3 } from 'three';
import type { HomeState } from '../contract';
import { makeText, setText, type SdfText } from './text';
import { THEME } from './theme';

type Icon = 'tag' | 'sliders' | 'grid' | 'bulb' | 'plug' | 'stop';
type Point = readonly [number, number];
interface ButtonSpec { name: string; label: string; icon: Icon }
const DIAMETER = 0.032, GAP = 0.008, GLYPH_SCALE = 0.009;
const MAX_PARTS = 7; // Six buttons and the count badge.
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
  }
  return vertices;
}

const ICONS = Object.fromEntries(['tag', 'sliders', 'grid', 'bulb', 'plug', 'stop'].map((icon) => [icon, iconVertices(icon as Icon)])) as Record<Icon, number[]>;
const vertexShader = `
  attribute float part;
  uniform vec3 transforms[${MAX_PARTS}];
  uniform vec3 states[${MAX_PARTS}];
  varying vec2 local;
  varying vec3 state;
  void main() {
    int i = int(part);
    vec3 transform = transforms[i];
    local = uv * 2.0 - 1.0;
    state = states[i];
    vec3 p = vec3(position.xy * transform.z + transform.xy, position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

/** Two batched meshes draw every disc and vector icon; text appears only on demand. */
export class DockIcons extends Group {
  readonly buttons: Group[] = [];
  readonly wrist = new Group();
  readonly height = DIAMETER;
  private readonly transforms = Array.from({ length: MAX_PARTS }, () => new Vector3());
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
    float fillAlpha = mix(0.84, 0.18, selected);
    fillAlpha = mix(fillAlpha, 0.48, state.z);
    fillAlpha = mix(fillAlpha, 1.0, badge);
    float edgeAlpha = mix(0.16, 1.0, highlight);
    float border = smoothstep(-0.038 - aa, -0.038, d) * edgeAlpha;
    float alpha = fillAlpha + border * (1.0 - fillAlpha);
    vec3 edge = mix(white, accent, max(selected, highlight));
    vec3 color = (fill * fillAlpha * (1.0 - border) + edge * border) / max(alpha, 0.00001);
    gl_FragColor = vec4(color, alpha * cover * opacity);
  `);
  private readonly glyphMaterial = this.material('gl_FragColor = vec4(mix(white, accent, step(0.5, state.x)), opacity);');
  private readonly discs = new Mesh(this.discGeometry, this.discMaterial);
  private readonly glyphs = new Mesh(this.glyphGeometry, this.glyphMaterial);
  private readonly hoverLabel = makeText({ text: '', size: 0.011, anchorX: 'center', singleLine: true, maxWidth: 0.15 });
  private readonly badge = makeText({ text: '', size: 0.007, color: THEME.color.plate, weight: 600, tabular: true, anchorX: 'center', singleLine: true, maxWidth: 0.011 });
  private readonly wristMaterial = new MeshBasicMaterial({ color: THEME.color.text, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false });
  private readonly wristGlyph = new Mesh(new BufferGeometry(), this.wristMaterial);
  private structure = '';
  private wristMode = '';
  private taggedCount = 0;
  private opacity = 1;

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
    this.wrist.add(this.wristGlyph);
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
        white: { value: new Color(THEME.color.text) }, accent: { value: new Color(THEME.color.accent) }, plate: { value: new Color(THEME.color.plate) },
      },
      vertexShader,
      fragmentShader: `varying vec2 local; varying vec3 state; uniform vec3 white, accent, plate; uniform float opacity;
        void main() { ${fragment} \n #include <colorspace_fragment> \n }`,
    });
  }

  setState(home: HomeState, canStop: boolean): void {
    const stop = home.mode === 'control' && canStop;
    const structure = `${home.mode}/${stop}`;
    this.taggedCount = home.tagged;
    if (structure !== this.structure) {
      this.structure = structure;
      for (const button of this.buttons) this.remove(button);
      this.buttons.length = 0;
      const specs = [...MODE_BUTTONS, ...(home.mode === 'annotate' ? FILTER_BUTTONS : []), ...(stop ? [{ name: 'deck:panic', label: 'Stop everything', icon: 'stop' as const }] : [])];
      for (const [index, spec] of specs.entries()) {
        const button = new Group();
        button.name = spec.name;
        button.position.x = (index - (specs.length - 1) / 2) * (DIAMETER + GAP);
        button.userData = { dockIcon: true, label: spec.label };
        this.buttons.push(button); this.add(button);
      }
      this.rebuildGeometry(specs);
    }
    for (const button of this.buttons) {
      button.userData.selected = button.name === `mode-${home.mode}` || button.name === `filter:${home.filter}`;
      if (button.name === 'mode-control') button.userData.label = home.tagged > 0 ? `Control · ${home.tagged}` : 'Control';
    }
    setText(this.badge, home.tagged > 99 ? '99+' : String(home.tagged));
    this.updateFeedback(this.opacity);
  }

  private rebuildGeometry(specs: ButtonSpec[]): void {
    const discs: number[] = [], discParts: number[] = [], uv: number[] = [], glyphs: number[] = [], glyphParts: number[] = [];
    for (let index = 0; index <= specs.length; index++) {
      const radius = index === specs.length ? 0.0055 : DIAMETER / 2;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
        discs.push(x! * radius, y! * radius, index === specs.length ? 0.002 : 0);
        uv.push((x! + 1) / 2, (y! + 1) / 2); discParts.push(index);
      }
      const spec = specs[index];
      if (spec) for (let i = 0; i < ICONS[spec.icon].length; i += 3) {
        glyphs.push(ICONS[spec.icon][i]! * GLYPH_SCALE, ICONS[spec.icon][i + 1]! * GLYPH_SCALE, 0.001);
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
    for (const [index, button] of this.buttons.entries()) {
      const { selected, hovered, pressed } = button.userData;
      this.transforms[index]!.set(button.position.x, button.position.y, button.scale.x);
      this.states[index]!.set(Number(!!selected), Number(!!hovered), Number(!!pressed));
      if (hovered) hover = button;
    }
    const control = this.buttons[1]!;
    const badgeX = control.position.x + 0.012, badgeY = control.position.y + 0.012;
    this.transforms[this.buttons.length]!.set(badgeX, badgeY, this.taggedCount > 0 ? control.scale.x : 0);
    this.states[this.buttons.length]!.set(2, 0, 0);
    this.badge.position.set(badgeX, badgeY, 0.003);
    this.badge.visible = this.taggedCount > 0 && this.opacity > 0;
    this.hoverLabel.visible = !!hover && this.opacity > 0;
    if (hover) {
      setText(this.hoverLabel, hover.userData.label as string);
      this.hoverLabel.position.x = hover.position.x;
    }
    for (const label of [this.hoverLabel, this.badge]) (label as SdfText & { fillOpacity: number }).fillOpacity = this.opacity;
  }

  setWrist(mode: HomeState['mode'], opacity: number): void {
    if (mode !== this.wristMode) {
      this.wristMode = mode;
      this.wristGlyph.geometry.setAttribute('position', new Float32BufferAttribute(ICONS[mode === 'annotate' ? 'tag' : 'sliders'], 3));
    }
    this.wrist.visible = opacity > 0;
    this.wristMaterial.opacity = Math.min(0.6, Math.max(0, opacity));
  }

  override dispose(): void {
    this.discGeometry.dispose(); this.glyphGeometry.dispose(); this.wristGlyph.geometry.dispose();
    this.discMaterial.dispose(); this.glyphMaterial.dispose(); this.wristMaterial.dispose();
    this.removeFromParent(); this.wrist.removeFromParent();
  }
}
