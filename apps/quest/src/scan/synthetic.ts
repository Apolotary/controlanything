/**
 * Desktop emulator camera. A "virtual room" (a backdrop plane textured with a photo, or with the sim room's
 * live canvas from /sim/?embed=room) stands in front of the emulated headset, and a SyntheticCamera renders
 * it from the emulated LEFT camera pose (head ∘ head→camera offset) with the exact Quest 3 1280×960
 * intrinsics. So scan frames, detections and their 3D placement are geometrically consistent, and the
 * whole scan → select → verify loop runs with no headset.
 */
import {
  CanvasTexture,
  Color,
  DoubleSide,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Intrinsics, Pose } from '../io/v1';
import type { CameraInfo, CameraSource, CameraStats, GrabbedFrame } from './camera';
import { cameraPoseFromHead, type PoseLike, projectionFromIntrinsics, QUEST3_1280x960, type WorldRay } from './projection';

/** IWER's default headset position; the backdrop is framed for it. */
export const DEFAULT_HEAD = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };

/** What /sim/?embed=room exposes (agreed with the sim lane). */
export interface CeSim {
  version?: number;
  canvas: HTMLCanvasElement;
  view?: string;
  layout?: { width: number; height: number; devices: { id: string; kind: string; label: string; box: [number, number, number, number] }[] };
}

export interface RoomSource {
  kind: 'photo' | 'sim';
  /** photo URL, or the sim embed URL */
  url: string;
}

export class VirtualRoom {
  readonly scene = new Scene();
  /** add to the emulator's main scene: stands in for passthrough */
  readonly backdropGroup = new Group();
  readonly center = new Vector3();
  readonly quaternion = new Quaternion();
  widthM = 1;
  heightM = 1;
  imageWidth = 1;
  imageHeight = 1;
  texture?: Texture;
  /** passthrough never occludes virtual content: the backdrop is a background layer (no depth writes, drawn first) */
  private readonly material = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, depthWrite: false });
  private readonly planes: Mesh[] = [];
  private simCanvas?: HTMLCanvasElement;
  /** the sim embed's API when the source is the sim room */
  sim?: CeSim;
  private lastCanvasUpdate = 0;
  ready: Promise<void>;
  label = '';

  constructor(
    readonly source: RoomSource,
    opts: { distanceM?: number; intrinsics?: Intrinsics } = {},
  ) {
    this.scene.background = new Color(0x1a1f24);
    this.ready = this.load(opts.distanceM ?? 2.5, opts.intrinsics ?? QUEST3_1280x960);
  }

  private async load(distance: number, k: Intrinsics): Promise<void> {
    if (this.source.kind === 'sim') {
      this.sim = await loadSim(this.source.url);
      const canvas = this.sim.canvas;
      this.simCanvas = canvas;
      const t = new CanvasTexture(canvas);
      t.colorSpace = SRGBColorSpace;
      this.texture = t;
      this.imageWidth = canvas.width;
      this.imageHeight = canvas.height;
      this.label = 'sim room (live)';
    } else {
      const t = await new TextureLoader().loadAsync(this.source.url);
      t.colorSpace = SRGBColorSpace;
      this.texture = t;
      const img = t.image as { width: number; height: number };
      this.imageWidth = img.width;
      this.imageHeight = img.height;
      this.label = `photo ${this.source.url.split('/').pop()}`;
    }
    this.material.map = this.texture;
    this.material.needsUpdate = true;

    // perpendicular to the default camera's optical axis, filling its vertical field of view at `distance`
    const cam = cameraPoseFromHead(DEFAULT_HEAD, 'left');
    const fwd = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.center.copy(cam.position).addScaledVector(fwd, distance);
    this.quaternion.copy(cam.quaternion);
    this.heightM = (distance * k.height) / k.fy;
    this.widthM = (this.heightM * this.imageWidth) / this.imageHeight;

    const geo = new PlaneGeometry(this.widthM, this.heightM);
    for (const target of [this.scene, this.backdropGroup]) {
      const m = new Mesh(geo, this.material);
      m.position.copy(this.center);
      m.quaternion.copy(this.quaternion);
      m.name = 'virtual-room-backdrop';
      m.renderOrder = -100;
      target.add(m);
      // static: world matrices must be valid for raycasts even before anything renders this scene
      m.updateMatrixWorld(true);
      this.planes.push(m);
    }
    const grid = new GridHelper(8, 16, 0x2a3540, 0x1c252d);
    grid.renderOrder = -99;
    (grid.material as { depthWrite: boolean }).depthWrite = false;
    this.backdropGroup.add(grid);
  }

  /** Upload the live sim canvas now (before a synthetic capture). */
  refresh(): void {
    if (this.simCanvas && this.texture) {
      this.texture.needsUpdate = true;
      this.lastCanvasUpdate = performance.now();
    }
  }

  /** Keep a live sim canvas fresh (≤ 10 Hz). */
  update(now: number): void {
    if (!this.simCanvas || !this.texture || now - this.lastCanvasUpdate < 100) return;
    this.lastCanvasUpdate = now;
    this.texture.needsUpdate = true;
  }

  /** Virtual hit-test: where a world ray meets the backdrop. */
  raycast(ray: WorldRay): { point: Vector3; normal: Vector3 } | null {
    const plane = this.planes[0];
    if (!plane) return null;
    plane.updateMatrixWorld(true);
    const rc = new Raycaster(ray.origin, ray.dir.clone().normalize(), 0.05, 20);
    const hit = rc.intersectObject(plane, false)[0];
    if (!hit) return null;
    return { point: hit.point.clone(), normal: new Vector3(0, 0, 1).applyQuaternion(this.quaternion) };
  }

  /** Image pixel of the room source → world point on the backdrop. */
  imageToWorld(u: number, v: number): Vector3 {
    const x = (u / this.imageWidth - 0.5) * this.widthM;
    const y = (0.5 - v / this.imageHeight) * this.heightM;
    return new Vector3(x, y, 0).applyQuaternion(this.quaternion).add(this.center);
  }
}

/** Same-origin iframe to /sim/?embed=room that exposes window.ceSim (agreed with the sim lane). */
async function loadSim(url: string): Promise<CeSim> {
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = 'sim room (camera source)';
  Object.assign(iframe.style, { position: 'fixed', width: '1280px', height: '960px', left: '-20000px', top: '0', border: '0' });
  document.body.appendChild(iframe);
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const sim = (iframe.contentWindow as unknown as { ceSim?: CeSim } | null)?.ceSim;
      if (sim?.canvas && sim.canvas.width > 0) return sim;
    } catch {
      // not same-origin or not loaded yet
    }
  }
  iframe.remove();
  throw new Error(`the sim room at ${url} did not expose window.ceSim.canvas within 15 s`);
}

/** Renders the virtual room from the emulated head-mounted camera. */
export class SyntheticCamera implements CameraSource {
  readonly kind = 'synthetic' as const;
  readonly eye = 'left' as const;
  info?: CameraInfo;
  readonly stats: CameraStats = { frames: 0, fps: 0, lastFrameAt: 0, captureTime: true };
  readonly element: HTMLCanvasElement;
  private renderer?: WebGLRenderer;
  private readonly cam = new PerspectiveCamera();
  private readonly k: Intrinsics;
  private readonly camPose: PoseLike = { position: new Vector3(), quaternion: new Quaternion() };

  constructor(
    readonly room: VirtualRoom,
    private readonly headPose: () => PoseLike | null,
    k: Intrinsics = QUEST3_1280x960,
  ) {
    this.k = { ...k };
    this.element = document.createElement('canvas');
    this.element.width = k.width;
    this.element.height = k.height;
  }

  async start(): Promise<CameraInfo> {
    await this.room.ready;
    if (!this.renderer) {
      this.renderer = new WebGLRenderer({ canvas: this.element, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.k.width, this.k.height, false);
      this.renderer.outputColorSpace = SRGBColorSpace;
      this.cam.projectionMatrix.copy(projectionFromIntrinsics(this.k, 0.05, 50));
      this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
    }
    this.info = { width: this.k.width, height: this.k.height, label: `synthetic camera · ${this.room.label}`, frameRate: 30 };
    return this.info;
  }

  stop(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  async grab(): Promise<GrabbedFrame | null> {
    if (!this.renderer) return null;
    const head = this.headPose() ?? DEFAULT_HEAD;
    cameraPoseFromHead(head, this.eye, this.camPose);
    this.cam.position.copy(this.camPose.position);
    this.cam.quaternion.copy(this.camPose.quaternion);
    this.cam.updateMatrixWorld(true);
    this.room.refresh();
    this.renderer.render(this.room.scene, this.cam);
    const tCapture = performance.now();
    const bitmap = await createImageBitmap(this.element);
    this.stats.frames++;
    this.stats.lastFrameAt = tCapture;
    const headPose: Pose = {
      position: { x: head.position.x, y: head.position.y, z: head.position.z },
      orientation: { x: head.quaternion.x, y: head.quaternion.y, z: head.quaternion.z, w: head.quaternion.w },
    };
    return { bitmap, width: this.k.width, height: this.k.height, tCapture, headPose, intrinsics: { ...this.k } };
  }
}
