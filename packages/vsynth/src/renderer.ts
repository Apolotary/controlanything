import { applyVisualSynthMidi, createVisualSynthState, isVisualSynthState } from './state.js';
import type { VisualSynthParameters } from './state.js';
import { WaterRipples } from './ripples.js';

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
uniform vec4 shape; // zoom, symmetry, pattern, spare
uniform vec2 water; // real animation seconds, forward/back depth value
uniform vec4 ripples[6]; // origin xy, start time, signed strength
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
// An analytic water surface: expanding, damped wavefronts with lighting from the
// surface gradient. Depth CC motion launches the wavefronts; Warp is not involved.
vec3 waterSurface(vec2 p) {
  vec2 gradient = vec2(0.0);
  float height = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = max(0.0, water.x - ripples[i].z);
    vec2 offset = p - ripples[i].xy;
    float radius = max(.0001, length(offset));
    float front = radius - age * .72;
    float envelope = exp(-front * front * 24.0 - age * 1.15);
    float wave = sin(front * 35.0);
    float strength = ripples[i].w * envelope;
    height += wave * strength;
    gradient += offset / radius * strength * (35.0 * cos(front * 35.0) - 48.0 * front * wave);
  }
  vec3 normal = normalize(vec3(-gradient * .52, 1.0));
  vec3 light = normalize(vec3(-.45, .65, .9));
  float diffuse = max(0.0, dot(normal, light));
  float sheen = pow(max(0.0, dot(normal, normalize(light + vec3(0, 0, 1)))), 36.0);
  float caustic = pow(.5 + .5 * sin(p.x * 7.0 + height * 18.0 + .25 * water.x)
    * cos(p.y * 9.0 - height * 20.0 - .18 * water.x), 5.0);
  vec3 deep = vec3(.008, .065, .13), shallow = vec3(.025, .48, .66);
  vec3 pool = mix(deep, shallow, .18 + .28 * water.y + .28 * diffuse);
  pool += vec3(.18, .46, .50) * caustic * .18;
  pool += vec3(.62, .90, 1.0) * sheen * .72;
  pool *= .45 + colour.x * .75;
  return pool;
}
void main() {
  vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / max(resolution.y, 1.0);
  if (shape.z > 2.5) { outputColour = vec4(waterSurface(p), 1.0); return; }
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
  outputColour = vec4(mix(base, ribbon, edge * 0.52), 1.0);
}`;

export interface VisualSynthRenderer {
  receiveMidi(bytes: readonly number[]): boolean;
  reset(): void;
  setState(parameters: VisualSynthParameters): void;
  getState(): VisualSynthParameters;
  /** Read-only evidence for the actual rendered effect; not a capability or control API. */
  getWaterDiagnostics(): { pattern: number; depth: number; seconds: number; waves: { x: number; y: number; age: number; strength: number }[] };
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
  };
  let target = createVisualSynthState();
  let current = { ...target };
  let previousMs: number | null = null;
  let phase = 0;
  let waterSeconds = 0;
  const waterRipples = new WaterRipples();
  let frame = 0;
  let disposed = false;
  const draw = (parameters: VisualSynthParameters, phaseSeconds: number, waterTime = waterSeconds): void => {
    if (disposed || gl.isContextLost()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, phaseSeconds);
    gl.uniform4f(uniforms.colour, parameters.brightness, parameters.hue, parameters.saturation, parameters.warp);
    gl.uniform4f(uniforms.shape, parameters.zoom, parameters.symmetry, parameters.pattern, 0);
    gl.uniform2f(uniforms.water, waterTime, parameters.ripple);
    gl.uniform4fv(uniforms.ripples, waterRipples.data);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const change = (parameters: VisualSynthParameters, label: string, liveMidi = false): void => {
    // The first activation establishes a baseline. It must not manufacture a
    // large splash merely because a saved value differs from the initial midpoint.
    if (liveMidi && parameters.pattern === 3 && target.pattern === 3) waterRipples.push(target.ripple, parameters.ripple, waterSeconds);
    else if (parameters.pattern !== target.pattern || !liveMidi && parameters.ripple !== target.ripple) waterRipples.reset();
    target = { ...parameters };
    options.onChange?.(label, { ...target });
  };
  const api: VisualSynthRenderer = {
    receiveMidi(bytes) {
      const result = applyVisualSynthMidi(target, bytes);
      if (!result) return false;
      if (bytes[0] === 0xff || (bytes[0] & 0xf0) === 0xb0 && [120, 121, 123].includes(bytes[1])) { phase = waterSeconds = 0; waterRipples.reset(); }
      change(result.parameters, result.label, true);
      return true;
    },
    reset() {
      phase = waterSeconds = 0; waterRipples.reset();
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
    render(nowMs) {
      const delta = previousMs === null ? 0 : Math.min(Math.max(nowMs - previousMs, 0), 100);
      previousMs = nowMs;
      // Reach 95% of a new value in 80 ms, regardless of display refresh rate.
      const weight = 1 - Math.exp(-delta / (80 / 3));
      for (const key of Object.keys(current) as (keyof VisualSynthParameters)[]) current[key] += (target[key] - current[key]) * weight;
      phase += delta / 1000 * current.speed * 2.5;
      waterSeconds += delta / 1000;
      current.pattern = target.pattern; // modes are discrete; never blend through unrelated patterns
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
