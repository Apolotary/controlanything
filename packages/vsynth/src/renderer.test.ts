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

describe('Mac visual synth Water renderer', () => {
  it('resumes an authoritative Water snapshot without replaying motion as a fresh wave', () => {
    const { synth } = renderer(); synth.receiveMidi([0xb0, 21, 20]); synth.receiveMidi([0xb0, 21, 60]);
    expect(synth.getWaterDiagnostics().waves).toHaveLength(1);
    synth.setState({ ...synth.getState(), ripple: .9 });
    expect(synth.getState()).toMatchObject({ pattern: 3, ripple: .9 });
    expect(synth.getWaterDiagnostics().waves).toEqual([]);
    synth.render(0); synth.render(100); synth.receiveMidi([0xb0, 21, 70]);
    expect(synth.getWaterDiagnostics().waves[0]?.strength).toBeLessThan(0); synth.dispose();
  });

  it('activates Water with no fabricated startup impulse, then creates bounded forward/back waves', () => {
    const { synth, gl } = renderer();
    synth.receiveMidi([0xb0, 21, 0]);
    expect(synth.getState()).toMatchObject({ pattern: 3, ripple: 0, warp: .4 });
    expect(synth.getWaterDiagnostics().waves).toEqual([]);
    synth.render(0); synth.render(100); synth.receiveMidi([0xb0, 21, 40]);
    expect(synth.getWaterDiagnostics().waves[0]?.strength).toBeGreaterThan(0);
    synth.render(200); synth.render(300); synth.receiveMidi([0xb0, 21, 10]);
    expect(synth.getWaterDiagnostics().waves.some(wave => wave.strength < 0)).toBe(true);
    const count = synth.getWaterDiagnostics().waves.length;
    synth.receiveMidi([0xb0, 21, 10]); expect(synth.getWaterDiagnostics().waves).toHaveLength(count);
    synth.renderAt(1000); expect(gl.uniform2f).toHaveBeenLastCalledWith('water', 1, 10 / 127);
    expect(gl.uniform4fv).toHaveBeenCalledWith('ripples[0]', expect.any(Float32Array));
    synth.reset(); expect(synth.getWaterDiagnostics().waves).toEqual([]); expect(synth.getState().pattern).toBe(0); synth.dispose();
  });
  it('does not turn ordinary Warp changes into water impulses', () => {
    const { synth } = renderer(); synth.receiveMidi([0xb0, 71, 127]);
    expect(synth.getState()).toMatchObject({ pattern: 0, warp: 1, ripple: .5 });
    expect(synth.getWaterDiagnostics().waves).toEqual([]); synth.dispose();
  });
});
