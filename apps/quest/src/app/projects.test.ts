import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@ce/protocol';
import type { ProjectView } from '../hud/contract';
import { makeGestureFrame, moveHand, setPosture } from '../gestures/fixtures.test-support';
import { headsetCanvasUrl, ProjectControls } from './projects';

const document: ProjectDocument = { projectId: 'p1', revision: 1, prompt: 'Make an orb', source: 'fixture', createdAt: 1,
  spec: { title: 'Orb', description: 'Test', html: '<main>Orb</main>', css: '', js: '', actions: [
    { id: 'amount', label: 'Amount', kind: 'number', min: 0, max: 100, initial: 50 }, { id: 'shuffle', label: 'Shuffle', kind: 'trigger' },
  ] } };
const chordDocument: ProjectDocument = { ...document, source: 'preset', presetId: 'chord-garden-v1', spec: { ...document.spec, title: 'Chord Garden', actions: [
  { id: 'chord_c', label: 'Cmaj7', kind: 'trigger' }, { id: 'chord_am', label: 'Am7', kind: 'trigger' },
  { id: 'chord_f', label: 'Fmaj7', kind: 'trigger' }, { id: 'chord_g', label: 'G7', kind: 'trigger' },
  { id: 'silence', label: 'Stop sound', kind: 'trigger' },
] } };
function setup(initialDocument = document) {
  let immersive = true, connected = true, view: ProjectView | null = null;
  const sent: { type: string; payload: any }[] = [];
  const opened: (string | undefined)[] = [];
  const controls = new ProjectControls({ openPage: id => opened.push(id), send: (type, payload) => { sent.push({ type, payload }); return connected; }, render: (next) => { view = next; }, immersive: () => immersive, connected: () => connected });
  const frame = makeGestureFrame();
  const step = (time: number) => { frame.time = time; controls.update(frame); };
  controls.show(); controls.receiveCatalog({ projects: [{ projectId: 'p1', revision: 1, title: 'Orb' }] });
  controls.receive({ projectId: 'p1', status: 'ready', document: initialDocument, revision: 1, sequence: 0,
    values: Object.fromEntries(initialDocument.spec.actions.map(action => [action.id, action.initial ?? 0])), preview: { count: 1 } });
  const actions = () => sent.filter((entry) => entry.type === 'project.action');
  return { controls, frame, step, actions, sent, opened, view: () => view, immersive: (value: boolean) => { immersive = value; }, connected: (value: boolean) => { connected = value; } };
}

describe('native AR Canvas preview', () => {
  const spatialDocument: ProjectDocument = { ...document, spec: { ...document.spec, spatial: { kind: 'ripples', color: '#40ccff', actionId: 'amount' } } };
  it('runs a validated native recipe without a Mac preview, then requires separate hand Start', () => {
    const f = setup(spatialDocument);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 0 } });
    expect(f.view()?.ready).toBe(false); expect(f.view()?.spatial?.running).toBe(false);
    f.controls.command('start'); f.step(0); expect(f.actions()).toHaveLength(0);
    f.controls.command('run-spatial'); expect(f.view()?.spatial?.running).toBe(true); expect(f.view()?.ready).toBe(true);
    f.step(80); expect(f.actions()).toHaveLength(0); expect(f.controls.running).toBe(false);
    f.controls.command('start'); f.step(160); f.step(240);
    expect(f.actions()).toHaveLength(1); expect(f.actions()[0]!.payload).toMatchObject({ actionId: 'amount', requirePreview: false });
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, sequence: 2, values: { amount: 75, shuffle: 0 }, preview: { count: 0 } });
    expect(f.view()?.spatial?.normalized).toBe(.75);
    f.controls.command('run-spatial'); expect(f.controls.running).toBe(false); expect(f.view()?.spatial?.running).toBe(false); expect(f.view()?.ready).toBe(false);
  });
  it.each(['navigation', 'hidden', 'revision', 'disconnect', 'error'] as const)('stops native control after %s and never resumes from an acknowledgement', reason => {
    const f = setup(spatialDocument); f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 0 } });
    f.controls.command('run-spatial'); f.controls.command('start'); f.step(0); f.step(80);
    if (reason === 'navigation') f.controls.pauseForNavigation();
    if (reason === 'hidden') { f.immersive(false); f.step(160); }
    if (reason === 'revision') f.controls.receive({ projectId: 'p1', status: 'ready', document: { ...spatialDocument, revision: 2 }, preview: { count: 0 } });
    if (reason === 'disconnect') f.controls.disconnect();
    if (reason === 'error') f.controls.receive({ projectId: 'p1', status: 'error', revision: 1, message: 'Unavailable', preview: { count: 0 } });
    expect(f.controls.running).toBe(false); expect(f.view()?.spatial?.running).toBe(false);
    f.immersive(true); f.controls.receive({ projectId: 'p1', status: 'ready', revision: reason === 'revision' ? 2 : 1, preview: { count: 0 } });
    expect(f.controls.running).toBe(false); expect(f.view()?.spatial?.running).toBe(false); expect(f.view()?.ready).toBe(false);
  });
  it('does not grant native rendering to the audio preset or an unbound scene', () => {
    const f = setup({ ...chordDocument, spec: { ...chordDocument.spec, spatial: { kind: 'orb', color: '#ffffff', actionId: 'amount' } } });
    f.controls.command('run-spatial'); expect(f.view()?.spatial).toBeUndefined(); expect(f.controls.running).toBe(false);
  });
});

describe('Muse Canvas Quest software controls', () => {
  it('requires a single started preview and never resumes automatically after preview loss or duplicates', () => {
    const f = setup();
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 0 } });
    f.controls.command('start'); f.step(0); f.step(80);
    expect(f.controls.running).toBe(false); expect(f.actions()).toHaveLength(0); expect(f.view()?.status).toContain('No preview');
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 1 } });
    expect(f.controls.running).toBe(false); f.controls.command('start'); f.step(100); f.step(180);
    expect(f.actions()).toHaveLength(1); expect(f.actions()[0].payload.requirePreview).toBe(true);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 2 } });
    expect(f.controls.running).toBe(false); expect(f.view()?.status).toContain('More than one');
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 1 } });
    moveHand(f.frame.hands.right!, .2, 1.6, -.4); f.step(260); f.step(340);
    expect(f.actions()).toHaveLength(1); expect(f.view()?.ready).toBe(true);
    f.controls.command('start'); f.step(400); f.step(480); expect(f.actions()).toHaveLength(2);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 0 } });
    expect(f.controls.running).toBe(false);
  });
  it('opens the selected full webpage only on an explicit command and stops AR inputs first', () => {
    const f = setup(); f.controls.command('start'); f.step(0); f.step(80);
    expect(f.opened).toEqual([]);
    f.controls.command('open-page');
    expect(f.opened).toEqual(['p1']); expect(f.controls.running).toBe(false);
    moveHand(f.frame.hands.right!, .2, 1.6, -.4); f.step(160); expect(f.actions()).toHaveLength(1);
    expect(headsetCanvasUrl('page /&token=bad')).toBe('/companion/canvas/?headset=1&project=page+%2F%26token%3Dbad');
  });
  it('guides an empty catalog to headset creation and restores the requested project on return', () => {
    const f = setup(); f.controls.receiveCatalog({ projects: [] });
    expect(f.view()?.status).toContain('Create webpage');
    f.controls.command('open-page'); expect(f.opened).toEqual([undefined]);
    f.controls.show('p2'); expect(f.sent.at(-1)).toEqual({ type: 'project.get', payload: { projectId: 'p2' } });
  });
  it('requires an explicit Start and an immersive session; fist height sends only project actions', () => {
    const f = setup(); f.step(0); f.step(80); expect(f.actions()).toHaveLength(0);
    f.immersive(false); f.controls.command('start'); expect(f.controls.running).toBe(false);
    f.immersive(true); f.controls.command('start'); f.step(100); f.step(180);
    expect(f.actions()).toHaveLength(1); expect(f.actions()[0]!.payload).toMatchObject({ projectId: 'p1', revision: 1, actionId: 'amount' });
    expect(f.actions()[0]!.payload.value).toBeCloseTo(50);
    expect(f.view()?.engaged).toBe(true);
  });
  it('limits frequency to 15 Hz and suppresses unchanged values', () => {
    const f = setup(); f.controls.command('start'); f.step(0); f.step(80); f.step(160);
    expect(f.actions()).toHaveLength(1);
    moveHand(f.frame.hands.right!, 0.2, 1.5, -0.4); f.step(170); expect(f.actions()).toHaveLength(2);
    moveHand(f.frame.hands.right!, 0.2, 1.6, -0.4); f.step(180); expect(f.actions()).toHaveLength(2);
    f.step(240); expect(f.actions()).toHaveLength(3);
  });
  it('releases the clutch immediately and requires Start again after tracking loss', () => {
    const f = setup(); f.controls.command('start'); f.step(0); f.step(80);
    setPosture(f.frame.hands.left!, 'point'); moveHand(f.frame.hands.right!, 0.2, 1.5, -0.4); f.step(160);
    expect(f.actions()).toHaveLength(1); expect(f.view()?.engaged).toBe(false);
    delete f.frame.hands.right; f.step(180); expect(f.controls.running).toBe(false);
    f.frame.hands.right = makeGestureFrame().hands.right; setPosture(f.frame.hands.left!, 'fist'); f.step(250); f.step(330);
    expect(f.actions()).toHaveLength(1);
  });
  it('both palms Stop, navigation, disconnect and leaving XR prevent further sends', () => {
    for (const mode of ['palms', 'menu', 'disconnect', 'xr'] as const) {
      const f = setup(); f.controls.command('start'); f.step(0); f.step(80);
      if (mode === 'palms') { setPosture(f.frame.hands.left!, 'open_palm'); f.step(100); f.step(180); }
      if (mode === 'menu') f.controls.pauseForNavigation();
      if (mode === 'disconnect') { f.connected(false); f.controls.disconnect(); }
      if (mode === 'xr') { f.immersive(false); f.step(160); }
      expect(f.controls.running).toBe(false);
      moveHand(f.frame.hands.right!, 0.2, 1.6, -0.4); f.step(240); expect(f.actions()).toHaveLength(1);
    }
  });
  it('retains the document for compact value packets and rejects stale sequence/revision', () => {
    const f = setup(); f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, sequence: 2, values: { amount: 70 } });
    expect(f.view()?.title).toBe('Orb'); expect(f.view()?.action?.value).toBe(70);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, sequence: 1, values: { amount: 10 } });
    expect(f.view()?.action?.value).toBe(70);
    f.controls.command('start');
    f.controls.receive({ projectId: 'p1', status: 'ready', document: { ...document, revision: 2, spec: { ...document.spec, title: 'New orb' } }, sequence: 0 });
    expect(f.controls.running).toBe(false);
    f.controls.receive({ projectId: 'p1', status: 'ready', document, sequence: 100 }); expect(f.view()?.title).toBe('New orb');
  });
  it('an immediate visibility/navigation pause survives an interval with no XR frames', () => {
    const f = setup(); f.controls.command('start'); f.step(0); f.step(80);
    f.controls.pauseForNavigation(); // visibilitychange can fire when no more XR frames will arrive
    expect(f.controls.running).toBe(false);
    moveHand(f.frame.hands.right!, 0.2, 1.6, -0.4); f.step(5000); f.step(5080);
    expect(f.actions()).toHaveLength(1);
    f.controls.command('start'); f.step(5100); f.step(5180); expect(f.actions()).toHaveLength(2);
  });
  it('explicitly switches project/control and keeps software trigger actions separate', () => {
    const f = setup(); f.controls.command('start'); f.controls.command('next-action'); expect(f.controls.running).toBe(false);
    f.controls.command('start'); expect(f.controls.running).toBe(false);
    f.controls.command('trigger'); expect(f.actions()[0]!.payload).toMatchObject({ actionId: 'shuffle', revision: 1 });
    expect(f.actions()[0]!.payload.value).toBeUndefined();
    f.controls.receiveCatalog({ projects: [{ projectId: 'p1', revision: 1, title: 'Orb' }, { projectId: 'p2', revision: 1, title: 'Other' }] });
    f.controls.command('next-project'); expect(f.sent.at(-1)).toEqual({ type: 'project.get', payload: { projectId: 'p2' } });
    f.controls.receive({ projectId: 'p1', status: 'ready', document }); expect(f.view()?.ready).toBe(false);
    f.controls.close(); f.controls.receive({ projectId: 'p2', status: 'ready', document: { ...document, projectId: 'p2' } }); expect(f.view()).toBeNull();
  });
});

describe('Chord Garden Quest pad controls', () => {
  it('requires explicit enable, a ready audio preview and AR before sending a named pad', () => {
    const f = setup(chordDocument);
    expect(f.view()?.chordPads?.map(pad => pad.label)).toEqual(['Cmaj7', 'Am7', 'Fmaj7', 'G7']);
    f.controls.command('pad', 'chord_c'); f.controls.command('trigger'); expect(f.actions()).toHaveLength(0);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 0 } });
    f.controls.command('start'); expect(f.controls.running).toBe(false); expect(f.view()?.status).toContain('Enable sound');
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 1 } });
    f.immersive(false); f.controls.command('start'); expect(f.controls.running).toBe(false);
    f.immersive(true); f.controls.command('start'); expect(f.controls.running).toBe(true);
    f.controls.command('pad', 'chord_am');
    expect(f.actions()).toHaveLength(1);
    expect(f.actions()[0]?.payload).toMatchObject({ projectId: 'p1', revision: 1, actionId: 'chord_am', requirePreview: true });
    expect(f.actions()[0]?.payload.value).toBeUndefined(); expect(f.view()?.lastChord).toBe('chord_am');
    expect(f.view()?.status).toContain('Am7 triggered');
    f.controls.command('pad', 'silence'); f.controls.command('pad', 'unknown'); f.controls.command('trigger');
    expect(f.actions()).toHaveLength(1);
  });

  it('permits one pointing hand without a fist and disarms on lost tracking without resuming', () => {
    const f = setup(chordDocument); f.controls.command('start');
    delete f.frame.hands.left; f.step(0); f.step(80);
    expect(f.controls.running).toBe(true); expect(f.actions()).toHaveLength(0);
    f.controls.command('pad', 'chord_f'); delete f.frame.hands.right; f.step(160);
    expect(f.controls.running).toBe(false); expect(f.actions().map(a => a.payload.actionId)).toEqual(['chord_f', 'silence']);
    f.frame.hands.right = makeGestureFrame().hands.right; f.step(240); f.controls.command('pad', 'chord_g');
    expect(f.actions()).toHaveLength(2);
    f.controls.command('start'); f.controls.command('pad', 'chord_g'); expect(f.actions()).toHaveLength(3);
  });

  it('silences once and disarms for stop, navigation, close and leaving XR', () => {
    for (const mode of ['stop', 'menu', 'close', 'xr'] as const) {
      const f = setup(chordDocument); f.controls.command('start'); f.controls.command('pad', 'chord_c');
      if (mode === 'stop') f.controls.command('stop');
      if (mode === 'menu') f.controls.pauseForNavigation();
      if (mode === 'close') f.controls.close();
      if (mode === 'xr') { f.immersive(false); f.step(80); }
      expect(f.controls.running).toBe(false);
      f.controls.command('pad', 'chord_g'); f.controls.stop();
      expect(f.actions().map(a => a.payload.actionId)).toEqual(['chord_c', 'silence']);
    }
  });

  it('never auto-enables after preview loss, disconnection or a new revision', () => {
    const f = setup(chordDocument); f.controls.command('start');
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 0 } });
    expect(f.controls.running).toBe(false);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 1 } });
    f.controls.command('pad', 'chord_c'); expect(f.actions()).toHaveLength(0);
    f.controls.command('start'); f.connected(false); f.controls.disconnect(); f.connected(true);
    f.controls.receive({ projectId: 'p1', status: 'ready', revision: 1, preview: { count: 1 } });
    expect(f.controls.running).toBe(false);
    f.controls.command('start');
    f.controls.receive({ projectId: 'p1', status: 'ready', document: { ...chordDocument, revision: 2 }, sequence: 0, preview: { count: 1 } });
    expect(f.controls.running).toBe(false);
    f.controls.command('pad', 'chord_c'); expect(f.actions().filter(a => a.payload.actionId === 'chord_c')).toHaveLength(0);
  });

  it('does not give an ordinary or edited project the trusted preset pad interface', () => {
    const f = setup({ ...chordDocument, source: 'fixture', presetId: undefined });
    expect(f.view()?.chordPads).toBeUndefined();
    f.controls.command('start'); f.controls.command('pad', 'chord_c'); expect(f.actions()).toHaveLength(0);
    const normal = setup(); normal.controls.command('pad', 'shuffle'); expect(normal.actions()).toHaveLength(0);
  });
});
