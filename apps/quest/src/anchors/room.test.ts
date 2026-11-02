import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryDevice, RoomPlacement } from '@ce/protocol';
import { Vector3 } from 'three';
import { RoomAnchors, type AnchorFrame, type AnchorSession } from './room';
import { matchSavedDevice } from './matching';

const placement = (handle?: string, updatedAt = 1): RoomPlacement => ({ headsetId: 'quest', origin: 'https://room.test', handle,
  panelOffset: { x: 0, y: 0, z: 0 }, fallback: { label: 'Ceiling light' }, updatedAt });
const device = (cardId = 'light', saved = placement()): LibraryDevice => ({ cardId, displayName: cardId,
  identity: { label: 'Ceiling light' }, placement: saved, hidden: false, createdAt: 1, updatedAt: 1, enabled: true, versions: [], connection: 'ready' });
const refSpace = {} as XRReferenceSpace;
const anchor = (handle = 'new-handle') => ({ anchorSpace: {} as XRSpace, delete: vi.fn(), requestPersistentHandle: vi.fn(async () => handle) });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function session(handles: string[] = []): AnchorSession {
  return { enabledFeatures: ['anchors'], persistentAnchors: handles,
    restorePersistentAnchor: vi.fn(async () => anchor()),
    deletePersistentAnchor: vi.fn(async (handle: string) => { const index = handles.indexOf(handle); if (index >= 0) handles.splice(index, 1); }) };
}
function fixture(devices: LibraryDevice[] = [device()]) {
  const save = vi.fn(), locate = vi.fn();
  const room = new RoomAnchors({ save, locate }); room.setDevices(devices);
  return { room, save, locate };
}
const frame = (current: AnchorSession, overrides: Partial<AnchorFrame> = {}): AnchorFrame => ({ session: current, getPose: () => null, ...overrides });
afterEach(() => vi.unstubAllGlobals());

describe('persistent device placement', () => {
  it('does not try missing, foreign-origin, or another headset handles', async () => {
    const { room, locate } = fixture([device('missing', placement('gone')), device('foreign', { ...placement('foreign'), origin: 'https://elsewhere.test' }),
      device('other-headset', { ...placement('other'), headsetId: 'other-quest' })]);
    const current = session(['foreign', 'other']); room.begin(current, 'quest', 'https://room.test'); await tick();
    expect(current.restorePersistentAnchor).not.toHaveBeenCalled(); expect(locate).not.toHaveBeenCalled();
    expect([...room.states.values()]).toEqual(['unlocated', 'unlocated', 'unlocated']);
  });

  it('restores without creating anchors or issuing commands, and null pose means Locating', async () => {
    const { room, locate, save } = fixture([device('light', { ...placement('kept'), panelOffset: { x: 0, y: 0.2, z: 0 } })]);
    const current = session(['kept']); room.begin(current, 'quest', 'https://room.test'); await tick();
    expect(current.restorePersistentAnchor).toHaveBeenCalledWith('kept');
    room.update(frame(current), refSpace); expect(room.states.get('light')).toBe('locating'); expect(locate).toHaveBeenLastCalledWith('light', null);
    const pose = { transform: { position: { x: 2, y: 1, z: -3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } } as XRPose;
    room.update(frame(current, { getPose: () => pose }), refSpace);
    expect(locate).toHaveBeenLastCalledWith('light', new Vector3(2, 1.2, -3)); expect(room.states.get('light')).toBe('located'); expect(save).not.toHaveBeenCalled();
    room.update(frame(current), refSpace); expect(room.states.get('light')).toBe('locating');
  });

  it('saves fallback identity and relative offset on unsupported runtimes, never XYZ', () => {
    const { room, save, locate } = fixture(); const current = {};
    room.begin(current, 'quest', 'https://room.test'); room.place('light', new Vector3(10, 3, -5)); room.update(frame(current), refSpace);
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0][1]).toMatchObject({ fallback: { label: 'Ceiling light' }, panelOffset: { x: 0, y: 0, z: 0 } });
    expect(save.mock.calls[0][1]).not.toHaveProperty('position'); expect(locate).toHaveBeenLastCalledWith('light', new Vector3(10, 3, -5));
    room.end(); room.begin({}, 'quest', 'https://room.test'); expect(room.states.get('light')).toBe('unlocated');
  });

  it('invokes createAnchor in the active frame and persists its handle later', async () => {
    vi.stubGlobal('XRRigidTransform', class { constructor(public position: unknown, public orientation: unknown) {} });
    const { room, save } = fixture(); const current = session(); room.begin(current, 'quest', 'https://room.test');
    const created = anchor(); let active = false;
    const createAnchor = vi.fn(async () => { expect(active).toBe(true); return created; });
    room.place('light', new Vector3(1, 2, -1)); expect(createAnchor).not.toHaveBeenCalled();
    active = true; room.update(frame(current, { createAnchor }), refSpace); active = false; await tick();
    expect(createAnchor).toHaveBeenCalledOnce(); expect(created.requestPersistentHandle).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith('light', expect.objectContaining({ handle: 'new-handle' }));
  });

  it('evicts the oldest of eight anchors before creating the newest device anchor', async () => {
    vi.stubGlobal('XRRigidTransform', class {});
    const devices = Array.from({ length: 8 }, (_, index) => device(`light-${index}`, placement(`h${index}`, index + 1)));
    devices.push(device('new')); const { room, save } = fixture(devices); const current = session(devices.slice(0, 8).map((d) => d.placement!.handle!));
    room.begin(current, 'quest', 'https://room.test'); await tick(); room.place('new', new Vector3(0, 1, -1));
    const createAnchor = vi.fn(async () => anchor()); room.update(frame(current, { createAnchor }), refSpace);
    expect(createAnchor).not.toHaveBeenCalled(); await tick(); expect(current.deletePersistentAnchor).toHaveBeenCalledWith('h0');
    expect(save).toHaveBeenCalledWith('light-0', expect.not.objectContaining({ handle: expect.anything() }));
    room.update(frame(current, { createAnchor }), refSpace); await tick(); expect(createAnchor).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer placement when an eviction finishes late', async () => {
    const devices = Array.from({ length: 8 }, (_, index) => device(`light-${index}`, placement(`h${index}`, index + 1)));
    devices.push(device('new'));
    const { room } = fixture(devices), current = session(devices.slice(0, 8).map((d) => d.placement!.handle!));
    let finish!: () => void;
    current.deletePersistentAnchor = () => new Promise<void>((resolve) => { finish = resolve; });
    room.begin(current, 'quest', 'https://room.test'); await tick();
    room.place('new', new Vector3(0, 1, -1));
    room.update(frame(current, { createAnchor: vi.fn(async () => anchor()) }), refSpace);
    room.setDevices([...room.devices.values()].map((saved) => saved.cardId === 'light-0'
      ? { ...saved, placement: placement('newer-place', Date.now() + 1) } : saved));
    finish(); await tick();
    expect(room.devices.get('light-0')?.placement?.handle).toBe('newer-place');
  });

  it('replaces a moved device anchor and explicitly deletes a forgotten persistent handle', async () => {
    const { room } = fixture([device('light', placement('old-place'))]); const current = session(['old-place']);
    room.begin(current, 'quest', 'https://room.test'); await tick(); room.place('light', new Vector3(4, 1, -1)); await tick();
    expect(current.deletePersistentAnchor).toHaveBeenCalledWith('old-place'); expect(room.devices.get('light')?.placement?.handle).toBeUndefined();
    const other = device('second', placement('second-place')); room.setDevices([room.devices.get('light')!, other]);
    await room.forget('second'); expect(current.deletePersistentAnchor).toHaveBeenCalledWith('second-place'); expect(room.devices.has('second')).toBe(false);
  });

  it('discards an old session restoration that completes after a new session begins', async () => {
    const { room } = fixture([device('light', placement('old'))]); const restored = anchor();
    let resolve!: (value: ReturnType<typeof anchor>) => void;
    const current = session(['old']); current.restorePersistentAnchor = () => new Promise((done) => { resolve = done; });
    room.begin(current, 'quest', 'https://room.test'); room.begin({}, 'quest', 'https://room.test'); resolve(restored); await tick();
    expect(restored.delete).toHaveBeenCalledOnce(); expect(room.states.get('light')).toBe('unlocated');
  });

  it('reports a rejected restoration as unlocated after showing its locating marker', async () => {
    const { room, locate } = fixture([device('light', placement('lost'))]); const current = session(['lost']);
    let reject!: (error: Error) => void;
    current.restorePersistentAnchor = () => new Promise((_resolve, fail) => { reject = fail; });
    room.begin(current, 'quest', 'https://room.test'); room.update(frame(current), refSpace);
    expect(room.states.get('light')).toBe('locating'); expect(locate).toHaveBeenLastCalledWith('light', null);
    reject(new Error('anchor lost')); await tick();
    expect(room.states.get('light')).toBe('unlocated'); expect(locate).toHaveBeenLastCalledWith('light', null);
  });

  it('does not let a late persistent handle overwrite a newer placement', async () => {
    vi.stubGlobal('XRRigidTransform', class {});
    const { room, save } = fixture(); const current = session(); room.begin(current, 'quest', 'https://room.test');
    let resolve!: (handle: string) => void;
    const first = anchor(); first.requestPersistentHandle = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    room.place('light', new Vector3(1, 1, -1)); room.update(frame(current, { createAnchor: async () => first }), refSpace); await tick();
    room.place('light', new Vector3(3, 1, -1)); resolve('stale-handle'); await tick();
    expect(current.deletePersistentAnchor).toHaveBeenCalledWith('stale-handle');
    expect(save.mock.calls.some((call) => call[1].handle === 'stale-handle')).toBe(false);
    expect(room.devices.get('light')?.placement?.handle).toBeUndefined();
  });

  it('ignores a late restore failure after the device was freshly reattached', async () => {
    const { room, locate } = fixture([device('light', placement('lost'))]); const current = session(['lost']);
    let reject!: (error: Error) => void;
    current.restorePersistentAnchor = () => new Promise((_resolve, fail) => { reject = fail; });
    room.begin(current, 'quest', 'https://room.test'); room.place('light', new Vector3(4, 2, -1));
    reject(new Error('old handle unavailable')); await tick();
    expect(room.states.get('light')).toBe('located'); expect(locate).toHaveBeenLastCalledWith('light', new Vector3(4, 2, -1));
  });
});

describe('saved device identity matching', () => {
  it('requires an explicit saved-device choice for indistinguishable twins', () => {
    expect(matchSavedDevice([device('one'), device('two')], { label: 'Ceiling light' }).kind).toBe('ambiguous');
  });
  it('prefers executor and MIDI port identity over duplicate appearance', () => {
    const first = { ...device('one'), identity: { label: 'Synth', executorDeviceId: 'mac', portId: 'port-1' } };
    const second = { ...device('two'), identity: { label: 'Synth', executorDeviceId: 'mac', portId: 'port-2' } };
    expect(matchSavedDevice([first, second], { label: 'Synth', executorDeviceId: 'mac', portId: 'port-2' })).toEqual({ kind: 'match', device: second });
    expect(matchSavedDevice([first, second], { label: 'Synth', executorDeviceId: 'mac' }).kind).toBe('ambiguous');
  });
  it('uses the IR fingerprint and appearance descriptor without any saved position', () => {
    const first = { ...device('one'), identity: { label: 'Ceiling light', irFingerprint: 'codes-one', appearance: 'white circular lamp' } };
    const second = { ...device('two'), identity: { label: 'Ceiling light', irFingerprint: 'codes-two', appearance: 'black square lamp' } };
    expect(matchSavedDevice([first, second], { label: 'Lamp', irFingerprint: 'codes-two' })).toEqual({ kind: 'match', device: second });
    expect(matchSavedDevice([first, second], { label: 'Ceiling light', appearance: 'white circular lamp' })).toEqual({ kind: 'match', device: first });
    expect(matchSavedDevice([first], { label: 'person', cardId: 'one' })).toEqual({ kind: 'none' });
  });
});
