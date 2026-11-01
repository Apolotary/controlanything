/**
 * DRAFT verification for gen3d-draft/0 specs: schema -> bindings (every call exists in the driver with
 * in-range values) -> geometry sanity (footprints, overlaps, travel) -> safety (3 Hz light cap, expected
 * effects the oracle can check). Deterministic; the pipeline feeds the errors back to the model for repair.
 */
import { CATALOG, BOUNDS, MIN_GAP_M } from './catalog';
import { type Control, type Daemon, type Hack, type Object3D, Spec } from './spec';
import { changesLight, checkCall, type DeviceDriver, effectMatches, issue, type Issue, MAX_LIGHT_RATE_HZ } from './driver';

export interface VerifyContext {
  /** driver of the device the spec is for */
  target: DeviceDriver;
  /** every paired device's driver, including the target (daemons may reach them) */
  room: DeviceDriver[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function schemaIssues(value: unknown): { spec?: Spec; issues: Issue[] } {
  const r = Spec.safeParse(value);
  if (r.success) return { spec: r.data, issues: [] };
  return {
    issues: r.error.issues.slice(0, 25).map((i) => issue('schema', 'schema', i.path.length ? i.path.join('.') : '(root)', i.message)),
  };
}

function uniqueIds(list: { id: string }[], what: string): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  list.forEach((x, i) => {
    if (seen.has(x.id)) out.push(issue('schema', 'duplicate_id', `${what}[${i}].id`, `${what} id "${x.id}" is used twice`));
    seen.add(x.id);
  });
  return out;
}

function controlIssues(c: Control, i: number, ctx: VerifyContext): Issue[] {
  const at = `controls[${i}]`;
  const out: Issue[] = [];
  if (!(c.min < c.max)) out.push(issue('bindings', 'range', at, `min ${c.min} must be below max ${c.max}`));
  if (c.default < c.min || c.default > c.max) out.push(issue('bindings', 'default_range', `${at}.default`, `default ${c.default} is outside ${c.min}..${c.max}`));
  if (c.kind === 'toggle' && (c.min !== 0 || c.max !== 1 || c.step !== 1)) out.push(issue('bindings', 'toggle_range', at, 'a toggle uses min 0, max 1, step 1'));
  if (c.kind === 'stepped' && !(c.step > 0)) out.push(issue('bindings', 'stepped_step', at, 'a stepped control needs step > 0'));
  if (c.kind !== 'momentary' && !c.binding.valueArg) {
    out.push(issue('bindings', 'missing_value_arg', `${at}.binding.valueArg`, `a ${c.kind} control must pass its value to a param (set valueArg), or be momentary`));
  }
  out.push(...checkCall(ctx.target, c.binding, `${at}.binding`, c.binding.valueArg ? { min: c.min, max: c.max, step: c.step } : undefined));
  const m = effectMatches(ctx.target, [c.binding.action], c.expect.sensor, c.expect.effect);
  if (m === false) out.push(issue('safety', 'expect_mismatch', `${at}.expect`, `${c.binding.action} cannot cause ${c.expect.sensor}:${c.expect.effect}; declared: ${declared(ctx.target, [c.binding.action])}`));
  return out;
}

function declared(d: DeviceDriver, actions: string[]): string {
  return [...new Set(actions.flatMap((n) => d.actions.find((a) => a.name === n)?.effects ?? []))].join(', ') || '(none)';
}

function hackIssues(h: Hack, i: number, ctx: VerifyContext): Issue[] {
  const at = `hacks[${i}]`;
  const out: Issue[] = [];
  h.steps.forEach((s, j) => out.push(...checkCall(ctx.target, { action: s.action, args: s.args }, `${at}.steps[${j}]`)));
  const m = effectMatches(
    ctx.target,
    h.steps.map((s) => s.action),
    h.expect.sensor,
    h.expect.effect,
  );
  if (m === false) out.push(issue('safety', 'expect_mismatch', `${at}.expect`, `"${h.name}" cannot cause ${h.expect.sensor}:${h.expect.effect}; its steps declare: ${declared(ctx.target, h.steps.map((s) => s.action))}`));
  // photosensitivity: light-changing steps must be >= 1/3 s apart
  let last = -Infinity;
  let t = 0;
  h.steps.forEach((s, j) => {
    t += s.delayMs;
    if (!changesLight(ctx.target, s.action)) return;
    if (t - last < 1000 / MAX_LIGHT_RATE_HZ) {
      out.push(issue('safety', 'photosensitive', `${at}.steps[${j}].delayMs`, `light changes ${Math.round(t - last)} ms apart; keep >= ${Math.ceil(1000 / MAX_LIGHT_RATE_HZ)} ms (max ${MAX_LIGHT_RATE_HZ} Hz)`));
    }
    last = t;
  });
  return out;
}

function daemonIssues(d: Daemon, i: number, ctx: VerifyContext): Issue[] {
  const at = `daemons[${i}]`;
  const out: Issue[] = [];
  const src = ctx.room.find((x) => x.cardId === d.source.cardId);
  const dst = ctx.room.find((x) => x.cardId === d.target.cardId);
  if (!src) out.push(issue('bindings', 'unknown_device', `${at}.source.cardId`, `no paired device "${d.source.cardId}"; room: ${ctx.room.map((x) => x.cardId).join(', ')}`));
  else if (!(src.signals ?? []).some((s) => s.name === d.source.signal)) {
    out.push(issue('bindings', 'unknown_signal', `${at}.source.signal`, `${src.name} has no signal "${d.source.signal}"; signals: ${(src.signals ?? []).map((s) => s.name).join(', ') || '(none)'}`));
  }
  out.push(...checkCall(dst, d.target, `${at}.target`));
  if (!(d.maxRateHz > 0)) out.push(issue('safety', 'rate', `${at}.maxRateHz`, 'maxRateHz must be > 0'));
  if (changesLight(dst, d.target.action) && d.maxRateHz > MAX_LIGHT_RATE_HZ) {
    out.push(issue('safety', 'photosensitive', `${at}.maxRateHz`, `${d.target.action} changes a light: maxRateHz ${d.maxRateHz} must be <= ${MAX_LIGHT_RATE_HZ}`));
  }
  const m = effectMatches(dst, [d.target.action], d.expect.sensor, d.expect.effect);
  if (m === false && dst) out.push(issue('safety', 'expect_mismatch', `${at}.expect`, `${d.target.action} cannot cause ${d.expect.sensor}:${d.expect.effect}; declared: ${declared(dst, [d.target.action])}`));
  return out;
}

function footprint(o: Object3D) {
  const s = CATALOG[o.archetype]?.size ?? { w: 0.06, h: 0.03, d: 0.06 };
  // a yaw of 90/270 degrees swaps width and depth
  const yaw = ((Math.round(o.rotation.y) % 180) + 180) % 180;
  const swap = yaw > 45 && yaw < 135;
  const w = (swap ? s.d : s.w) * o.scale;
  const d = (swap ? s.w : s.d) * o.scale;
  return { x0: o.position.x - w / 2, x1: o.position.x + w / 2, z0: o.position.z - d / 2, z1: o.position.z + d / 2, top: o.position.y + s.h * o.scale };
}

const TRAVEL: Record<string, [number, number]> = { rotate: [-360, 360], flip: [-90, 90], slide: [-0.3, 0.3], press: [-0.03, 0.03], none: [-1, 1] };

function objectIssues(objects: Object3D[], controls: Control[]): Issue[] {
  const out: Issue[] = [];
  const byControl = new Map<string, number>();
  objects.forEach((o, i) => {
    const at = `objects[${i}]`;
    if (o.controlId) {
      const c = controls.find((x) => x.id === o.controlId);
      if (!c) out.push(issue('geometry', 'unknown_control', `${at}.controlId`, `no control "${o.controlId}"`));
      else if (!CATALOG[o.archetype].suits.includes(c.kind)) {
        out.push(issue('geometry', 'archetype_kind', `${at}.archetype`, `a ${o.archetype} suits ${CATALOG[o.archetype].suits.join('/')} controls, but "${c.id}" is ${c.kind}`));
      }
      byControl.set(o.controlId, (byControl.get(o.controlId) ?? 0) + 1);
    }
    const f = footprint(o);
    if (f.x0 < BOUNDS.x[0] - 1e-6 || f.x1 > BOUNDS.x[1] + 1e-6 || f.z0 < BOUNDS.z[0] - 1e-6 || f.z1 > BOUNDS.z[1] + 1e-6) {
      out.push(issue('geometry', 'out_of_bounds', `${at}.position`, `footprint x ${r3(f.x0)}..${r3(f.x1)}, z ${r3(f.z0)}..${r3(f.z1)} leaves the plate x ${BOUNDS.x.join('..')}, z ${BOUNDS.z.join('..')}`));
    }
    if (o.position.y < BOUNDS.y[0] || f.top > BOUNDS.y[1]) out.push(issue('geometry', 'out_of_bounds', `${at}.position.y`, `object spans y ${r3(o.position.y)}..${r3(f.top)}; keep it inside ${BOUNDS.y.join('..')}`));
    const [lo, hi] = TRAVEL[o.behaviour.motion];
    if (o.behaviour.from < lo || o.behaviour.to > hi || o.behaviour.from > hi || o.behaviour.to < lo) {
      out.push(issue('geometry', 'travel', `${at}.behaviour`, `${o.behaviour.motion} travel ${o.behaviour.from}..${o.behaviour.to} is outside ${lo}..${hi}`));
    }
    if (o.behaviour.motion !== 'none' && o.behaviour.from === o.behaviour.to) out.push(issue('geometry', 'travel', `${at}.behaviour`, 'from and to are equal: the object cannot move'));
    o.parts.forEach((p, j) => {
      const pa = `${at}.parts[${j}]`;
      if (![p.size.x, p.size.y, p.size.z].every((v) => v > 0 && v <= 0.4)) out.push(issue('geometry', 'part_size', `${pa}.size`, 'part extents must be > 0 and <= 0.4 m'));
      if (![p.position.x, p.position.y, p.position.z].every((v) => Math.abs(v) <= 0.3)) out.push(issue('geometry', 'part_position', `${pa}.position`, 'parts must stay within 0.3 m of their object'));
    });
  });
  for (const c of controls) {
    const n = byControl.get(c.id) ?? 0;
    if (n !== 1) out.push(issue('geometry', 'control_objects', `controls.${c.id}`, `control "${c.id}" has ${n} objects; it needs exactly one (objects[].controlId)`));
  }
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = footprint(objects[i]);
      const b = footprint(objects[j]);
      const gapX = Math.max(b.x0 - a.x1, a.x0 - b.x1);
      const gapZ = Math.max(b.z0 - a.z1, a.z0 - b.z1);
      if (Math.max(gapX, gapZ) < MIN_GAP_M - 1e-6) {
        out.push(issue('geometry', 'overlap', `objects[${j}].position`, `"${objects[j].id}" is ${r3(Math.max(gapX, gapZ))} m from "${objects[i].id}"; keep >= ${MIN_GAP_M} m between footprints`));
      }
    }
  }
  return out;
}

/** All deterministic checks after the schema. */
export function semanticIssues(spec: Spec, ctx: VerifyContext): Issue[] {
  const out: Issue[] = [];
  if (spec.device.cardId !== ctx.target.cardId) out.push(issue('schema', 'device', 'device.cardId', `spec is for "${spec.device.cardId}" but the target is "${ctx.target.cardId}"`));
  if (!spec.hacks.length && !spec.controls.length) out.push(issue('schema', 'empty', '(root)', 'the spec needs at least one hack or control'));
  out.push(...uniqueIds(spec.controls, 'controls'), ...uniqueIds(spec.objects, 'objects'), ...uniqueIds(spec.hacks, 'hacks'), ...uniqueIds(spec.daemons, 'daemons'));
  spec.controls.forEach((c, i) => out.push(...controlIssues(c, i, ctx)));
  spec.hacks.forEach((h, i) => out.push(...hackIssues(h, i, ctx)));
  spec.daemons.forEach((d, i) => out.push(...daemonIssues(d, i, ctx)));
  out.push(...objectIssues(spec.objects, spec.controls));
  const o = spec.anchor.offset;
  if (Math.hypot(o.x, o.y, o.z) > 1.5) out.push(issue('geometry', 'anchor', 'anchor.offset', 'anchor offset must stay within 1.5 m of the anchor point'));
  return out;
}

export function verifySpec(value: unknown, ctx: VerifyContext): { spec?: Spec; issues: Issue[] } {
  const s = schemaIssues(value);
  if (!s.spec) return s;
  return { spec: s.spec, issues: semanticIssues(s.spec, ctx) };
}
