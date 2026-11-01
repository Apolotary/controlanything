/**
 * Archetype expansion: turns one `kind: "archetype"` part into primitives, text, paths, behaviours and
 * feedback, all parented under the archetype part (which becomes a plain group). Pure data, no three.js,
 * so the renderer, the validator (budgets) and 2D clients share one definition of what a "knob" is.
 *
 * Local frame of every archetype: +x = user's right, +y = up, +z = toward the user. Controls face +z.
 * Rotation about z is specified clockwise as the user sees it (knob convention), see Behavior.sweepDeg.
 */
import type { ArchetypeName, Behavior, Control, Feedback, Gen3dSpec, HexColor, Material, Part, TextStyle, Vec3 } from './schema';
import { DEFAULT_ACCENTS, NEON, statusColor } from './theme';

export interface Expansion {
  parts: Part[];
  behaviors: Behavior[];
  feedback: Feedback[];
}

export interface ExpandContext {
  /** indicator colour for this archetype */
  accent: HexColor;
  /** the control it operates, if any */
  control?: Control;
  /** position of this archetype among the spec's archetypes (for alternating looks) */
  index: number;
}

/** Archetypes that operate a control (and therefore need `controlId`). */
export const INTERACTIVE_ARCHETYPES: ReadonlySet<ArchetypeName> = new Set<ArchetypeName>([
  'knob',
  'fader',
  'lever',
  'button',
  'toggle',
  'dimmer-ring',
  'pull-cord',
  'xy-orb',
  'pads',
  'keys',
  'wheel',
]);

/** Which control kinds each interactive archetype can operate. */
export const ARCHETYPE_CONTROL_KINDS: Record<ArchetypeName, readonly Control['kind'][]> = {
  knob: ['continuous', 'stepped'],
  fader: ['continuous', 'stepped'],
  lever: ['continuous', 'stepped', 'toggle'],
  button: ['trigger', 'toggle'],
  toggle: ['toggle'],
  'dimmer-ring': ['continuous', 'stepped'],
  'pull-cord': ['trigger', 'toggle', 'stepped'],
  'xy-orb': ['xy'],
  pads: ['trigger'],
  keys: ['trigger'],
  wheel: ['stepped'],
  outline: [],
  tag: [],
  brackets: [],
  twin: [],
  'sweep-plane': [],
  reticle: [],
  'ping-line': [],
  'link-matrix': [],
  'oracle-strip': [],
  'hack-list': ['trigger', 'toggle'],
  'queue-strip': [],
  'upload-bar': [],
  'daemon-link': ['toggle'],
  deck: ['trigger', 'toggle'],
  'model-chips': [],
  worklog: [],
  'ir-waveform-card': [],
  'remote-chips': [],
  handle: [],
};

// --- small builders ---------------------------------------------------------------------------------

type P = Partial<Part> & { id: string; kind: Part['kind'] };

function holo(color: HexColor, extra: Partial<Material> = {}): Material {
  return { style: 'holo', color, opacity: 0.85, fresnel: 2, scanlines: true, glow: 0.6, ...extra };
}
function solidGlow(color: HexColor, extra: Partial<Material> = {}): Material {
  return { style: 'solid', color, emissive: color, emissiveIntensity: 1.2, roughness: 0.4, metalness: 0.1, glow: 1, ...extra };
}
function plate(color: HexColor = NEON.panel, edgeColor: HexColor = NEON.cyan): Material {
  return { style: 'holo', color, opacity: 0.92, fresnel: 3, scanlines: true, edges: true, edgeColor, glow: 0.5 };
}
function dim(color: HexColor): Material {
  return { style: 'holo', color, opacity: 0.5, fresnel: 2, glow: 0.2 };
}
/** Bright holographic glass (knob bodies, caps): dark cyan body, strong cyan rim. */
function glass(rim: HexColor = NEON.cyan, extra: Partial<Material> = {}): Material {
  return { style: 'holo', color: '#0E4F5C', emissive: rim, opacity: 0.72, fresnel: 2.2, scanlines: true, glow: 1.4, ...extra };
}
/** A plate with four angular corner brackets: the HUD's panel language. Returns the plate followed by the brackets. */
function panel(id: string, parentId: string, w: number, h: number, d: number, position: Vec3, edgeColor: HexColor, extra: Partial<Part> = {}): Part[] {
  const out: Part[] = [box(id, parentId, w, h, d, position, plate(NEON.plate, edgeColor), { role: 'base', dims: { radius: 0.003 }, ...extra })];
  const arm = Math.max(0.008, Math.min(0.02, w * 0.1, h * 0.35));
  const t = 0.0022;
  const z = position[2]! + d / 2 + 0.0008;
  let n = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const cx = position[0]! + sx * (w / 2 + 0.0025);
    const cy = position[1]! + sy * (h / 2 + 0.0025);
    out.push(box(`${id}.c${n}h`, parentId, arm, t, 0.0008, [cx - (sx * arm) / 2, cy, z], solidGlow(edgeColor, { emissiveIntensity: 1.6 })));
    out.push(box(`${id}.c${n}v`, parentId, t, arm, 0.0008, [cx, cy - (sy * arm) / 2, z], solidGlow(edgeColor, { emissiveIntensity: 1.6 })));
    n++;
  }
  return out;
}
/** "LABEL  97" readout plate: label left in bone, value right in large volt mono (role readout). */
function readoutPlate(id: string, parentId: string, position: Vec3, label: string, value: string, accent: HexColor, w = 0.1): Part[] {
  const lbl = label.slice(0, 12);
  const out = panel(`${id}.rp`, parentId, w, 0.03, 0.003, position, accent, { role: 'decor' });
  const labelH = Math.min(0.0068, Math.max(0.0045, (w * 0.42) / Math.max(3, lbl.length) / 0.72));
  if (lbl) out.push(text(`${id}.name`, parentId, lbl, [position[0]! - w / 2 + 0.005, position[1]!, position[2]! + 0.0025], { heightM: labelH, color: NEON.bone, align: 'left' }, { role: 'label' }));
  out.push(text(`${id}.value`, parentId, value, [position[0]! + w / 2 - 0.005, position[1]!, position[2]! + 0.0025], { heightM: w >= 0.09 ? 0.0125 : 0.011, color: NEON.volt, align: 'right', font: 'mono' }, { role: 'readout' }));
  return out;
}

function part(p: P): Part {
  return p as Part;
}
function box(id: string, parentId: string, w: number, h: number, d: number, position: Vec3, material: Material, extra: Partial<Part> = {}): Part {
  return part({ id, parentId, kind: 'primitive', shape: 'box', dims: { w, h, d, ...(extra.dims ?? {}) }, transform: { position, ...(extra.transform ?? {}) }, material, ...omit(extra, ['dims', 'transform']) });
}
function cyl(id: string, parentId: string, r: number, h: number, position: Vec3, material: Material, extra: Partial<Part> = {}): Part {
  return part({ id, parentId, kind: 'primitive', shape: 'cylinder', dims: { rTop: r, rBottom: r, h, segments: 48, ...(extra.dims ?? {}) }, transform: { position, ...(extra.transform ?? {}) }, material, ...omit(extra, ['dims', 'transform']) });
}
function sphere(id: string, parentId: string, r: number, position: Vec3, material: Material, extra: Partial<Part> = {}): Part {
  return part({ id, parentId, kind: 'primitive', shape: 'sphere', dims: { r, segments: 24 }, transform: { position }, material, ...extra });
}
function ring(id: string, parentId: string, rInner: number, rOuter: number, position: Vec3, material: Material, arcDeg = 360, startDeg = 0, extra: Partial<Part> = {}): Part {
  return part({ id, parentId, kind: 'primitive', shape: 'ring', dims: { rInner, rOuter, arcDeg, startDeg, segments: 64 }, transform: { position }, material, ...extra });
}
function text(id: string, parentId: string, value: string, position: Vec3, style: Partial<TextStyle> = {}, extra: Partial<Part> = {}): Part {
  // control labels longer than 10 characters wrap onto two lines so neighbours 90-100 mm apart never overlap
  const wrap = extra.role === 'label' && value.length > 10 && !style.wrap && value.includes(' ') ? { wrap: Math.max(6, Math.ceil(value.length / 2)) } : {};
  return part({ id, parentId, kind: 'text', text: { value, heightM: 0.009, color: NEON.text, font: 'sans', weight: 'bold', align: 'center', uppercase: true, ...wrap, ...style }, transform: { position }, ...extra });
}
function group(id: string, parentId: string, position: Vec3, extra: Partial<Part> = {}): Part {
  return part({ id, parentId, kind: 'group', transform: { position, ...(extra.transform ?? {}) }, ...omit(extra, ['transform']) });
}
function omit<T extends object>(o: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out as Partial<T>;
}

/** Clockwise-from-12-o'clock angle (degrees) -> local xy position on a radius. */
function onRing(deg: number, r: number, z = 0): Vec3 {
  const a = (deg * Math.PI) / 180;
  return [Math.sin(a) * r, Math.cos(a) * r, z];
}
/** Clockwise sweep [a, b] (from 12 o'clock) -> ring dims (counter-clockwise from +x). */
function cwArc(aDeg: number, bDeg: number): { startDeg: number; arcDeg: number } {
  return { startDeg: 90 - bDeg, arcDeg: Math.max(1, bDeg - aDeg) };
}

function fmtDefault(control: Control | undefined): string {
  if (!control) return '';
  const d = control.default;
  if (typeof d === 'number') return control.unit ? `${d}${control.unit}` : String(d);
  if (typeof d === 'boolean') return d ? 'ON' : 'OFF';
  if (d && typeof d === 'object') return `${d.x},${d.y}`;
  return control.kind === 'toggle' ? 'OFF' : control.range ? String(control.range.min) : '0';
}

// --- the catalogue -----------------------------------------------------------------------------------

export function expandArchetype(a: Part, ctx: ExpandContext): Expansion {
  const p = a.params ?? {};
  const id = a.id;
  const c = ctx.control;
  const cid = a.controlId ?? c?.id ?? '';
  const accent = (p.accent ?? ctx.accent) as HexColor;
  const body = (p.body ?? NEON.holo) as HexColor;
  const capColor = (p.cap ?? accent) as HexColor;
  const label = c?.label ?? p.title ?? '';
  const showLabel = p.showLabel ?? true;
  const showValue = p.showValue ?? (c ? c.kind !== 'trigger' : false);
  const parts: Part[] = [];
  const behaviors: Behavior[] = [];
  const feedback: Feedback[] = [];
  const fb = (type: Feedback['type'], partId: string | undefined, extra: Partial<Feedback> = {}) => {
    if (!cid) return;
    feedback.push({ id: `${id}.fb.${type}${partId ? `.${partId.slice(id.length + 1)}` : ''}`, controlId: cid, type, ...(partId ? { partId } : {}), ...extra });
  };

  switch (a.archetype) {
    case 'knob': {
      const dia = p.size ?? 0.064;
      const r = dia / 2;
      const skirtH = p.thickness ?? 0.014;
      const sweep = p.sweepDeg ?? 270;
      const half = sweep / 2;
      parts.push(cyl(`${id}.skirt`, id, r, skirtH, [0, 0, skirtH / 2], glass(NEON.cyan, { color: p.body ?? '#0E4F5C' }), { role: 'base', transform: { position: [0, 0, skirtH / 2], rotationDeg: [90, 0, 0] } }));
      // the glowing rim ring (fake bloom copies are added by the renderer for glow >= 1)
      parts.push(part({ id: `${id}.rim`, parentId: id, kind: 'primitive', shape: 'torus', dims: { r: r - 0.001, tube: 0.0022, segments: 64 }, transform: { position: [0, 0, skirtH] }, material: solidGlow(NEON.cyan, { emissiveIntensity: 2 }), role: 'indicator' }));
      // the cap rotates: a group so the pointer turns with it
      parts.push(group(`${id}.cap`, id, [0, 0, skirtH], { role: 'cap' }));
      parts.push(cyl(`${id}.capface`, `${id}.cap`, r - 0.005, 0.008, [0, 0, 0.004], glass(NEON.cyan, { opacity: 0.6, fresnel: 3 }), { transform: { position: [0, 0, 0.004], rotationDeg: [90, 0, 0] } }));
      parts.push(box(`${id}.pointer`, `${id}.cap`, 0.0055, r - 0.012, 0.0025, [0, (r - 0.012) / 2 + 0.003, 0.0085], solidGlow(NEON.bone, { emissiveIntensity: 1.8 }), { role: 'indicator' }));
      parts.push(ring(`${id}.track`, id, r + 0.004, r + 0.013, [0, 0, 0.001], dim(accent), sweep, cwArc(-half, half).startDeg, { role: 'track' }));
      parts.push(ring(`${id}.arc`, id, r + 0.004, r + 0.013, [0, 0, 0.0015], solidGlow(accent, { emissiveIntensity: 1.6 }), 1, cwArc(-half, -half + 1).startDeg, { role: 'arc' }));
      parts.push(box(`${id}.tick0`, id, 0.0022, 0.008, 0.002, onRing(-half, r + 0.019, 0.001), solidGlow(accent), { transform: { position: onRing(-half, r + 0.019, 0.001), rotationDeg: [0, 0, half] } }));
      parts.push(box(`${id}.tick1`, id, 0.0022, 0.008, 0.002, onRing(half, r + 0.019, 0.001), solidGlow(accent), { transform: { position: onRing(half, r + 0.019, 0.001), rotationDeg: [0, 0, -half] } }));
      if (showLabel || showValue) parts.push(...readoutPlate(id, id, [0, -(r + 0.038), 0.002], showLabel ? label : '', showValue ? fmtDefault(c) : '', accent, dia + 0.016));
      if (c?.minLabel) parts.push(text(`${id}.min`, id, c.minLabel, onRing(-half, r + 0.03, 0.002), { heightM: 0.0045, color: NEON.dim }));
      if (c?.maxLabel) parts.push(text(`${id}.max`, id, c.maxLabel, onRing(half, r + 0.03, 0.002), { heightM: 0.0045, color: NEON.dim }));
      parts.push(text(`${id}.hint`, id, c?.hint ?? 'PINCH · DRAG UP/DOWN', [0, -(r + 0.062), 0.002], { heightM: 0.005, color: NEON.volt, background: NEON.void }, { role: 'decor', visibleWhen: 'hover' }));
      if (cid) {
        behaviors.push({ id: `${id}.rotate`, partId: `${id}.cap`, controlId: cid, type: 'rotate', axis: 'z', sweepDeg: [-half, half], gestures: ['pinch-drag', 'pinch-twist'], dragGain: 0.1, grabRadius: r + 0.02, ...(p.detents ? { detents: p.detents } : {}) });
        fb('arc-fill', `${id}.arc`);
        fb('glow', `${id}.skirt`, { on: 'hover', color: NEON.volt });
        fb('tick', undefined, { every: 0.05, sound: 'tick' });
        if (showValue) fb('readout', `${id}.value`, { format: '{value}{unit}' });
      }
      break;
    }

    case 'fader': {
      const len = p.length ?? p.size ?? 0.16;
      const vertical = (p.orientation ?? 'vertical') === 'vertical';
      const rot: Vec3 = vertical ? [0, 0, 0] : [0, 0, 90];
      parts.push(group(`${id}.rail`, id, [0, 0, 0], { transform: { position: [0, 0, 0], rotationDeg: rot } }));
      parts.push(box(`${id}.track`, `${id}.rail`, 0.014, len + 0.02, 0.006, [0, 0, 0.003], plate(NEON.panel, accent), { role: 'track' }));
      parts.push(box(`${id}.slot`, `${id}.rail`, 0.004, len, 0.002, [0, 0, 0.007], dim(accent)));
      parts.push(box(`${id}.fill`, `${id}.rail`, 0.006, 0.002, 0.0025, [0, -len / 2, 0.0075], solidGlow(accent), { role: 'arc' }));
      parts.push(group(`${id}.cap`, `${id}.rail`, [0, -len / 2, 0.012], { role: 'cap' }));
      parts.push(box(`${id}.capbody`, `${id}.cap`, 0.032, 0.018, 0.012, [0, 0, 0], glass(NEON.cyan, { opacity: 0.8 }), { dims: { radius: 0.003 } }));
      parts.push(box(`${id}.capline`, `${id}.cap`, 0.032, 0.003, 0.002, [0, 0, 0.0065], solidGlow(accent, { emissiveIntensity: 1.8 }), { role: 'indicator' }));
      for (let i = 0; i <= 4; i++) {
        const y = -len / 2 + (len * i) / 4;
        parts.push(box(`${id}.t${i}`, `${id}.rail`, 0.006, 0.0015, 0.001, [0.013, y, 0.0065], dim(accent)));
      }
      if (showLabel || showValue) parts.push(...readoutPlate(id, id, vertical ? [0, -(len / 2 + 0.04), 0.004] : [0, -0.04, 0.004], showLabel ? label : '', showValue ? fmtDefault(c) : '', accent, 0.1));
      if (c?.minLabel) parts.push(text(`${id}.min`, `${id}.rail`, c.minLabel, [0.03, -len / 2, 0.004], { heightM: 0.0045, color: NEON.dim, align: 'left' }));
      if (c?.maxLabel) parts.push(text(`${id}.max`, `${id}.rail`, c.maxLabel, [0.03, len / 2, 0.004], { heightM: 0.0045, color: NEON.dim, align: 'left' }));
      parts.push(text(`${id}.hint`, id, c?.hint ?? 'PINCH THE CAP · DRAG', vertical ? [0, -(len / 2 + 0.066), 0.004] : [0, -0.066, 0.004], { heightM: 0.005, color: NEON.volt, background: NEON.void }, { role: 'decor', visibleWhen: 'hover' }));
      if (cid) {
        behaviors.push({ id: `${id}.slide`, partId: `${id}.cap`, controlId: cid, type: 'slide', axis: 'y', travel: [-len / 2, len / 2], gestures: ['pinch-drag', 'grab'], grabRadius: 0.035, ...(p.detents ? { detents: p.detents } : {}) });
        fb('arc-fill', `${id}.fill`);
        fb('glow', `${id}.capbody`, { on: 'hover', color: accent });
        fb('tick', undefined, { every: 1 / 16, sound: 'tick' });
        if (showValue) fb('readout', `${id}.value`, { format: '{value}{unit}' });
      }
      break;
    }

    case 'lever': {
      const len = p.length ?? p.size ?? 0.12;
      const throwDeg = p.throwDeg ?? 60;
      const half = throwDeg / 2;
      parts.push(box(`${id}.base`, id, 0.07, 0.03, 0.07, [0, 0.015, 0], plate(NEON.panel, accent), { role: 'base', dims: { radius: 0.006 } }));
      parts.push(cyl(`${id}.pivot`, id, 0.008, 0.08, [0, 0.03, 0], holo(body), { transform: { position: [0, 0.03, 0], rotationDeg: [0, 0, 90] } }));
      // guide arc in the yz plane (rotate the ring 90° about y)
      parts.push(ring(`${id}.guide`, id, len + 0.014, len + 0.02, [0, 0.03, 0], dim(accent), throwDeg, 90 - half, { transform: { position: [0, 0.03, 0], rotationDeg: [0, -90, 0] } }));
      parts.push(group(`${id}.arm`, id, [0, 0.03, 0], { role: 'cap' }));
      parts.push(cyl(`${id}.rod`, `${id}.arm`, 0.0065, len, [0, len / 2, 0], holo(body, { fresnel: 3, opacity: 0.95 })));
      parts.push(sphere(`${id}.ball`, `${id}.arm`, p.thickness ?? 0.02, [0, len, 0], solidGlow(capColor), { role: 'indicator' }));
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -0.012, 0.045], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      if (showValue) parts.push(text(`${id}.value`, id, fmtDefault(c), [0.07, 0.04, 0.0], { heightM: 0.009, color: accent, font: 'mono', background: NEON.ink, billboard: true }, { role: 'readout' }));
      if (cid) {
        behaviors.push({ id: `${id}.rotate`, partId: `${id}.arm`, controlId: cid, type: 'rotate', axis: 'x', sweepDeg: [-half, half], gestures: ['pinch-drag', 'grab'], dragGain: 0.12, grabRadius: 0.05, spring: c?.kind === 'trigger', ...(p.detents ? { detents: p.detents } : {}) });
        fb('glow', `${id}.ball`, { on: 'hover', color: capColor });
        fb('tick', undefined, { every: 0.1, sound: 'click' });
        if (showValue) fb('readout', `${id}.value`, { format: '{value}{unit}' });
      }
      break;
    }

    case 'button': {
      const size = p.size ?? 0.044;
      const round = (p.shape ?? 'round') === 'round';
      const h = 0.012;
      parts.push(ring(`${id}.base`, id, size / 2 + 0.002, size / 2 + 0.006, [0, 0, 0.0005], dim(accent), 360, 0, { role: 'base' }));
      parts.push(group(`${id}.cap`, id, [0, 0, 0], { role: 'cap' }));
      if (round) parts.push(cyl(`${id}.face`, `${id}.cap`, size / 2, h, [0, 0, h / 2], holo(body, { fresnel: 3, opacity: 0.95 }), { transform: { position: [0, 0, h / 2], rotationDeg: [90, 0, 0] } }));
      else parts.push(box(`${id}.face`, `${id}.cap`, size, size, h, [0, 0, h / 2], holo(body, { fresnel: 3, opacity: 0.95 }), { dims: { radius: 0.006 } }));
      parts.push(ring(`${id}.rim`, `${id}.cap`, size / 2 - 0.004, size / 2 - 0.001, [0, 0, h + 0.0005], solidGlow(accent), 360, 0, { role: 'indicator' }));
      if (showLabel && label) parts.push(text(`${id}.label`, `${id}.cap`, label, [0, 0, h + 0.001], { heightM: Math.min(0.008, size * 0.16), color: NEON.text }, { role: 'label' }));
      if (cid) {
        const momentary = p.momentary ?? c?.kind === 'trigger';
        behaviors.push({ id: `${id}.press`, partId: `${id}.cap`, controlId: cid, type: momentary ? 'press' : 'toggle', axis: 'z', depth: 0.007, gestures: ['poke', 'pinch'], grabRadius: size / 2 + 0.02 });
        fb('glow', `${id}.face`, { on: 'hover', color: accent });
        fb('scale-pop', `${id}.cap`, { on: 'trigger' });
        fb('tick', undefined, { on: 'trigger', sound: 'click' });
      }
      break;
    }

    case 'toggle': {
      const w = p.width ?? p.size ?? 0.072;
      const travel = w / 2 - 0.02;
      parts.push(box(`${id}.base`, id, w, 0.04, 0.01, [0, 0, 0.005], plate(NEON.panel, accent), { role: 'base', dims: { radius: 0.02 } }));
      parts.push(group(`${id}.cap`, id, [-travel, 0, 0.012], { role: 'cap' }));
      parts.push(cyl(`${id}.knob`, `${id}.cap`, 0.015, 0.012, [0, 0, 0.006], holo(body, { fresnel: 3, opacity: 0.95 }), { transform: { position: [0, 0, 0.006], rotationDeg: [90, 0, 0] } }));
      parts.push(ring(`${id}.rim`, `${id}.cap`, 0.011, 0.014, [0, 0, 0.0125], solidGlow(accent), 360, 0, { role: 'indicator' }));
      parts.push(text(`${id}.off`, id, 'OFF', [-travel, -0.032, 0.002], { heightM: 0.006, color: NEON.dim }));
      parts.push(text(`${id}.on`, id, 'ON', [travel, -0.032, 0.002], { heightM: 0.006, color: accent }));
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, 0.036, 0.002], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      if (cid) {
        behaviors.push({ id: `${id}.toggle`, partId: `${id}.cap`, controlId: cid, type: 'toggle', axis: 'x', travel: [-travel, travel], gestures: ['poke', 'pinch', 'pinch-drag'], grabRadius: 0.035 });
        fb('glow', `${id}.base`, { on: 'hover', color: accent });
        fb('tick', undefined, { on: 'trigger', sound: 'click' });
      }
      break;
    }

    case 'dimmer-ring': {
      const dia = p.size ?? 0.14;
      const band = p.thickness ?? 0.02;
      const rOut = dia / 2;
      const rIn = rOut - band;
      const sweep = p.sweepDeg ?? 300;
      const half = sweep / 2;
      const rMid = (rIn + rOut) / 2;
      parts.push(ring(`${id}.track`, id, rIn, rOut, [0, 0, 0], dim(accent), sweep, cwArc(-half, half).startDeg, { role: 'track' }));
      parts.push(ring(`${id}.arc`, id, rIn + 0.002, rOut - 0.002, [0, 0, 0.001], solidGlow(accent, { emissiveIntensity: 1.6 }), 1, cwArc(-half, -half + 1).startDeg, { role: 'arc' }));
      parts.push(ring(`${id}.inner`, id, rIn - 0.004, rIn - 0.0015, [0, 0, 0], dim(NEON.dim), 360, 0));
      parts.push(group(`${id}.cap`, id, [0, 0, 0.004], { role: 'cap', transform: { position: [0, 0, 0.004], rotationDeg: [0, 0, half] } }));
      parts.push(sphere(`${id}.bead`, `${id}.cap`, 0.014, [0, rMid, 0.004], solidGlow(capColor), { role: 'indicator' }));
      parts.push(text(`${id}.value`, id, fmtDefault(c), [0, 0.004, 0.002], { heightM: 0.034, font: 'mono', color: NEON.volt }, { role: 'readout' }));
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -(rOut + 0.02), 0.002], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      if (cid) {
        behaviors.push({ id: `${id}.rotate`, partId: `${id}.cap`, controlId: cid, type: 'rotate', axis: 'z', sweepDeg: [-half, half], gestures: ['pinch-drag', 'pinch-twist', 'grab'], dragGain: 0.12, grabRadius: rOut + 0.03, ...(p.detents ? { detents: p.detents } : {}) });
        fb('arc-fill', `${id}.arc`);
        fb('readout', `${id}.value`, { format: '{value}{unit}' });
        fb('glow', `${id}.bead`, { on: 'hover', color: capColor });
        fb('tick', undefined, { every: 0.05, sound: 'tick' });
      }
      break;
    }

    case 'pull-cord': {
      const len = p.length ?? p.size ?? 0.2;
      const travel = 0.08;
      parts.push(cyl(`${id}.mount`, id, 0.012, 0.006, [0, 0, 0], holo(body), { transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0] } }));
      parts.push(group(`${id}.cap`, id, [0, 0, 0], { role: 'cap' }));
      parts.push(cyl(`${id}.cord`, `${id}.cap`, 0.002, len, [0, -len / 2, 0], dim(NEON.text), { dims: { segments: 12 } }));
      parts.push(part({ id: `${id}.bead`, parentId: `${id}.cap`, kind: 'primitive', shape: 'capsule', dims: { r: 0.011, h: 0.03, segments: 16 }, transform: { position: [0, -len - 0.015, 0] }, material: solidGlow(capColor), role: 'indicator' }));
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -len - 0.05, 0.002], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      if (cid) {
        behaviors.push({ id: `${id}.pull`, partId: `${id}.cap`, controlId: cid, type: 'pull', axis: 'y', travel: [0, -travel], gestures: ['pinch-drag', 'grab'], spring: true, grabRadius: 0.04 });
        fb('glow', `${id}.bead`, { on: 'hover', color: capColor });
        fb('tick', undefined, { on: 'trigger', sound: 'chirp' });
      }
      break;
    }

    case 'xy-orb': {
      const size = p.size ?? 0.16;
      const hs = size / 2;
      parts.push(box(`${id}.pad`, id, size, size, 0.004, [0, 0, 0.002], plate(NEON.panel, accent), { role: 'base' }));
      parts.push(box(`${id}.hx`, id, size - 0.01, 0.0015, 0.001, [0, 0, 0.0045], dim(accent)));
      parts.push(box(`${id}.vx`, id, 0.0015, size - 0.01, 0.001, [0, 0, 0.0045], dim(accent)));
      parts.push(group(`${id}.cap`, id, [0, 0, 0.018], { role: 'cap' }));
      parts.push(sphere(`${id}.orb`, `${id}.cap`, 0.013, [0, 0, 0], solidGlow(capColor), { role: 'indicator' }));
      parts.push(ring(`${id}.shadow`, `${id}.cap`, 0.012, 0.016, [0, 0, -0.013], dim(capColor)));
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -(hs + 0.018), 0.004], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      if (showValue) parts.push(text(`${id}.value`, id, fmtDefault(c), [0, hs + 0.018, 0.004], { heightM: 0.008, color: accent, font: 'mono', background: NEON.ink }, { role: 'readout' }));
      if (cid) {
        behaviors.push({ id: `${id}.xy`, partId: `${id}.cap`, controlId: cid, type: 'xy', plane: 'xy', travel: [-hs + 0.012, hs - 0.012], gestures: ['pinch-drag', 'grab'], grabRadius: hs });
        fb('glow', `${id}.orb`, { on: 'grab', color: capColor });
        fb('tick', undefined, { every: 0.125, sound: 'tick' });
        if (showValue) fb('readout', `${id}.value`, { format: '{x},{y}' });
      }
      break;
    }

    case 'pads': {
      const rows = p.rows ?? 2;
      const cols = p.cols ?? 4;
      const s = p.size ?? 0.06;
      const gap = 0.012;
      const w = cols * s + (cols - 1) * gap;
      const h = rows * s + (rows - 1) * gap;
      parts.push(box(`${id}.plate`, id, w + 0.02, h + 0.02, 0.004, [0, 0, 0.002], plate(NEON.panel, accent), { role: 'base' }));
      let i = 0;
      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++, i++) {
          const x = -w / 2 + s / 2 + col * (s + gap);
          const y = h / 2 - s / 2 - r * (s + gap);
          const roundPad = (r + col) % 2 === 0;
          parts.push(group(`${id}.pad${i}`, id, [x, y, 0.004], { role: 'cap' }));
          if (roundPad) parts.push(cyl(`${id}.pad${i}.face`, `${id}.pad${i}`, s / 2, 0.01, [0, 0, 0.005], holo(body, { opacity: 0.95 }), { transform: { position: [0, 0, 0.005], rotationDeg: [90, 0, 0] } }));
          else parts.push(box(`${id}.pad${i}.face`, `${id}.pad${i}`, s, s, 0.01, [0, 0, 0.005], holo(body, { opacity: 0.95 }), { dims: { radius: 0.006 } }));
          parts.push(text(`${id}.pad${i}.n`, `${id}.pad${i}`, String(i + 1), [0, 0, 0.011], { heightM: 0.007, color: accent, font: 'mono' }));
          if (cid) {
            behaviors.push({ id: `${id}.pad${i}.press`, partId: `${id}.pad${i}`, controlId: cid, type: 'press', axis: 'z', depth: 0.006, gestures: ['poke', 'pinch'], grabRadius: s / 2 + 0.01, index: i });
            fb('glow', `${id}.pad${i}.face`, { on: 'trigger', color: accent });
          }
        }
      }
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -(h / 2 + 0.024), 0.004], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      break;
    }

    case 'keys': {
      const octaves = p.octaves ?? 1;
      const wk = 0.030;
      const gap = 0.004;
      const whiteLen = 0.1;
      const whites = 7 * octaves;
      const total = whites * wk + (whites - 1) * gap;
      const blackAfter = [0, 1, 3, 4, 5]; // white indices followed by a black key (C# D# F# G# A#)
      const semis = [0, 2, 4, 5, 7, 9, 11];
      const blackSemis = [1, 3, 6, 8, 10];
      parts.push(box(`${id}.bed`, id, total + 0.02, whiteLen + 0.02, 0.004, [0, 0, 0.002], plate(NEON.panel, accent), { role: 'base' }));
      for (let o = 0; o < octaves; o++) {
        for (let k = 0; k < 7; k++) {
          const wi = o * 7 + k;
          const x = -total / 2 + wk / 2 + wi * (wk + gap);
          const idx = o * 12 + semis[k]!;
          parts.push(group(`${id}.k${idx}`, id, [x, 0, 0.004], { role: 'cap' }));
          parts.push(box(`${id}.k${idx}.face`, `${id}.k${idx}`, wk, whiteLen, 0.012, [0, 0, 0.006], holo(NEON.text, { color: '#9FD9E6', opacity: 0.85 }), { dims: { radius: 0.003 } }));
          if (cid) behaviors.push({ id: `${id}.k${idx}.press`, partId: `${id}.k${idx}`, controlId: cid, type: 'press', axis: 'z', depth: 0.005, gestures: ['poke', 'pinch'], grabRadius: 0.02, index: idx });
          const bi = blackAfter.indexOf(k);
          if (bi >= 0) {
            const bidx = o * 12 + blackSemis[bi]!;
            const bx = x + (wk + gap) / 2;
            parts.push(group(`${id}.k${bidx}`, id, [bx, whiteLen * 0.2, 0.016], { role: 'cap' }));
            parts.push(box(`${id}.k${bidx}.face`, `${id}.k${bidx}`, 0.02, 0.06, 0.012, [0, 0, 0.006], holo(NEON.ink, { opacity: 0.98, edges: true, edgeColor: accent }), { dims: { radius: 0.002 } }));
            if (cid) behaviors.push({ id: `${id}.k${bidx}.press`, partId: `${id}.k${bidx}`, controlId: cid, type: 'press', axis: 'z', depth: 0.005, gestures: ['poke', 'pinch'], grabRadius: 0.015, index: bidx });
          }
        }
      }
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -(whiteLen / 2 + 0.024), 0.004], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      break;
    }

    case 'wheel': {
      const dia = p.size ?? 0.14;
      const mode = p.mode ?? 'hue';
      if (mode === 'hue') {
        const n = p.segments ?? 12;
        const rOut = dia / 2;
        const rIn = rOut * 0.55;
        for (let i = 0; i < n; i++) {
          const hue = Math.round((360 * i) / n);
          const col = hslHex(hue, 0.9, 0.55);
          const a0 = (360 * i) / n;
          parts.push(group(`${id}.seg${i}`, id, [0, 0, 0.004], { role: 'cap' }));
          parts.push(ring(`${id}.seg${i}.face`, `${id}.seg${i}`, rIn, rOut - 0.002, [0, 0, 0], solidGlow(col, { emissiveIntensity: 0.7 }), 360 / n - 2, 90 - a0 - 360 / n + 1));
          if (cid) behaviors.push({ id: `${id}.seg${i}.press`, partId: `${id}.seg${i}`, controlId: cid, type: 'press', axis: 'z', depth: 0.004, gestures: ['poke', 'pinch'], grabRadius: rOut, index: i });
        }
        parts.push(cyl(`${id}.swatch`, id, rIn * 0.8, 0.006, [0, 0, 0.003], solidGlow(accent), { role: 'indicator', transform: { position: [0, 0, 0.003], rotationDeg: [90, 0, 0] } }));
        if (cid) fb('color-shift', `${id}.swatch`);
      } else {
        const steps = p.segments ?? 5;
        const w = p.width ?? 0.16;
        const sw = (w - (steps - 1) * 0.004) / steps;
        const warm = [255, 179, 107];
        const cool = [187, 217, 245];
        for (let i = 0; i < steps; i++) {
          const t = steps === 1 ? 0 : i / (steps - 1);
          const col = rgbHex(warm.map((c, k) => c + (cool[k]! - c) * t));
          const x = -w / 2 + sw / 2 + i * (sw + 0.004);
          parts.push(group(`${id}.seg${i}`, id, [x, 0, 0.004], { role: 'cap' }));
          parts.push(box(`${id}.seg${i}.face`, `${id}.seg${i}`, sw, 0.044, 0.008, [0, 0, 0.004], solidGlow(col, { emissiveIntensity: 0.6 }), { dims: { radius: 0.004 } }));
          const stepLabel = c?.stepLabels?.[i];
          if (stepLabel) parts.push(text(`${id}.seg${i}.t`, `${id}.seg${i}`, stepLabel, [0, 0, 0.0085], { heightM: Math.min(0.0045, (sw * 0.8) / Math.max(3, stepLabel.length) / 0.65), color: NEON.void }));
          if (cid) behaviors.push({ id: `${id}.seg${i}.press`, partId: `${id}.seg${i}`, controlId: cid, type: 'press', axis: 'z', depth: 0.004, gestures: ['poke', 'pinch'], grabRadius: sw, index: i });
        }
        parts.push(text(`${id}.warm`, id, 'WARM', [-w / 2 - 0.022, 0, 0.004], { heightM: 0.006, color: NEON.dim }));
        parts.push(text(`${id}.cool`, id, 'COOL', [w / 2 + 0.022, 0, 0.004], { heightM: 0.006, color: NEON.dim }));
      }
      if (showLabel && label) parts.push(text(`${id}.label`, id, label, [0, -(dia / 2 + 0.02), 0.004], { heightM: 0.008, background: NEON.panel }, { role: 'label' }));
      break;
    }

    // --- HUD archetypes ----------------------------------------------------------------------------

    // --- SCAN ---------------------------------------------------------------------------------------

    case 'outline': {
      const st = p.status ?? 'scanned';
      const col = st === 'linking' || st === 'linked' ? NEON.magenta : st === 'uploading' || st === 'locked' || st === 'candidate' ? NEON.volt : st === 'verified' || st === 'controlled' ? NEON.ok : st === 'failed' || st === 'offline' ? NEON.fail : NEON.cyan;
      const contour = p.contour ?? rectContour((p.boxSize?.[0] ?? 0.3) / 2, (p.boxSize?.[1] ?? 0.1) / 2);
      const pts: Vec3[] = contour.map(([x, y]) => [x!, y!, 0]);
      parts.push(part({ id: `${id}.line`, parentId: id, kind: 'path', role: 'indicator', path: { points: pts, closed: true, width: 0.003, color: col, keyline: true, lineStyle: st === 'scanned' ? 'dashed' : 'solid', animate: st === 'linking' || st === 'uploading' ? 'pulse' : 'none' } }));
      break;
    }

    case 'tag': {
      const col = statusColor(p.status, accent);
      const w = p.width ?? 0.19;
      const h = 0.038;
      parts.push(...panel(`${id}.plate`, id, w, h, 0.003, [0, 0, 0], col, { role: 'label' }));
      parts.push(sphere(`${id}.pip`, id, 0.004, [-w / 2 + 0.014, 0, 0.003], solidGlow(col, { emissiveIntensity: 1.8 }), { role: 'indicator' }));
      parts.push(text(`${id}.title`, id, (p.title ?? label) || 'DEVICE', [-w / 2 + 0.026, 0.007, 0.003], { heightM: 0.0095, color: NEON.volt, align: 'left' }));
      parts.push(text(`${id}.sub`, id, p.subtitle ?? p.status ?? 'scanned', [-w / 2 + 0.026, -0.0085, 0.003], { heightM: 0.0058, color: col === NEON.volt ? NEON.bone : col, align: 'left' }));
      if (p.channel) parts.push(text(`${id}.chan`, id, channelGlyph(p.channel), [w / 2 - 0.012, 0, 0.003], { heightM: 0.0065, color: NEON.dim, align: 'right', font: 'mono' }));
      break;
    }

    case 'brackets': {
      const [bw, bh, bd] = (p.boxSize ?? [0.3, 0.1, 0.2]) as [number, number, number];
      const col = p.status === 'candidate' ? NEON.volt : p.status === 'failed' ? NEON.fail : (p.accent ?? NEON.volt);
      const arm = Math.min(0.024, Math.min(bw, bh) * 0.35);
      const t = 0.003;
      const mat = solidGlow(col, { emissiveIntensity: 1.5 });
      let n = 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const cx = (sx * bw) / 2, cy = (sy * bh) / 2, cz = bd / 2;
        parts.push(box(`${id}.c${n}x`, id, arm, t, t, [cx - (sx * arm) / 2, cy, cz], mat));
        parts.push(box(`${id}.c${n}y`, id, t, arm, t, [cx, cy - (sy * arm) / 2, cz], mat));
        if (bd > 0.02) parts.push(box(`${id}.c${n}z`, id, t, t, Math.min(arm, bd), [cx, cy, cz - Math.min(arm, bd) / 2], mat));
        n++;
      }
      break;
    }

    case 'twin': {
      const contour = p.contour ?? rectContour((p.boxSize?.[0] ?? 0.3) / 2, (p.boxSize?.[1] ?? 0.1) / 2);
      const depth = p.depth ?? p.boxSize?.[2] ?? 0.04;
      const col = statusColor(p.status, accent);
      parts.push(part({ id: `${id}.body`, parentId: id, kind: 'primitive', shape: 'extrude', dims: { profile: contour, depth }, transform: { position: [0, 0, -depth] }, material: { style: 'holo', color: NEON.holo, opacity: 0.55, fresnel: 2.5, scanlines: true, glow: 0.8, edges: true, edgeColor: col }, role: 'body' }));
      const pts: Vec3[] = contour.map(([x, y]) => [x!, y!, 0.001]);
      parts.push(part({ id: `${id}.edge`, parentId: id, kind: 'path', path: { points: pts, closed: true, width: 0.0025, color: col, keyline: true } }));
      break;
    }

    case 'sweep-plane': {
      const w = p.width ?? 2.5;
      const h = p.size ?? 1.6;
      parts.push(box(`${id}.band`, id, w, h, 0.004, [0, 0, 0], { style: 'holo', color: NEON.cyan, opacity: 0.35, fresnel: 1, scanlines: true, glow: 1 }, { role: 'indicator' }));
      parts.push(box(`${id}.edge`, id, w, h, 0.0005, [0, 0, 0.003], { style: 'wire', color: NEON.cyan, glow: 1, edges: true, edgeColor: NEON.cyan }));
      break;
    }

    // --- LINK -------------------------------------------------------------------------------------

    case 'oracle-strip': {
      const w = p.width ?? 0.26;
      const h = 0.028;
      const v = p.verdict ?? 'pending';
      const col = v === 'ok' ? NEON.ok : v === 'fail' ? NEON.fail : NEON.volt;
      parts.push(...panel(`${id}.plate`, id, w, h, 0.003, [0, 0, 0], col));
      const line = `SENT ${p.sent ?? '—'} · EXPECT ${p.expect ?? '—'} · SEEN ${p.seen ?? '…'}`;
      parts.push(text(`${id}.t`, id, line, [-w / 2 + 0.008, 0, 0.003], { heightM: 0.006, color: NEON.bone, align: 'left', font: 'mono', uppercase: false }, { role: 'readout' }));
      parts.push(sphere(`${id}.pip`, id, 0.0045, [w / 2 - 0.012, 0, 0.003], v === 'pending' ? dim(NEON.volt) : solidGlow(col), { role: 'indicator' }));
      break;
    }

    // --- HACK ----------------------------------------------------------------------------------------

    case 'hack-list': {
      const all = p.items ?? [];
      const items = all.slice(0, 6);
      const more = all.length - items.length;
      const w = p.width ?? 0.26;
      const rowH = 0.046;
      const headH = 0.032;
      const h = headH + Math.max(1, items.length + (more > 0 ? 1 : 0)) * rowH + 0.012;
      parts.push(...panel(`${id}.plate`, id, w, h, 0.004, [0, 0, 0], accent));
      parts.push(box(`${id}.headbar`, id, w - 0.012, 0.0015, 0.001, [0, h / 2 - headH, 0.0025], solidGlow(accent)));
      parts.push(text(`${id}.title`, id, (p.title ?? label) || 'HACKS', [-w / 2 + 0.008, h / 2 - headH / 2, 0.003], { heightM: 0.0095, color: accent, align: 'left' }));
      if (p.subtitle) parts.push(text(`${id}.sub`, id, p.subtitle, [w / 2 - 0.008, h / 2 - headH / 2, 0.003], { heightM: 0.0055, color: NEON.dim, align: 'right', uppercase: false }));
      items.forEach((it, i) => {
        const y = h / 2 - headH - rowH / 2 - i * rowH - 0.004;
        const st = it.status ?? 'ready';
        const col = st === 'verified' ? NEON.ok : st === 'failed' ? NEON.fail : st === 'locked' ? NEON.dim : st === 'ready' ? accent : NEON.volt;
        parts.push(group(`${id}.row${i}`, id, [0, y, 0.0025], { role: 'cap' }));
        parts.push(box(`${id}.row${i}.hit`, `${id}.row${i}`, w - 0.012, rowH - 0.005, 0.003, [0, 0, 0], { style: 'holo', color: NEON.void, opacity: 0.92, fresnel: 1, glow: 0.2, edges: true, edgeColor: st === 'locked' ? NEON.dim : col }, { dims: { radius: 0.003 } }));
        parts.push(text(`${id}.row${i}.glyph`, `${id}.row${i}`, kindGlyph(it.kind), [-w / 2 + 0.018, 0, 0.003], { heightM: 0.008, color: it.kind === 'daemon' ? NEON.magenta : col, font: 'mono', uppercase: false }));
        parts.push(text(`${id}.row${i}.label`, `${id}.row${i}`, it.label, [-w / 2 + 0.034, it.detail ? 0.0065 : 0, 0.003], { heightM: 0.011, color: st === 'locked' ? NEON.dim : NEON.volt, align: 'left' }));
        if (it.detail) parts.push(text(`${id}.row${i}.detail`, `${id}.row${i}`, it.detail, [-w / 2 + 0.034, -0.0095, 0.003], { heightM: 0.0058, color: NEON.dim, align: 'left', uppercase: false }));
        const verdict = it.verdict === 'seen' ? 'SEEN ✓' : it.verdict === 'heard' ? 'HEARD ✓' : it.verdict === 'wired' ? 'WIRED ✓' : it.verdict === 'pending' ? 'AWAITING' : it.channel ? channelGlyph(it.channel) : '—';
        parts.push(text(`${id}.row${i}.verdict`, `${id}.row${i}`, verdict, [w / 2 - 0.028, 0, 0.003], { heightM: 0.0055, color: it.verdict && it.verdict !== 'pending' && it.verdict !== 'none' ? NEON.ok : NEON.dim, align: 'right', font: 'mono', uppercase: false }));
        parts.push(sphere(`${id}.row${i}.pip`, `${id}.row${i}`, 0.0035, [w / 2 - 0.016, 0, 0.003], st === 'ready' || st === 'locked' ? dim(col) : solidGlow(col), { role: st === 'uploading' ? 'indicator' : 'decor' }));
        const target = it.controlId ?? cid;
        if (target && st !== 'locked') {
          behaviors.push({ id: `${id}.row${i}.press`, partId: `${id}.row${i}`, controlId: target, type: 'press', axis: 'z', depth: 0.003, gestures: ['poke', 'pinch'], grabRadius: 0.024, index: i });
          feedback.push({ id: `${id}.row${i}.glow`, controlId: target, type: 'glow', partId: `${id}.row${i}.hit`, on: 'hover', color: NEON.volt });
          feedback.push({ id: `${id}.row${i}.snd`, controlId: target, type: 'tick', on: 'trigger', sound: 'chirp' });
        }
      });
      if (more > 0) {
        const y = h / 2 - headH - rowH / 2 - items.length * rowH - 0.004;
        parts.push(text(`${id}.more`, id, `+${more} MORE`, [0, y, 0.003], { heightM: 0.0065, color: NEON.dim }));
      }
      break;
    }

    case 'queue-strip': {
      const items = (p.items ?? []).slice(0, 6);
      const chipW = 0.07;
      const gap = 0.006;
      const w = Math.max(chipW, items.length * chipW + (items.length - 1) * gap);
      items.forEach((it, i) => {
        const x = -w / 2 + chipW / 2 + i * (chipW + gap);
        const st = it.status ?? 'queued';
        const col = st === 'verified' ? NEON.ok : st === 'failed' ? NEON.fail : NEON.volt;
        parts.push(box(`${id}.q${i}`, id, chipW, 0.024, 0.003, [x, 0, 0], plate(NEON.plate, col), { dims: { radius: 0.004 } }));
        parts.push(text(`${id}.q${i}.t`, id, it.label, [x, 0.004, 0.003], { heightM: 0.0055, color: NEON.bone }));
        const prog = Math.max(0, Math.min(1, it.progress ?? (st === 'verified' ? 1 : 0)));
        parts.push(box(`${id}.q${i}.track`, id, chipW - 0.01, 0.0025, 0.001, [x, -0.007, 0.003], dim(col)));
        if (prog > 0) parts.push(box(`${id}.q${i}.fill`, id, (chipW - 0.01) * prog, 0.0025, 0.0015, [x - (chipW - 0.01) / 2 + ((chipW - 0.01) * prog) / 2, -0.007, 0.0035], solidGlow(col), { role: 'arc' }));
      });
      if (!items.length) parts.push(text(`${id}.empty`, id, 'QUEUE EMPTY', [0, 0, 0.003], { heightM: 0.006, color: NEON.dim, background: NEON.plate }));
      break;
    }

    case 'upload-bar': {
      const steps = p.steps ?? ['GEN', 'CHECK', 'SEND', 'SEEN'];
      const done = Math.min(steps.length, p.stepsDone ?? 0);
      const failed = p.status === 'failed';
      const w = p.width ?? p.size ?? 0.22;
      const segW = (w - (steps.length - 1) * 0.004) / steps.length;
      const col = failed ? NEON.fail : done >= steps.length ? NEON.ok : NEON.volt;
      parts.push(...panel(`${id}.plate`, id, w + 0.016, 0.04, 0.004, [0, 0, 0], col));
      parts.push(text(`${id}.title`, id, (p.title ?? label) || 'UPLOAD', [-w / 2, 0.011, 0.003], { heightM: 0.0072, color: NEON.bone, align: 'left' }));
      parts.push(text(`${id}.state`, id, failed ? 'FAILED' : done >= steps.length ? 'VERIFIED' : `${done}/${steps.length}`, [w / 2, 0.011, 0.003], { heightM: 0.0065, color: col, align: 'right', font: 'mono' }, { role: 'readout' }));
      steps.forEach((s, i) => {
        const x = -w / 2 + segW / 2 + i * (segW + 0.004);
        const lit = i < done;
        const cur = i === done && !failed;
        const segCol = failed && i === done ? NEON.fail : lit ? col : NEON.dim;
        parts.push(box(`${id}.s${i}`, id, segW, 0.009, 0.002, [x, -0.007, 0.0025], lit || (failed && i === done) ? solidGlow(segCol) : dim(cur ? NEON.volt : NEON.dim), { role: cur ? 'indicator' : lit ? 'arc' : 'decor' }));
        parts.push(text(`${id}.s${i}.t`, id, s, [x, -0.016, 0.003], { heightM: 0.0045, color: lit ? segCol : NEON.dim, font: 'mono' }));
      });
      break;
    }

    // --- HUD ------------------------------------------------------------------------------------------

    case 'deck': {
      const items = (p.items ?? [
        { id: 'scan', label: 'SCAN' },
        { id: 'ping', label: 'PING' },
        { id: 'hacks', label: 'HACKS', subtitle: 'your devices' },
        { id: 'daemons', label: 'DAEMONS', subtitle: 'automations', kind: 'daemon' as const },
        { id: 'undo', label: 'UNDO' },
      ]).slice(0, 6);
      const key = 0.044;
      const gap = 0.016;
      const w = items.length * key + (items.length - 1) * gap + 0.024;
      const anySub = items.some((it) => it.subtitle);
      const h = key + 0.044 + (anySub ? 0.012 : 0);
      parts.push(...panel(`${id}.plate`, id, w, h, 0.004, [0, 0, 0], accent));
      parts.push(text(`${id}.title`, id, p.title ?? 'DECK', [-w / 2 + 0.012, h / 2 - 0.01, 0.003], { heightM: 0.0072, color: accent, align: 'left' }));
      items.forEach((it, i) => {
        const x = -w / 2 + 0.012 + key / 2 + i * (key + gap);
        parts.push(group(`${id}.k${i}`, id, [x, -0.004 + (anySub ? 0.004 : 0), 0.0025], { role: 'cap' }));
        parts.push(box(`${id}.k${i}.face`, `${id}.k${i}`, key, key, 0.008, [0, 0, 0.004], holo(NEON.void, { opacity: 0.95, edges: true, edgeColor: it.kind === 'daemon' ? NEON.magenta : accent }), { dims: { radius: 0.005 } }));
        parts.push(text(`${id}.k${i}.t`, `${id}.k${i}`, it.label, [0, it.subtitle ? 0.004 : 0, 0.0085], { heightM: 0.0066, color: NEON.volt }));
        if (it.subtitle) parts.push(text(`${id}.k${i}.s`, `${id}.k${i}`, it.subtitle, [0, -0.011, 0.0085], { heightM: 0.0036, color: NEON.dim, uppercase: false }));
        const target = it.controlId ?? cid;
        if (target) {
          behaviors.push({ id: `${id}.k${i}.press`, partId: `${id}.k${i}`, controlId: target, type: 'press', axis: 'z', depth: 0.005, gestures: ['poke', 'pinch'], grabRadius: key / 2 + 0.01, index: i });
          feedback.push({ id: `${id}.k${i}.glow`, controlId: target, type: 'glow', partId: `${id}.k${i}.face`, on: 'hover', color: NEON.volt });
          feedback.push({ id: `${id}.k${i}.snd`, controlId: target, type: 'tick', on: 'trigger', sound: 'click' });
        }
      });
      break;
    }

    case 'model-chips': {
      const models = p.models ?? [];
      const chipW = p.width ?? 0.11;
      const gap = 0.006;
      const w = models.length * chipW + Math.max(0, models.length - 1) * gap;
      models.forEach((m, i) => {
        const x = -w / 2 + chipW / 2 + i * (chipW + gap);
        const col = statusColor(m.state, NEON.dim);
        parts.push(box(`${id}.m${i}`, id, chipW, 0.02, 0.002, [x, 0, 0], { style: 'holo', color: NEON.void, opacity: 0.95, edges: true, edgeColor: col, glow: m.state === 'live' ? 1 : 0.3, fresnel: 2 }, { dims: { radius: 0.004 }, role: m.state === 'live' ? 'indicator' : 'decor' }));
        parts.push(sphere(`${id}.m${i}.pip`, id, 0.0025, [x - chipW / 2 + 0.008, 0, 0.0025], m.state === 'live' ? solidGlow(col) : dim(col)));
        parts.push(text(`${id}.m${i}.t`, id, m.id, [x + 0.004, 0, 0.0025], { heightM: 0.0052, color: m.state === 'idle' ? NEON.dim : NEON.bone, font: 'mono', uppercase: false }));
      });
      break;
    }

    // --- PING -----------------------------------------------------------------------------------------

    case 'ping-line': {
      const from = (p.from ?? [0, 0, 0]) as Vec3;
      const to = (p.to ?? [0.4, 0.2, 0]) as Vec3;
      const col = statusColor(p.status, accent);
      const ch = p.channel;
      const lineStyle = ch === 'ir' ? 'cone' : ch === 'wifi' ? 'dotted' : ch === 'ble' ? 'dash-dot' : 'solid';
      parts.push(part({ id: `${id}.beam`, parentId: id, kind: 'path', role: 'beam', path: { from, to, arcHeight: ch === 'ir' ? 0 : 0.04, width: 0.002, color: col, lineStyle, keyline: true, animate: 'flow', particles: p.particles ?? 12, speed: p.speed ?? 0.5 } }));
      parts.push(ring(`${id}.a`, id, 0.006, 0.009, from, solidGlow(col)));
      parts.push(ring(`${id}.b`, id, 0.006, 0.009, to, solidGlow(col)));
      const mid: Vec3 = [(from[0]! + to[0]!) / 2, (from[1]! + to[1]!) / 2 + 0.06, (from[2]! + to[2]!) / 2];
      if (p.title || label) parts.push(text(`${id}.title`, id, p.title ?? label, mid, { heightM: 0.0065, color: col, background: NEON.panel, font: 'mono', uppercase: false, billboard: true }));
      break;
    }

    case 'link-matrix': {
      const rows = p.rows ?? 5;
      const cols = p.cols ?? 5;
      const cell = p.size ?? 0.028;
      const gap = 0.004;
      const w = cols * cell + (cols - 1) * gap;
      const h = rows * cell + (rows - 1) * gap;
      const picked = new Set(p.picked ?? []);
      const solved = new Set(p.solved ?? []);
      parts.push(...panel(`${id}.plate`, id, w + 0.024, h + 0.05, 0.004, [0, -0.012, 0], NEON.magenta));
      parts.push(text(`${id}.title`, id, p.title ?? 'LINK', [-w / 2, h / 2 + 0.014, 0.003], { heightM: 0.007, color: NEON.magenta, align: 'left', font: 'display' }));
      if (p.subtitle) parts.push(text(`${id}.sub`, id, p.subtitle, [w / 2, h / 2 + 0.014, 0.003], { heightM: 0.005, color: NEON.dim, align: 'right', uppercase: false }));
      for (let i = 0; i < rows * cols; i++) {
        const r = Math.floor(i / cols), c2 = i % cols;
        const x = -w / 2 + cell / 2 + c2 * (cell + gap);
        const y = h / 2 - cell / 2 - r * (cell + gap);
        const txt = p.cells?.[i] ?? hex2(i * 37 + 11);
        const meta = p.cellMeta?.find((m) => m.i === i);
        const isCur = p.current === i || meta?.state === 'trying';
        const isOk = solved.has(i) || meta?.state === 'ok';
        const isFail = meta?.state === 'fail';
        const col = isOk ? NEON.ok : isFail ? NEON.fail : isCur ? NEON.volt : picked.has(i) ? NEON.magenta : NEON.cyan;
        const faded = picked.has(i) && !isOk && !isCur && !isFail;
        parts.push(box(`${id}.cell${i}`, id, cell, cell, 0.002, [x, y, 0.002], { style: 'holo', color: faded ? NEON.ink : NEON.holo, opacity: faded ? 0.5 : 0.9, edges: isCur || isOk || isFail, edgeColor: col, glow: isCur ? 1 : 0.3, fresnel: 2 }, { role: isCur ? 'indicator' : 'decor' }));
        parts.push(text(`${id}.cell${i}.t`, id, meta?.effect ? txt : txt, [x, meta?.effect ? y + cell * 0.18 : y, 0.0035], { heightM: meta?.effect ? 0.005 : 0.0065, color: faded ? NEON.dim : col, font: 'mono' }));
        if (meta?.effect) parts.push(text(`${id}.cell${i}.e`, id, meta.effect, [x, y - cell * 0.22, 0.0035], { heightM: Math.min(0.0042, (cell * 0.9) / Math.max(4, meta.effect.length) / 0.6), color: col }));
        if (isFail) parts.push(text(`${id}.cell${i}.x`, id, '✕', [x + cell * 0.32, y + cell * 0.3, 0.0036], { heightM: 0.004, color: NEON.fail, font: 'mono', uppercase: false }));
      }
      // path through picked cells
      const order = p.picked ?? [];
      for (let k = 1; k < order.length; k++) {
        const a = order[k - 1]!, b = order[k]!;
        const pa: Vec3 = [-w / 2 + cell / 2 + (a % cols) * (cell + gap), h / 2 - cell / 2 - Math.floor(a / cols) * (cell + gap), 0.004];
        const pb: Vec3 = [-w / 2 + cell / 2 + (b % cols) * (cell + gap), h / 2 - cell / 2 - Math.floor(b / cols) * (cell + gap), 0.004];
        parts.push(part({ id: `${id}.p${k}`, parentId: id, kind: 'path', path: { from: pa, to: pb, width: 0.0012, color: NEON.magenta, lineStyle: 'dashed' } }));
      }
      break;
    }

    case 'daemon-link': {
      const from = (p.from ?? [-0.2, 0, 0]) as Vec3;
      const to = (p.to ?? [0.2, 0, 0]) as Vec3;
      const active = p.active ?? true;
      const col = active ? NEON.violet : NEON.dim;
      parts.push(part({ id: `${id}.beam`, parentId: id, kind: 'path', role: 'beam', path: { from, to, arcHeight: 0.05, width: 0.0018, color: col, lineStyle: 'dashed', animate: active ? 'pulse' : 'none' } }));
      const mid: Vec3 = [(from[0]! + to[0]!) / 2, (from[1]! + to[1]!) / 2 + 0.05, (from[2]! + to[2]!) / 2];
      parts.push(group(`${id}.cap`, id, mid, { role: 'cap' }));
      parts.push(box(`${id}.chip`, `${id}.cap`, 0.12, 0.026, 0.003, [0, 0, 0], plate(NEON.panel, col), { dims: { radius: 0.006 } }));
      parts.push(sphere(`${id}.dot`, `${id}.cap`, 0.0035, [-0.05, 0, 0.003], solidGlow(col), { role: 'indicator' }));
      parts.push(text(`${id}.title`, `${id}.cap`, (p.title ?? label) || 'DAEMON', [-0.042, 0, 0.003], { heightM: 0.0065, color: NEON.text, align: 'left' }));
      if (cid) {
        behaviors.push({ id: `${id}.toggle`, partId: `${id}.cap`, controlId: cid, type: 'toggle', axis: 'z', depth: 0.003, gestures: ['poke', 'pinch'], grabRadius: 0.03 });
        fb('glow', `${id}.chip`, { on: 'hover', color: NEON.violet });
        fb('color-shift', `${id}.dot`);
        fb('tick', undefined, { on: 'trigger', sound: 'chirp' });
      }
      break;
    }

    case 'worklog': {
      const rows = p.logRows ?? [];
      const models = p.models ?? [];
      const w = p.width ?? 0.36;
      const rowH = 0.034;
      const headH = 0.036;
      const chipsH = models.length ? 0.03 : 0;
      const h = headH + rows.length * rowH + chipsH + 0.016;
      parts.push(...panel(`${id}.plate`, id, w, h, 0.005, [0, 0, 0], accent));
      parts.push(text(`${id}.title`, id, (p.title ?? label) || 'AGENT', [-w / 2 + 0.014, h / 2 - headH / 2, 0.0035], { heightM: 0.011, color: accent, align: 'left', font: 'display' }));
      if (p.subtitle) parts.push(text(`${id}.sub`, id, p.subtitle, [w / 2 - 0.014, h / 2 - headH / 2, 0.0035], { heightM: 0.006, color: NEON.dim, align: 'right', uppercase: false }));
      parts.push(box(`${id}.headbar`, id, w - 0.028, 0.0015, 0.001, [0, h / 2 - headH, 0.0035], solidGlow(accent)));
      rows.forEach((row, i) => {
        const y = h / 2 - headH - rowH / 2 - i * rowH - 0.004;
        const col = statusColor(row.status, NEON.dim);
        parts.push(text(`${id}.r${i}.n`, id, String(i + 1), [-w / 2 + 0.018, y, 0.0035], { heightM: 0.0065, color: NEON.dim, font: 'mono' }));
        parts.push(text(`${id}.r${i}.t`, id, row.title, [-w / 2 + 0.03, y, 0.0035], { heightM: 0.0095, color: row.status === 'pending' ? NEON.dim : row.status === 'running' ? NEON.volt : NEON.text, align: 'left' }));
        if (row.status === 'ok') parts.push(text(`${id}.r${i}.s`, id, '✓', [w / 2 - 0.018, y, 0.0035], { heightM: 0.0085, color: NEON.green, font: 'mono', uppercase: false }));
        else if (row.status === 'fail') parts.push(text(`${id}.r${i}.s`, id, '✕', [w / 2 - 0.018, y, 0.0035], { heightM: 0.0085, color: NEON.red, font: 'mono', uppercase: false }));
        else parts.push(sphere(`${id}.r${i}.s`, id, 0.0035, [w / 2 - 0.018, y, 0.004], row.status === 'running' ? solidGlow(NEON.yellow) : dim(NEON.dim), { role: row.status === 'running' ? 'indicator' : 'decor' }));
        if (row.evidence) {
          const ev = row.kind === 'proof' ? NEON.green : row.kind === 'opinion' ? NEON.cyan : NEON.dim;
          parts.push(text(`${id}.r${i}.e`, id, row.evidence, [w / 2 - 0.032, y, 0.0035], { heightM: 0.006, color: ev, align: 'right', uppercase: false, font: 'mono' }));
        }
      });
      if (models.length) {
        const y = -h / 2 + chipsH / 2 + 0.006;
        const chipW = Math.min(0.1, (w - 0.028 - (models.length - 1) * 0.006) / models.length);
        models.forEach((m, i) => {
          const x = -w / 2 + 0.014 + chipW / 2 + i * (chipW + 0.006);
          const col = statusColor(m.state, NEON.dim);
          parts.push(box(`${id}.m${i}`, id, chipW, 0.018, 0.002, [x, y, 0.0035], { style: 'holo', color: NEON.ink, opacity: 0.95, edges: true, edgeColor: col, glow: m.state === 'live' ? 1 : 0.3, fresnel: 2 }, { dims: { radius: 0.004 }, role: m.state === 'live' ? 'indicator' : 'decor' }));
          parts.push(text(`${id}.m${i}.t`, id, m.id, [x, y, 0.005], { heightM: 0.0048, color: col, font: 'mono', uppercase: false }));
        });
      }
      break;
    }

    case 'reticle': {
      const r = (p.size ?? 0.036) / 2;
      const st = p.reticleState ?? 'idle';
      const col = st === 'idle' ? NEON.cyan : st === 'candidate' ? NEON.volt : st === 'lost' ? NEON.fail : st === 'working' ? NEON.volt : NEON.ok;
      parts.push(part({ id: `${id}.ring`, parentId: id, kind: 'primitive', shape: 'torus', dims: { r, tube: 0.0012, segments: 48 }, transform: { position: [0, 0, 0] }, material: solidGlow(col, { emissiveIntensity: 1.5 }), role: 'indicator' }));
      const spread = st === 'idle' ? r + 0.008 : r + 0.002;
      parts.push(box(`${id}.t0`, id, 0.0018, 0.008, 0.0018, [0, spread, 0], solidGlow(col)));
      parts.push(box(`${id}.t1`, id, 0.0018, 0.008, 0.0018, [0, -spread, 0], solidGlow(col)));
      parts.push(box(`${id}.t2`, id, 0.008, 0.0018, 0.0018, [spread, 0, 0], solidGlow(col)));
      parts.push(box(`${id}.t3`, id, 0.008, 0.0018, 0.0018, [-spread, 0, 0], solidGlow(col)));
      if (st === 'working') parts.push(sphere(`${id}.dot`, id, 0.004, [0, 0, 0], solidGlow(NEON.volt), { role: 'indicator' }));
      break;
    }

    // --- LEARN (IR) -------------------------------------------------------------------------------------

    case 'ir-waveform-card': {
      const w = p.width ?? 0.12;
      const h = 0.036;
      const st = p.cardState ?? 'captured';
      const col = st === 'seen' ? NEON.ok : st === 'no-change' ? NEON.fail : st === 'replaying' ? NEON.volt : NEON.cyan;
      parts.push(box(`${id}.plate`, id, w, h, 0.003, [0, 0, 0], plate(NEON.plate, col), { role: 'base', dims: { radius: 0.004 } }));
      const samples = p.samples && p.samples.length >= 2 ? p.samples : Array.from({ length: 40 }, (_, k) => ((k * 7919) % 13 < 6 ? 1 : 0));
      const n = samples.length;
      const left = -w / 2 + 0.008;
      const span = w - 0.016;
      const pts: Vec3[] = [];
      for (let k = 0; k < n; k++) {
        const x = left + (span * k) / (n - 1);
        const y = 0.004 + (samples[k]! - 0.5) * 0.012;
        pts.push([x, y, 0.0025]);
        if (k < n - 1 && samples[k + 1] !== samples[k]) pts.push([x, 0.004 + (samples[k + 1]! - 0.5) * 0.012, 0.0025]);
      }
      parts.push(part({ id: `${id}.wave`, parentId: id, kind: 'path', role: 'indicator', path: { points: pts.slice(0, 96), width: 0.0012, color: col, keyline: true, animate: st === 'replaying' ? 'pulse' : 'none' } }));
      const label = st === 'captured' ? `${p.title ?? 'CAPTURED'} · ?` : st === 'replaying' ? 'REPLAYING…' : st === 'seen' ? `SEEN ✓ ${p.effectLabel ?? ''}`.trim() : st === 'no-change' ? 'NO CHANGE ✗' : p.title ?? 'IR';
      parts.push(text(`${id}.label`, id, label, [left, -0.011, 0.003], { heightM: 0.0052, color: st === 'captured' ? NEON.dim : col, align: 'left', font: 'mono', uppercase: false }, { role: 'readout' }));
      if (p.jpLabel) parts.push(text(`${id}.jp`, id, p.jpLabel, [w / 2 - 0.008, -0.011, 0.003], { heightM: 0.0052, color: NEON.bone, align: 'right', uppercase: false }));
      break;
    }

    case 'remote-chips': {
      const chips = p.chips ?? [];
      chips.forEach((c, i) => {
        const st = c.state ?? 'idle';
        const col = st === 'captured' ? NEON.ok : st === 'pressed' ? NEON.volt : NEON.cyan;
        parts.push(box(`${id}.c${i}`, id, 0.024, 0.024, 0.002, [c.x, c.y, 0], { style: 'holo', color: NEON.void, opacity: st === 'idle' ? 0.6 : 0.92, edges: true, edgeColor: col, glow: st === 'pressed' ? 1 : 0.3, fresnel: 2 }, { dims: { radius: 0.004 }, role: st === 'pressed' ? 'indicator' : 'decor' }));
        parts.push(text(`${id}.c${i}.t`, id, c.jpLabel ?? c.label, [c.x, c.y + (c.jpLabel ? 0.003 : 0), 0.0025], { heightM: c.jpLabel ? 0.0055 : 0.0038, color: st === 'idle' ? NEON.dim : NEON.bone, uppercase: false }));
        if (c.jpLabel) parts.push(text(`${id}.c${i}.e`, id, c.label, [c.x, c.y - 0.0075, 0.0025], { heightM: 0.0028, color: col }));
      });
      break;
    }

    case 'handle': {
      const titleW = p.title ? p.title.length * 0.0048 + 0.02 : 0;
      const w = Math.max(p.width ?? p.size ?? 0.12, 0.05 + titleW);
      parts.push(box(`${id}.bar`, id, w, 0.024, 0.006, [0, 0, 0], plate(NEON.panel, accent), { role: 'handle', dims: { radius: 0.006 } }));
      for (let i = 0; i < 3; i++) parts.push(box(`${id}.g${i}`, id, 0.0025, 0.012, 0.0015, [-w / 2 + 0.012 + i * 0.007, 0, 0.0035], solidGlow(accent)));
      if (p.title) parts.push(text(`${id}.title`, id, p.title, [w / 2 - 0.008, 0, 0.0035], { heightM: 0.0055, color: NEON.dim, align: 'right' }));
      behaviors.push({ id: `${id}.grab`, partId: id, type: 'grab', gestures: ['pinch-drag', 'grab'], grabRadius: 0.04 });
      break;
    }
  }

  return { parts, behaviors, feedback };
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
}
function rectContour(hx: number, hy: number): number[][] {
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
}
function channelGlyph(ch: string): string {
  return ch === 'usb' ? 'USB' : ch === 'midi' ? 'MIDI' : ch === 'ir' ? 'IR' : ch === 'wifi' ? 'WIFI' : ch === 'ble' ? 'BLE' : ch === 'serial' ? 'TTY' : 'SIM';
}
function kindGlyph(kind: string | undefined): string {
  return kind === 'control' ? '◎' : kind === 'daemon' ? '∞' : '▸';
}
function rgbHex(rgb: number[]): HexColor {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
function hslHex(h: number, s: number, l: number): HexColor {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

// --- whole-spec expansion -----------------------------------------------------------------------------

export interface ExpandedSpec {
  /** every part, archetypes replaced by groups, generated parts appended */
  parts: Part[];
  behaviors: Behavior[];
  feedback: Feedback[];
  /** generated part id -> archetype part id it came from */
  origin: Map<string, string>;
}

/** Resolve the accent for the i-th archetype/control: control.accent > params.accent > device accent > theme. */
export function resolveAccent(spec: Gen3dSpec, part: Part, control: Control | undefined, index: number): HexColor {
  if (control?.accent) return control.accent;
  if (part.params?.accent) return part.params.accent;
  const dev = spec.device?.accents;
  if (dev && dev.length) return dev[index % dev.length]!;
  return DEFAULT_ACCENTS[index % DEFAULT_ACCENTS.length]!;
}

export function expandSpec(spec: Gen3dSpec): ExpandedSpec {
  const controls = new Map(spec.controls.map((c) => [c.id, c]));
  const parts: Part[] = [];
  const behaviors: Behavior[] = [...(spec.behaviors ?? [])];
  const feedback: Feedback[] = [...(spec.feedback ?? [])];
  const origin = new Map<string, string>();
  let i = 0;
  for (const p of spec.parts) {
    if (p.kind !== 'archetype' || !p.archetype) {
      parts.push(p);
      continue;
    }
    const control = p.controlId ? controls.get(p.controlId) : undefined;
    const accent = resolveAccent(spec, p, control, i++);
    const ex = expandArchetype(p, { accent, control, index: i });
    const { archetype: _a, params: _p, ...rest } = p;
    parts.push({ ...rest, kind: 'group' } as Part);
    for (const gp of ex.parts) {
      parts.push(gp);
      origin.set(gp.id, p.id);
    }
    behaviors.push(...ex.behaviors);
    feedback.push(...ex.feedback);
  }
  // the whole-object handle when the anchor is grabbable
  if (spec.anchor.grabbable !== false && !spec.parts.some((p) => p.archetype === 'handle')) {
    const ex = expandArchetype({ id: '_handle', kind: 'archetype', archetype: 'handle', params: { width: 0.12, title: spec.title } }, { accent: NEON.cyan, index: 0 });
    parts.push({ id: '_handle', kind: 'group', transform: { position: [0, handleY(spec), 0] }, role: 'handle' });
    for (const gp of ex.parts) parts.push(gp);
    behaviors.push(...ex.behaviors);
  }
  return { parts, behaviors, feedback, origin };
}

/**
 * Put the handle under the object: lowest root part minus its rough half-height minus 40 mm, so it never
 * covers a readout (reviewer note: a handle above the object collided with faders and lists).
 */
function handleY(spec: Gen3dSpec): number {
  let bottom = 0;
  for (const p of spec.parts) {
    if (p.parentId) continue;
    const y = p.transform?.position?.[1] ?? 0;
    const half = roughHalfHeight(p);
    bottom = Math.min(bottom, y - half);
  }
  return bottom - 0.05;
}
function roughHalfHeight(p: Part): number {
  const s = p.params?.size ?? p.params?.length ?? 0;
  if (p.kind === 'archetype') {
    switch (p.archetype) {
      case 'fader':
        return (p.params?.length ?? 0.16) / 2 + 0.05;
      case 'hack-list':
        return (0.03 + Math.max(1, Math.min(6, p.params?.items?.length ?? 1)) * 0.044) / 2 + 0.01;
      case 'worklog':
        return (0.036 + (p.params?.logRows?.length ?? 0) * 0.034 + 0.05) / 2;
      case 'link-matrix':
        return ((p.params?.rows ?? 6) * ((p.params?.size ?? 0.028) + 0.004)) / 2 + 0.03;
      case 'knob':
        return (s || 0.064) / 2 + 0.05;
      case 'dimmer-ring':
        return (s || 0.14) / 2 + 0.03;
      case 'pull-cord':
        return (p.params?.length ?? 0.2) + 0.06;
      case 'wheel':
        return (p.params?.mode === 'warmth' ? 0.05 : (s || 0.14) / 2) + 0.04;
      case 'xy-orb':
        return (s || 0.16) / 2 + 0.04;
      case 'toggle':
      case 'button':
        return 0.06;
      default:
        return (s || 0.06) / 2 + 0.03;
    }
  }
  const d = p.dims;
  return Math.max(d?.h ?? 0, (d?.r ?? 0) * 2, (d?.rOuter ?? 0) * 2) / 2;
}
