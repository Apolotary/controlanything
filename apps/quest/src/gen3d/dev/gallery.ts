/**
 * The gen3d gallery: renders every example spec (and any pasted spec) on a desktop stage with mouse
 * interaction, replays the streaming build-up, and can enter an emulated XR session (IWER) when the browser
 * has no WebXR. Served at /quest/gallery.html.
 */
import { AmbientLight, Color, Timer, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Quaternion, Scene, SRGBColorSpace, Vector3, WebGLRenderer, BoxGeometry, GridHelper } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { EXAMPLES, scanPartialSpec, validateSpec, repairSpec, type ControlEvent, type Gen3dSpec } from '@ce/gen3d';
import { ConsoleSink, Emitter, MaterialClock, MouseCursor, MultiSink, SpecObject, UiAudio, newCursor, type Cursor, type GenEvents } from '../index';
import { createHud, type Hud, type HudFrame } from '../../hud/index';

const stage = document.getElementById('stage')!;
const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(stage.clientWidth, stage.clientHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = SRGBColorSpace;
renderer.xr.enabled = true;
stage.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(60, stage.clientWidth / stage.clientHeight, 0.02, 50);
camera.position.set(0, 1.42, 0.05);
const target = new Vector3(0, 1.2, -0.6);
camera.lookAt(target);

scene.add(new HemisphereLight(0xcfe6ff, 0x1a1e24, 0.9));
const sun = new DirectionalLight(0xffffff, 1.2);
sun.position.set(0.6, 2.2, 1.2);
scene.add(sun, new AmbientLight(0x404850, 0.5));

// a desk and a floor grid stand in for the room (passthrough)
const room = new Group();
const desk = new Mesh(new BoxGeometry(1.2, 0.03, 0.6), new MeshStandardMaterial({ color: 0x4f4a44, roughness: 0.9 }));
desk.position.set(0, 0.72, -0.62);
room.add(desk);
const floor = new Mesh(new PlaneGeometry(6, 6), new MeshStandardMaterial({ color: 0x1a1e24, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
room.add(floor);
const grid = new GridHelper(6, 24, 0x2a3440, 0x1f262e);
grid.position.y = 0.001;
room.add(grid);
scene.add(room);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(target);
controls.mouseButtons = { LEFT: -1 as never, MIDDLE: 1, RIGHT: 0 } as never; // left button is for the controls themselves
controls.enableDamping = true;
controls.update();

const clock = new MaterialClock();
const audio = new UiAudio();
const emitter = new Emitter<GenEvents>();
const eventsEl = document.getElementById('events')!;
const lines: string[] = [];
const sink = new MultiSink([
  new ConsoleSink(),
  {
    control(e: ControlEvent) {
      lines.push(`${e.controlId}${e.index !== undefined ? `[${e.index}]` : ''} ${e.phase.padEnd(5)} ${JSON.stringify(e.value)}`);
      while (lines.length > 14) lines.shift();
      eventsEl.textContent = lines.join('\n');
    },
  },
]);
emitter.on('grab', (g) => {
  lines.push(`grab → ${g.position.map((v) => v.toFixed(2)).join(',')} yaw ${g.yawDeg.toFixed(0)}°`);
  eventsEl.textContent = lines.join('\n');
});

const mouse = new MouseCursor(renderer.domElement, camera);
const controllerCursors: Cursor[] = [newCursor('ctrl0', 'controller'), newCursor('ctrl1', 'controller')];
const wrap = new Group();
scene.add(wrap);
let current: SpecObject | null = null;
let currentSpec: Gen3dSpec | null = null;

function placeFor(spec: Gen3dSpec): { position: Vector3; faceCamera: boolean } {
  const a = spec.anchor;
  if (a.mode === 'world' && a.position) return { position: new Vector3(a.position[0], a.position[1], a.position[2]), faceCamera: false };
  if (a.mode === 'device') return { position: new Vector3(0, 0.76 + (a.offset?.[1] ?? 0.05), -0.55), faceCamera: a.faceUser ?? true };
  if (a.mode === 'hand') return { position: new Vector3(-0.25, 1.1, -0.45), faceCamera: true };
  const d = a.distance ?? 0.6;
  const pitch = ((a.pitchDeg ?? -12) * Math.PI) / 180;
  return { position: new Vector3(0, 1.42 + Math.sin(pitch) * d, 0.05 - Math.cos(pitch) * d), faceCamera: a.faceUser ?? true };
}

function show(spec: Gen3dSpec, animate: 'none' | 'buildup' = 'buildup'): void {
  if (current) {
    wrap.remove(current);
    current.dispose();
  }
  currentSpec = spec;
  current = new SpecObject(spec, { clock, audio, sink, emitter });
  if (animate === 'buildup') current.applySpec(spec, 'buildup');
  const place = placeFor(spec);
  if (!renderer.xr.isPresenting && spec.anchor.mode !== 'world') place.position.x += 0.22;
  current.position.copy(place.position);
  if (place.faceCamera) current.lookAt(camera.position.x, place.position.y, camera.position.z);
  wrap.add(current);
  mouse.setTargets(current.interactiveMeshes());
  controls.target.copy(place.position);
  armBtn.textContent = spec.state?.armed === false ? 'arm' : 'disarm';
  jsonEl.value = JSON.stringify(spec, null, 2);
  report(validateSpec(spec));
}

// --- panel --------------------------------------------------------------------------------------------------
const select = document.getElementById('examples') as HTMLSelectElement;
for (const name of Object.keys(EXAMPLES)) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  select.appendChild(o);
}
// live specs recorded by gen3d-forge (research/, dev server only): shown as extra options when reachable
const LIVE_SPECS: Record<string, string> = {
  'live · ceiling light (muse-spark-1.3)': '/quest/@fs/Volumes/macbook_ext/Developer/muse_hack2/research/gen3d-live/ceiling-light.hackset.json',
  'live · OP-1 Field (muse-spark-1.3)': '/quest/@fs/Volumes/macbook_ext/Developer/muse_hack2/research/gen3d-live/op1-field.hackset.json',
  'live · OP-1 Field rev 2 · red lever': '/quest/@fs/Volumes/macbook_ext/Developer/muse_hack2/research/gen3d-live/op1-field.resonance-lever.json',
};
const liveCache = new Map<string, Gen3dSpec>();
for (const [name, url] of Object.entries(LIVE_SPECS)) {
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((doc: { gen3d?: unknown }) => {
      const raw = doc.gen3d ?? doc;
      const { spec } = repairSpec(raw);
      const v = validateSpec(spec);
      if (!v.spec) return;
      liveCache.set(name, v.spec);
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      select.appendChild(o);
    })
    .catch(() => {});
}
const params = new URLSearchParams(location.search);
const initial = params.get('spec') && EXAMPLES[params.get('spec')!] ? params.get('spec')! : 'op1-knobs';
select.value = initial;
select.addEventListener('change', () => {
  const live = liveCache.get(select.value);
  if (live) {
    show(live);
    return;
  }
  history.replaceState(null, '', `?spec=${select.value}`);
  show(EXAMPLES[select.value]!);
});

const armBtn = document.getElementById('arm') as HTMLButtonElement;
armBtn.addEventListener('click', () => {
  if (!current) return;
  const armed = !(current.spec.state?.armed ?? true);
  current.setArmed(armed, armed ? 'USB says OP-1 Field ✓ · CC echoed ✓' : 'verifying on the real device…');
  armBtn.textContent = armed ? 'disarm' : 'arm';
});
document.getElementById('materialize')!.addEventListener('click', () => current?.applySpec(current.spec, 'buildup'));
document.getElementById('stream')!.addEventListener('click', () => void streamDemo());
document.getElementById('shot')!.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `gen3d-${select.value}.png`;
  a.click();
});
const jsonEl = document.getElementById('json') as HTMLTextAreaElement;
const validationEl = document.getElementById('validation')!;
document.getElementById('load')!.addEventListener('click', () => {
  try {
    const raw = JSON.parse(jsonEl.value) as unknown;
    const { spec, fixes } = repairSpec(raw);
    const v = validateSpec(spec);
    report(v, fixes);
    if (v.spec) show(v.spec);
  } catch (e) {
    validationEl.innerHTML = `<span class="err">${String(e)}</span>`;
  }
});
document.getElementById('copy')!.addEventListener('click', () => void navigator.clipboard.writeText(jsonEl.value));

function report(v: ReturnType<typeof validateSpec>, fixes: string[] = []): void {
  const out: string[] = [];
  if (fixes.length) out.push(`<span class="warn">repaired: ${fixes.join('; ')}</span>`);
  if (v.ok) out.push(`<span class="ok">ok</span> · ${v.stats.parts} parts → ${v.stats.expandedParts} expanded · ~${v.stats.triangles} tris · ${v.stats.behaviors} behaviours`);
  else out.push(...v.errors.map((e) => `<span class="err">${e.path}: ${e.message}</span>`));
  out.push(...v.warnings.map((w) => `<span class="warn">${w.path}: ${w.message}</span>`));
  validationEl.innerHTML = out.join('\n');
}

/** Replay the current spec as if Muse were streaming it: ~120 chars per 60 ms into scanPartialSpec. */
async function streamDemo(): Promise<void> {
  if (!currentSpec || !current) return;
  const full = currentSpec;
  const text = JSON.stringify(sortKeys(full));
  const base: Gen3dSpec = { ...full, controls: [], parts: [], behaviors: [], feedback: [] };
  current.applySpec({ ...base, parts: [{ id: 'placeholder', kind: 'group' }] }, 'none');
  let seen = 0;
  for (let i = 0; i < text.length; i += 120) {
    await new Promise((r) => setTimeout(r, 60));
    const partial = scanPartialSpec(text.slice(0, i + 120));
    const n = partial.controls.length + partial.parts.length;
    if (n !== seen) {
      seen = n;
      current.applyPartial(partial, base);
    }
  }
  current.applySpec(full, 'diff');
}
/** The Meta decoder emits keys alphabetically; mimic it so the demo exercises the forward-reference path. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

// --- HUD demo: the scan → lock → link → hack → upload → arm sequence, driven by script -----------------------
let hud: (Hud & { setDevCursors?: (c: Cursor[]) => void }) | null = null;
const log = (line: string) => {
  lines.push(line);
  while (lines.length > 14) lines.shift();
  eventsEl.textContent = lines.join('\n');
};
document.getElementById('hud')!.addEventListener('click', () => void hudDemo());
async function hudDemo(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (current) {
    wrap.remove(current);
    current.dispose();
    current = null;
  }
  if (hud) hud.dispose();
  hud = createHud({ scene, camera, renderer });
  hud.setDevCursors?.([mouse.cursor]);
  mouse.setTargets([hud.root]);
  hud.on('hack', (e) => log(`hack ${e.itemId} on ${e.targetId}`));
  hud.on('deck', (e) => log(`deck ${e.key} ${e.phase}`));
  hud.on('confirm', (e) => log(`confirm ${e.id} ${e.approve ? 'approve' : 'deny'}`));
  hud.on('control', (e) => log(`${e.controlId} ${e.phase.padEnd(5)} ${JSON.stringify(e.value)}`));
  controls.target.set(0.2, 1.1, -0.7);
  hud.setModelChips([{ id: 'sam-3.1', state: 'idle' }, { id: 'muse-spark-1.3', state: 'idle' }, { id: 'muse-voice-transcribe-1.0', state: 'idle' }]);
  hud.setDeck({ open: true, at: [-0.25, 0.95, -0.45] });
  hud.toast('SCAN', 'info');
  hud.setScanning(true, { modelId: 'sam-3.1', prompts: 6 });
  await sleep(1300);
  const circle: [number, number][] = Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * 0.22, Math.sin((i / 24) * Math.PI * 2) * 0.22]);
  hud.upsertTarget({ id: 'light', label: 'CEILING LIGHT', status: 'scanned', channel: 'ir', position: [0.55, 1.75, -1.5], facing: [0, -0.35, 0.94], confirmed: true, sizeM: [0.45, 0.06, 0.45], contour: circle, modelId: 'sam-3.1' });
  await sleep(600);
  hud.upsertTarget({ id: 'op1', label: 'OP-1 FIELD', status: 'scanned', channel: 'usb', position: [0.22, 0.75, -0.6], facing: [0, 1, 0], confirmed: true, sizeM: [0.288, 0.03, 0.102], contour: [[-0.144, -0.051], [0.144, -0.051], [0.144, 0.051], [-0.144, 0.051]], modelId: 'sam-3.1' });
  hud.setScanning(false);
  hud.logStep({ stepId: 's1', title: 'SCAN', status: 'ok', evidence: 'camera says 2 devices', kind: 'opinion', model: 'sam-3.1' });
  await sleep(900);
  hud.setCandidate('op1');
  await sleep(900);
  hud.setLocked('op1');
  hud.logStep({ stepId: 's2', title: 'IDENTIFY', status: 'running', model: 'muse-spark-1.3' });
  await sleep(1400);
  hud.logStep({ stepId: 's2', title: 'IDENTIFY', status: 'ok', evidence: 'usb says OP-1 Field ✓', kind: 'proof', model: 'muse-spark-1.3' });
  hud.upsertTarget({ id: 'op1', label: 'OP-1 FIELD', subtitle: 'synthesizer · linking', status: 'linking', channel: 'usb', position: [0.22, 0.75, -0.6], facing: [0, 1, 0], confirmed: true, sizeM: [0.288, 0.03, 0.102], contour: [[-0.144, -0.051], [0.144, -0.051], [0.144, 0.051], [-0.144, 0.051]] });
  hud.setPing([{ id: 'p1', targetId: 'op1', from: [-0.4, 1.0, -0.6], channel: 'usb', proven: true, inFlight: true, label: 'usb-midi · 4 ms' }]);
  hud.logStep({ stepId: 's3', title: 'LINK', status: 'running', evidence: 'CC 1 → 97 · awaiting evidence' });
  hud.showEvidence({ targetId: 'op1', sent: 'CC 1 → 97', expect: 'tone-up', seen: '…', verdict: 'pending' });
  await sleep(1400);
  hud.showEvidence({ targetId: 'op1', sent: 'CC 1 → 97', expect: 'tone-up', seen: 'centroid +412 Hz', verdict: 'ok' });
  hud.logStep({ stepId: 's3', title: 'LINK', status: 'ok', evidence: 'heard ✓ · centroid +412 Hz', kind: 'proof' });
  hud.setPing([{ id: 'p1', targetId: 'op1', from: [-0.4, 1.0, -0.6], channel: 'usb', proven: true, inFlight: false, label: 'usb-midi · verified' }]);
  hud.upsertTarget({ id: 'op1', label: 'OP-1 FIELD', subtitle: 'synthesizer · verified by ear', status: 'verified', channel: 'usb', position: [0.22, 0.75, -0.6], facing: [0, 1, 0], confirmed: true, sizeM: [0.288, 0.03, 0.102], contour: [[-0.144, -0.051], [0.144, -0.051], [0.144, 0.051], [-0.144, 0.051]] });
  await sleep(600);
  hud.showHackMenu('op1', { title: 'HACKS', subtitle: 'MIDI · verified by ear', items: [
    { id: 'h_cutoff', label: 'OPEN CUTOFF', detail: 'CC 1 · heard', kind: 'control', channel: 'midi', status: 'verified', verdict: 'heard' },
    { id: 'h_note', label: 'PLAY NOTE', detail: 'C3 for 800 ms', kind: 'action', channel: 'midi', status: 'verified', verdict: 'heard' },
    { id: 'h_chord', label: 'STRIKE CHORD', detail: 'C major triad', kind: 'action', channel: 'midi', status: 'ready', verdict: 'pending' },
  ] });
  hud.logStep({ stepId: 's4', title: 'HACK', status: 'running', evidence: 'writing 4 controls', model: 'muse-spark-1.3' });
  const knobs = { ...EXAMPLES['op1-knobs']!, state: { armed: false, reason: 'verifying CC 1-4 by ear…' } };
  hud.renderSpec(knobs, { targetId: 'op1' });
  for (let i = 1; i <= 4; i++) {
    hud.setUpload({ hackId: 'h_cutoff', label: 'UPLOAD · 4 CONTROLS', stepsDone: i, modelId: 'muse-spark-1.3', verdict: i === 4 ? 'ok' : 'pending' });
    await sleep(700);
  }
  hud.logStep({ stepId: 's4', title: 'HACK', status: 'ok', evidence: '4 controls · heard ✓', kind: 'proof', model: 'muse-spark-1.3' });
  hud.showConfirm({ id: 'arm1', title: 'Arm 4 verified controls?', summary: 'OP-1 Field · CC 1-4 echoed · heard by the Mac mic', targetId: 'op1' });
  const off = hud.on('confirm', (e) => {
    if (!e.approve) return;
    hud!.showConfirm(null);
    hud!.setArmed(knobs.specId, true, 'heard ✓ · 4 of 4 controls');
    hud!.logStep({ stepId: 's5', title: 'UPLOAD', status: 'ok', evidence: 'armed by pinch', kind: 'proof' });
    hud!.toast('controls armed · the device agreed', 'ok');
    off();
  });
}

// --- XR (emulated when there is no navigator.xr) ------------------------------------------------------------
document.getElementById('xr')!.addEventListener('click', () => void enterXR());
async function enterXR(): Promise<void> {
  if (!navigator.xr) {
    const { XRDevice, metaQuest3 } = await import('iwer');
    const dev = new XRDevice(metaQuest3);
    dev.installRuntime();
    try {
      const { DevUI } = await import('@iwer/devui');
      new DevUI(dev);
    } catch (e) {
      console.warn('devui unavailable', e);
    }
  }
  const session = await navigator.xr!.requestSession('immersive-ar', { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'hit-test'] }).catch((e) => {
    console.warn('immersive-ar failed, trying immersive-vr', e);
    return navigator.xr!.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
  });
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  room.visible = false;
  session.addEventListener('end', () => (room.visible = true));
  // controllers as cursors: select = pinch, ray hit = position
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    const cur = controllerCursors[i]!;
    c.addEventListener('selectstart', () => (cur.pinching = true));
    c.addEventListener('selectend', () => (cur.pinching = false));
    scene.add(c);
  }
}

// --- loop -------------------------------------------------------------------------------------------------------
const timer = new Timer();
let lastPinch = [false, false];
let loopErrors = 0;
const errorsEl = () => document.getElementById('events')!;
window.addEventListener('error', (e) => (errorsEl().textContent = `error: ${e.message} @ ${e.filename.split('/').pop()}:${e.lineno}`));
renderer.setAnimationLoop((ts) => {
  try {
    frame(ts);
  } catch (e) {
    if (!loopErrors++) console.error('[gallery] frame failed', e);
    errorsEl().textContent = `frame error: ${String(e)}`;
  }
});
function frame(ts: number): void {
  timer.update(ts);
  const dt = Math.min(0.05, timer.getDelta());
  const time = timer.getElapsed();
  clock.tick(time);
  const cursors: Cursor[] = [];
  if (!renderer.xr.isPresenting) {
    cursors.push(mouse.update());
    controls.enabled = !mouse.busy;
    controls.update();
  } else {
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      const cur = controllerCursors[i]!;
      cur.tracked = c.visible;
      c.getWorldPosition(cur.position);
      cur.position.addScaledVector(c.getWorldDirection(new Vector3()).negate(), 0.08);
      cur.tip.copy(cur.position);
      cur.justPinched = cur.pinching && !lastPinch[i];
      cur.justReleased = !cur.pinching && lastPinch[i]!;
      lastPinch[i] = cur.pinching;
      cursors.push(cur);
    }
  }
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  current?.update(dt, time, cursors, cam, mouse.takeWheel());
  if (hud) {
    const origin = cam.getWorldPosition(new Vector3());
    const dir = cam.getWorldDirection(new Vector3());
    const f: HudFrame = { time, dt, head: { position: origin, quaternion: cam.getWorldQuaternion(new Quaternion()), ray: { origin, dir } }, hands: {} };
    hud.update(f);
  }
  renderer.render(scene, cam);
}

window.addEventListener('resize', () => {
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
});
renderer.domElement.addEventListener('pointerdown', () => audio.unlock(), { once: true });

show(EXAMPLES[initial]!);
// expose for debugging and screenshots
(window as unknown as { gallery: unknown }).gallery = { show, EXAMPLES, get current() { return current; }, scene, camera, renderer, Color, mouse };
