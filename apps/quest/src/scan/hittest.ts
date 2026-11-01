/**
 * WebXR hit test along an arbitrary world ray (local-floor), one-shot: request a hit-test source with an
 * offsetRay, read the results on the next frames, cancel. On Quest Browser 40.4+ hit testing runs on the
 * Depth API, so it lands on the synth on the desk, not just room-setup planes (research/04 §3 step 4).
 */
import { Matrix4, Vector3 } from 'three';
import type { DepthHit, DepthProvider } from './placement';
import type { WorldRay } from './projection';

interface PendingHit {
  source?: XRHitTestSource;
  frames: number;
  resolve: (h: DepthHit | null) => void;
  done: boolean;
}

export class XrHitTester implements DepthProvider {
  readonly name = 'hit-test';
  private session?: XRSession;
  private refSpace?: XRReferenceSpace;
  private readonly pending = new Set<PendingHit>();
  supported = false;
  /** give up after this many XR frames (~140 ms at 72 Hz) */
  maxFrames = 10;

  attach(session: XRSession, refSpace: XRReferenceSpace): void {
    this.session = session;
    this.refSpace = refSpace;
    this.supported = typeof session.requestHitTestSource === 'function';
  }

  detach(): void {
    for (const p of this.pending) this.finish(p, null);
    this.session = undefined;
    this.refSpace = undefined;
    this.supported = false;
  }

  hit(ray: WorldRay): Promise<DepthHit | null> {
    const session = this.session;
    const refSpace = this.refSpace;
    if (!session || !refSpace || !this.supported) return Promise.resolve(null);
    return new Promise((resolve) => {
      const p: PendingHit = { frames: 0, resolve, done: false };
      this.pending.add(p);
      const XRRayCtor = (globalThis as unknown as { XRRay?: new (o: DOMPointInit, d: DOMPointInit) => XRRay }).XRRay;
      if (!XRRayCtor) {
        this.finish(p, null);
        return;
      }
      const offsetRay = new XRRayCtor({ x: ray.origin.x, y: ray.origin.y, z: ray.origin.z, w: 1 }, { x: ray.dir.x, y: ray.dir.y, z: ray.dir.z, w: 0 });
      session
        .requestHitTestSource!({ space: refSpace, offsetRay })!
        .then((src) => {
          if (p.done) src.cancel();
          else p.source = src;
        })
        .catch(() => this.finish(p, null));
    });
  }

  /** Call once per XR frame. */
  onFrame(frame: XRFrame): void {
    if (!this.refSpace) return;
    for (const p of this.pending) {
      if (p.done) continue;
      p.frames++;
      if (p.source) {
        let results: XRHitTestResult[] = [];
        try {
          results = frame.getHitTestResults(p.source);
        } catch {
          results = [];
        }
        const pose = results[0]?.getPose(this.refSpace);
        if (pose) {
          const m = new Matrix4().fromArray(pose.transform.matrix);
          const point = new Vector3().setFromMatrixPosition(m);
          const normal = new Vector3(0, 1, 0).transformDirection(m);
          this.finish(p, { point, normal });
          continue;
        }
      }
      if (p.frames > this.maxFrames) this.finish(p, null);
    }
  }

  private finish(p: PendingHit, h: DepthHit | null): void {
    if (p.done) return;
    p.done = true;
    p.source?.cancel();
    this.pending.delete(p);
    p.resolve(h);
  }
}

/** The emulator's virtual room as a depth source. */
export class VirtualRoomDepth implements DepthProvider {
  readonly name = 'virtual-room';
  constructor(private readonly room: { raycast(ray: WorldRay): { point: Vector3; normal: Vector3 } | null }) {}
  async hit(ray: WorldRay): Promise<DepthHit | null> {
    return this.room.raycast(ray);
  }
}
