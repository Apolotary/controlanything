import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState } from './state.js';
import type { VisualSynthParameters } from './state.js';
import { TouchWater, WaterRipples } from './ripples.js';
import type { TouchWaveInfo } from './ripples.js';
import type { TouchPhase } from './state.js';

const vertexSource = `#version 300 es
void main() {
  vec2 point = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
}`;

// Original domain-warped value-noise field, rendered with one full-screen triangle.
const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform vec4 colour; // brightness, hue, saturation, warp
uniform vec4 shape; // zoom, symmetry, pattern, touch presence (quiets the steady centre rings)
uniform vec2 water; // real animation seconds, forward/back depth value
uniform vec4 ripples[6]; // origin xy, start time, signed strength
uniform vec4 touchSeg[24]; // fingertip wave segments: a.uv, b.uv (canvas fractions, v from the top)
uniform vec4 touchWave[24]; // start seconds, signed strength, bigness 0 wake .. 1 splash, spare
uniform vec4 finger; // fingertip u, v, hover glow 0..1, contact 0..1
out vec4 outputColour;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2(1, 0)), u.x),
             mix(hash(cell + vec2(0, 1)), hash(cell + vec2(1, 1)), u.x), u.y);
}
float field(vec2 p) {
  return 0.57 * noise(p) + 0.28 * noise(p * 2.03 + 3.1) + 0.15 * noise(p * 4.07 - 2.3);
}
vec3 hsv(float h, float s, float v) {
  vec3 rgb = clamp(abs(fract(h + vec3(0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1), rgb, s);
}
// Ripples on every pattern. Two parts, both with big wavelengths (a third of the screen) and bright
// crests so they read through a headset's passthrough camera:
// - steady concentric rings expanding from the centre, as deep as the Ripples value (water.y);
// - expanding, damped wavefronts launched by each live Ripples change (push/pull in Perform).
float steadyRipple(vec2 p, out vec2 gradient, out float crest) {
  float radius = max(.0001, length(p));
  float depth = pow(clamp(water.y, 0.0, 1.0), 1.5);
  float fall = 1.0 / (1.0 + .7 * radius);
  float ring = radius * 10.0 - water.x * 3.0;
  float wave = sin(ring);
  float amplitude = .05 * depth * fall;
  gradient = p / radius * amplitude * 10.0 * cos(ring);
  crest = depth * fall * pow(max(0.0, wave), 8.0);
  return amplitude * wave;
}
float rippleWaves(vec2 p, out vec2 gradient, out float crest) {
  gradient = vec2(0.0);
  crest = 0.0;
  float height = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = max(0.0, water.x - ripples[i].z);
    vec2 offset = p - ripples[i].xy;
    float radius = max(.0001, length(offset));
    float front = radius - age * .62;
    float envelope = exp(-front * front * 7.0 - age * .85);
    float wave = sin(front * 16.0);
    float strength = ripples[i].w * envelope;
    height += wave * strength;
    gradient += offset / radius * strength * (16.0 * cos(front * 16.0) - 14.0 * front * wave);
    crest += abs(strength) * smoothstep(.55, 1.0, wave);
  }
  return height;
}
// Touch the water. Canvas fractions (u from the left, v from the top) become the shader's screen space (p), so a
// fingertip lands where it touches whatever the aspect.
vec2 toScreen(vec2 uv) { return vec2((uv.x * 2.0 - 1.0) * resolution.x / max(resolution.y, 1.0), 1.0 - uv.y * 2.0); }
// Fingertip waves: each slot is a damped wave packet leaving a point (a tap) or a short segment of the finger's
// path (a wake). Big wavelengths (~0.4 of the screen height), bright crests and dark troughs, so they read through a
// headset's passthrough camera. A bigger strength travels faster, rings wider and lingers longer.
float touchWaves(vec2 p, out vec2 gradient, out float crest, out float flash, out float body) {
  gradient = vec2(0.0); crest = 0.0; flash = 0.0; body = 0.0;
  float height = 0.0;
  for (int i = 0; i < 24; i++) {
    float strength = touchWave[i].y;
    float age = water.x - touchWave[i].x;
    if (strength == 0.0 || age < 0.0 || age > 6.0) continue;
    float big = touchWave[i].z;
    vec2 a = toScreen(touchSeg[i].xy);
    vec2 ba = toScreen(touchSeg[i].zw) - a;
    vec2 pa = p - a;
    vec2 offset = pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    float radius = sqrt(dot(offset, offset) + .004); // a rounded cone tip: no crease along the path or spike at the contact
    float sigma = mix(.12, .2, big) + .06 * age;
    float front = radius - age * mix(.5, 1.2, big);
    float foam = (1.0 - big) * abs(strength) * exp(-age * 5.0) * exp(-dot(offset, offset) / (.0035 + .04 * age));
    flash += .6 * foam; // the trail: a soft bright line right where the finger passed, gone in half a second
    if (abs(front) > 3.5 * sigma) continue;
    float life = exp(-age * mix(3.4, .9, big)) / (1.0 + 1.5 * radius);
    float envelope = exp(-.5 * front * front / (sigma * sigma));
    float amplitude = strength * life * mix(.1, .11, big);
    float k = mix(11.0, 15.0, big); // the wake's ripples are a little longer than the splash's
    float phase = front * k;
    float c = cos(phase);
    height += amplitude * envelope * c;
    gradient += offset / radius * amplitude * envelope * (-front / (sigma * sigma) * c - k * sin(phase));
    crest += abs(strength) * life * envelope * pow(max(c, 0.0), 3.0) * mix(.45, 1.0, big);
    body += abs(strength) * life * envelope;
    // the splash's pop: a bright disc at the contact that opens and fades in a quarter second
    flash += big * abs(strength) * exp(-age * 7.0) * exp(-radius * radius / (.008 + .09 * age));
  }
  gradient /= 1.0 + .3 * length(gradient); // many overlapping wake segments never fold the surface into hard edges
  return height;
}
// The fingertip itself. Hovering: a soft lens (a dome of water drawn toward the finger) with a caustic glow and
// rings drifting inward, growing as the finger gets closer. Touching: a dimple with a bright rim around the contact.
float fingerLens(vec2 p, out vec2 gradient, out float glow) {
  float hover = finger.z, contact = finger.w;
  gradient = vec2(0.0); glow = 0.0;
  if (hover + contact < .003) return 0.0;
  vec2 offset = p - toScreen(finger.xy);
  float d2 = dot(offset, offset);
  float radius = sqrt(d2);
  float lens = hover * (1.0 - contact);
  float size = mix(.1, .32, hover);
  float domeSigma2 = size * size * .35;
  float dome = .07 * lens * exp(-.5 * d2 / domeSigma2);
  float pitSigma2 = .0045;
  float pit = .06 * contact * exp(-.5 * d2 / pitSigma2);
  gradient = -offset * (dome / domeSigma2) + offset * (pit / pitSigma2);
  float rings = pow(.5 + .5 * cos(radius * 24.0 + water.x * 6.0), 3.0) * exp(-.5 * d2 / (size * size * 2.0));
  glow = (.1 + .6 * hover * hover) * exp(-.5 * d2 / (size * size * .3)) * (1.0 - .75 * contact) + lens * rings * .45
    + contact * (.34 * exp(-pow(radius - .085, 2.0) / .0009) + .1 * exp(-.5 * d2 / .02));
  return dome - pit;
}
// An analytic water surface lit from the ripple gradient. Warp tints the pool and quickens its caustics,
// so height control stays visible while Water is active.
vec3 waterSurface(vec2 p) {
  vec2 gradient, steadyGradient, touchGradient, lensGradient;
  float crest, steadyCrest, touchCrest, flash, glow, touchBody;
  float height = rippleWaves(p, gradient, crest);
  float calm = 1.0 - .7 * shape.w; // the steady centre rings step back while a fingertip is playing
  height += steadyRipple(p, steadyGradient, steadyCrest) * calm;
  float touchHeight = touchWaves(p, touchGradient, touchCrest, flash, touchBody) + fingerLens(p, lensGradient, glow);
  height += touchHeight;
  gradient += steadyGradient * calm + touchGradient + lensGradient;
  crest += steadyCrest * .12 * calm;
  float warp = colour.w;
  vec3 normal = normalize(vec3(-gradient * .9, 1.0));
  vec3 light = normalize(vec3(-.45, .65, .9));
  float diffuse = max(0.0, dot(normal, light));
  float sheen = pow(max(0.0, dot(normal, normalize(light + vec3(0, 0, 1)))), 24.0);
  vec2 seen = p + gradient * .05; // the lit pool is seen through its own waves: a lens at every crest
  float caustic = pow(.5 + .5 * sin(seen.x * (5.0 + 4.0 * warp) + height * 18.0 + .25 * water.x)
    * cos(seen.y * (6.0 + 5.0 * warp) - height * 20.0 - .18 * water.x), 4.0);
  float hue = colour.y - .01 + warp * .30;
  vec3 deep = hsv(hue + .04, .9, .14 + .08 * warp);
  vec3 shallow = hsv(hue - .02, .72, .74);
  vec3 pool = mix(deep, shallow, .2 + .3 * water.y + .3 * diffuse);
  pool += hsv(hue - .05, .35, 1.0) * caustic * (.14 + .2 * warp);
  pool += vec3(.75, .95, 1.0) * (sheen * .8 + crest * 2.4);
  pool *= (.5 + colour.x * .7) * (1.0 - .07 * dot(p, p));
  // Fingertip crests are lit white and the troughs fall dark: that contrast is what the passthrough camera sees.
  pool *= 1.0 - clamp(-touchHeight * 5.0, 0.0, .5);
  pool += vec3(.8, .96, 1.0) * ((1.0 - exp(-1.6 * touchCrest)) * 1.25 + flash * .9 + glow);
  return pool;
}
void main() {
  vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / max(resolution.y, 1.0);
  if (shape.z > 2.5) { outputColour = vec4(waterSurface(p), 1.0); return; }
  // Flow, Rings and Prism: the ripples bend the field (screen space, before zoom) and light their crests.
  vec2 waveGradient, steadyGradient;
  float waveCrest, steadyCrest;
  rippleWaves(p, waveGradient, waveCrest);
  float steadyHeight = steadyRipple(p, steadyGradient, steadyCrest);
  float calm = 1.0 - .7 * shape.w;
  vec2 touchGradient, lensGradient;
  float touchCrest, flash, glow, touchBody;
  float touchHeight = touchWaves(p, touchGradient, touchCrest, flash, touchBody) + fingerLens(p, lensGradient, glow);
  p += waveGradient * .03 + steadyGradient * .16 * calm + (touchGradient + lensGradient) * .12;
  p *= 0.65 + shape.x * 3.2;
  float radius = length(p);
  if (shape.y > 1.5) {
    float sector = 6.2831853 / floor(shape.y + 0.5);
    float angle = abs(mod(atan(p.y, p.x) + sector * 0.5, sector) - sector * 0.5);
    p = vec2(cos(angle), sin(angle)) * radius;
  }
  vec2 drift = vec2(time * 0.12, -time * 0.09);
  vec2 bend = vec2(field(p + drift), field(p + vec2(5.2, 1.3) - drift));
  vec2 warped = p + (bend - 0.5) * (0.15 + colour.w * 4.0);
  float flow = field(warped * 1.7 + drift * 0.5);
  float rings = 0.5 + 0.5 * cos(length(warped) * 10.0 - time * 0.5 + flow * 4.0);
  float prism = 0.5 + 0.5 * sin((warped.x + warped.y * 0.7) * 6.0 + flow * 8.0 + time * 0.3);
  float pattern = shape.z;
  float structure = mix(flow, rings, clamp(pattern, 0.0, 1.0));
  structure = mix(structure, prism, clamp(pattern - 1.0, 0.0, 1.0));
  // Warp and patterns shift the palette and its mean luminance as well as geometry,
  // giving a camera oracle a stable effect distinct from the ongoing animation.
  float hue = colour.y + colour.w * 0.20 + pattern * 0.23 + (structure - 0.5) * 0.10;
  float light = colour.x * (0.34 + 0.55 * colour.w) * (0.82 + 0.18 * structure);
  light *= mix(1.0, 0.70, clamp(pattern, 0.0, 1.0));
  light *= mix(1.0, 1.60, clamp(pattern - 1.0, 0.0, 1.0));
  vec3 base = hsv(hue, colour.z * 0.78, light);
  vec3 ribbon = hsv(hue + 0.07, colour.z * 0.55, light * 1.22);
  float edge = pow(0.5 + 0.5 * cos(structure * 22.0), 8.0);
  vec3 colourOut = mix(base, ribbon, edge * 0.52);
  // Troughs darken and crests glow, so the rings keep their contrast on every palette.
  colourOut *= 1.0 - clamp(-steadyHeight * 9.0 * calm, 0.0, .35);
  // Under a fingertip's waves the busy field steps back (a dark pool) so the white crests stand out on every pattern.
  colourOut *= (1.0 - .5 * clamp(touchBody * 3.0, 0.0, 1.0)) * (1.0 - clamp(-touchHeight * 5.0, 0.0, .5));
  colourOut += vec3(.80, .95, 1.0) * (steadyCrest * .55 * calm + waveCrest * 2.0 + (1.0 - exp(-1.6 * touchCrest)) * 1.25 + flash * .9 + glow);
  outputColour = vec4(colourOut, 1.0);
}`;

export interface VisualSynthRenderer {
  receiveMidi(bytes: readonly number[]): boolean;
  reset(): void;
  setState(parameters: VisualSynthParameters): void;
  getState(): VisualSynthParameters;
  /** Read-only evidence for the actual rendered effect; not a capability or control API. */
  getWaterDiagnostics(): { pattern: number; depth: number; seconds: number; waves: { x: number; y: number; age: number; strength: number }[] };
  /** Read-only evidence for the fingertip: its phase, the lens, and the live wave segments (canvas fractions). */
  getTouchDiagnostics(): { phase: TouchPhase; x: number; y: number; pressure: number; glow: number; contact: number; waves: TouchWaveInfo[] };
  /** Frames drawn so far and whether the animation loop is running (for the renderer self-report). */
  stats(): { frames: number; running: boolean };
  render(nowMs: number): void;
  /** Fixed phase and settled parameters, for camera evidence and screenshot comparisons. */
  renderAt(timeMs: number): void;
  start(): void;
  stop(): void;
  dispose(): void;
}

export function createVisualSynth(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: { onChange?: (label: string, parameters: VisualSynthParameters) => void } = {},
): VisualSynthRenderer {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('This visual instrument needs WebGL2. Try a current browser with graphics acceleration enabled.');
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create the visual shader.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Visual shader compilation failed: ${message}`);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create the visual program.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Visual shader linking failed: ${message}`);
  }
  const uniforms = {
    resolution: gl.getUniformLocation(program, 'resolution'),
    time: gl.getUniformLocation(program, 'time'),
    colour: gl.getUniformLocation(program, 'colour'),
    shape: gl.getUniformLocation(program, 'shape'),
    water: gl.getUniformLocation(program, 'water'),
    ripples: gl.getUniformLocation(program, 'ripples[0]'),
    touchSeg: gl.getUniformLocation(program, 'touchSeg[0]'),
    touchWave: gl.getUniformLocation(program, 'touchWave[0]'),
    finger: gl.getUniformLocation(program, 'finger'),
  };
  let target = createVisualSynthState();
  let current = { ...target };
  let previousMs: number | null = null;
  let phase = 0;
  let waterSeconds = 0;
  const waterRipples = new WaterRipples();
  const touchWater = new TouchWater();
  const touchSample = (parameters: VisualSynthParameters) => ({ x: parameters.touchX, y: parameters.touchY, pressure: parameters.touchPressure });
  let frame = 0;
  let frames = 0;
  let disposed = false;
  const draw = (parameters: VisualSynthParameters, phaseSeconds: number, waterTime = waterSeconds): void => {
    if (disposed || gl.isContextLost()) return;
    frames++;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, phaseSeconds);
    gl.uniform4f(uniforms.colour, parameters.brightness, parameters.hue, parameters.saturation, parameters.warp);
    gl.uniform4f(uniforms.shape, parameters.zoom, parameters.symmetry, parameters.pattern, touchWater.activity);
    gl.uniform2f(uniforms.water, waterTime, parameters.ripple);
    gl.uniform4fv(uniforms.ripples, waterRipples.data);
    gl.uniform4fv(uniforms.touchSeg, touchWater.segments);
    gl.uniform4fv(uniforms.touchWave, touchWater.waves);
    gl.uniform4fv(uniforms.finger, touchWater.finger);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const change = (parameters: VisualSynthParameters, label: string, liveMidi = false): void => {
    // A live Ripples change launches a wavefront on every pattern. A snapshot (another tab, a resume) or a
    // reset never manufactures a splash merely because a saved value differs from the current one.
    if (liveMidi && parameters.ripple !== target.ripple) waterRipples.push(target.ripple, parameters.ripple, waterSeconds);
    else if (!liveMidi && parameters.ripple !== target.ripple) waterRipples.reset();
    // The fingertip (CC22/23/24) is applied the instant it arrives: no smoothing between a touch and its splash.
    const touched = parameters.touchX !== target.touchX || parameters.touchY !== target.touchY || parameters.touchPressure !== target.touchPressure;
    if (touched) {
      if (liveMidi) touchWater.receive(touchSample(parameters), waterSeconds);
      else touchWater.adopt(touchSample(parameters), waterSeconds);
    }
    target = { ...parameters };
    options.onChange?.(label, { ...target });
  };
  const api: VisualSynthRenderer = {
    receiveMidi(bytes) {
      const result = applyVisualSynthMidi(target, bytes);
      if (!result) return false;
      const resetAll = bytes[0] === 0xff || (bytes[0] & 0xf0) === 0xb0 && [120, 121, 123].includes(bytes[1]);
      if (resetAll) { phase = waterSeconds = 0; waterRipples.reset(); touchWater.reset(); }
      change(result.parameters, result.label, !resetAll);
      return true;
    },
    reset() {
      phase = waterSeconds = 0; waterRipples.reset(); touchWater.reset();
      previousMs = null;
      change(createVisualSynthState(), 'Reset · Ready');
    },
    setState(parameters) {
      if (isVisualSynthState(parameters)) change(parameters, 'Connected · Ready');
    },
    getState: () => ({ ...target }),
    getWaterDiagnostics: () => ({ pattern: target.pattern, depth: target.ripple, seconds: waterSeconds,
      waves: Array.from({ length: 6 }, (_, index) => { const offset = index * 4; return {
        x: waterRipples.data[offset]!, y: waterRipples.data[offset + 1]!,
        age: Math.max(0, waterSeconds - waterRipples.data[offset + 2]!), strength: waterRipples.data[offset + 3]!,
      }; }).filter(wave => Math.abs(wave.strength) > 0 && wave.age >= 0 && wave.age < 6),
    }),
    getTouchDiagnostics: () => touchWater.diagnostics(),
    stats: () => ({ frames, running: frame !== 0 }),
    render(nowMs) {
      const delta = previousMs === null ? 0 : Math.min(Math.max(nowMs - previousMs, 0), 100);
      previousMs = nowMs;
      // Reach 95% of a new value in 80 ms, regardless of display refresh rate.
      const weight = 1 - Math.exp(-delta / (80 / 3));
      for (const key of Object.keys(current) as (keyof VisualSynthParameters)[]) current[key] += (target[key] - current[key]) * weight;
      phase += delta / 1000 * current.speed * 2.5;
      waterSeconds += delta / 1000;
      current.pattern = target.pattern; // modes are discrete; never blend through unrelated patterns
      touchWater.frame(waterSeconds, delta / 1000, canvas.width / Math.max(canvas.height, 1));
      draw(current, phase);
    },
    renderAt(timeMs) { draw(target, Math.max(0, timeMs) / 1000 * target.speed * 2.5, Math.max(0, timeMs) / 1000); },
    start() {
      if (frame || disposed) return;
      const tick = (nowMs: number): void => {
        api.render(nowMs);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      previousMs = null;
    },
    dispose() {
      api.stop();
      disposed = true;
      gl.deleteProgram(program);
    },
  };
  api.renderAt(0);
  return api;
}
