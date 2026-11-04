import { AmbientLight, DirectionalLight, Group, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three';
import { Mascot, type BuddyAction, type Mood } from '../buddy/mascot';

/** Same animated Buddy as Quest, with real native WebXR only when the browser offers immersive-ar. */
export class ReviewerScene {
  readonly mascot = new Mascot();
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, .01, 30);
  private readonly rig = new Group();
  private readonly renderer: WebGLRenderer;
  private readonly look = new Vector3();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private last = 0;
  private place = false;
  private session?: XRSession;
  private cameraMode = false;
  private observer: ResizeObserver;
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly resize = () => {
    if (this.session) return;
    const r = this.container.getBoundingClientRect(); this.camera.aspect = r.width / Math.max(1, r.height); this.camera.updateProjectionMatrix(); this.renderer.setSize(r.width, r.height);
  };
  constructor(private readonly container: HTMLElement, private readonly onXR: (active: boolean, message?: string) => void) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8)); this.renderer.xr.enabled = true; this.renderer.xr.setReferenceSpaceType('local');
    container.append(this.renderer.domElement); this.camera.position.set(0, .035, .52); this.camera.lookAt(0, 0, 0);
    this.scene.add(new AmbientLight(0xffffff, 2.6)); const light = new DirectionalLight(0xffffff, 3); light.position.set(-1, 2, 3); this.scene.add(light);
    this.rig.add(this.mascot); this.scene.add(this.rig); this.mascot.setMood('delighted', 2); this.mascot.play('wave');
    this.observer = new ResizeObserver(this.resize); this.observer.observe(container); this.resize();
    this.renderer.setAnimationLoop((time) => {
      if (document.hidden && !this.session) { this.last = time; return; }
      const dt = Math.min(.05, this.last ? (time - this.last) / 1000 : .016); this.last = time;
      if (this.session && this.place) {
        const camera = this.renderer.xr.getCamera(); this.rig.position.set(.07, -.08, -.6).applyQuaternion(camera.quaternion).add(camera.position);
        this.rig.quaternion.copy(camera.quaternion); this.place = false;
      }
      this.look.copy(this.session ? this.renderer.xr.getCamera().position : this.camera.position);
      this.mascot.update(this.motion ? Math.min(dt, .012) : dt, this.look);
      this.renderer.render(this.scene, this.camera);
    });
  }
  pose(mood: Mood, action: BuddyAction): void { this.mascot.setMood(mood, 4); this.mascot.play(action); }
  celebrate(): void { this.mascot.celebrate(false); }
  cameraOn(on: boolean): void {
    this.cameraMode = on; if (this.session) return;
    this.rig.position.set(on ? .115 : 0, on ? -.045 : 0, 0); this.rig.scale.setScalar(on ? .6 : 1);
  }
  async supported(): Promise<boolean> { return window.isSecureContext && !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false); }
  async enter(): Promise<void> {
    if (this.session) { await this.session.end(); return; }
    try {
      const session = await navigator.xr!.requestSession('immersive-ar', { requiredFeatures: ['local', 'dom-overlay'], domOverlay: { root: document.body } });
      this.session = session; this.place = true; this.rig.scale.setScalar(1);
      session.addEventListener('end', () => { this.session = undefined; this.rig.position.set(0, 0, 0); this.rig.quaternion.identity(); this.cameraOn(this.cameraMode); this.resize(); this.onXR(false); });
      this.onXR(true); await this.renderer.xr.setSession(session);
    } catch {
      const acquired = this.session; this.session = undefined;
      if (acquired) await acquired.end().catch(() => {});
      this.rig.position.set(0, 0, 0); this.rig.quaternion.identity(); this.cameraOn(this.cameraMode); this.resize(); this.onXR(false, 'Native AR could not start with touch UI support. The camera demo remains available.');
    }
  }
  /** Pointer tap on Buddy, accessible buttons provide the same actions. */
  tap(clientX: number, clientY: number): boolean {
    if (this.session) return false;
    const r = this.container.getBoundingClientRect(); this.pointer.set((clientX - r.left) / r.width * 2 - 1, 1 - (clientY - r.top) / r.height * 2);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObject(this.mascot.body, false).length > 0;
  }
  snapshot() { return { nativeAR: !!this.session, mood: this.mascot.currentMood, action: this.mascot.busyAction, calls: this.renderer.info.render.calls }; }
  dispose(): void { this.renderer.setAnimationLoop(null); void this.session?.end(); this.observer.disconnect(); this.mascot.dispose(); this.renderer.dispose(); }
}
