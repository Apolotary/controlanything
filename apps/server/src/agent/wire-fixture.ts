/**
 * Wiring programs that no Meta model wrote, both labelled:
 *   FIXTURE  recorded wirings for "Touch the water" and "Hands as knobs", so the emulator flow and the tests run
 *            without Muse credits (MODEL_MODE=fixture). They are chosen by the request text and built from the
 *            driver actions named in the prompt.
 *   Template the hand-written mapping behind a failed live attempt. It keeps the demo alive and is never the default.
 */
import type { ChatMessage } from '../muse/adapter';
import { touchControls } from '../devices/visualSynth';

export interface ActionBrief { actionId: string; label: string; kind: 'set' | 'trigger' | 'toggle'; min?: number; max?: number; effect?: string }
export interface WireDraftData { title: string; explanation: string; code: string; needs: ('right' | 'left' | 'screen')[] }

const num = (n: number) => String(Math.round(n * 1000) / 1000);
const lerp = (a: ActionBrief, expr: string) => {
  const min = a.min ?? 0;
  const max = a.max ?? 1;
  return min === 0 ? `${expr} * ${num(max)}` : `${num(min)} + ${expr} * ${num(max - min)}`;
};
const q = (id: string) => `'${id}'`;

/** The driver's touch inputs (X, Y, pressure), found through the capability manifest's touch controls. */
export function pickTouch(actions: ActionBrief[], controls = touchControls()): { x: ActionBrief; y: ActionBrief; pressure: ActionBrief } | undefined {
  const byCc = (c: { cc: number }) => actions.find((a) => a.actionId === `cc${c.cc}` && a.kind === 'set');
  const find = (re: RegExp) => { const c = controls.find((k) => re.test(`${k.parameter} ${k.label}`)); return c ? byCc(c) : undefined; };
  const x = find(/\bx\b|horizontal|left/i);
  const y = find(/\by\b|vertical|top/i);
  const pressure = find(/press|force|contact|depth/i);
  return x && y && pressure ? { x, y, pressure } : undefined;
}

function touchCode(x: ActionBrief, y: ActionBrief, p: ActionBrief, real: boolean): string {
  // `real`: the device's own touch inputs (X, Y, pressure: 0 lifted, 1-20 hover, above 20 touching). Otherwise the fingertip
  // drives three ordinary controls and the pressure is just scaled into that control's range.
  const pressure = real
    ? [
      '  // Pressure: 0 = lifted, 1-20 = hovering (a soft glow), above 20 = touching (a splash).',
      '  let press = 0;',
      '  if (t.touching) press = 100;',
      '  else if (t.hover > 0.02) press = 1 + t.hover * 19;',
      `  out.set(${q(p.actionId)}, press);`,
    ]
    : [
      '  // Pressure: a soft glow while the finger hovers, a full splash on contact.',
      '  const press = t.touching ? 1 : t.hover * 0.15; // hover stays under the touch threshold (20 of 127)',
      `  out.set(${q(p.actionId)}, ${lerp(p, 'press')});`,
    ];
  return [
    '// Touch the water: your fingertip on the screen becomes a ripple.',
    '// Where the finger is on the screen (0..1 across and down) -> the touch position.',
    'const t = s.screen;',
    'if (t && t.inside) {',
    '  // Position first, then pressure, so the splash lands under the finger.',
    `  out.set(${q(x.actionId)}, ${lerp(x, 't.u')});`,
    `  out.set(${q(y.actionId)}, ${lerp(y, 't.v')});`,
    ...pressure,
    '  mem.lit = true;',
    '} else if (mem.lit) {',
    '  // The finger left the screen or the hand was lost: lift the touch once.',
    `  out.set(${q(p.actionId)}, ${num(p.min ?? 0)});`,
    '  mem.lit = false;',
    '}',
  ].join('\n');
}

function knobsCode(sets: ActionBrief[], trigger?: ActionBrief): string {
  const [a, b, c] = sets;
  const lines = ['// Hands as knobs: each hand moves a different control.'];
  const smooth = (name: string, from: string) => `  mem.${name} = mem.${name} === undefined ? ${from} : mem.${name} + (${from} - mem.${name}) * 0.35; // smooth the motion`;
  lines.push('const r = s.right;');
  if (c) lines.push('const l = s.left;');
  if (a || b) {
    lines.push('if (r) {');
    if (a) lines.push(`  // Right hand height -> ${a.label}`, smooth('a', 'r.height'), `  out.set(${q(a.actionId)}, ${lerp(a, 'mem.a')});`);
    if (b) lines.push(`  // Right hand forward/back -> ${b.label}`, smooth('b', 'r.push'), `  out.set(${q(b.actionId)}, ${lerp(b, 'mem.b')});`);
    lines.push('}');
  }
  if (c) lines.push('if (l) {', `  // Left hand height -> ${c.label}`, smooth('c', 'l.height'), `  out.set(${q(c.actionId)}, ${lerp(c, 'mem.c')});`, '}');
  if (trigger) lines.push('// A quick pinch with the right hand fires the one-shot.', `if (r && r.pinchTap) out.trigger(${q(trigger.actionId)});`);
  return lines.join('\n');
}

const TOUCH_WORDS = /touch|water|ripple|splash|finger|screen|poke|tap on|press the/i;

/** The wiring for a request, built from the driver's own actions. `prefix` labels who wrote it (FIXTURE / Template). */
export function buildWiring(actions: ActionBrief[], request: string, prefix: 'FIXTURE' | 'Template', note: string, controls = touchControls()): WireDraftData {
  const sets = actions.filter((a) => a.kind === 'set');
  const trigger = actions.find((a) => a.kind === 'trigger') ?? actions.find((a) => a.kind === 'toggle');
  if (TOUCH_WORDS.test(request) && sets.length) {
    const touch = pickTouch(actions, controls);
    // A device without touch inputs (the manifest has none yet): the fingertip drives its first controls instead.
    const t = touch ?? { x: sets[0]!, y: sets[1] ?? sets[0]!, pressure: sets[2] ?? sets[1] ?? sets[0]! };
    return {
      title: `${prefix}: Touch the water`,
      explanation: `${note} ${touch ? 'Touch the screen with your fingertip and ripples follow your finger.' : `This device has no touch input, so your fingertip moves ${t.x.label} and ${t.y.label}.`}`.slice(0, 200),
      code: touchCode(t.x, t.y, t.pressure, !!touch), needs: ['screen'],
    };
  }
  // Hands as knobs: the first controls the device has (right hand height / push, left hand height, pinch); the
  // fingertip inputs (Touch X / Y / pressure) are not knobs.
  const touchIds = new Set(controls.map((c) => `cc${c.cc}`));
  const knobs = sets.filter((a) => !touchIds.has(a.actionId)).slice(0, 3);
  if (!knobs.length && !trigger) {
    return { title: `${prefix}: nothing to wire`, explanation: `${note} This device has no actions to play.`.slice(0, 200), code: `// ${prefix}: this device has no controls\nconst r = s.right;`, needs: ['right'] };
  }
  const needsLeft = knobs.length > 2;
  return {
    title: `${prefix}: Hands as knobs`,
    explanation: `${note} ${knobs.length ? `Right hand height moves ${knobs[0]!.label}${knobs[1] ? `, push/pull moves ${knobs[1].label}` : ''}${needsLeft ? `, left hand height moves ${knobs[2]!.label}` : ''}.` : 'Pinch to fire the control.'}`.slice(0, 200),
    code: knobsCode(knobs, trigger), needs: needsLeft ? ['right', 'left'] : ['right'],
  };
}

/** Driver actions as the prompt lists them: one JSON array on a line starting "Driver actions (JSON): ". */
export function parseBriefs(text: string): ActionBrief[] {
  const line = /Driver actions \(JSON\): (\[.*\])$/m.exec(text)?.[1];
  if (!line) return [];
  try {
    const rows = JSON.parse(line) as { actionId: string; label: string; kind: ActionBrief['kind']; range?: [number, number]; effect?: string }[];
    return rows.map((r) => ({ actionId: r.actionId, label: r.label, kind: r.kind, min: r.range?.[0], max: r.range?.[1], effect: r.effect }));
  } catch {
    return [];
  }
}

const textOf = (messages: ChatMessage[]): string => messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '))).join('\n');

/** The FIXTURE answer for chatJson("wire_program"): reads the request and the driver actions out of the prompt. */
export function fixtureWireDraft(messages: ChatMessage[]): WireDraftData {
  const text = textOf(messages);
  const request = /^Wearer request: (.*)$/m.exec(text)?.[1] ?? '';
  return buildWiring(parseBriefs(text), request, 'FIXTURE', 'Recorded wiring, no Meta model wrote it.');
}

/** The hand-written mapping behind a failed live attempt (title starts "Template:"). */
export function templateWiring(actions: ActionBrief[], request: string): WireDraftData {
  return buildWiring(actions, request, 'Template', 'No Meta model wrote this: a hand-made mapping so the demo keeps going.');
}
