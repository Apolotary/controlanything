import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { THEME } from './theme';

const RING_SEGMENTS = 24, DOT_SEGMENTS = 12;
const VERTICES = RING_SEGMENTS * 2 + DOT_SEGMENTS + 1 + 4;
const INDICES = RING_SEGMENTS * 6 + DOT_SEGMENTS * 3 + 6;
const up = new Vector3(0, 1, 0);

/** All quiet rings, status dots and short stems share one draw call. */
export class ChipMarkers extends Mesh<BufferGeometry, MeshBasicMaterial> {
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private alpha = new Float32Array(0);
  private opacity = 1;
  private readonly right = new Vector3();
  private readonly direction = new Vector3();
  private readonly ring = new Color(THEME.color.muted);
  private readonly dot = new Color(THEME.color.accent);
  private capacity = 0;
  private markerCount = 0;
  private collapsedCount = 0;

  constructor() {
    super(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, side: DoubleSide, forceSinglePass: true, depthWrite: false, toneMapped: false }));
    this.name = 'chip-markers'; this.frustumCulled = false; this.renderOrder = THEME.render.boxes;
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float markerOpacity; varying float vMarkerOpacity;\n' + shader.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\nvMarkerOpacity = markerOpacity;');
      shader.fragmentShader = 'varying float vMarkerOpacity;\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vMarkerOpacity;');
    };
    this.material.customProgramCacheKey = () => 'ce-chip-marker-opacity';
    this.reserve(24);
  }
  reserve(capacity: number): void {
    if (capacity <= this.capacity) return;
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * VERTICES * 3);
    this.colors = new Float32Array(capacity * VERTICES * 3);
    this.alpha = new Float32Array(capacity * VERTICES);
    const indices = new Uint32Array(capacity * INDICES);
    for (let instance = 0; instance < capacity; instance++) {
      const base = instance * VERTICES; let at = instance * INDICES;
      for (let segment = 0; segment < RING_SEGMENTS; segment++) {
        const a = base + segment * 2, b = base + (segment + 1) % RING_SEGMENTS * 2;
        indices.set([a, b, a + 1, b, b + 1, a + 1], at); at += 6;
      }
      const center = base + RING_SEGMENTS * 2;
      for (let segment = 0; segment < DOT_SEGMENTS; segment++) {
        indices.set([center, center + 1 + segment, center + 1 + (segment + 1) % DOT_SEGMENTS], at); at += 3;
      }
      const stem = center + DOT_SEGMENTS + 1;
      indices.set([stem, stem + 1, stem + 2, stem + 2, stem + 1, stem + 3], at);
    }
    this.geometry.dispose();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('markerOpacity', new BufferAttribute(this.alpha, 1));
    this.geometry.setIndex(new BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);
  }
  begin(): void { this.markerCount = 0; this.collapsedCount = 0; }
  private vertex(at: number, center: Vector3, x: number, y: number, color: Color): void {
    this.positions[at] = center.x + this.right.x * x;
    this.positions[at + 1] = center.y + y;
    this.positions[at + 2] = center.z + this.right.z * x;
    this.colors[at] = color.r; this.colors[at + 1] = color.g; this.colors[at + 2] = color.b;
    this.alpha[at / 3] = this.opacity;
  }
  write(anchor: Vector3, head: Vector3, scale: number, collapsed: boolean, top: number, opacity: number): void {
    const base = this.markerCount++ * VERTICES * 3;
    this.opacity = opacity;
    if (collapsed) this.collapsedCount++;
    this.direction.subVectors(head, anchor); this.direction.y = 0;
    if (this.direction.lengthSq() < 1e-8) this.direction.set(0, 0, 1);
    this.direction.normalize(); this.right.crossVectors(up, this.direction);
    const radius = collapsed ? THEME.box.labelHeight / 2 * scale : 0;
    const inner = collapsed ? (THEME.box.labelHeight / 2 - 0.0012) * scale : 0;
    for (let segment = 0; segment < RING_SEGMENTS; segment++) {
      const angle = segment * Math.PI * 2 / RING_SEGMENTS, c = Math.cos(angle), s = Math.sin(angle);
      this.vertex(base + segment * 6, anchor, c * radius, s * radius, this.ring);
      this.vertex(base + segment * 6 + 3, anchor, c * inner, s * inner, this.ring);
    }
    const dot = base + RING_SEGMENTS * 6;
    this.vertex(dot, anchor, 0, 0, this.dot);
    for (let segment = 0; segment < DOT_SEGMENTS; segment++) {
      const angle = segment * Math.PI * 2 / DOT_SEGMENTS, radius = collapsed ? 0.003 * scale : 0;
      this.vertex(dot + (segment + 1) * 3, anchor, Math.cos(angle) * radius, Math.sin(angle) * radius, this.dot);
    }
    const stem = dot + (DOT_SEGMENTS + 1) * 3, halfWidth = 0.0006 * scale;
    const stemTop = -Math.min(THEME.box.labelHeight / 2 * scale, anchor.y - top);
    this.vertex(stem, anchor, -halfWidth, top - anchor.y, this.ring);
    this.vertex(stem + 3, anchor, halfWidth, top - anchor.y, this.ring);
    this.vertex(stem + 6, anchor, -halfWidth, stemTop, this.ring);
    this.vertex(stem + 9, anchor, halfWidth, stemTop, this.ring);
  }
  finish(): void {
    this.geometry.setDrawRange(0, this.markerCount * INDICES);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('color').needsUpdate = true;
    this.geometry.getAttribute('markerOpacity').needsUpdate = true;
    this.userData.count = this.markerCount; this.userData.collapsedCount = this.collapsedCount;
  }
  override dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}
