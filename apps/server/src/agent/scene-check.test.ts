import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkScene, dryRunScene, validateScene } from './scene-check';
import { FIXTURE_SCENE_FIELD, FIXTURE_SCENE_GALAXY } from './scene-fixture';
import { MuseAgent } from './muse-agent';
import type { ConnectorHost } from './connector-host';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('XR scene checks', () => {
  it('accepts the fixture scenes and sees them react', () => {
    const galaxy = dryRunScene(FIXTURE_SCENE_GALAXY);
    expect(galaxy.issues).toEqual([]);
    expect(galaxy.peak.point).toBeGreaterThan(1000);
    expect(galaxy.reactsToHands).toBe(true);
    const field = dryRunScene(FIXTURE_SCENE_FIELD, ['cc21', 'cc71', 'cc74']);
    expect(field.ok).toBe(true);
    expect(field.reactsToValues).toBe(true);
    expect(field.peak.line).toBeLessThanOrEqual(800);
  });

  it('refuses forbidden tokens, wrappers, regexes and programs that never draw', () => {
    expect(validateScene('fetch("https://x"); draw.point(0,0,0,0.01,0xffffff,1);').issues.map((i) => i.code)).toContain('forbidden');
    expect(validateScene('var a = this; draw.point(0,0,0,0.01,0xffffff,1);').ok).toBe(false);
    expect(validateScene('function scene(s, draw, mem) { draw.point(0,0,0,0.01,0xffffff,1); }').issues.map((i) => i.code)).toContain('program_wrapper');
    expect(validateScene('var x = 1 + 2;').issues.map((i) => i.code)).toContain('no_draw');
    expect(validateScene('draw.point(0,0,0,').issues.map((i) => i.code)).toContain('syntax');
  });

  it('dry-run catches null hands, NaN and endless loops', () => {
    expect(checkScene('draw.sphere(s.right.x, s.right.y, s.right.z, 0.02, 0xff00ff, 1);').issues.join(' ')).toMatch(/Guard null hands/);
    expect(checkScene('draw.point(NaN, 0, 0, 0.01, 0xffffff, 1);').issues.join(' ')).toMatch(/non-finite/);
    expect(checkScene('for (var i = 0; i >= 0; i++) {} draw.point(0,0,0,0.01,0xffffff,1);').issues.join(' ')).toMatch(/longer than/);
    const still = checkScene('draw.point(0, 0, 0, 0.01, 0xffffff, 1);');
    expect(still.ok).toBe(true);
    expect(still.notes.join(' ')).toMatch(/does not react to the hands/);
  });

  it('finish accepts a pure scene without a connector', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ce-agent-scene-')); dirs.push(workspace);
    const calls: [string, unknown][] = [
      ['finish', { title: 'Broken', explanation: 'x', scene: { code: 'draw.point(s.right.x, 0, 0, 0.01, 0xffffff, 1);' } }],
      ['finish', { title: 'Hand trails', explanation: 'Move your hands.', scene: { title: 'Hand trails', code: 'var h = s.right; if (h) draw.trail("r", h.tip.x, h.tip.y, h.tip.z, 0x40d8ff, 0.012); draw.point(0, 0, 0, 0.01, 0xffffff, 1);' } }],
    ];
    let i = 0; const progress: string[] = [];
    const agent = new MuseAgent({ mode: 'live', model: 'muse-spark-1.3', workspace, repoRoot: workspace,
      host: { deploy: async () => ({ ok: true, output: [] }), has: () => false } as unknown as ConnectorHost,
      stream: { model: 'muse-spark-1.3', stream: async () => { const [name, args] = calls[i++]!; return { content: '', model: 'muse-spark-1.3', latencyMs: 0, chunks: 0, finishReason: 'tool_calls', toolCalls: [{ id: String(i), name, arguments: JSON.stringify(args), index: 0, startedMs: 0, doneMs: 0 }] } as never; } },
    });
    const result = await agent.build('test', { cardId: 'test', deviceName: 'Lamp', companion: { online: false, midiOutputs: [], visualsOpen: false, musicalOpen: false } }, 'Show my hand speed as glowing trails', (_phase, payload) => { if (payload?.code) progress.push(payload.code); });
    expect(result.ok).toBe(true); expect(i).toBe(2);
    expect(progress.join('\n')).toMatch(/scene: the scene threw/);
    expect(result.scene?.title).toBe('Hand trails');
    expect(result.actions).toEqual([]);
  });
});
