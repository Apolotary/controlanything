import { describe, expect, it, vi } from 'vitest';
import { createVisualSynth } from './renderer.js';

function renderer() {
  const gl = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, TRIANGLES: 5,
    createShader: () => ({}), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: () => true,
    deleteShader: vi.fn(), createProgram: () => ({}), attachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: () => true,
    getUniformLocation: (_program: unknown, name: string) => name, isContextLost: () => false,
    viewport: vi.fn(), useProgram: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(), uniform4f: vi.fn(), uniform4fv: vi.fn(), drawArrays: vi.fn(), deleteProgram: vi.fn() };
  const synth = createVisualSynth({ width: 100, height: 100, getContext: () => gl } as unknown as HTMLCanvasElement);
  return { synth, gl };
}

describe('Mac visual synth ripples renderer', () => {
  it('resumes an authoritative snapshot without replaying motion as a fresh wave', () => {
    const { synth } = renderer(); synth.receiveMidi([0xc0, 3]); synth.receiveMidi([0xb0, 21, 20]); synth.render(0); synth.render(200); synth.receiveMidi([0xb0, 21, 60]);
    expect(synth.getWaterDiagnostics().waves).toHaveLength(2);
    synth.setState({ ...synth.getState(), ripple: .9 });
    expect(synth.getState()).toMatchObject({ pattern: 3, ripple: .9 });
    expect(synth.getWaterDiagnostics().waves).toEqual([]);
    synth.render(0); synth.render(100); synth.receiveMidi([0xb0, 21, 70]);
    expect(synth.getWaterDiagnostics().waves[0]?.strength).toBeLessThan(0); synth.dispose();
  });

  it('makes bounded forward/back ripple waves on every pattern and keeps the selected pattern', () => {
    const { synth, gl } = renderer();
    for (const pattern of [0, 1, 2]) {
      synth.receiveMidi([0xc0, pattern]); synth.render(0); synth.render(300); synth.receiveMidi([0xb0, 21, pattern * 40]);
      expect(synth.getState().pattern).toBe(pattern);
      expect(synth.getWaterDiagnostics().waves.length).toBeGreaterThan(0);
      synth.reset();
    }
    synth.receiveMidi([0xb0, 21, 0]);
    expect(synth.getState()).toMatchObject({ pattern: 0, ripple: 0, warp: .4 });
    synth.render(0); synth.render(100); synth.receiveMidi([0xb0, 21, 40]);
    expect(synth.getWaterDiagnostics().waves.some(wave => wave.strength > 0)).toBe(true);
    synth.render(200); synth.render(300); synth.receiveMidi([0xb0, 21, 10]);
    expect(synth.getWaterDiagnostics().waves.some(wave => wave.strength < 0)).toBe(true);
    const count = synth.getWaterDiagnostics().waves.length;
    synth.receiveMidi([0xb0, 21, 10]); expect(synth.getWaterDiagnostics().waves).toHaveLength(count);
    synth.renderAt(1000); expect(gl.uniform2f).toHaveBeenLastCalledWith('water', 1, 10 / 127);
    expect(gl.uniform4fv).toHaveBeenCalledWith('ripples[0]', expect.any(Float32Array));
    synth.reset(); expect(synth.getWaterDiagnostics().waves).toEqual([]); expect(synth.getState().pattern).toBe(0); synth.dispose();
  });
  it('touches the water on every pattern: a splash on the first frame after touch-down, a wake while it drags, hover only a glow', () => {
    const { synth, gl } = renderer();
    for (const pattern of [0, 1, 2, 3]) {
      synth.receiveMidi([0xc0, pattern]); synth.render(0); synth.render(16);
      synth.receiveMidi([0xb0, 22, 32]); synth.receiveMidi([0xb0, 23, 95]); synth.receiveMidi([0xb0, 24, 8]); // hovering
      synth.render(32); synth.render(48);
      expect(synth.getTouchDiagnostics()).toMatchObject({ phase: 'hover', waves: [] });
      expect(synth.getTouchDiagnostics().glow).toBeGreaterThan(0);
      synth.receiveMidi([0xb0, 24, 100]);                        // touch-down at the canvas's top-left quarter
      synth.render(64);                                           // ONE frame later the splash is in the uniforms
      const [splash] = synth.getTouchDiagnostics().waves;
      expect(splash).toMatchObject({ x: expect.closeTo(32 / 127, 5), y: expect.closeTo(95 / 127, 5), big: 1 });
      expect(gl.uniform4fv).toHaveBeenLastCalledWith('finger', expect.any(Float32Array));
      expect(gl.uniform4fv).toHaveBeenCalledWith('touchSeg[0]', expect.any(Float32Array));
      expect(gl.uniform4fv).toHaveBeenCalledWith('touchWave[0]', expect.any(Float32Array));
      for (let i = 1; i <= 30; i++) { synth.receiveMidi([0xb0, 22, 32 + i * 2]); synth.render(64 + i * 16); }
      expect(synth.getTouchDiagnostics().waves.some((wave) => wave.big === 0)).toBe(true);
      expect(synth.getState().pattern).toBe(pattern);            // touching never changes the pattern
      synth.receiveMidi([0xb0, 24, 0]); synth.render(700);
      expect(synth.getTouchDiagnostics().phase).toBe('lifted');
      synth.reset(); expect(synth.getTouchDiagnostics()).toMatchObject({ waves: [], glow: 0, phase: 'lifted' });
    }
    synth.dispose();
  });

  it('keeps the fingertip out of the Ripples (CC21) wavefronts, and a snapshot never splashes', () => {
    const { synth } = renderer();
    synth.receiveMidi([0xb0, 24, 100]); synth.render(0); synth.render(16);
    expect(synth.getWaterDiagnostics().waves).toEqual([]);
    synth.receiveMidi([0xb0, 24, 0]); synth.render(32);
    synth.setState({ ...synth.getState(), touchX: .3, touchY: .6, touchPressure: .9 });
    synth.render(48); synth.render(64);
    expect(synth.getTouchDiagnostics()).toMatchObject({ phase: 'touching', x: .3, y: .6, waves: [] });
    synth.receiveMidi([0xb0, 120, 0]); expect(synth.getTouchDiagnostics()).toMatchObject({ phase: 'lifted', waves: [] });
    synth.dispose();
  });

  it('does not turn ordinary Warp changes into water impulses', () => {
    const { synth } = renderer(); synth.receiveMidi([0xb0, 71, 127]);
    expect(synth.getState()).toMatchObject({ pattern: 0, warp: 1, ripple: .5 });
    expect(synth.getWaterDiagnostics().waves).toEqual([]); synth.dispose();
  });
});
