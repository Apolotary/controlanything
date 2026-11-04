/**
 * Phone AR first: where the browser offers WebXR `immersive-ar` (Android Chrome), Start AR opens a real AR session
 * (camera passthrough by the OS) with the page's controls in a DOM overlay. Like the Quest:
 *   - Annotate frames for SAM 3.1 come from the AR camera itself (WebXR raw camera access, `camera-access`): the
 *     camera texture is drawn into a small framebuffer and read back once per scan, then sent as scan.frame.
 *   - A tagged device is anchored in the room with a hit test from where it was tapped (an XR anchor when the
 *     browser has them), and its label, card and Muse's controls follow that anchor as the phone moves.
 *   - The page's particle field floats about a metre ahead and follows touch.
 * Without `camera-access` the session cannot see the camera frames, so the page says so and goes back to the
 * camera view (where SAM works). iPhone Safari has no WebXR AR at all: the camera view is the experience there.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Matrix4, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector3, Vector4 } from 'three';
import type { Tag } from './annotate';
import type { Overlay } from './overlay';
import type { HandTracker } from './tracker';
import type { HandVisuals } from './visuals';

const VERT = /* glsl */`
attribute vec2 ref;
uniform sampler2D tPos; uniform sampler2D tVel; uniform float uAspect; uniform float uSize;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec4 p = texture2D(tPos, ref); vec4 v = texture2D(tVel, ref);
  vec3 world = vec3((p.x / uAspect - 0.5) * 1.2, (p.y - 0.5) * 1.2 / uAspect, -1.1 + (fract(p.w) - 0.5) * 0.3);
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float sp = clamp(v.z * 0.8, 0.0, 1.0);
  float owner = floor(p.w + 0.001);
  vec3 c = owner > 1.5 ? mix(vec3(0.85, 0.12, 0.62), vec3(1.0, 0.62, 0.28), sp)
    : owner > 0.5 ? mix(vec3(0.12, 0.32, 1.0), vec3(0.3, 1.0, 0.92), sp) : mix(vec3(0.32, 0.3, 0.75), vec3(0.6, 0.75, 1.0), sp);
  vColor = mix(c, vec3(1.0), smoothstep(0.8, 1.0, sp) * 0.5);
  float base = owner > 0.5 ? 0.25 : 0.08;
  vAlpha = smoothstep(0.0, 1.1, abs(p.z)) * (p.z < 0.0 ? 0.0 : 1.0) * (base + (1.0 - base) * sp) * 0.8;
  gl_PointSize = uSize * (0.7 + sp * 1.2) / max(0.3, -mv.z);
}`;
const FRAG = /* glsl */`
varying vec3 vColor; varying float vAlpha;
void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard; float a = exp(-d * 12.0) * vAlpha; gl_FragColor = vec4(vColor * a, a); }`;

interface Anchored { point: Vector3; anchor?: XRAnchor; size: { w: number; h: number } }
/** WebXR Raw Camera Access (not in the TypeScript WebXR types yet) */
interface XRCamera { width: number; height: number }
type CameraBinding = XRWebGLBinding & { getCameraImage(camera: XRCamera): WebGLTexture | null };
interface PendingHit { key: string; source?: XRHitTestSource; frames: number; dir: Vector3; size: { w: number; h: number } }

export interface PhoneARHost {
  changed(active: boolean, message?: string): void;
  /** a camera frame for Annotate (only when the page asked for one) */
  frame(canvas: HTMLCanvasElement): void;
}

export class PhoneAR {
  available: boolean | undefined;
  active = false;
  frames = 0;
  cameraAccess = false;
  private session?: XRSession;
  private refSpace?: XRReferenceSpace;
  private viewerSpace?: XRReferenceSpace;
  private binding?: XRWebGLBinding;
  private scene?: Scene;
  private points?: Points<BufferGeometry, ShaderMaterial>;
  private size = 0;
  private readonly camera = new PerspectiveCamera(70, 1, 0.05, 20);
  private readonly anchors = new Map<string, Anchored>();
  private readonly hits: PendingHit[] = [];
  private proj = new Matrix4();
  private viewInv = new Matrix4();
  private camImage = { w: 0, h: 0 };
  private grab?: { fbo: WebGLFramebuffer; tex: WebGLTexture; prog: WebGLProgram; w: number; h: number; pixels: Uint8Array };
  private readonly grabCanvas = document.createElement('canvas');
  private lastGrab = -Infinity;
  private grabPose?: { p: Vector3; q: Vector4 };
  private pose?: { p: Vector3; q: Vector4 };
  get anchorCount(): number { return this.anchors.size; }

  constructor(private readonly visuals: HandVisuals, private readonly tracker: HandTracker, private readonly host: PhoneARHost) {}

  async supported(): Promise<boolean> {
    try { this.available = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); } catch { this.available = false; }
    return this.available;
  }

  /** camera image (0..1) → screen (0..1): the AR camera image fills the screen (cover fit), not mirrored */
  imageToDisplay(x: number, y: number): { x: number; y: number } {
    const vw = this.camImage.w || innerWidth, vh = this.camImage.h || innerHeight;
    const va = vw / vh, ca = innerWidth / innerHeight;
    const sx = ca > va ? 1 : ca / va, sy = ca > va ? va / ca : 1;
    return { x: (x - 0.5) / sx + 0.5, y: (y - 0.5) / sy + 0.5 };
  }

  async start(): Promise<boolean> {
    if (!navigator.xr) return false;
    const r = this.visuals.renderer;
    let session: XRSession;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local'],
        optionalFeatures: ['dom-overlay', 'hit-test', 'anchors', 'camera-access'],
        domOverlay: { root: document.body },
      } as XRSessionInit);
    } catch (e) {
      this.host.changed(false, `WebXR AR could not start here (${(e as Error).message}). Using the camera view instead.`);
      return false;
    }
    this.build();
    this.session = session; this.active = true; this.frames = 0;
    r.setClearColor(0x000000, 0);
    r.xr.enabled = true; r.xr.setReferenceSpaceType('local');
    await r.xr.setSession(session);
    this.refSpace = r.xr.getReferenceSpace() ?? undefined;
    this.viewerSpace = await session.requestReferenceSpace('viewer').catch(() => undefined);
    try { this.binding = new XRWebGLBinding(session, r.getContext() as WebGL2RenderingContext); } catch { this.binding = undefined; }
    const enabled = (session as XRSession & { enabledFeatures?: string[] }).enabledFeatures;
    this.cameraAccess = !!this.binding && (!enabled || enabled.includes('camera-access'));
    this.host.changed(true, this.cameraAccess
      ? 'WebXR AR: SAM outlines what the AR camera sees. Tap an outline to tag it; tags stay anchored in your room.'
      : 'WebXR AR is on, but this browser does not share AR camera frames with the page, so SAM cannot outline objects here. Tap Exit AR (back) for the camera view.');
    session.addEventListener('end', () => {
      r.setAnimationLoop(null); r.xr.enabled = false; r.setClearColor(0x05060b, 1);
      for (const h of this.hits) h.source?.cancel();
      this.hits.length = 0; this.anchors.clear();
      this.session = undefined; this.active = false; this.visuals.resize();
      this.host.changed(false, 'Left WebXR AR.');
    });
    let last = performance.now();
    r.setAnimationLoop((t: number, frame?: XRFrame) => {
      this.frames++;
      const dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000)); last = t;
      if (frame) this.onFrame(frame);
      // GPUComputationRenderer simulates without the XR camera and restores the XR framebuffer afterwards
      this.visuals.step(this.tracker.hands(), dt);
      const tex = this.visuals.particleTextures();
      if (tex.size !== this.size) this.build();
      const u = this.points!.material.uniforms;
      u.tPos!.value = tex.pos; u.tVel!.value = tex.vel; u.uAspect!.value = this.visuals.aspect;
      r.clear();
      r.render(this.scene!, this.camera);
    });
    return true;
  }

  async end(): Promise<void> { await this.session?.end().catch(() => {}); }

  private build(): void {
    const { size } = this.visuals.particleTextures();
    if (this.points && this.size === size) return;
    this.points?.geometry.dispose();
    const n = size * size, geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    const ref = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { ref[i * 2] = ((i % size) + 0.5) / size; ref[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size; }
    geo.setAttribute('ref', new BufferAttribute(ref, 2));
    this.points = new Points(geo, new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { tPos: { value: null }, tVel: { value: null }, uAspect: { value: 1 }, uSize: { value: 3.5 * Math.min(2, window.devicePixelRatio || 1) } },
    }));
    this.points.frustumCulled = false;
    this.scene = new Scene(); this.scene.add(this.points);
    this.size = size;
  }

  private onFrame(frame: XRFrame): void {
    if (!this.refSpace) return;
    const pose = frame.getViewerPose(this.refSpace);
    const view = pose?.views[0];
    if (!pose || !view) return;
    this.proj.fromArray(view.projectionMatrix);
    this.viewInv.fromArray(view.transform.inverse.matrix);
    const o = pose.transform.position, q = pose.transform.orientation;
    this.pose = { p: new Vector3(o.x, o.y, o.z), q: new Vector4(q.x, q.y, q.z, q.w) };
    // hit tests for taps waiting to be anchored
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i]!;
      h.frames++;
      const result = h.source ? frame.getHitTestResults(h.source)[0] : undefined;
      const hitPose = result?.getPose(this.refSpace);
      if (hitPose || h.frames > 30) {
        const point = hitPose ? new Vector3(hitPose.transform.position.x, hitPose.transform.position.y, hitPose.transform.position.z)
          : this.pose.p.clone().add(h.dir.clone().applyQuaternion({ x: q.x, y: q.y, z: q.z, w: q.w } as never).multiplyScalar(1.2));
        const entry: Anchored = { point, size: h.size };
        this.anchors.set(h.key, entry);
        if (result && 'createAnchor' in result) (result as XRHitTestResult & { createAnchor(): Promise<XRAnchor> }).createAnchor().then((a) => { entry.anchor = a; }).catch(() => {});
        h.source?.cancel();
        this.hits.splice(i, 1);
      }
    }
    for (const a of this.anchors.values()) {
      const p = a.anchor ? frame.getPose(a.anchor.anchorSpace, this.refSpace) : undefined;
      if (p) a.point.set(p.transform.position.x, p.transform.position.y, p.transform.position.z);
    }
    // a camera frame for Annotate, about every 1.2 s
    const cam = (view as XRView & { camera?: XRCamera }).camera;
    if (cam && this.binding && performance.now() - this.lastGrab > 1200) {
      this.lastGrab = performance.now();
      const canvas = this.readCamera(cam);
      if (canvas) { this.grabPose = { p: this.pose.p.clone(), q: this.pose.q.clone() }; this.host.frame(canvas); }
    }
  }

  /** Draw the AR camera texture into a small framebuffer, read it back, and hand it over as a canvas. */
  private readCamera(cam: XRCamera): HTMLCanvasElement | null {
    const r = this.visuals.renderer;
    const gl = r.getContext() as WebGL2RenderingContext;
    let texture: WebGLTexture | null = null;
    try { texture = (this.binding as CameraBinding).getCameraImage(cam); } catch { return null; }
    if (!texture) return null;
    this.camImage = { w: cam.width, h: cam.height };
    const w = Math.min(640, cam.width), h = Math.round(w * cam.height / cam.width);
    if (!this.grab || this.grab.w !== w || this.grab.h !== h) {
      const vs = gl.createShader(gl.VERTEX_SHADER)!, fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(vs, '#version 300 es\nout vec2 uv; void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); uv = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }');
      gl.shaderSource(fs, '#version 300 es\nprecision mediump float; in vec2 uv; uniform sampler2D cam; out vec4 color; void main(){ color = texture(cam, vec2(uv.x, 1.0 - uv.y)); }');
      gl.compileShader(vs); gl.compileShader(fs);
      const prog = gl.createProgram()!; gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.grab = { fbo, tex, prog, w, h, pixels: new Uint8Array(w * h * 4) };
    }
    const g = this.grab;
    const target = r.getRenderTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo); gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(g.prog); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(g.prog, 'cam'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, g.pixels);
    // hand the GL state back to three.js (and the XR framebuffer with it)
    r.state.reset(); r.setRenderTarget(target);
    this.grabCanvas.width = w; this.grabCanvas.height = h;
    const ctx = this.grabCanvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(g.pixels), w, h), 0, 0);
    return this.grabCanvas;
  }

  /** Anchor a tag in the room where it was tapped (screen 0..1): a hit test along that ray, else 1.2 m along it. */
  anchorTag(key: string, x: number, y: number, size = { w: 0.12, h: 0.1 }): void {
    if (!this.session || !this.viewerSpace || this.anchors.has(key)) return;
    const ndc = new Vector4(x * 2 - 1, 1 - y * 2, -1, 1).applyMatrix4(this.proj.clone().invert());
    const dir = new Vector3(ndc.x / ndc.w, ndc.y / ndc.w, ndc.z / ndc.w).normalize();
    const pending: PendingHit = { key, frames: 0, dir, size };
    this.hits.push(pending);
    const ray = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: dir.x, y: dir.y, z: dir.z, w: 0 });
    this.session.requestHitTestSource?.({ space: this.viewerSpace, offsetRay: ray })?.then((s) => { pending.source = s; }).catch(() => {});
  }

  /** Where an anchored tag is on screen now (display 0..1), as a small box. */
  projected(key: string): { box: { x0: number; y0: number; x1: number; y1: number } } | undefined {
    const a = this.anchors.get(key);
    if (!a) return undefined;
    const v = new Vector4(a.point.x, a.point.y, a.point.z, 1).applyMatrix4(this.viewInv).applyMatrix4(this.proj);
    if (v.w <= 0) return undefined;
    const x = (v.x / v.w + 1) / 2, y = (1 - v.y / v.w) / 2;
    return { box: { x0: x - a.size.w / 2, y0: y - a.size.h / 2, x1: x + a.size.w / 2, y1: y + a.size.h / 2 } };
  }

  /** Tags follow their anchors; fresh outlines show only while the phone is about where that frame was taken. */
  updateOverlay(overlay: Overlay, _tags: Map<string, Tag>): void {
    const moved = !this.pose || !this.grabPose || this.pose.p.distanceTo(this.grabPose.p) > 0.06
      || Math.abs(this.pose.q.dot(this.grabPose.q)) < Math.cos((5 * Math.PI) / 360);
    overlay.items = overlay.items.filter((item) => {
      if (item.kind === 'tag') {
        const p = this.projected(item.key);
        if (!p) return !moved;
        const cx = (item.box.x0 + item.box.x1) / 2, cy = (item.box.y0 + item.box.y1) / 2;
        const nx = (p.box.x0 + p.box.x1) / 2, ny = (p.box.y0 + p.box.y1) / 2;
        item.points = item.points.map((pt) => ({ x: pt.x + nx - cx, y: pt.y + ny - cy }));
        item.box = { x0: item.box.x0 + nx - cx, y0: item.box.y0 + ny - cy, x1: item.box.x1 + nx - cx, y1: item.box.y1 + ny - cy };
        return true;
      }
      return !moved;
    });
  }
}
