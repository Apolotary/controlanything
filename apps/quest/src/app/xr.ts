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
    const wantsFloor = (step.init.requiredFeatures ?? step.init.optionalFeatures ?? []).includes('local-floor');
    renderer.xr.setReferenceSpaceType(wantsFloor ? 'local-floor' : 'local');
    try {
      await renderer.xr.setSession(session);
    } catch {
      renderer.xr.setReferenceSpaceType('local');
      await renderer.xr.setSession(session);
    }
    const refSpace = renderer.xr.getReferenceSpace();
    if (!refSpace) throw new Error('no reference space after setSession');
    const features = Array.from((session as XRSession & { enabledFeatures?: string[] }).enabledFeatures ?? []);
    return { session, refSpace, mode: step.mode, features, attempt: step.label };
  }
  throw new Error(`could not start an XR session: ${errors.join(' | ')}`);
}
