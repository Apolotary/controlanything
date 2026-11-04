/** Model-only probe. No hub, executor, audio engine, browser or physical device is created.
 * Run deliberately: node --import tsx apps/server/scripts/musical-wire-probe.ts --live
 * Loads configured Meta key without printing it; emits generated source + synthetic dry-run evidence.
 * At most one live API call. A labelled fallback is reported as a failed live probe, never live success.
 */
import type { Driver, WireProgressPayload } from '@ce/protocol';
import { loadConfig, loadDotEnv } from '../src/config';
import { createMuseChat, ModelCallError, type MuseChat } from '../src/muse/adapter';
import { musicalSynthDraft } from '../src/devices/musicalSynth';
import { writeWiring } from '../src/agent/wire';

if (!process.argv.includes('--live')) throw new Error('Pass --live to run this one-call Meta model probe. No device or audio commands run.');
loadDotEnv();
const config = loadConfig().muse;
if (config.mode !== 'live' || !config.apiKey || !/^muse-/.test(config.model)) throw new Error('A configured live Meta Muse model and key are required.');
config.recordDir = undefined; config.replayDir = undefined;
let httpRequests = 0;
const oneRequest: typeof fetch = async (...args) => {
  if (httpRequests >= 1) throw new ModelCallError('This probe permits only one real HTTP request; compatibility retries are disabled.');
  httpRequests++;
  return fetch(...args);
};
const client = createMuseChat(config, { fetchImpl: oneRequest });
let calls = 0;
const spark = new Proxy(client, { get(target, property) {
  if (property === 'chatJson') return (...args: Parameters<MuseChat['chatJson']>) => {
    if (++calls > 1) throw new ModelCallError('This model-only probe permits only one live API call.');
    return target.chatJson(...args);
  };
  const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
} });
const driver: Driver = { ...musicalSynthDraft('musical-synth-mac', []), driverId: 'model-only-musical', executor: { deviceId: 'model-only-no-device', port: 'ce-musical-synth' }, maxRateHz: 200 };
const phases: { phase: WireProgressPayload['phase']; note?: string }[] = [];
const result = await writeWiring({ spark, chunkDelayMs: 0 }, {
  cardId: driver.cardId, deviceName: 'ControlAnything Synth', driver,
  request: 'Make a theremin: my right hand height picks the scale note, pinching my right hand plays it, releasing or losing that hand stops it. My left hand push changes filter cutoff.',
}, (phase, extra) => phases.push({ phase, note: extra?.note }), { budgetMs: 45_000, wiringTag: 'model-only-musical-probe' });
const live = result.ok && result.source === 'live';
console.log(JSON.stringify({ modelOnly: true, noDeviceCommands: true, apiCalls: httpRequests, livePassed: live, ...result, phases }, null, 2));
if (!live) process.exitCode = 1;
