/**
 * Prompts for the gen3d generator. Order is chosen for Meta's automatic prefix cache:
 *   1. system: the stable rules + archetype catalog (byte-identical across requests and devices)
 *   2. developer: the mode (json spec / json patch / tool calls), identical per mode
 *   3. user: device card, drivers, current spec, request (everything that varies goes last)
 */
import type { DeviceCardPayload } from '@ce/protocol';
import type { DeviceDriver } from './driver';
import type { StreamMessage } from '../stream';

export type GenMode = 'json' | 'tools';
export type GenTask = 'generate' | 'edit';

export interface PromptKit {
  version: string;
  catalogTable(): string;
}

export interface PromptInput {
  card: Pick<DeviceCardPayload, 'cardId' | 'name' | 'maker' | 'model' | 'category'> & Partial<DeviceCardPayload>;
  target: DeviceDriver;
  /** other paired devices (daemon targets/sources); the target may be included, it is filtered out */
  room?: DeviceDriver[];
  request: string;
  /** the spec currently on screen (edits) */
  current?: unknown;
  /** issues from the previous attempt (repairs) */
  repair?: { issues: string[]; previous?: string };
}

const cache = new Map<string, string>();

export function systemPrompt(kit: PromptKit): string {
  const hit = cache.get(kit.version);
  if (hit) return hit;
  const text = `You are the generator inside ControlEverything, a Meta Quest 3 passthrough app that lets a person take over the devices in their own room, netrunner style. For ONE target device you design its hack set: named one-shot hacks, live 3D controls that float beside the device, and daemons that link it to other devices. Everything you output is bound to the device's real driver and checked by a physical oracle (camera or microphone) after it fires.

## Inputs
- TARGET: the device card the camera identified, and its DRIVER: the only actions you may call (typed params with ranges, and the physical effects each action can cause) and the signals it emits.
- ROOM: other paired devices with their drivers. Use them only in daemons.
- CURRENT SPEC: what is on screen now (edits only). REQUEST: what the user asked for, often spoken, so read intent generously.

## Rules (a deterministic checker enforces every one; violations come back to you for repair)
1. Call only actions listed in the driver. Pass only params that action declares; numbers inside the declared range; enum values spelled exactly as listed. Give every required param except the one named in valueArg.
2. valueArg names the param that receives the live control value ("" for none). The control's min..max must lie inside that param's range. Integer params need integer min, max and step >= 1. A bool param needs min 0, max 1.
3. Control kinds: continuous (any value in range); stepped (step > 0); toggle (min 0, max 1, step 1); momentary (fires on press). Every non-momentary control needs a valueArg.
4. Each control gets exactly one 3D object with controlId = the control id. Decorative objects use controlId "". The archetype must suit the control kind (see the catalog).
5. ids: lowercase snake_case, unique within their list. Labels <= 16 characters. Hack names are short imperatives, <= 24 characters ("Lights out", "Filter sweep", "Night mode").
6. expect is the physical effect the oracle checks after the hack, control or daemon fires: sensor "camera" for light or screen changes, "mic" for sound, "none" if nothing is observable. It must be an effect the called actions declare.
7. Photosensitivity: anything that changes a light runs at most 3 times per second. In hacks, keep light-changing steps >= 340 ms apart (delayMs). Daemons that drive a light need maxRateHz <= 3; prefer 1-2.
8. Only the user's own devices. Never describe attacking other people's devices or networks.

## 3D layout
Frame: metres, origin at the anchor point, +x right, +y up, +z toward the user. Objects stand on an invisible plate at y = 0, so position.y is usually 0. Footprint = catalog size x scale; keep every footprint inside x -0.30..0.30 and z -0.20..0.20, with >= 0.02 m clear between footprints. A row of four 0.06 m knobs at scale 1 fits at x = -0.135, -0.045, 0.045, 0.135.
Anchor: "device" docks the plate beside a tabletop device; "panel" floats it in front of the user (use it for out-of-reach devices such as ceiling lights); "hand" and "world" are rarely right. offset is metres from that point.
scale: 0.5-2.5 (1 = catalog size; "big" means about 1.6-2). rotation in degrees.

## Archetype catalog
The renderer builds every archetype from primitives. Add parts only for extra detail (a glow ring, a grip); most objects need none.
${kit.catalogTable()}
Part primitives: box, cylinder, sphere, torus, cone, capsule; size = x/y/z extents in metres (cylinder: x = diameter, y = height); part position is relative to its object.
Behaviour: motion rotate or flip (degrees), slide or press (metres), none; from..to is the travel; detents 0 = smooth; springBack true for momentary objects. Start from the catalog default.

## Look
Colours are hex. Borrow the device's own colours when it has them (an instrument's encoder colours, a lamp's warm white). emissive is the glow colour (#000000 for none); a dim neon glow in a matching hue suits the netrunner overlay. metalness and roughness are 0-1.

## Output
Follow the format the developer message asks for. Use empty lists for parts of the hack set the request does not need.`;
  cache.set(kit.version, text);
  return text;
}

export function modeInstruction(mode: GenMode, task: GenTask): string {
  if (mode === 'json' && task === 'generate') {
    return 'Answer with one JSON object that matches the response schema: the complete spec for the target device.';
  }
  if (mode === 'json' && task === 'edit') {
    return 'Answer with one JSON patch object that matches the response schema. List only the items the request changes, each as its complete new version (copy the unchanged fields from CURRENT SPEC and keep its id); put ids to delete in remove. Everything you do not list stays exactly as it is, so leave untouched items out.';
  }
  if (task === 'generate') {
    return 'Build the spec with tool calls, no prose. add_control places a control and its 3D object; bind attaches it to a driver action; add_hack and add_daemon add the semantic items; set_material colours an object; add_part adds extra geometry. Put independent calls in parallel in the same turn, then call done once everything is in.';
  }
  return 'Edit CURRENT SPEC with tool calls, no prose. Calling add_control, add_hack or add_daemon with an existing id replaces that item; set_material recolours; remove deletes. Touch only what the request needs, then call done.';
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

export function userPrompt(p: PromptInput): string {
  const card = {
    cardId: p.card.cardId,
    name: p.card.name,
    maker: p.card.maker,
    model: p.card.model,
    category: p.card.category,
    ...(p.card.evidence?.length ? { evidence: p.card.evidence } : {}),
    ...(p.card.notes ? { notes: p.card.notes } : {}),
  };
  const room = (p.room ?? []).filter((d) => d.cardId !== p.target.cardId);
  const lines = [
    'TARGET DEVICE',
    json(card),
    'TARGET DRIVER',
    json(p.target),
    'ROOM (other paired devices, for daemons only)',
    room.length ? json(room) : '[]',
    'CURRENT SPEC',
    p.current === undefined ? 'none' : json(p.current),
    'REQUEST',
    json(p.request),
  ];
  if (p.repair) {
    lines.push(
      'REPAIR',
      'Your previous answer failed these checks. Fix every one and answer again in the same format:',
      ...p.repair.issues.map((i) => `- ${i}`),
    );
    if (p.repair.previous) lines.push('PREVIOUS ANSWER', p.repair.previous);
  }
  return lines.join('\n');
}

export function buildMessages(kit: PromptKit, mode: GenMode, task: GenTask, input: PromptInput): StreamMessage[] {
  return [
    { role: 'system', content: systemPrompt(kit) },
    { role: 'developer', content: modeInstruction(mode, task) },
    { role: 'user', content: userPrompt(input) },
  ];
}
