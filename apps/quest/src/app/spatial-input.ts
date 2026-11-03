/**
 * The single owner of UI pointing: Meta IWSDK's standalone input manager (`@iwsdk/xr-input`).
 * Each hand or controller gets a MultiPointer (poke/touch > grab > ray). The ray uses the system select
 * event, so Quest's own pinch tuning applies. pmndrs pointer-events dispatches `pointerdown/move/up/click`
 * to any Object3D with listeners (LeanHud widget hit planes, uikit roots, dials).
 * On the desktop and in the IWER emulator, mouse events on the canvas are forwarded into the same scene.
 *
 * Touch rules (from Google XR Blocks' DirectTouch, which xr-input already follows):
 * - a click fires on lift-off;
 * - sliding off the target, or losing tracking, cancels without a click;
 * - an active touch hides that hand's ray.
 */
import { ArrayCamera, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { XRInputManager } from '@iwsdk/xr-input';
import { forwardHtmlEvents } from '@pmndrs/pointer-events';

export type SpatialHand = 'left' | 'right';
export type SpatialPointerKind = 'ray' | 'touch' | 'grab';
type UiRoot = { update(dtMs: number): void };

export class SpatialInput {
  readonly input: XRInputManager;
  private readonly html: { destroy(): void; update(): void } | null;
  private readonly roots: { root: UiRoot; isVisible?: () => boolean }[] = [];
  /** Forwarded mouse pointers currently over a UI target (pointerover/out bookkeeping). */
  private readonly mouseHover = new Set<number>();
  private readonly pointerHands = new Map<number, SpatialHand>();
  frames = 0;

  constructor(scene: Scene, private readonly camera: PerspectiveCamera, private readonly renderer: WebGLRenderer, opts: { mouse?: boolean } = {}) {
    // Passthrough shows the real hands and controllers: skip the CDN meshes; pointers still work.
    this.input = new XRInputManager({
      scene, camera,
      assetLoader: { loadGLTF: () => Promise.reject(new Error('passthrough: no input mesh')) },
    });
    scene.add(this.input.xrOrigin);
    for (const hand of ['left', 'right'] as const) {
      const multi = this.input.multiPointers[hand];
      multi.toggleSubPointer('grab', true);
      for (const kind of ['ray', 'touch', 'grab'] as const) this.pointerHands.set(multi.getPointer(kind).id, hand);
    }
    const getCamera = (): PerspectiveCamera => this.renderer.xr.isPresenting ? visibleXrCamera(this.renderer.xr.getCamera() as ArrayCamera) ?? this.camera : this.camera;
    this.html = opts.mouse === false ? null : forwardHtmlEvents(renderer.domElement, getCamera, scene, { intersectEveryFrame: true });
  }

  /** Call once per frame inside the animation loop, after the camera pose is current. */
  update(dtSeconds: number, timeMs: number): void {
    this.frames++;
    this.input.update(this.renderer.xr, dtSeconds, timeMs / 1000);
    this.html?.update();
    const dtMs = dtSeconds * 1000;
    for (const { root, isVisible } of this.roots) if (!isVisible || isVisible()) root.update(dtMs);
  }

  /** Per-frame update for a uikit root (or anything with `update(dtMs)`), skipped while hidden. */
  addUiRoot(root: UiRoot, isVisible?: () => boolean): () => void {
    const entry = { root, isVisible };
    this.roots.push(entry);
    return () => { const i = this.roots.indexOf(entry); if (i >= 0) this.roots.splice(i, 1); };
  }

  /** Which hand an xr-input pointer belongs to; forwarded mouse pointers count as the right hand. */
  handOf(pointerId: number, pointerType?: string): SpatialHand | 'mouse' | undefined {
    return this.pointerHands.get(pointerId) ?? (pointerType?.startsWith('screen-') || pointerType?.startsWith('forward-') ? 'mouse' : undefined);
  }

  /** UI hover bookkeeping for forwarded mouse pointers (xr pointers are read from the manager). */
  markHover(e: { pointerId: number; pointerType?: string }, over: boolean): void {
    if (this.handOf(e.pointerId, e.pointerType) !== 'mouse') return;
    if (over) this.mouseHover.add(e.pointerId); else this.mouseHover.delete(e.pointerId);
  }

  /** True while a UI target owns this hand: legacy pinch/target selection must ignore it. */
  uiOwns(hand: SpatialHand | 'mouse'): boolean {
    if (hand === 'mouse') return this.mouseHover.size > 0;
    const pointer = this.input.multiPointers[hand].getActivePointer();
    const hit = pointer?.getIntersection();
    return !!hit && !(hit.object as { isVoidObject?: boolean }).isVoidObject || !!pointer?.getPointerCapture();
  }

  pointerKind(hand: SpatialHand): SpatialPointerKind | null {
    return this.input.multiPointers[hand].getActiveKind();
  }

  /** Debug readout: per hand, the active pointer kind and whether it is selecting. */
  describe(): string {
    const part = (hand: SpatialHand) => {
      const multi = this.input.multiPointers[hand];
      const kind = multi.getActiveKind();
      const pointer = multi.getActivePointer();
      const down = (pointer?.getButtonsDown().size ?? 0) > 0;
      return `${hand[0]!.toUpperCase()}:${kind ?? '-'}${down ? '●' : ''}`;
    };
    return `${part('left')} ${part('right')}${this.mouseHover.size ? ' M:ui' : ''}`;
  }

  dispose(): void {
    this.html?.destroy();
    this.input.xrOrigin.removeFromParent();
    this.input.multiPointers.left.dispose();
    this.input.multiPointers.right.dispose();
  }
}

/**
 * The XR view actually drawn on the canvas. IWER's "mono" emulator still reports two views, but only the first has a
 * viewport (the second is 0 px wide); the union camera three copies into the scene camera is offset from it, which put
 * mouse rays up to ~25 px off the picture. Mouse rays must use the drawn view.
 */
export function visibleXrCamera(xr: ArrayCamera): PerspectiveCamera | undefined {
  let best: PerspectiveCamera | undefined, width = 0;
  for (const camera of xr.cameras) {
    const w = (camera as PerspectiveCamera & { viewport?: { z: number } }).viewport?.z ?? 0;
    if (w > width) { width = w; best = camera as PerspectiveCamera; }
  }
  if (xr.cameras.length === 1) return xr.cameras[0] as PerspectiveCamera;
  return xr.cameras.filter((c) => ((c as PerspectiveCamera & { viewport?: { z: number } }).viewport?.z ?? 0) > 0).length === 1 ? best : undefined;
}

export function createSpatialInput(scene: Scene, camera: PerspectiveCamera, renderer: WebGLRenderer, opts?: { mouse?: boolean }): SpatialInput {
  return new SpatialInput(scene, camera, renderer, opts);
}
