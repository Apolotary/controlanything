import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { Cursor } from '../../gen3d/interact';
import { BoxField } from './boxes';
import { THEME } from './theme';

interface ReticleState {
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  start: Vector3;
  end: Vector3;
  target: string | null;
  elapsed: number;
  releaseElapsed: number;
  releasedScale: number;
  contracting: boolean;
}

/** A critically damped spring settles without flashing or bouncing across the target. */
function settle(t: number): number {
  const value = Math.min(1, Math.max(0, t));
  return (1 - (1 + 8 * value) * Math.exp(-8 * value)) / (1 - 9 * Math.exp(-8));
}

function reticleGeometry(): BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const ring = new Color(THEME.color.line), dot = new Color(THEME.color.accent);
  const count = THEME.reticle.segments;
  const vertex = (x: number, y: number, color: Color) => {
    positions.push(x, y, 0); colors.push(color.r, color.g, color.b);
  };
  for (let i = 0; i < count; i++) {
    const angle = i / count * Math.PI * 2;
    for (const radius of [THEME.reticle.radius, THEME.reticle.radius - THEME.reticle.stroke]) vertex(Math.cos(angle) * radius, Math.sin(angle) * radius, ring);
    const a = i * 2, b = (i + 1) % count * 2;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const center = positions.length / 3;
  vertex(0, 0, dot);
  for (let i = 0; i < count; i++) {
    const angle = i / count * Math.PI * 2;
    vertex(Math.cos(angle) * THEME.reticle.dotRadius, Math.sin(angle) * THEME.reticle.dotRadius, dot);
    indices.push(center, center + 1 + i, center + 1 + (i + 1) % count);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** One ring and centre dot per hand, sharing geometry and requiring two draw calls. */
export class PinchReticles extends Group {
  private readonly geometry = reticleGeometry();
  private readonly material = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, forceSinglePass: true, transparent: true, opacity: THEME.opacity.line, depthWrite: false, depthTest: false, toneMapped: false });
  private readonly states: ReticleState[] = [];
  private readonly destination = new Vector3();

  constructor() {
    super();
    this.name = 'pinch-reticles';
    for (const hand of ['left', 'right']) {
      const mesh = new Mesh(this.geometry, this.material);
      mesh.name = `${hand}-reticle`;
      mesh.visible = false;
      mesh.renderOrder = THEME.render.text + 1;
      this.add(mesh);
      this.states.push({ mesh, start: new Vector3(), end: new Vector3(), target: null, elapsed: 0, releaseElapsed: THEME.motion.duration, releasedScale: 1, contracting: false });
    }
  }
  update(cursors: readonly Cursor[], head: Vector3, dt: number, boxes: BoxField): void {
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i]!, cursor = cursors[i];
      const { mesh } = state;
      mesh.visible = !!cursor?.tracked && !!cursor.ray;
      if (!mesh.visible || !cursor?.ray) {
        state.contracting = false; state.target = null; state.releaseElapsed = THEME.motion.duration;
        mesh.scale.setScalar(1);
        continue;
      }
      const hit = boxes.intersectRay(cursor.ray, head);
      if (hit) this.destination.copy(hit.point);
      else this.destination.copy(cursor.ray.origin).addScaledVector(cursor.ray.dir, THEME.reticle.distance);
      boxes.facingQuaternion(head, this.destination, mesh.quaternion, hit?.box.facing);
      if (cursor.justPinched && hit) {
        state.start.copy(this.destination);
        state.end.copy(this.destination);
        state.target = hit.box.id;
        state.elapsed = 0;
        state.contracting = true;
      }
      if (state.contracting && cursor.pinching) {
        state.elapsed = Math.min(THEME.motion.duration, state.elapsed + Math.max(0, dt));
        if (state.target) {
          boxes.nearestBorder(state.target, state.start, head, state.end);
          const target = boxes.boxes.get(state.target);
          if (target) boxes.facingQuaternion(head, target.center, mesh.quaternion, target.facing);
        }
        const progress = settle(state.elapsed / THEME.motion.duration);
        mesh.position.lerpVectors(state.start, state.end, progress);
        mesh.scale.setScalar(1 - progress * 0.92);
      } else {
        if (state.contracting) {
          state.contracting = false; state.target = null;
          state.releaseElapsed = 0; state.releasedScale = mesh.scale.x;
        }
        state.releaseElapsed = Math.min(THEME.motion.duration, state.releaseElapsed + Math.max(0, dt));
        const progress = settle(state.releaseElapsed / THEME.motion.duration);
        mesh.scale.setScalar(state.releasedScale + (1 - state.releasedScale) * progress);
        mesh.position.copy(this.destination);
      }
    }
  }
  override dispose(): void { this.geometry.dispose(); this.material.dispose(); this.removeFromParent(); }
}
