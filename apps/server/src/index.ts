/** Entry point: `npm run dev` (watch) or `npm start`. */
import { createApp } from './app';
import { loadConfig, loadDotEnv, SERVER_VERSION } from './config';
import { startConsoleApprovals } from './console';
import { createContext, startServers } from './context';
import { getAgent } from './agent';
import { resolveRemoConfig, startRemoBridge } from './devices/remo';
import { resolveOsmoConfig, startOsmoBridge } from './devices/osmo/bridge';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.error(`ControlAnything needs Node 22.12 or newer (you have v${process.versions.node}). https://nodejs.org`);
  process.exit(1);
}

const envFiles = loadDotEnv();
const config = loadConfig(process.env);
const ctx = createContext(config);
const app = createApp(ctx);

let servers: Awaited<ReturnType<typeof startServers>>;
try {
  servers = await startServers(ctx, app);
} catch (e) {
  console.error(`[server] could not start: ${(e as Error).message}`);
  process.exit(1);
}

const u = ctx.urls();
const m = config.muse;
const lines = [
  '',
  `ControlAnything server ${SERVER_VERSION}`,
  `  mode      ${m.mode === 'live' ? `LIVE (Meta Model API, key from ${envFiles.length ? 'env/.env' : 'env'})` : 'FIXTURE (no MODEL_API_KEY; replies are canned and labelled FIXTURE)'}`,
  `  models    chat=${m.model} transcribe=${m.transcribeModel}${m.reasoningEffort ? ` effort=${m.reasoningEffort}` : ''}`,
  `  space     ${ctx.registry.spaceId} · ${ctx.registry.size} paired device(s)`,
];
if (u.local) lines.push(`  local     ${u.local}/companion/   (this Mac is the owner here)`);
if (u.https) {
  lines.push(`  LAN https ${u.https}/companion/   ${u.https}/quest/`);
  for (const ip of u.lan.slice(1)) lines.push(`            https://${ip}:${ctx.bound.https}/`);
  lines.push('            self-signed cert: open the https URL once on each device and accept the warning');
}
if (u.http) lines.push(`  LAN http  ${u.http}  (no TLS: for ESP32/CLI clients with a device token; trusted LAN only)`);
lines.push(`  websocket ${u.https ? u.https.replace('https', 'wss') : ''}/ws · ws://localhost:${ctx.bound.http ?? config.http.port}/ws`);
lines.push(`  Quest/USB adb reverse tcp:${ctx.bound.http ?? config.http.port} tcp:${ctx.bound.http ?? config.http.port}  then open ${u.local ?? ''}/quest/`);
if (m.recordDir) lines.push(`  recording keyed live responses to ${m.recordDir} (MUSE_RECORD=1)`);
const replayed = 'recordedKeys' in ctx.muse ? (ctx.muse as { recordedKeys(): string[] }).recordedKeys() : [];
if (replayed.length) lines.push(`  replaying ${replayed.length} recorded real response(s) as FIXTURE: ${replayed.join(', ')}`);
if (config.trustFirstDevice) lines.push('  CE_TRUST_FIRST_DEVICE=1: the first device to pair is approved automatically');
if (servers.certRegenerated) lines.push(`  generated a new dev certificate for ${servers.certAltNames?.join(', ')}`);
const agent = getAgent(ctx);
lines.push(`  agent     scan prompts: ${agent.scan.prompts.join(' · ')} · profiles: ${agent.profiles.files.length} · sam=${agent.sam.mode} · mac-local=${agent.roster.macLocal ? 'on' : 'off'}`);
// a Nature Remo on the LAN as IR learner + blaster (REMO_HOST=<ip> or CE_REMO=1); it never sends until REMO_SEND=1
const remoConfig = resolveRemoConfig(process.env);
const remo = ctx.bound.http
  ? await startRemoBridge({
      config: remoConfig, serverBase: `http://127.0.0.1:${ctx.bound.http}`, dataDir: config.dataDir, log: ctx.log,
      register: (name) => ctx.registry.add({ name, kind: 'remo', capabilities: ['ir'], canApprove: false }),
    }).catch((e) => {
      console.error(`[remo] bridge not started: ${(e as Error).message}`);
      return undefined;
    })
  : undefined;
if (remo) lines.push(`  remo      ${remo.name} at ${remo.remoBase} as ${remo.deviceId} · IR learn: GET only · IR send: ${remo.allowSend ? 'ON (REMO_SEND=1)' : 'OFF until the user approves (REMO_SEND=1)'}`);
else if (remoConfig.host || remoConfig.discover) lines.push('  remo      not bridged (see the [remo] line above)');
else lines.push('  remo      off (REMO_HOST=<ip> or CE_REMO=1 bridges a Nature Remo as IR learner + blaster)');
// a DJI Osmo Mobile gimbal over Bluetooth LE (CE_OSMO=mock|ble|web); opening the link never moves it
const osmoConfig = resolveOsmoConfig(process.env);
const osmo = ctx.bound.http && osmoConfig.link
  ? await startOsmoBridge({
      config: osmoConfig, serverBase: `http://127.0.0.1:${ctx.bound.http}`, dataDir: config.dataDir, log: ctx.log,
      register: (name) => ctx.registry.add({ name, kind: 'gimbal', capabilities: ['ble'], canApprove: false }),
    }).catch((e) => {
      console.error(`[osmo] bridge not started: ${(e as Error).message}`);
      return undefined;
    })
  : undefined;
if (osmo) lines.push(`  osmo      ${osmo.name} as ${osmo.deviceId} · link ${osmoConfig.link}${osmoConfig.link === 'web' ? ' (open http://localhost:8799 in Chrome)' : osmoConfig.link === 'mock' ? ' (twin, no Bluetooth)' : ''} · moves only on a command`);
else lines.push(`  osmo      ${osmoConfig.link ? 'not bridged (see the [osmo] line above)' : 'off (CE_OSMO=mock|ble|web bridges a DJI Osmo Mobile gimbal)'}`);
for (const w of m.warnings) lines.push(`  warning   ${w}`);
if (config.consoleApprove) lines.push('  pairing   new requests print here with their code; type "y" to approve, "n" to deny');
console.log(lines.join('\n'));

const stopConsole = config.consoleApprove ? startConsoleApprovals(ctx) : () => {};

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`\n[server] ${signal}: shutting down`);
  stopConsole();
  remo?.stop();
  osmo?.stop();
  await agent.coding.close();
  await agent.freshConnectors.close();
  agent.close();
  await servers.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
