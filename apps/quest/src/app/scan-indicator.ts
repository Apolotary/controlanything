import { Group, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import type { ShellFrame } from './hud-contract';
import { makeText, type SdfText } from '../hud/v2/text';
import { THEME } from '../hud/v2/theme';

const OFFSET = new Vector3(0, -0.26, -0.75);
/** Do not flash for a scan that answers at once. */
const SHOW_AFTER_MS = 300;

/**
 * A quiet "Looking…" low in the view while a SAM 3.1 scan is in flight (Annotate): a small sweeping arc and a
 * pulsing word, head-locked with a lazy follow. SAM takes 1–3 s per frame and is now the only detector, so the
 * wearer should see that the headset is looking rather than wonder whether boxes will come.
 */
export class ScanIndicator extends Group {
  private readonly arc: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly label: SdfText;
  private readonly target = new Vector3();
  private opacity = 0;
  private placed = false;

  constructor() {
    super();
    this.name = 'scan-indicator';
    this.visible = false;
    this.arc = new Mesh(new RingGeometry(0.0085, 0.011, 24, 1, 0, Math.PI * 0.6), new MeshBasicMaterial({ color: THEME.color.accent, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }));
    this.arc.position.x = -0.04;
    this.arc.renderOrder = 120;
    this.arc.raycast = () => {};
    this.label = makeText({ text: 'Looking…', size: 0.016, weight: 500, color: THEME.color.text, anchorX: 'left', singleLine: true });
    this.label.position.set(-0.024, 0, 0);
    (this.label as unknown as { anchorY: string }).anchorY = 'middle';
    this.label.renderOrder = 120;
    this.label.raycast = () => {};
    this.add(this.arc, this.label);
  }

  /** Per frame. `active`: a scan is in flight in Annotate; `since`: when it was sent (performance.now()). */
  update(f: ShellFrame, time: number, active: boolean, since: number): void {
    const want = active && since > 0 && performance.now() - since > SHOW_AFTER_MS ? 1 : 0;
    const dt = Math.min(0.1, Math.max(0, f.dt));
    this.opacity += (want - this.opacity) * Math.min(1, dt * 8);
    if (this.opacity < 0.02 && !want) { this.visible = false; this.placed = false; return; }
    this.visible = true;
    this.target.copy(OFFSET).applyQuaternion(f.head.quaternion).add(f.head.position);
    if (!this.placed) { this.position.copy(this.target); this.placed = true; }
    else this.position.lerp(this.target, 1 - Math.exp(-dt * 6));
    this.quaternion.copy(f.head.quaternion);
    this.arc.rotation.z = -time / 1000 * 4;
    const pulse = 0.55 + 0.45 * Math.sin(time / 1000 * 4);
    this.arc.material.opacity = 0.9 * this.opacity;
    (this.label as unknown as { fillOpacity: number }).fillOpacity = this.opacity * pulse;
  }
}
