/** The 1.2 s scan sweep: a thin cyan band that travels outward from the user; outlines reveal as it passes. */
import { Camera, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { NEON } from '@ce/gen3d';

export class ScanSweep extends Group {
  private band: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private edge: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private t0 = -1;
  private readonly fwd = new Vector3();
  readonly duration = 1.2;
  /** distance the band has travelled, metres (for revealing outlines as it passes) */
  distance = 0;

  constructor() {
    super();
    this.name = 'scanSweep';
    this.band = new Mesh(new PlaneGeometry(4, 2.4), new MeshBasicMaterial({ color: NEON.cyan, transparent: true, opacity: 0.08, depthWrite: false, side: DoubleSide, toneMapped: false }));
    this.edge = new Mesh(new PlaneGeometry(4, 0.012), new MeshBasicMaterial({ color: NEON.cyan, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide, toneMapped: false }));
    this.edge.position.z = 0.001;
    this.add(this.band, this.edge);
    this.visible = false;
    for (const m of [this.band, this.edge]) m.raycast = () => {}; // never catches a cursor ray
  }

  start(time: number): void {
    this.t0 = time;
    this.visible = true;
  }

  get active(): boolean {
    return this.visible;
  }

  update(camera: Camera, time: number): void {
    if (this.t0 < 0) return;
    const u = (time - this.t0) / this.duration;
    if (u >= 1) {
      this.visible = false;
      this.t0 = -1;
      return;
    }
    this.distance = 0.2 + u * 3.0;
    camera.getWorldPosition(this.position);
    camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    this.fwd.normalize();
    this.position.addScaledVector(this.fwd, this.distance);
    this.lookAt(this.position.clone().sub(this.fwd));
    const fade = u < 0.1 ? u / 0.1 : u > 0.8 ? (1 - u) / 0.2 : 1;
    this.band.material.opacity = 0.08 * fade;
    this.edge.material.opacity = 0.9 * fade;
  }
}
