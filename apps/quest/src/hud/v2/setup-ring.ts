import { Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import type { SetupProgressView } from '@ce/protocol';
import { LOOK } from './theme';

export type RingMode = 'hidden' | 'quiet' | 'setup' | 'live';
const MAX_TICKS = 8;

/** Verified-action count from the setup tracker's own fact line ("3/5 commands verified"). */
export function setupChecks(view: SetupProgressView | null | undefined): { passed: number; total: number } {
  for (const fact of view?.facts ?? []) {
    const match = /(\d+)\s*\/\s*(\d+)\s+commands verified/.exec(fact);
    if (match) return { passed: Number(match[1]), total: Math.max(1, Number(match[2])) };
  }
  return { passed: 0, total: LOOK.ring.ticks };
}
/** Stage progress 0..1 (done stages, half credit for the active one). */
export function setupFraction(view: SetupProgressView | null | undefined): number {
  const stages = view?.stages ?? [];
  if (!stages.length) return 0;
  let done = 0;
  for (const stage of stages) done += stage.status === 'done' ? 1 : stage.status === 'active' ? 0.5 : 0;
  return Math.min(1, done / stages.length);
}

/**
 * One quad, one draw: a rounded ring around the selected device. During setup it fills clockwise from the top with
 * the stage progress, shows one tick per verified action and pulses once per pass (≤ 1 Hz, photosensitivity-safe);
 * a slow comet circles while the agent is working. Armed, it becomes the quiet selection ring the dials sit on.
 */
export class ScreenRing extends Mesh<PlaneGeometry, ShaderMaterial> {
  private readonly ticks = Array.from({ length: MAX_TICKS }, () => new Vector2());
  private mode: RingMode = 'hidden';
  private passed = 0;
  private pulse = 1;
  private pulseTick = -1;
  private time = 0;
  private w = 0;
  private h = 0;

  constructor() {
    super(new PlaneGeometry(1, 1), new ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        size: { value: new Vector2(1, 1) }, box: { value: new Vector2(0.5, 0.5) }, radius: { value: LOOK.ring.radius },
        stroke: { value: LOOK.ring.stroke }, progress: { value: 0 }, working: { value: 0 }, time: { value: 0 },
        baseAlpha: { value: 0.4 }, fillAlpha: { value: 0.95 }, ticks: { value: [] as Vector2[] }, tickCount: { value: 0 },
        passed: { value: 0 }, pulse: { value: 1 }, pulseTick: { value: -1 }, fade: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        #define MAX_TICKS ${MAX_TICKS}
        varying vec2 vUv;
        uniform vec2 size, box; uniform vec2 ticks[MAX_TICKS];
        uniform float radius, stroke, progress, working, time, baseAlpha, fillAlpha, tickCount, passed, pulse, pulseTick, fade;
        float rrect(vec2 p) { vec2 q = abs(p) - box + radius; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius; }
        void main() {
          vec2 p = (vUv - 0.5) * size;
          float d = rrect(p);
          float aa = max(fwidth(d), 1e-5);
          float line = 1.0 - smoothstep(stroke * 0.5 - aa, stroke * 0.5 + aa, abs(d));
          // Perimeter parameter: 0 at top centre, increasing clockwise.
          float t = fract(atan(p.x / box.x, p.y / box.y) / 6.2831853 + 1.0);
          float te = aa * 4.0 / (box.x + box.y);
          float filled = (1.0 - smoothstep(progress - te, progress + te, t)) * step(0.001, progress);
          float comet = working * pow(clamp(1.0 - fract(fract(time / ${LOOK.ring.sweepS.toFixed(2)}) - t) / 0.18, 0.0, 1.0), 2.0);
          float lineA = line * max(mix(baseAlpha, fillAlpha, filled), comet * 0.9);
          float shadow = (1.0 - smoothstep(stroke * 0.5 + 0.003 - aa, stroke * 0.5 + 0.003 + aa, abs(d))) * 0.3;
          float alpha = lineA + shadow * (1.0 - lineA);
          vec3 color = vec3(lineA / max(alpha, 1e-4));
          // One dot per verified action: lit = passed; the newest one swells while it pulses.
          for (int i = 0; i < MAX_TICKS; i++) {
            if (float(i) >= tickCount) break;
            float lit = step(float(i) + 0.5, passed);
            float swell = (float(i) == pulseTick) ? (1.0 - pulse) : 0.0;
            float r = ${(LOOK.ring.stroke * 2.4).toFixed(4)} * (1.0 + 0.7 * swell);
            float dt = length(p - ticks[i]);
            float dot = 1.0 - smoothstep(r - aa, r + aa, dt);
            float rim = 1.0 - smoothstep(0.0012, 0.0012 + aa, abs(dt - r));
            float tickAlpha = lit > 0.5 ? dot : max(rim * 0.9, dot * 0.25);
            alpha = max(alpha, tickAlpha);
            color = mix(color, lit > 0.5 ? vec3(1.0) : vec3(0.82), max(dot, rim * (1.0 - lit)));
          }
          // Pass pulse: one soft halo leaves the ring and fades (0.9 s).
          float halo = (1.0 - pulse) * (1.0 - smoothstep(0.0, 0.004 + pulse * 0.03, abs(d - pulse * 0.03)));
          alpha = max(alpha, halo * 0.55 * step(0.0, d));
          gl_FragColor = vec4(color, alpha * fade);
          #include <colorspace_fragment>
        }`,
    }));
    this.name = 'setup-ring';
    this.renderOrder = LOOK.render.ring;
    this.frustumCulled = false;
    this.raycast = () => {};
    this.visible = false;
    this.material.uniforms.ticks!.value = this.ticks;
  }

  /** Screen (device) size in metres. The ring sits LOOK.ring.margin outside it. */
  setSize(w: number, h: number): void {
    if (Math.abs(w - this.w) < 0.002 && Math.abs(h - this.h) < 0.002) return;
    this.w = w; this.h = h;
    const bx = w / 2 + LOOK.ring.margin, by = h / 2 + LOOK.ring.margin, pad = 0.05;
    this.scale.set(bx * 2 + pad * 2, by * 2 + pad * 2, 1);
    const u = this.material.uniforms;
    u.size!.value.set(this.scale.x, this.scale.y); u.box!.value.set(bx, by);
    u.radius!.value = Math.min(LOOK.ring.radius, bx * 0.5, by * 0.5);
    this.layoutTicks();
  }

  private layoutTicks(): void {
    const u = this.material.uniforms, count = u.tickCount!.value as number;
    const bx = u.box!.value.x, by = u.box!.value.y, r = u.radius!.value as number;
    const sdf = (x: number, y: number) => {
      const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    for (let i = 0; i < count; i++) {
      // Spread ticks over the top half so they read as a row of checks above the screen.
      const angle = (-0.36 + 0.72 * (count === 1 ? 0.5 : i / (count - 1))) * Math.PI;
      const dx = Math.sin(angle) * bx, dy = Math.cos(angle) * by;
      let lo = 0, hi = 2;
      for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (sdf(dx * mid, dy * mid) > 0) hi = mid; else lo = mid; }
      this.ticks[i]!.set(dx * lo, dy * lo);
    }
  }

  setMode(mode: RingMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    const u = this.material.uniforms;
    u.baseAlpha!.value = mode === 'setup' ? 0.22 : mode === 'live' ? 0.62 : 0.4;
    if (mode !== 'setup') { u.progress!.value = 0; u.working!.value = 0; u.tickCount!.value = 0; }
    this.userData.mode = mode;
  }

  /** Setup progress: stage fraction plus verified ticks. A new pass starts one pulse. */
  setProgress(fraction: number, passed: number, total: number, working: boolean): void {
    const u = this.material.uniforms;
    const count = Math.max(1, Math.min(MAX_TICKS, Math.round(total)));
    if (u.tickCount!.value !== count) { u.tickCount!.value = count; this.layoutTicks(); }
    u.progress!.value = Math.max(0, Math.min(1, fraction));
    u.working!.value = working ? 1 : 0;
    const clamped = Math.max(0, Math.min(count, Math.round(passed)));
    if (clamped > this.passed) { this.pulse = 0; this.pulseTick = clamped - 1; }
    this.passed = clamped;
    u.passed!.value = clamped;
    this.userData.progress = { fraction: u.progress!.value, passed: clamped, total: count, working };
  }

  update(dtSeconds: number, opacity: number): void {
    this.time += dtSeconds;
    this.pulse = Math.min(1, this.pulse + dtSeconds / LOOK.ring.pulseS);
    const u = this.material.uniforms;
    u.time!.value = this.time; u.pulse!.value = this.pulse; u.pulseTick!.value = this.pulse < 1 ? this.pulseTick : -1;
    u.fade!.value = opacity;
  }

  override dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}
