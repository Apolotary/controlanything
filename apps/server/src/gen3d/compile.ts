/**
 * HackSet (semantic, model-written; @ce/protocol ce.hackset/1) -> ce.gen3d/1 (3D presentation), deterministically:
 *   - one Control per hack (control hacks: continuous/stepped/toggle/xy; action hacks: trigger), id = hack id,
 *     bound to the driver actionId of its first live command (else first command), args.hack = the hack id;
 *   - one archetype Part per control hack on a row (0.03 m clear between footprints), a hack-list Part for the
 *     one-shot hacks, a tag Part (device, status, channel) and a model-chips Part with the Meta model ids;
 *   - controls whose actions are not all verified render disarmed (control.armed = false), and spec.state
 *     says why. Hack.status mirrors the evidence: ready (untested) · uploading (pending) · verified · failed.
 * Then packages/gen3d's repairSpec -> validateSpec is the geometry gate.
 */
import { type ArchetypeName, type Channel, type Control, type Gen3dSpec, GEN3D_SPEC_VERSION, type HackItem, type Part, repairSpec, validateSpec } from '@ce/gen3d';
import type { HackStatus } from '@ce/protocol';
import type { ForgeDevice, ForgeDriver, VerifyState } from './forgeTypes';
import { type Hack, type HackArchetypeName, type HackSet, isStepperHack } from './hackset';

const ARCHETYPE: Record<HackArchetypeName, ArchetypeName> = { knob: 'knob', slider: 'fader', ring: 'dimmer-ring', xy: 'xy-orb', pads: 'pads', toggle: 'toggle', button: 'button', lever: 'lever' };

/** footprint width (x) at size "m", metres, from packages/gen3d's archetype defaults */
const WIDTH: Record<HackArchetypeName, number> = { knob: 0.064, slider: 0.044, ring: 0.14, xy: 0.16, pads: 0.27, toggle: 0.072, button: 0.05, lever: 0.06 };
/** the param each archetype's size lives in, and its size-"m" value */
const SIZE_PARAM: Record<HackArchetypeName, ['size' | 'length' | 'width', number]> = {
  knob: ['size', 0.064],
  slider: ['length', 0.16],
  ring: ['size', 0.14],
  xy: ['size', 0.16],
  pads: ['size', 0.06],
  toggle: ['width', 0.072],
  button: ['size', 0.05],
  lever: ['length', 0.12],
};
const SCALE = { s: 0.8, m: 1, l: 1.3 } as const;
const GAP_M = 0.03;
/** centre-to-centre minimum between neighbouring controls: knob readout plates are diameter + 16 mm wide */
export const MIN_PITCH_M = 0.1;
const HACK_LIST_W = 0.22;

const CHANNEL: Record<ForgeDriver['transport'], Channel> = { midi: 'usb', ir: 'ir', local: 'wifi' };
const TRANSPORT: Record<ForgeDriver['transport'], NonNullable<Gen3dSpec['device']>['transport']> = { midi: 'usb-midi', ir: 'ir', local: 'other' };

export const STATUS: Record<VerifyState, HackStatus & NonNullable<HackItem['status']>> = { untested: 'ready', pending: 'uploading', pass: 'verified', fail: 'failed' };

export interface CompileInput {
  specId: string;
  rev: number;
  title: string;
  hackset: HackSet;
  device: ForgeDevice;
  driver: ForgeDriver;
  verification: Record<string, VerifyState>;
  /** colours the model chose per hack id (the protocol HackControl has no accent) */
  accents?: Record<string, string>;
  modelIds: string[];
  source: 'live' | 'fixture';
}

export interface CompileResult {
  ok: boolean;
  spec: Gen3dSpec;
  errors: { code: string; path: string; message: string }[];
  warnings: { code: string; path: string; message: string }[];
  fixes: string[];
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const round = (n: number) => Math.round(n * 1000) / 1000;

function actionsOf(h: Hack): string[] {
  return [...h.commands, ...(h.inverse?.commands ?? [])].map((c) => c.action);
}

/** A hack is armed when every action it calls passed verification on the real device. */
export function hackArmed(h: Hack, verification: Record<string, VerifyState>): boolean {
  const a = actionsOf(h);
  return a.length > 0 && a.every((x) => verification[x] === 'pass');
}

export function hackState(h: Hack, verification: Record<string, VerifyState>): VerifyState {
  const states = actionsOf(h).map((a) => verification[a] ?? 'untested');
  if (states.some((s) => s === 'fail')) return 'fail';
  if (states.every((s) => s === 'pass')) return 'pass';
  if (states.some((s) => s === 'pending')) return 'pending';
  return 'untested';
}

/** Hack.status from the evidence (server-owned). */
export function withStatus(hackset: HackSet, verification: Record<string, VerifyState>): HackSet {
  return { ...hackset, hacks: hackset.hacks.map((h) => ({ ...h, status: STATUS[hackState(h, verification)] })) };
}

function controlFor(h: Hack, driver: ForgeDriver, armed: boolean, accent: string | undefined): Control {
  const kindOf = (id: string) => driver.actions.find((a) => a.actionId === id)?.kind;
  const live = h.commands.filter((c) => c.param);
  const primary = (live[0] ?? h.commands[0]).action;
  const stepper = isStepperHack(h, kindOf);
  const args: Record<string, string> = stepper ? { hack: h.id, drive: 'stepper' } : { hack: h.id };
  const base = { id: h.id, label: short(h.name.toUpperCase(), 16), ...(h.blurb ? { description: short(h.blurb, 200) } : {}), binding: { action: primary, driverId: driver.driverId, args }, armed, ...(accent ? { accent } : {}) };
  if (h.kind !== 'control' || !h.control) return { ...base, kind: 'trigger' };
  const p = h.params?.find((x) => x.id === h.control!.param) ?? h.params?.[0];
  if (kindOf(primary) === 'toggle' || h.control.archetype === 'toggle') return { ...base, kind: 'toggle', default: Boolean(p && (p.default ?? 0) >= 0.5) };
  if (h.control.archetype === 'xy' && h.params && h.params.length >= 2) {
    const [px, py] = h.params;
    const yCmd = h.commands.find((c) => c.param === py.id);
    return {
      ...base,
      kind: 'xy',
      range: { min: px.min, max: px.max, ...(px.step ? { step: px.step } : {}) },
      yRange: { min: py.min, max: py.max, ...(py.step ? { step: py.step } : {}) },
      default: { x: px.default ?? px.min, y: py.default ?? py.min },
      yBinding: { action: yCmd?.action ?? primary, driverId: driver.driverId, args: { hack: h.id } },
    };
  }
  const stepped = stepper || Boolean(p?.step && p.step > 0 && (p.max - p.min) / p.step <= 16);
  return {
    ...base,
    kind: stepped ? 'stepped' : 'continuous',
    range: p ? { min: p.min, max: p.max, ...(p.step ? { step: p.step } : stepped ? { step: 1 } : {}) } : { min: 0, max: 1 },
    ...(p?.default !== undefined ? { default: p.default } : {}),
    ...(p?.unit ? { unit: short(p.unit, 8) } : {}),
  };
}

function partFor(h: Hack, accent: string | undefined, x: number): Part {
  const c = h.control!;
  const sp = SIZE_PARAM[c.archetype];
  const params: NonNullable<Part['params']> = { showLabel: true, showValue: true, ...(accent ? { accent } : {}) };
  params[sp[0]] = round(sp[1] * SCALE[c.size ?? 'm']);
  return { id: `p_${h.id}`, kind: 'archetype', archetype: ARCHETYPE[c.archetype], controlId: h.id, params, transform: { position: [round(x), 0, 0] } };
}

function itemFor(h: Hack, driver: ForgeDriver, verification: Record<string, VerifyState>): HackItem {
  return { id: `i_${h.id}`, label: short(h.name, 24), ...(h.blurb ? { detail: short(h.blurb, 32) } : {}), kind: 'action', channel: CHANNEL[driver.transport], controlId: h.id, status: STATUS[hackState(h, verification)] };
}

export function compileHackset(c: CompileInput): CompileResult {
  const { hackset, device, driver, verification } = c;
  const deviceAccents = device.accents ?? [];
  const controls: Control[] = [];
  const parts: Part[] = [];
  const controlHacks = hackset.hacks.filter((h) => h.kind === 'control' && h.control);
  const actionHacks = hackset.hacks.filter((h) => !(h.kind === 'control' && h.control));

  // row of control archetypes, centred on x = 0; neighbours at least MIN_PITCH_M apart (readout plates)
  const widths = controlHacks.map((h) => WIDTH[h.control!.archetype] * SCALE[h.control!.size ?? 'm']);
  const centres: number[] = [];
  widths.forEach((w, i) => centres.push(i === 0 ? 0 : centres[i - 1] + Math.max(MIN_PITCH_M, (widths[i - 1] + w) / 2 + GAP_M)));
  const rowLeft = widths.length ? centres[0] - widths[0] / 2 : 0;
  const rowRight = widths.length ? centres[centres.length - 1] + widths[widths.length - 1] / 2 : 0;
  const shift = -(rowLeft + rowRight) / 2;
  const rowW = rowRight - rowLeft;
  controlHacks.forEach((h, i) => {
    const accent = c.accents?.[h.id] ?? (deviceAccents.length ? deviceAccents[i % deviceAccents.length] : undefined);
    controls.push(controlFor(h, driver, hackArmed(h, verification), accent));
    parts.push(partFor(h, accent, centres[i] + shift));
  });

  // one-shot hacks -> trigger controls + one hack list to the right of the row
  if (actionHacks.length) {
    const items = actionHacks.map((h) => {
      controls.push(controlFor(h, driver, hackArmed(h, verification), c.accents?.[h.id]));
      return itemFor(h, driver, verification);
    });
    const listX = controlHacks.length ? rowW / 2 + GAP_M + HACK_LIST_W / 2 : 0;
    parts.push({ id: 'hacks', kind: 'archetype', archetype: 'hack-list', params: { title: 'HACKS', subtitle: short(`${driver.transport.toUpperCase()} · ${actionHacks.length} one-shot`, 40), width: HACK_LIST_W, items }, transform: { position: [round(listX), 0, 0] } });
  }

  const states = Object.values(verification);
  const passed = states.filter((s) => s === 'pass').length;
  const armedAny = controls.some((k) => k.armed);
  const leftEdge = controlHacks.length ? -rowW / 2 : -HACK_LIST_W / 2;
  const channel = CHANNEL[driver.transport];
  parts.push({
    id: 'tag',
    kind: 'archetype',
    archetype: 'tag',
    params: { title: short(device.name.toUpperCase(), 32), subtitle: short(`${armedAny ? 'controlled' : 'linked'} · ${passed}/${states.length} verified`, 40), status: armedAny ? 'controlled' : 'linked', channel },
    transform: { position: [round(leftEdge + 0.06), 0.11, 0] },
  });
  parts.push({ id: 'chips', kind: 'archetype', archetype: 'model-chips', params: { models: [...new Set(c.modelIds)].slice(0, 8).map((id) => ({ id: short(id, 40), state: 'done' as const })) }, transform: { position: [round(leftEdge + 0.2), 0.11, 0] } });

  const overhead = /light|lamp|ceiling/i.test(`${device.category ?? ''} ${device.name}`) || driver.transport === 'ir';
  const spec: Gen3dSpec = {
    spec: GEN3D_SPEC_VERSION,
    specId: c.specId,
    rev: c.rev,
    title: short(c.title, 40),
    device: { cardId: device.cardId, name: short(device.name, 60), ...(device.category ? { category: short(device.category, 32) } : {}), ...(deviceAccents.length ? { accents: deviceAccents } : {}), transport: TRANSPORT[driver.transport] },
    anchor: overhead ? { mode: 'floating', distance: 0.6, pitchDeg: -10, faceUser: true, grabbable: true } : { mode: 'device', cardId: device.cardId, side: 'right', offset: [round(rowW / 2 + 0.12), 0.06, 0], faceUser: true, grabbable: true },
    state: { armed: armedAny, reason: short(armedAny ? `${passed}/${states.length} actions verified on the device` : 'waiting for verification on the real device', 80) },
    controls,
    parts,
    notes: short(`hack set: ${hackset.hacks.length} hacks (${controlHacks.length} controls, ${actionHacks.length} one-shot)`, 400),
    source: c.source,
    modelId: short(c.modelIds[0] ?? 'unknown', 60),
  };
  const repaired = repairSpec(spec);
  const v = validateSpec(repaired.spec);
  if (!v.ok) return { ok: false, spec: (v.spec ?? repaired.spec) as Gen3dSpec, errors: v.errors, warnings: v.warnings, fixes: repaired.fixes };
  return { ok: true, spec: v.spec, errors: [], warnings: v.warnings, fixes: repaired.fixes };
}

/** One hack as it streams in: its control and its 3D part (or hack-list row), at a provisional position. */
export function previewHack(h: Hack, index: number, device: ForgeDevice, driver: ForgeDriver, verification: Record<string, VerifyState>, accent?: string): { control: Control; part?: Part; item?: HackItem } {
  const armed = hackArmed(h, verification);
  if (h.kind === 'control' && h.control) {
    const a = accent ?? (device.accents?.length ? device.accents[index % device.accents.length] : undefined);
    return { control: controlFor(h, driver, armed, a), part: partFor(h, a, index * 0.1) };
  }
  return { control: controlFor(h, driver, armed, accent), item: itemFor(h, driver, verification) };
}

/**
 * New evidence, no model call: refresh armed flags, hack statuses, hack-list rows, the tag and spec.state on
 * an existing (possibly edited) spec. Returns new objects; the caller bumps rev.
 */
export function rearmSpec(spec: Gen3dSpec, hackset: HackSet, verification: Record<string, VerifyState>): { spec: Gen3dSpec; hackset: HackSet } {
  const next = structuredClone(spec);
  const hs = withStatus(hackset, verification);
  const byId = new Map(hs.hacks.map((h) => [h.id, h]));
  for (const c of next.controls) {
    const h = byId.get(String(c.binding.args?.hack ?? c.id));
    if (h) c.armed = hackArmed(h, verification);
  }
  const states = Object.values(verification);
  const passed = states.filter((x) => x === 'pass').length;
  const armedAny = next.controls.some((c) => c.armed);
  for (const p of next.parts) {
    if (p.archetype === 'hack-list' && p.params?.items) {
      p.params.items = p.params.items.map((it) => {
        const h = it.controlId ? byId.get(it.controlId) : undefined;
        return h ? { ...it, status: STATUS[hackState(h, verification)] } : it;
      });
    }
    if (p.archetype === 'tag' && p.params) {
      p.params.status = armedAny ? 'controlled' : 'linked';
      p.params.subtitle = short(`${armedAny ? 'controlled' : 'linked'} · ${passed}/${states.length} verified`, 40);
    }
  }
  next.state = { armed: armedAny, reason: short(armedAny ? `${passed}/${states.length} actions verified on the device` : 'waiting for verification on the real device', 80) };
  return { spec: next, hackset: hs };
}
