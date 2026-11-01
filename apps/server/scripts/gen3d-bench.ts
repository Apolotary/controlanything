/**
 * Live benchmark of 3D control generation on the Meta Model API (costs real money; hard cost cap), on the
 * gen3d-draft/0 schema in src/gen3d/draft/ (research/12-gen3d-generation.md has the results).
 *   npx tsx apps/server/scripts/gen3d-bench.ts --plan smoke|full [--cap 2.0] [--concurrency 4] [--out DIR]
 * Measures, per model x mode (json_schema | streamed tool calls) x reasoning_effort: latency, time to the first
 * visible item, schema validity, deterministic checks (bindings, geometry, safety) and request-specific checks.
 * Reads MODEL_API_KEY from the repo-root .env; never prints it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { museResponseFormat } from '@ce/protocol';
import { REPO_ROOT, loadDotEnv } from '../src/config';
import { resolveMuseConfig, type ReasoningEffort } from '../src/muse';
import type { DeviceCardPayload } from '@ce/protocol';
import type { DeviceDriver, Issue } from '../src/gen3d/draft/driver';
import { buildMessages, type GenMode, type GenTask } from '../src/gen3d/draft/prompt';
import { costUsd, type StreamMessage, type StreamUsage, StreamClient } from '../src/gen3d/stream';
import { TopLevelItemScanner } from '../src/gen3d/partial';
import { catalogTable } from '../src/gen3d/draft/catalog';
import { BASELINE_OP1_SPEC } from '../src/gen3d/draft/baseline';
import { applyDraftPatch, changedIds, patchSetToPatch } from '../src/gen3d/draft/patch';
import { DRAFT_VERSION, Patch, PatchSet, Spec } from '../src/gen3d/draft/spec';
import { SpecBuilder, toolDefs } from '../src/gen3d/draft/tools';
import { verifySpec } from '../src/gen3d/draft/verify';
import { LIGHT_CARD, LIGHT_DRIVER, OP1_CARD, OP1_DRIVER } from '../src/gen3d/draft/benchDevices';

loadDotEnv();
const cfg = resolveMuseConfig(process.env);
if (cfg.mode !== 'live') {
  console.log('FIXTURE mode (no MODEL_API_KEY): the benchmark needs live calls.');
  process.exit(0);
}

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const PLAN = arg('plan', 'smoke');
const PATCH_SHAPE = arg('patch', 'ops'); // ops = flat PatchOp list, set = PatchSet collections
const CAP = Number(arg('cap', '2.0'));
const CONCURRENCY = Number(arg('concurrency', '4'));
const OUT = arg('out', join(REPO_ROOT, 'research/gen3d-bench'));
mkdirSync(join(OUT, 'runs'), { recursive: true });

const kit = { version: DRAFT_VERSION, catalogTable };
const client = new StreamClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeoutMs: 240_000 });

// --- cases -----------------------------------------------------------------------------------

interface Case {
  id: string;
  task: GenTask;
  card: DeviceCardPayload;
  target: DeviceDriver;
  room: DeviceDriver[];
  request: string;
  current?: Spec;
}

const CASES: Record<string, Case> = {
  op1_knobs: { id: 'op1_knobs', task: 'generate', card: OP1_CARD, target: OP1_DRIVER, room: [OP1_DRIVER], request: "four knobs matching the OP-1 Field's encoders for its synth parameters" },
  light_dimmer: { id: 'light_dimmer', task: 'generate', card: LIGHT_CARD, target: LIGHT_DRIVER, room: [LIGHT_DRIVER], request: 'a dimmer for an IR ceiling light with on/off and night light' },
  op1_lever_edit: { id: 'op1_lever_edit', task: 'edit', card: OP1_CARD, target: OP1_DRIVER, room: [OP1_DRIVER], request: 'make the resonance control a big red lever', current: BASELINE_OP1_SPEC },
  light_hacks: { id: 'light_hacks', task: 'generate', card: LIGHT_CARD, target: LIGHT_DRIVER, room: [LIGHT_DRIVER, OP1_DRIVER], request: 'generate a hack set for the Koizumi IR ceiling light' },
  op1_hacks: { id: 'op1_hacks', task: 'generate', card: OP1_CARD, target: OP1_DRIVER, room: [OP1_DRIVER, LIGHT_DRIVER], request: 'generate a hack set for the OP-1 Field' },
};

// --- request-specific checks ----------------------------------------------------------------------

function hsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}
const COLOUR: Record<string, (c: ReturnType<typeof hsl>) => boolean> = {
  blue: (c) => c.h >= 190 && c.h <= 260 && c.s >= 0.35,
  green: (c) => c.h >= 80 && c.h <= 170 && c.s >= 0.3,
  white: (c) => c.s <= 0.3 && c.l >= 0.75,
  orange: (c) => c.h >= 10 && c.h <= 50 && c.s >= 0.5,
  red: (c) => (c.h <= 15 || c.h >= 340) && c.s >= 0.45 && c.l >= 0.2 && c.l <= 0.75,
};
const looks = (name: string, ...hexes: string[]) => hexes.some((h) => /^#[0-9a-f]{6}$/i.test(h) && COLOUR[name](hsl(h)));

const calls = (s: Spec) => [...s.controls.map((c) => c.binding.action), ...s.hacks.flatMap((h) => h.steps.map((x) => x.action))];

function requestChecks(c: Case, s: Spec): { ok: boolean; notes: string[]; collateral?: string[] } {
  const notes: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) notes.push(msg);
  };
  switch (c.id) {
    case 'op1_knobs': {
      const enc = s.controls.filter((x) => x.binding.action === 'encoder.set');
      need(enc.length === 4, `${enc.length} controls bound to encoder.set (want 4)`);
      const colours = new Set<string>();
      for (const ctl of enc) {
        const e = ctl.binding.args.find((a) => a.name === 'encoder')?.value;
        if (typeof e === 'string') colours.add(e);
        const o = s.objects.find((x) => x.controlId === ctl.id);
        need(Boolean(o && (o.archetype === 'knob' || o.archetype === 'dial')), `${ctl.id}: object is ${o?.archetype ?? 'missing'} (want knob)`);
        if (o && typeof e === 'string' && COLOUR[e]) need(looks(e, o.material.color, o.material.emissive), `${ctl.id}: colour ${o.material.color} does not look ${e}`);
      }
      need(colours.size === 4, `encoders covered: ${[...colours].join(',') || 'none'}`);
      break;
    }
    case 'light_dimmer': {
      need(s.controls.some((x) => x.binding.action === 'light.level' && x.binding.valueArg === 'level' && x.kind !== 'momentary'), 'no dimmer control bound to light.level/level');
      const onOff = s.controls.some((x) => x.binding.action === 'light.power' && x.binding.valueArg === 'on') || (calls(s).includes('light.on') && calls(s).includes('light.off'));
      need(onOff, 'no on/off (toggle on light.power or both light.on and light.off)');
      need(calls(s).includes('light.night'), 'nothing calls light.night');
      if (s.anchor.target !== 'panel') notes.push(`(soft) anchor is ${s.anchor.target}, panel expected for a ceiling light`);
      break;
    }
    case 'op1_lever_edit': {
      const ctl = s.controls.find((x) => x.id === 'resonance');
      need(Boolean(ctl), 'resonance control is gone');
      const o = s.objects.find((x) => x.controlId === 'resonance');
      need(o?.archetype === 'lever', `resonance object is ${o?.archetype ?? 'missing'} (want lever)`);
      need(Boolean(o && looks('red', o.material.color)), `resonance colour ${o?.material.color} is not red`);
      need((o?.scale ?? 0) >= 1.3, `resonance scale ${o?.scale} is not big (>= 1.3)`);
      const base = BASELINE_OP1_SPEC.controls.find((x) => x.id === 'resonance')!;
      need(JSON.stringify(ctl?.binding) === JSON.stringify(base.binding), 'resonance binding changed');
      const mine = new Set(['resonance', 'resonance_knob', ...(o ? [o.id] : [])]);
      const collateral = changedIds(BASELINE_OP1_SPEC, s).filter((id) => !mine.has(id));
      if (collateral.length) notes.push(`(info) also changed: ${collateral.join(', ')}`);
      return { ok: !notes.some((n) => !n.startsWith('(')), notes, collateral };
    }
    case 'light_hacks': {
      need(s.hacks.length >= 3, `${s.hacks.length} hacks (want >= 3)`);
      need(s.hacks.some((h) => h.steps.some((x) => x.action === 'light.off' || (x.action === 'light.power' && x.args.some((a) => a.value === false)))), 'no lights-out hack');
      need(s.hacks.some((h) => h.steps.some((x) => x.action === 'light.night')), 'no night-light hack');
      need(s.hacks.filter((h) => h.expect.sensor === 'camera').length >= Math.min(3, s.hacks.length), 'hacks should expect a camera effect');
      need(s.controls.length >= 1, 'no live control');
      break;
    }
    case 'op1_hacks': {
      need(s.hacks.length >= 3, `${s.hacks.length} hacks (want >= 3)`);
      need(s.hacks.filter((h) => h.expect.sensor === 'mic').length >= 2, 'fewer than 2 hacks expect a mic effect');
      need(s.hacks.some((h) => h.steps.length >= 3), 'no multi-step hack (sweep/sequence)');
      need(s.controls.length >= 1, 'no live control');
      break;
    }
  }
  return { ok: !notes.some((n) => !n.startsWith('(')), notes };
}

// --- one run ---------------------------------------------------------------------------------

interface Cell {
  model: string;
  mode: GenMode;
  effort: ReasoningEffort;
  caseId: string;
  rep: number;
}

interface RunResult {
  cell: Cell;
  ok: boolean;
  error?: string;
  latencyMs: number;
  ttftMs?: number;
  firstItemMs?: number;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  maxCallsPerTurn: number;
  usage: StreamUsage;
  costUsd: number;
  finish: string[];
  parsed: boolean;
  schemaOk: boolean;
  errors: string[];
  warnings: string[];
  checksOk: boolean;
  requestOk: boolean;
  requestNotes: string[];
  collateral?: string[];
  keyOrder?: string[];
  summary?: { hacks: string[]; controls: string[]; daemons: string[]; anchor?: string };
}

const fmtIssue = (i: Issue) => `${i.code} ${i.path}: ${i.message}`;
const maxTokens = (model: string, effort: ReasoningEffort) => (model.startsWith('muse-wonder') ? (effort === 'low' ? 12_000 : 16_000) : effort === 'low' ? 12_000 : effort === 'medium' ? 24_000 : 32_000);

function addUsage(a: StreamUsage, b?: StreamUsage): StreamUsage {
  if (!b) return a;
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens, cachedTokens: a.cachedTokens + b.cachedTokens };
}

async function runCell(cell: Cell): Promise<RunResult> {
  const c = CASES[cell.caseId];
  const input = { card: c.card, target: c.target, room: c.room, request: c.request, current: c.current };
  const messages: StreamMessage[] = buildMessages(kit, cell.mode, c.task, input);
  const ctx = { target: c.target, room: c.room };
  const started = Date.now();
  const r: RunResult = {
    cell,
    ok: false,
    latencyMs: 0,
    turns: 0,
    toolCalls: 0,
    toolFailures: 0,
    maxCallsPerTurn: 0,
    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    costUsd: 0,
    finish: [],
    parsed: false,
    schemaOk: false,
    errors: [],
    warnings: [],
    checksOk: false,
    requestOk: false,
    requestNotes: [],
  };
  const raw: Record<string, unknown> = { cell, request: c.request };
  let spec: Spec | undefined;
  try {
    if (cell.mode === 'json') {
      const schema = c.task === 'edit' ? (PATCH_SHAPE === 'set' ? PatchSet : Patch) : Spec;
      const rf = museResponseFormat(c.task === 'edit' ? 'gen3d_patch' : 'gen3d_spec', schema);
      const scanner = new TopLevelItemScanner();
      const res = await client.stream(
        { model: cell.model, messages, responseFormat: rf as unknown as Record<string, unknown>, reasoningEffort: cell.effort, maxTokens: maxTokens(cell.model, cell.effort), promptCacheKey: 'ce-gen3d-draft' },
        {
          onContent: (_d, soFar) => {
            if (r.firstItemMs === undefined && scanner.push(soFar).length) r.firstItemMs = Date.now() - started;
          },
        },
      );
      r.turns = 1;
      r.ttftMs = res.ttftMs;
      r.usage = addUsage(r.usage, res.usage);
      r.finish.push(res.finishReason ?? '?');
      raw.content = res.content;
      let value: unknown;
      try {
        value = JSON.parse(res.content);
        r.parsed = true;
        r.keyOrder = value && typeof value === 'object' ? Object.keys(value as object) : undefined;
      } catch {
        r.errors.push(`not JSON (finish=${res.finishReason}, ${res.content.length} chars)`);
      }
      if (r.parsed && c.task === 'edit') {
        const p = PATCH_SHAPE === 'set' ? PatchSet.safeParse(value) : Patch.safeParse(value);
        if (!p.success) r.errors.push(...p.error.issues.slice(0, 10).map((i) => `schema ${i.path.join('.')}: ${i.message}`));
        else {
          const asOps = PATCH_SHAPE === 'set' ? patchSetToPatch(p.data as PatchSet) : (p.data as Patch);
          const applied = applyDraftPatch(c.current!, asOps);
          r.errors.push(...applied.errors);
          spec = applied.spec;
          raw.patch = p.data;
        }
      } else if (r.parsed) {
        const s = Spec.safeParse(value);
        if (!s.success) r.errors.push(...s.error.issues.slice(0, 10).map((i) => `schema ${i.path.join('.')}: ${i.message}`));
        else spec = s.data;
      }
    } else {
      const builder = new SpecBuilder(c.card, c.current ? structuredClone(c.current) : undefined);
      const tools = toolDefs(c.task === 'edit' ? undefined : ['add_control', 'bind', 'add_hack', 'add_daemon', 'add_part', 'set_material', 'done']);
      const turns: unknown[] = [];
      for (let turn = 1; turn <= 4; turn++) {
        const res = await client.stream(
          { model: cell.model, messages, tools, parallelToolCalls: true, reasoningEffort: cell.effort, maxTokens: maxTokens(cell.model, cell.effort), promptCacheKey: 'ce-gen3d-draft' },
          {
            onToolCall: (tc) => {
              if (r.firstItemMs === undefined && tc.name === (c.task === 'edit' ? tc.name : 'add_control')) r.firstItemMs = Date.now() - started;
            },
          },
        );
        r.turns = turn;
        r.ttftMs ??= res.ttftMs;
        r.usage = addUsage(r.usage, res.usage);
        r.finish.push(res.finishReason ?? '?');
        r.maxCallsPerTurn = Math.max(r.maxCallsPerTurn, res.toolCalls.length);
        const outcomes = res.toolCalls.map((tc) => ({ tc, out: builder.apply(tc.name, tc.arguments) }));
        r.toolCalls += outcomes.length;
        r.toolFailures += outcomes.filter((o) => !o.out.ok).length;
        turns.push({ content: res.content, calls: outcomes.map((o) => ({ name: o.tc.name, args: o.tc.arguments, result: o.out.result, at: [o.tc.startedMs, o.tc.doneMs] })) });
        if (!res.toolCalls.length) break;
        messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });
        for (const o of outcomes) messages.push({ role: 'tool', tool_call_id: o.tc.id, content: o.out.result });
        if (builder.done && outcomes.every((o) => o.out.ok)) break;
      }
      raw.turns = turns;
      r.parsed = true;
      if (!builder.done) r.warnings.push('done was never called');
      const s = Spec.safeParse(builder.spec);
      if (!s.success) r.errors.push(...s.error.issues.slice(0, 10).map((i) => `schema ${i.path.join('.')}: ${i.message}`));
      else spec = s.data;
    }
    r.ok = true;
    if (spec) {
      r.schemaOk = true;
      const v = verifySpec(spec, ctx);
      r.errors.push(...v.issues.filter((i) => i.severity === 'error').map(fmtIssue));
      r.warnings.push(...v.issues.filter((i) => i.severity === 'warn').map(fmtIssue));
      r.checksOk = !v.issues.some((i) => i.severity === 'error');
      const rq = requestChecks(c, spec);
      r.requestOk = rq.ok;
      r.requestNotes = rq.notes;
      r.collateral = rq.collateral;
      r.summary = { hacks: spec.hacks.map((h) => `${h.name} [${h.steps.map((x) => x.action).join('>')}] ${h.expect.sensor}:${h.expect.effect}`), controls: spec.controls.map((x) => `${x.label}(${x.kind}) ${x.binding.action}`), daemons: spec.daemons.map((d) => `${d.name}: ${d.source.cardId}.${d.source.signal} -> ${d.target.cardId}.${d.target.action} @${d.maxRateHz}Hz`), anchor: spec.anchor.target };
      raw.spec = spec;
    }
  } catch (e) {
    r.error = (e as Error).message;
  }
  r.latencyMs = Date.now() - started;
  r.costUsd = costUsd(cell.model, r.usage);
  raw.result = r;
  writeFileSync(join(OUT, 'runs', `${cell.model}.${cell.mode}.${cell.effort}.${cell.caseId}${PATCH_SHAPE === 'set' && c.task === 'edit' ? '.set' : ''}.r${cell.rep}.json`), `${JSON.stringify(raw, null, 2)}\n`);
  return r;
}

// --- plan ------------------------------------------------------------------------------------

const SPARK = 'muse-spark-1.3';
const WONDER = 'muse-wonder-1.0';
const ALL = Object.keys(CASES);

function cells(model: string, mode: GenMode, effort: ReasoningEffort, caseIds: string[], rep = 1): Cell[] {
  return caseIds.map((caseId) => ({ model, mode, effort, caseId, rep }));
}

function plan(): Cell[] {
  if (PLAN === 'smoke') return cells(SPARK, 'json', 'low', ['light_dimmer']);
  if (PLAN === 'smoke-tools') return cells(SPARK, 'tools', 'low', ['light_dimmer']);
  if (PLAN === 'edit-fix') return [1, 2, 3].flatMap((rep) => cells(SPARK, 'json', 'low', ['op1_lever_edit'], rep));
  if (PLAN === 'full') {
    return [
      // coverage first, so every configuration gets data before the cap; repeats of the likely defaults early
      ...cells(SPARK, 'json', 'low', ALL),
      ...cells(SPARK, 'json', 'medium', ALL),
      ...cells(SPARK, 'tools', 'low', ALL),
      ...cells(WONDER, 'json', 'low', ALL),
      ...cells(SPARK, 'json', 'high', ALL),
      ...cells(SPARK, 'json', 'low', ALL, 2),
      ...cells(SPARK, 'json', 'medium', ALL, 2),
      ...cells(SPARK, 'tools', 'medium', ALL),
      ...cells(WONDER, 'tools', 'low', ['op1_knobs', 'light_hacks']),
      ...cells(WONDER, 'json', 'medium', ['op1_knobs', 'light_hacks']),
      ...cells(SPARK, 'tools', 'high', ['op1_knobs', 'light_hacks']),
    ];
  }
  throw new Error(`unknown plan ${PLAN}`);
}

const EST: Record<string, number> = { [`${SPARK}:low`]: 0.016, [`${SPARK}:medium`]: 0.03, [`${SPARK}:high`]: 0.06, [`${WONDER}:low`]: 0.07, [`${WONDER}:medium`]: 0.14 };

async function main() {
  const queue = plan();
  const results: RunResult[] = [];
  let spent = 0;
  let inflight = 0;
  console.log(`plan=${PLAN} runs=${queue.length} cap=$${CAP} concurrency=${CONCURRENCY}`);
  await new Promise<void>((resolve) => {
    const next = () => {
      while (inflight < CONCURRENCY && queue.length) {
        const cell = queue.shift()!;
        const est = EST[`${cell.model}:${cell.effort}`] * (cell.mode === 'tools' ? 2 : 1);
        if (spent + est * (inflight + 1) > CAP) {
          console.log(`skip (cap) ${cell.model} ${cell.mode} ${cell.effort} ${cell.caseId} r${cell.rep}`);
          continue;
        }
        inflight++;
        runCell(cell).then((r) => {
          inflight--;
          spent += r.costUsd;
          results.push(r);
          console.log(
            `${r.ok ? 'ok ' : 'ERR'} ${cell.model} ${cell.mode.padEnd(5)} ${cell.effort.padEnd(6)} ${cell.caseId.padEnd(15)} r${cell.rep} ${(r.latencyMs / 1000).toFixed(1)}s first=${r.firstItemMs ? (r.firstItemMs / 1000).toFixed(1) : '-'}s schema=${r.schemaOk ? 'Y' : 'n'} checks=${r.checksOk ? 'Y' : 'n'} request=${r.requestOk ? 'Y' : 'n'} out=${r.usage.completionTokens}(r${r.usage.reasoningTokens}) $${r.costUsd.toFixed(4)} total=$${spent.toFixed(3)}${r.error ? ` ERROR ${r.error.slice(0, 160)}` : ''}`,
          );
          if (!queue.length && !inflight) resolve();
          else next();
        });
      }
      if (!queue.length && !inflight) resolve();
    };
    next();
  });
  writeFileSync(join(OUT, `summary.${PLAN}.${Date.now()}.json`), `${JSON.stringify({ plan: PLAN, spent, results }, null, 2)}\n`);
  console.log(`done: ${results.length} runs, spent $${spent.toFixed(3)}`);
}

await main();
