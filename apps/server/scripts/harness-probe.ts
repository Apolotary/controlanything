/** Explicitly opt-in live Muse tool-loop check. No server, hardware, sound or browser is opened. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encode } from 'jpeg-js';
import type { Driver } from '@ce/protocol';
import { loadDotEnv } from '../src/config';
import { resolveMuseConfig } from '../src/muse/config';
import { CallLog } from '../src/muse/callLog';
import { StreamClient } from '../src/gen3d/stream';
import { MuseBridgeHarness } from '../src/agent/muse-harness';
import { dryRun, type SignalFrame } from '../src/agent/wire-check';

if (!process.argv.includes('--live')) throw Error('This makes live Meta API calls. Add --live to run it deliberately.');
loadDotEnv();
const cfg = resolveMuseConfig(process.env);
assert.equal(cfg.mode, 'live', 'The live probe requires a Meta API key; fixture success is not substituted.');
assert.equal(new URL(cfg.baseUrl).hostname, 'api.meta.ai', 'This probe targets Meta directly.');
const output = resolve(process.env.CE_HARNESS_PROBE_OUT ?? '.data/harness-probe');
mkdirSync(output, { recursive: true });
const calls = new CallLog(() => {}), stream = new StreamClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
const harness = new MuseBridgeHarness({ model: 'muse-spark-1.3', mode: 'live',
  stream: { model: 'muse-spark-1.3', stream: stream.stream.bind(stream) }, callLog: calls });
const driver: Driver = { driverId: 'synthetic-probe-driver', cardId: 'synthetic-visual', transport: 'midi',
  executor: { deviceId: 'no-device-connected', port: 'ce-visual-synth' }, provenance: [],
  actions: [{ actionId: 'cc21', label: 'Water ripples', kind: 'set', range: { min: 0, max: 127, step: 1 },
    encode: { kind: 'midi', msg: 'cc', channel: 1, number: 21, value: '$value' }, expect: { sense: 'camera', effect: 'any' } }],
};
// An explicitly synthetic decoder input, not a photo or evidence of seeing a real instrument.
const pixels = Buffer.alloc(64 * 64 * 4);
for (let i = 0; i < 64 * 64; i++) { pixels[i * 4] = 24; pixels[i * 4 + 1] = i % 64 < 32 ? 160 : 80; pixels[i * 4 + 2] = 210; pixels[i * 4 + 3] = 255; }
const jpeg = encode({ width: 64, height: 64, data: pixels }, 80).data.toString('base64');
const progress: { phase: string; note?: string; codeDeltaBytes?: number }[] = [];
const request = 'Use my right hand forward/back position to control Water ripples. Map right.push linearly from 0..1 to cc21 0..127. Ignore hand height. No screen, no calibration, no clutch. Send cc21 zero once on hand loss. The attached image is a synthetic colour chart, not a real device.';
const result = await harness.write({ cardId: driver.cardId, deviceName: 'Synthetic probe visual instrument', request, driver,
  observation: { jpeg, capturedAt: Date.now() - 1000, width: 64, height: 64, label: 'Synthetic colour chart' },
}, (phase, data = {}) => progress.push({ phase, note: data.note, ...(data.codeDelta ? { codeDeltaBytes: data.codeDelta.length } : {}) }),
{ wiringTag: 'live-muse-harness-probe' });
const receipt = harness.get('live-muse-harness-probe');
writeFileSync(resolve(output, 'receipt.json'), JSON.stringify({ receipt, calls: calls.list(), progress, physicalDeviceCommands: 0,
  imageInput: 'Synthetic 64x64 colour chart; not an object-recognition test', result: { ok: result.ok, issues: result.issues } }, null, 2));
assert(result.ok, result.issues.join('; '));
assert.equal(result.source, 'live'); assert.equal(result.model, 'muse-spark-1.3');
assert.deepEqual(result.needs, ['right']); assert.deepEqual(result.used, ['cc21']);
const base = { height: .5, push: .5, side: .5, pinch: 0, pinchTap: false, fist: false, open: true, palmOut: false, speed: 0 };
const frames = (change: (k: number) => Partial<typeof base>): SignalFrame[] => Array.from({ length: 120 }, (_, i) =>
  ({ t: i / 60, dt: 1 / 60, right: { ...base, ...change(i / 119) }, left: null, screen: null }));
const push = dryRun(result.code, driver, result.needs, [{ name: 'push-only', needs: ['right'], frames: frames(k => ({ push: k })) }]);
const height = dryRun(result.code, driver, result.needs, [{ name: 'height-only', needs: ['right'], frames: frames(k => ({ height: k })) }]);
assert(push.ok && height.ok);
assert(push.spread.cc21.max - push.spread.cc21.min > 100, 'Push must actually change ripple output.');
assert(height.spread.cc21.max - height.spread.cc21.min < 1, 'Height alone must not change ripple output.');
assert(progress.some(p => p.codeDeltaBytes), 'Actual tool argument code should have streamed.');
writeFileSync(resolve(output, 'program.js'), result.code);
writeFileSync(resolve(output, 'semantics.json'), JSON.stringify({ push, height, pass: true, syntheticOnly: true }, null, 2));
console.log(JSON.stringify({ pass: true, model: result.model, turns: receipt?.turns, tools: receipt?.tools.map(t => t.name),
  pushChangesRipples: true, heightDoesNot: true, physicalDeviceCommands: 0, output }));
