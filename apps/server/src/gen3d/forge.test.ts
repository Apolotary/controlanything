import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayloadSchemas } from '@ce/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CallLog } from '../muse/callLog';
import { resolveMuseConfig } from '../muse/config';
import type { EditSet } from './editPatch';
import { createForge, ForgeInputError, type ForgeProgress } from './forge';
import { RECORDED_GEN3D_DIR } from './routes';
import { FORGE_LIGHT_DEVICE, FORGE_LIGHT_DRIVER, FORGE_LIGHT_VERIFIED, FORGE_OP1_DEVICE, FORGE_OP1_DRIVER, FORGE_OP1_VERIFIED } from './sampleDevices';
import { loadRecordedRuns } from './transport';
import { contentEvents, LIGHT_DRAFT, mockFetch, sseResponse } from './testkit';

const live = resolveMuseConfig({ MODEL_API_KEY: 'sk-test' });
const fixture = resolveMuseConfig({});
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ce-gen3d-'));
  tmps.push(d);
  return d;
};

const reply = (value: unknown) => () => sseResponse(contentEvents(typeof value === 'string' ? value : JSON.stringify(value)));
const forgeReq = (onProgress?: (p: ForgeProgress) => void) => ({ device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED, request: 'a dimmer with on/off and night light', onProgress });

const LEVER_EDIT: EditSet = {
  behaviors: [],
  controls: [],
  feedback: [],
  parts: [{ id: 'p_h_dim', kind: 'archetype', archetype: 'lever', controlId: 'h_dim', params: { length: 0.22, accent: '#FF2020' }, transform: { position: [-0.1, 0, 0] } }],
  remove: [],
  summary: 'the dimmer is a big red lever',
  title: '',
};

describe('forge: generate', () => {
  it('streams, verifies and compiles a hack set; every step carries model, effort and latency', async () => {
    const f = mockFetch([reply(LIGHT_DRAFT)]);
    const calls = new CallLog(() => {});
    const forge = createForge({ muse: live, fetchImpl: f.impl, callLog: calls });
    const steps: ForgeProgress[] = [];
    const r = await forge.forge(forgeReq((p) => steps.push(p)));
    expect(r.ok).toBe(true);
    expect(r.report).toMatchObject({ ok: true, attempts: 1 });
    expect(r.source).toBe('live');
    const ui = r.uiSpec!;
    expect(ui).toMatchObject({ specId: 'spec_card_light', cardId: 'card_light', driverId: 'drv_light', rev: 1, modelId: 'muse-spark-1.3', check: { ok: true, attempts: 1 } });
    // a valid @ce/protocol ui.spec payload
    expect(PayloadSchemas['ui.spec'].safeParse(ui).success).toBe(true);
    expect(ui.hackset.hacks.map((h) => h.id)).toEqual(['h_dim', 'h_warm', 'h_night', 'h_off', 'h_full']);
    expect(ui.hackset.hacks.find((h) => h.id === 'h_dim')).toMatchObject({ status: 'verified' });
    expect(ui.hackset.hacks.find((h) => h.id === 'h_warm')).toMatchObject({ status: 'uploading' });
    expect(ui.gen3d.controls.find((c) => c.id === 'h_dim')?.binding.args).toEqual({ hack: 'h_dim', drive: 'stepper' });
    expect(ui.gen3d.controls.find((c) => c.id === 'h_warm')?.armed).toBe(false);

    // the request: Spark, json_schema, low effort, stable system prompt first, no temperature
    const body = f.calls[0].body;
    expect(body).toMatchObject({ model: 'muse-spark-1.3', reasoning_effort: 'low', stream: true, response_format: { type: 'json_schema', json_schema: { name: 'ce_hackset' } } });
    expect(body.temperature).toBeUndefined();
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('ir.brighter');

    // progress: running -> one preview per hack as it streams -> answered -> verified -> deployed;
    // every step is a valid agent.step payload with model id, effort and source
    expect(steps.every((s) => s.model === 'muse-spark-1.3' && s.effort && s.source === 'live' && s.cardId === 'card_light')).toBe(true);
    for (const s of steps) {
      const { item: _item, ...wire } = s;
      expect(PayloadSchemas['agent.step'].safeParse(wire).success).toBe(true);
    }
    expect(steps.filter((s) => s.item).map((s) => s.item!.hack.id)).toEqual(['h_dim', 'h_warm', 'h_night', 'h_off', 'h_full']);
    expect(steps.filter((s) => s.phase === 'verify').map((s) => s.status)).toEqual(['ok']);
    expect(steps.at(-1)).toMatchObject({ phase: 'deploy', status: 'ok' });
    expect(steps.filter((s) => s.title.startsWith('Muse answered'))[0].latencyMs).toBeTypeOf('number');
    expect(calls.list()).toMatchObject([{ label: 'gen3d.forge', model: 'muse-spark-1.3', source: 'live', ok: true, effort: 'low', format: 'json_schema' }]);
    expect(forge.get('spec_card_light')?.rev).toBe(1);
  });

  it('repairs with the issues and the previous answer fed back, at medium effort', async () => {
    const bad = structuredClone(LIGHT_DRAFT);
    bad.hacks[2].commands[0].action = 'ir.strobe';
    const f = mockFetch([reply(bad), reply(LIGHT_DRAFT)]);
    const r = await createForge({ muse: live, fetchImpl: f.impl }).forge(forgeReq());
    expect(r.ok).toBe(true);
    expect(r.report.attempts).toBe(2);
    expect(r.report.history.map((h) => [h.attempt, h.effort, h.codes])).toEqual([
      [1, 'low', ['unknown_action']],
      [2, 'medium', []],
    ]);
    const second = f.calls[1].body;
    expect(second.reasoning_effort).toBe('medium');
    expect(second.messages[1].content).toContain('REPAIR');
    expect(second.messages[1].content).toContain('"ir.strobe" is not a driver action');
    expect(second.messages[1].content).toContain('PREVIOUS ANSWER');
    // the stable prefix is unchanged, so the prompt cache still applies
    expect(second.messages[0]).toEqual(f.calls[0].body.messages[0]);
  });

  it('gives up after two repairs and reports why', async () => {
    const f = mockFetch([reply('{"hacks": []}')]);
    const r = await createForge({ muse: live, fetchImpl: f.impl }).forge(forgeReq());
    expect(r.ok).toBe(false);
    expect(r.uiSpec).toBeUndefined();
    expect(r.report.attempts).toBe(3);
    expect(r.report.errors[0].stage).toBe('schema');
    expect(f.calls).toHaveLength(3);
  });

  it('aborts a whitespace loop and retries', async () => {
    const f = mockFetch([() => sseResponse(contentEvents(`{"hacks": [${' \r\n'.repeat(300)}`, 30)), reply(LIGHT_DRAFT)]);
    const r = await createForge({ muse: live, fetchImpl: f.impl }).forge(forgeReq());
    expect(r.ok).toBe(true);
    expect(r.report.history[0].codes).toEqual(['degenerate_output']);
  });

  it('refuses a request without a valid driver', async () => {
    const forge = createForge({ muse: live, fetchImpl: mockFetch([reply(LIGHT_DRAFT)]).impl });
    await expect(forge.forge({ device: FORGE_LIGHT_DEVICE, driver: { driverId: 'x' } as never })).rejects.toBeInstanceOf(ForgeInputError);
  });
});

describe('forge: edit, undo, redo, rearm', () => {
  async function forged() {
    const f = mockFetch([reply(LIGHT_DRAFT), reply(LEVER_EDIT)]);
    const forge = createForge({ muse: live, fetchImpl: f.impl });
    const g = await forge.forge(forgeReq());
    return { forge, f, g };
  }

  it('applies a spoken edit by id, proves untouched items are byte-identical, and keeps the hack set in line', async () => {
    const { forge, f, g } = await forged();
    const e = await forge.edit({ specId: g.uiSpec!.specId, instruction: 'make the dimmer a big red lever' });
    expect(e.ok).toBe(true);
    expect(e.uiSpec!.rev).toBe(2);
    expect(e.touched).toEqual(['parts:p_h_dim']);
    expect(e.untouchedIdentical).toBe(true);
    expect(e.uiSpec!.gen3d.parts.find((p) => p.id === 'p_h_dim')).toMatchObject({ archetype: 'lever', params: { accent: '#FF2020' } });
    expect(e.uiSpec!.hackset.hacks.find((h) => h.id === 'h_dim')?.control).toMatchObject({ archetype: 'lever' });
    expect(f.calls[1].body.response_format.json_schema.name).toBe('ce_gen3d_edit');
    expect(f.calls[1].body.messages[1].content).toContain('make the dimmer a big red lever');
  });

  it('undo republishes the earlier content as a new rev; redo goes forward; "undo" needs no model call', async () => {
    const { forge, f, g } = await forged();
    const id = g.uiSpec!.specId;
    await forge.edit({ specId: id, instruction: 'make the dimmer a big red lever' });
    const before = f.calls.length;
    const u = await forge.edit({ specId: id, instruction: 'Undo' });
    expect(u.history).toBe('undo');
    expect(f.calls.length).toBe(before);
    expect(u.uiSpec!.rev).toBe(3);
    expect(JSON.stringify(u.uiSpec!.gen3d.parts)).toBe(JSON.stringify(g.uiSpec!.gen3d.parts));
    const r = forge.redo(id);
    expect(r.uiSpec!.rev).toBe(4);
    expect(r.uiSpec!.gen3d.parts.find((p) => p.id === 'p_h_dim')?.archetype).toBe('lever');
    expect(forge.redo(id).ok).toBe(false);
  });

  it('rearms when new evidence arrives, without a model call', async () => {
    const { forge, f, g } = await forged();
    const n = f.calls.length;
    const ui = forge.rearm(g.uiSpec!.specId, { 'ir.warmer': 'pass', 'ir.cooler': 'pass' });
    expect(f.calls.length).toBe(n);
    expect(ui.rev).toBe(2);
    expect(ui.gen3d.controls.find((c) => c.id === 'h_warm')?.armed).toBe(true);
  });
});

describe('forge: record and replay (FIXTURE mode replays real recorded runs)', () => {
  it('records a live run and replays it through the same checks, labelled as recorded', async () => {
    const dir = tmp();
    const f = mockFetch([reply(LIGHT_DRAFT), reply(LEVER_EDIT)]);
    const liveForge = createForge({ muse: live, fetchImpl: f.impl, recordDir: dir });
    const g = await liveForge.forge(forgeReq());
    await liveForge.edit({ specId: g.uiSpec!.specId, instruction: 'make the dimmer a big red lever' });
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(2);

    const calls = new CallLog(() => {});
    const replay = createForge({ muse: fixture, replayDir: dir, replaySpeed: 0, callLog: calls });
    expect(replay.mode).toBe('fixture');
    const steps: ForgeProgress[] = [];
    const r = await replay.forge(forgeReq((p) => steps.push(p)));
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ source: 'fixture', recordedFrom: 'muse-spark-1.3' });
    expect(r.uiSpec!.hackset.hacks).toEqual(g.uiSpec!.hackset.hacks);
    expect(r.uiSpec!.gen3d.source).toBe('fixture');
    expect(steps.filter((s) => s.item)).toHaveLength(5);
    expect(steps.every((s) => s.source === 'fixture')).toBe(true);
    expect(calls.list()[0]).toMatchObject({ source: 'fixture', model: 'fixture', recordedFrom: 'muse-spark-1.3' });
    const e = await replay.edit({ specId: r.uiSpec!.specId, instruction: 'make the dimmer a big red lever' });
    expect(e.ok).toBe(true);
    expect(e.touched).toEqual(['parts:p_h_dim']);
  });

  it('says FIXTURE when there is nothing recorded for the device', async () => {
    const r = await createForge({ muse: fixture, replayDir: tmp(), replaySpeed: 0 }).forge(forgeReq());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/FIXTURE: no recorded generate run/);
  });
});

describe('committed recordings (what judges replay without a key)', () => {
  const SAMPLE: Record<string, { device: typeof FORGE_LIGHT_DEVICE; driver: typeof FORGE_LIGHT_DRIVER; verification: typeof FORGE_LIGHT_VERIFIED }> = {
    card_light: { device: FORGE_LIGHT_DEVICE, driver: FORGE_LIGHT_DRIVER, verification: FORGE_LIGHT_VERIFIED },
    card_op1f: { device: FORGE_OP1_DEVICE, driver: FORGE_OP1_DRIVER, verification: FORGE_OP1_VERIFIED },
  };
  const runs = loadRecordedRuns(RECORDED_GEN3D_DIR);

  it.each(runs.filter((r) => r.task === 'generate').map((r) => [r.cardId, r] as const))('%s: replays through the current checks', async (cardId, run) => {
    const target = SAMPLE[cardId];
    expect(target, `no sample driver for ${cardId}`).toBeDefined();
    const forge = createForge({ muse: fixture, replayDir: RECORDED_GEN3D_DIR, replaySpeed: 0 });
    const r = await forge.generate({ ...target, request: run.request });
    expect(r.report.errors).toEqual([]);
    expect(r).toMatchObject({ ok: true, source: 'fixture' });
    expect(r.recordedFrom).toMatch(/^muse-/);
    for (const edit of runs.filter((x) => x.task === 'edit' && x.cardId === cardId)) {
      const e = await forge.edit({ specId: r.uiSpec!.specId, instruction: edit.request });
      expect(e.report.errors).toEqual([]);
      expect(e.ok && e.untouchedIdentical).toBe(true);
    }
  });
});
