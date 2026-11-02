/**
 * immersive-ar session with a fallback ladder (research/04 §12 features.ts). Quest Browser has no DOM overlay
 * in immersive-ar, so every pixel of UI is WebGL; the 2D page is only the launcher.
 */
import type { WebGLRenderer } from 'three';

export interface XrStart {
  session: XRSession;
  refSpace: XRReferenceSpace;
  mode: XRSessionMode;
  features: string[];
  attempt: string;
}

const LADDER: { label: string; mode: XRSessionMode; init: XRSessionInit }[] = [
  {
    label: 'ar+all',
    mode: 'immersive-ar',
    init: { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'hit-test', 'anchors', 'plane-detection', 'mesh-detection'] },
  },
  { label: 'ar+hands+hit', mode: 'immersive-ar', init: { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'hit-test'] } },
  { label: 'ar-minimal', mode: 'immersive-ar', init: { optionalFeatures: ['local-floor', 'hand-tracking'] } },
];

export async function xrSupport(): Promise<{ ar: boolean; vr: boolean; xr: boolean }> {
  const xr = navigator.xr;
  if (!xr) return { ar: false, vr: false, xr: false };
  const [ar, vr] = await Promise.all([xr.isSessionSupported('immersive-ar').catch(() => false), xr.isSessionSupported('immersive-vr').catch(() => false)]);
  return { ar, vr, xr: true };
}

/** Read inside setAnimationLoop: the frame and reference space must belong to the renderer's current session. */
export function frameReferenceSpace(renderer: WebGLRenderer, frame?: XRFrame): XRReferenceSpace | undefined {
  if (!frame || frame.session !== renderer.xr.getSession()) return undefined;
  return renderer.xr.getReferenceSpace() ?? undefined;
}

export async function startXr(renderer: WebGLRenderer, opts: { allowVr?: boolean } = {}): Promise<XrStart> {
  const xr = navigator.xr;
  if (!xr) throw new Error('WebXR is not available in this browser');
  const ladder = [...LADDER];
  if (opts.allowVr) ladder.push({ label: 'vr-fallback', mode: 'immersive-vr', init: { optionalFeatures: ['local-floor', 'hand-tracking'] } });
  const errors: string[] = [];
  for (const step of ladder) {
    let session: XRSession;
    try {
      session = await xr.requestSession(step.mode, step.init);
    } catch (e) {
      errors.push(`${step.label}: ${(e as Error).message}`);
      continue;
    }
    try {
      // Resolve support before setSession: three.js allocates layers and binds events before requesting its space.
      // Retrying setSession on the same partly initialized session leaves those resources/listeners behind.
      let referenceType: XRReferenceSpaceType = 'local-floor';
      try {
        await session.requestReferenceSpace(referenceType);
      } catch {
        referenceType = 'local';
        await session.requestReferenceSpace(referenceType);
      }
      renderer.xr.setReferenceSpaceType(referenceType);
      await renderer.xr.setSession(session);
      const refSpace = renderer.xr.getReferenceSpace();
      if (!refSpace) throw new Error('no reference space after setSession');
      const features = Array.from((session as XRSession & { enabledFeatures?: string[] }).enabledFeatures ?? []);
      return { session, refSpace, mode: step.mode, features, attempt: step.label };
    } catch (e) {
      errors.push(`${step.label}: ${(e as Error).message}`);
      // End before advancing the ladder so a failed session cannot retain renderer or input listeners.
      await session.end();
    }
  }
  throw new Error(`could not start an XR session: ${errors.join(' | ')}`);
}
