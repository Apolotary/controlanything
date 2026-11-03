/**
 * Editable object games through the real XR HUD, Mac DOM and fixture Muse server.
 * An explicitly inserted fixture Book tag tests the software path, not detector accuracy.
 * Own silent server on 8801/8451, no physical devices/audio/API calls; one browser only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = join(ROOT, 'research/screens/canvas');
const BASE = 'http://127.0.0.1:8801';
const UI_TIMEOUT = 30_000;
const PIPELINE_TIMEOUT = 180_000;
let server, browser, quest, companion, dataDir;
const cardId = "fixture-book-canvas";
let serverReady = false;
let serverError;
let serverLog = '';
let currentPhase = '00-server';
const browserLog = [];
const abort = new AbortController();

async function json(path) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(3000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

async function until(description, probe, timeout = UI_TIMEOUT) {
  const deadline = Date.now() + timeout;
  do {
    abort.signal.throwIfAborted();
    if (serverError) throw serverError;
    if (server && (server.exitCode !== null || server.signalCode !== null)) {
      throw new Error(`Fixture server exited (${server.exitCode ?? server.signalCode})`);
    }
    const result = await probe();
    if (result) return result;
    await delay(200, undefined, { signal: abort.signal });
  } while (Date.now() < deadline);
  throw new Error(`Timed out after ${timeout / 1000}s: ${description}`);
}

async function portMustBeFree(port) {
  await new Promise((resolvePort, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Port ${port} is occupied; stop its owner or run this check later.`));
    });
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolvePort() : reject(error));
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error(`Could not check port ${port}`));
    });
  });
}

async function startServer() {
  for (const app of ['sim', 'quest', 'companion']) {
    await access(join(ROOT, `apps/${app}/dist/index.html`)).catch(() => {
      throw new Error(`${app} is not built. Run npm run build before npm run e2e:canvas.`);
    });
  }
  await access(join(ROOT, 'apps/companion/dist/vsynth/index.html')).catch(() => {
    throw new Error('The visual synth is not built. Run npm run build before npm run e2e:canvas.');
  });
  await portMustBeFree(8801);
  await portMustBeFree(8451);
  const freshDir = await mkdtemp(join(tmpdir(), 'ce-e2e-canvas-'));
  if (abort.signal.aborted) {
    await rm(freshDir, { recursive: true, force: true });
    abort.signal.throwIfAborted();
  }
  dataDir = freshDir;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HTTP_PORT: '8801', HTTPS_PORT: '8451',
      HTTP_HOST: '127.0.0.1', HTTPS_HOST: '127.0.0.1', PUBLIC_HOST: '127.0.0.1',
      CE_DATA_DIR: dataDir, MODEL_MODE: 'fixture', MODEL_API_KEY: '', CE_SCAN_PROMPTS: 'book',
      CE_MAC_SILENT: '1', CE_MAC_LOCAL: '0',
      CE_REMO: '0', REMO_HOST: '', REMO_SEND: '0',
      CE_TRUST_FIRST_DEVICE: '1', CE_TRUST_LOOPBACK: '1', CE_CONSOLE_APPROVE: '0',
      MUSE_REPLAY: '1', MUSE_RECORD: '0', MUSE_RECORD_DIR: '',
      FIXTURE_DELAY_MS: '500', GEN3D_REPLAY_SPEED: '0', GEN3D_SKIN: '0', VITEST: '',
    },
  });
  server.on('error', (error) => { serverError = error; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-250_000);
    // HTTP starts before HTTPS: wait until the entry point has finished starting both.
    serverReady ||= serverLog.includes('ControlAnything server ');
  });
  await until('own HTTP/HTTPS fixture server startup', () => serverReady);
  const health = await json('/api/health');
  assert.equal(health.mode, 'fixture');
  assert.equal(health.space.pairedDevices, 0, 'Server must start with an empty registry');
  assert.equal(new URL(health.urls.https).port, '8451');
}

function watchPage(page, name) {
  const log = (text) => {
    browserLog.push(`${name}: ${text}`);
    if (browserLog.length > 300) browserLog.shift();
  };
  page.on('pageerror', (error) => log(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') log(message.text());
  });
  page.on('requestfailed', (request) => log(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
}

async function waitQuest(predicate, arg, timeout = UI_TIMEOUT) {
  abort.signal.throwIfAborted();
  await quest.waitForFunction(predicate, arg, { timeout, polling: 100 });
  abort.signal.throwIfAborted();
}

async function renderedFrames(count = 2) {
  // Observe the app loop, including emulated XR frames, instead of sleeping for GPU timing.
  for (let i = 0; i < count; i++) {
    const time = await quest.evaluate(() => window.__ce.lastFrame?.time ?? 0);
    await waitQuest((previous) => window.__ce.lastFrame?.time > previous, time);
  }
}

async function screenshot(name) {
  await quest.bringToFront();
  await waitQuest(() => {
    let ready = true;
    window.__ce.hud.root.traverse((node) => {
      if (typeof node.sync !== 'function') return;
      // Troika does not invoke sync callbacks for text that is already clean.
      node.sync();
      if (node._needsSync || node._isSyncing || (node.text && !node.textRenderInfo)) ready = false;
    });
    const { card, controls } = window.__ce.hud;
    return ready && (!card.visible || card.scale.x > 0.99) && (!controls.visible || controls.scale.y > 0.99);
  });
  await renderedFrames();
  // IWER moves the renderer canvas out of #stage when XR starts.
  const canvas = await quest.evaluateHandle(() => window.__ce.renderer.domElement);
  try {
    await canvas.asElement().screenshot({ path: join(SCREENS, `${name}.png`), timeout: UI_TIMEOUT });
  } finally {
    await canvas.dispose();
  }
}

async function phase(name, action, capture = true) {
  abort.signal.throwIfAborted();
  currentPhase = name;
  const started = Date.now();
  await action();
  abort.signal.throwIfAborted();
  if (capture) await screenshot(name);
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

async function pinch({ targetId, nodeName, turn = false, fraction }) {
  await renderedFrames();
  if (targetId && !turn) await waitQuest((id) => {
    const app = window.__ce;
    return app.visibleTargets.has(id) && (app.modes.tags.has(id) || Date.now() - (app.observed.get(id)?.at ?? 0) < 200);
  }, targetId);
  const point = await quest.evaluate(({ targetId, nodeName, turn, fraction }) => {
    const app = window.__ce;
    const object = nodeName ? app.hud.root.getObjectByName(nodeName)
      : app.modes.tags.has(targetId) ? app.hud.root.getObjectByName(`target-label:${targetId}`) : null;
    if (nodeName && !object) throw new Error(`HUD node not found: ${nodeName}`);
    for (let node = turn ? null : object; node; node = node.parent) {
      if (!node.visible) throw new Error(`HUD node is hidden: ${nodeName}`);
    }
    const world = object
      ? fraction === undefined ? object.getWorldPosition(app.desktopCam.position.clone())
        : object.localToWorld(app.desktopCam.position.clone().set((fraction - 0.5) * object.getObjectByName('button-plate').scale.x, 0, 0))
      : app.targets.get(targetId)?.position.clone();
    if (!world) throw new Error(`Target not found: ${targetId}`);
    if (turn) {
      app.emulator.lookAt(world);
      return null;
    }
    const camera = app.renderer.xr.isPresenting ? app.renderer.xr.getCamera().cameras[0] : app.desktopCam;
    const ndc = world.project(camera);
    const rect = app.renderer.domElement.getBoundingClientRect();
    if (Math.abs(ndc.x) > 0.98 || Math.abs(ndc.y) > 0.98 || Math.abs(ndc.z) > 1) {
      throw new Error(`Outside emulator view: ${nodeName ?? targetId} (${ndc.x}, ${ndc.y})`);
    }
    return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
  }, { targetId, nodeName, turn, fraction });
  if (turn) {
    const time = await quest.evaluate(() => window.__ce.lastFrame.time);
    await waitQuest((time) => window.__ce.lastFrame.time >= time + 300, time);
    return pinch({ targetId, nodeName, fraction });
  }
  await quest.mouse.move(point.x, point.y);
  await quest.mouse.down();
  try {
    await renderedFrames();
  } finally {
    await quest.mouse.up();
  }
  await renderedFrames();
}

async function openMenu() {
  if (await quest.evaluate(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible)) return;
  await pinch({ nodeName: 'menu-toggle', turn: true });
  await waitQuest(() => window.__ce.hud.root.getObjectByName('main-menu')?.visible
    && window.__ce.hud.deck.userData.open);
}

async function menuAction(nodeName, options = {}) {
  await openMenu();
  const route = await quest.evaluate(nodeName => {
    const menu = window.__ce.hud.root.getObjectByName('main-menu'), node = menu.getObjectByName(nodeName);
    if (!node?.userData.menuButton) throw new Error(`Unknown menu action: ${nodeName}`);
    let visible = true;
    for (let owner = node; owner; owner = owner.parent) if (!owner.visible) visible = false;
    return visible ? null : menu.userData.toolsOpen ? 'menu-tools-back' : 'menu-tools';
  }, nodeName);
  if (route) await pinch({ nodeName: route, turn: true });
  await waitQuest(nodeName => {
    let node = window.__ce.hud.root.getObjectByName(nodeName);
    if (!node) return false;
    for (; node; node = node.parent) if (!node.visible) return false;
    return true;
  }, nodeName);
  await pinch({ nodeName, turn: true, ...options });
}


async function waitCanvas(phase, revision) {
  await waitQuest(({ phase, revision, cardId }) => window.__canvasEvents.some(event => event.type === 'canvas.state'
    && event.payload.cardId === cardId && event.payload.document?.revision === revision && event.payload.game?.phase === phase), { phase, revision, cardId });
}
async function canvasState() {
  return quest.evaluate(() => window.__canvasEvents.findLast(event => event.type === 'canvas.state')?.payload);
}
async function assertMacCanvasDisclosure(expanded) {
  assert.equal(await companion.locator('#canvas-toggle').getAttribute('aria-expanded'), String(expanded));
  assert.equal(await companion.locator('#canvas-toggle').textContent(), expanded ? 'Hide Canvas' : 'Open Canvas');
  assert.equal(await companion.locator('#canvas-body').isVisible(), expanded, 'Mac Canvas visibility must follow its disclosure');
}
async function run() {
  await mkdir(SCREENS, { recursive: true });
  await phase('00-server', startServer, false);
  await phase('01-fixture-book', async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    context.setDefaultTimeout(UI_TIMEOUT);
    await context.addInitScript(() => {
      window.__ceMute = true;
      for (const name of ['AudioContext', 'webkitAudioContext']) if (window[name]) window[name] = new Proxy(window[name], {
        construct() { throw new Error('Canvas E2E must never create an audio graph'); },
      });
    });
    quest = await context.newPage(); watchPage(quest, 'quest');
    await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&hud=v2&yolo=0`);
    await waitQuest(() => window.__ce?.welcome && window.__ce.ws.open && window.__ce.room?.sim?.canvas);
    await quest.evaluate(() => {
      window.__canvasEvents = []; window.__canvasRequests = [];
      window.__ce.ws.tap('in', ({type,payload}) => window.__canvasEvents.push({type,payload}));
      window.__ce.ws.tap('out', ({type,payload}) => window.__canvasRequests.push({type,payload: type === 'scan.frame' ? {frameId:payload.frameId} : payload}));
    });
    await quest.locator('#btn-enter').click();
    await waitQuest(() => window.__ce.renderer.xr.isPresenting);
    // A deliberate test fixture. A detector is not used or claimed in this check.
    await quest.evaluate(cardId => {
      const app = window.__ce, position = app.desktopCam.position.clone().set(0,1.4,-1.2);
      app.targets.targets.set(cardId,{id:cardId,label:'Book',score:1,position,facing:position.clone().set(0,0,1),
        confirmed:true,refined:false,method:'fixture',sizeM:[.2,.25,.03],status:'detected',frameId:'',detId:'',seen:1,firstSeenAt:Date.now(),lastSeenAt:Date.now()});
      app.observeTarget({id:cardId,label:'Book',rawLabel:'Book',score:1,position:[0,1.4,-1.2],sizeM:[.2,.25,.03],confirmed:true});
    },cardId);
    await quest.evaluate(id => window.__ce.lock(id,'fixture'),cardId);
    await waitQuest(id => !!window.__ce.modes.byCard(id), cardId);
    await menuAction('mode-control');
    await waitQuest(() => window.__ce.modes.mode === 'control');
    const targetId = await quest.evaluate(id => window.__ce.modes.byCard(id).targetId, cardId);
    await pinch({ targetId, turn: true });
    await waitQuest(id => window.__ce.lockedId === id, targetId);
    assert.equal(await quest.evaluate(id => window.__ce.modes.byCard(id).connection, cardId), 'offline');
    companion = await context.newPage(); watchPage(companion, 'companion');
    await companion.goto(`${BASE}/companion/?mute=1`);
    await companion.locator('#canvas-toggle').waitFor();
    await companion.waitForFunction(id => document.querySelector('#canvas-object')?.value === id, cardId);
    await assertMacCanvasDisclosure(false);
    // A tagged ordinary object keeps setup/device actions primary until Canvas is requested.
    await companion.locator('#canvas-toggle').click();
    await companion.locator('#canvas-object').waitFor();
    await assertMacCanvasDisclosure(true);
    await companion.locator('#canvas-toggle').click();
    await assertMacCanvasDisclosure(false);
  });
  await phase('01b-inspect-offline-book', async () => {
    await pinch({nodeName:'object-inspect',turn:true});
    await waitQuest(() => window.__ce.assistant.view?.objectInfo?.source === 'fixture');
    const info = await quest.evaluate(() => window.__ce.assistant.view.objectInfo);
    assert.equal(info.identityStatus, 'uncertain');
    for (const field of ['description', 'dimensions', 'weight']) assert.equal(info[field].value, null);
    assert.equal(info.price, null);
    assert.deepEqual(info.sources, []);
    assert.match(info.identityNote, /no live web lookup/i);
    const visibleFacts = await quest.evaluate(() => {
      const text = [];
      window.__ce.hud.root.getObjectByName('assistant-panel').traverseVisible(node => { if (typeof node.text === 'string') text.push(node.text); });
      return text.join('\n');
    });
    assert.match(visibleFacts, /No sourced details yet/);
    assert.match(visibleFacts, /Not available: dimensions, weight, price/);
    assert.equal((visibleFacts.match(/Not available:/g) ?? []).length, 1, 'Missing facts should share one note');
    assert.doesNotMatch(visibleFacts, /(?:Dimensions|Weight|Price): Unknown/);
    assert.equal(await quest.evaluate(() => window.__canvasRequests.some(event => ['control.setup','control.event','arm.confirm','canvas.request'].includes(event.type))),false);
    await writeFile(join(SCREENS,'inspect-state.json'),JSON.stringify(info,null,2));
  });
  await phase('02-preview', async () => {
    await pinch({nodeName:'object-info-close'});
    await pinch({nodeName:'canvas-create',turn:true});
    await waitCanvas('preview',1);
    const state = await canvasState();
    assert.equal(state.document.source, 'fixture');
    assert.equal(state.game.score,0);
    assert.match(state.document.spec.intro,/unseen contents are not known/);
    await companion.locator('#canvas-play').waitFor();
    await assertMacCanvasDisclosure(true); // The first game created in Quest reveals its Mac editor.
    assert.match(await companion.locator('#canvas-source').textContent(),/fixture/i);
  });
  await phase('03-shared-play', async () => {
    await pinch({nodeName:'canvas-primary',turn:true});
    await waitCanvas('playing',1);
    await pinch({nodeName:'canvas-choice-0',turn:true});
    await waitCanvas('feedback',1);
    const state = await canvasState();
    assert.equal(state.game.score,3);
    await companion.locator('#canvas-feedback').waitFor();
    assert.match(await companion.locator('#canvas-feedback').textContent(),/surprising detail/);
    const action = await quest.evaluate(() => window.__canvasRequests.findLast(event => event.type === 'canvas.action').payload);
    // Replay the exact request and a new request for the already answered round: neither can rescore.
    await quest.evaluate(action => window.__ce.ws.send('canvas.action',action,{to:'server'}),action);
    await quest.evaluate(action => window.__ce.ws.send('canvas.action',{...action,requestId:'second-answer'},{to:'server'}),action);
    await waitQuest(() => window.__canvasEvents.some(event => event.payload.requestId === 'second-answer' && event.payload.status === 'error'));
    assert.equal((await canvasState()).game.score,3);
    // Fetch after the deliberate stale action to restore the normal ready view.
    await quest.evaluate(id => window.__ce.ws.send('canvas.get',{cardId:id},{to:'server'}),cardId);
    await companion.locator('#canvas-next').click();
    await waitCanvas('finished',1);
  });
  await phase('04-ask-muse-edit', async () => {
    await companion.locator('#canvas-toggle').click();
    await assertMacCanvasDisclosure(false);
    assert.equal(await quest.evaluate(() => window.__ce.assistant.sendText('Make this game harder')),true);
    await waitCanvas('preview',2);
    const state = await canvasState();
    assert.equal(state.game.score,0);
    assert.match(state.document.spec.rounds[0].prompt,/competing clues/);
    assert.equal(state.document.history.length,2);
    await companion.waitForFunction(() => /revision 2/i.test(document.querySelector('#canvas-preview .canvas-kicker')?.textContent));
    await assertMacCanvasDisclosure(false); // New status/revision messages respect a manual close.
    await companion.locator('#canvas-toggle').click();
    await assertMacCanvasDisclosure(true);
    await companion.locator('#object-canvas').scrollIntoViewIfNeeded();
    await companion.screenshot({path:join(SCREENS,'04-mac-edit.png'),fullPage:true});
  });
  await phase('05-restore-from-mac', async () => {
    // Ask Muse owns the foreground until its completed reply is dismissed.
    await waitQuest(() => window.__ce.assistant.view?.state === 'reply');
    await pinch({nodeName:'assistant-dismiss',turn:true});
    await companion.locator('#canvas-restore').click();
    await waitCanvas('preview',3);
    assert.match((await canvasState()).document.spec.rounds[0].prompt,/kind of story/);
    // A previous revision can no longer start a round.
    await quest.evaluate(id => window.__ce.ws.send('canvas.action',{requestId:'stale-play',cardId:id,revision:1,action:'play'},{to:'server'}),cardId);
    await waitQuest(() => window.__canvasEvents.some(event => event.payload.requestId === 'stale-play' && event.payload.status === 'error'));
    assert.equal((await canvasState()).game.phase,'preview');
    await quest.evaluate(id => window.__ce.ws.send('canvas.get',{cardId:id},{to:'server'}),cardId);
  });
  await phase('06-mac-prompt-and-responsive', async () => {
    await companion.locator('#canvas-prompt').fill('Make the story harder');
    await companion.locator('#canvas-submit').click();
    await waitCanvas('preview',4);
    await companion.locator('#canvas-play').waitFor();
    await companion.setViewportSize({width:640,height:900});
    assert.equal(await companion.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await companion.locator('#object-canvas').scrollIntoViewIfNeeded();
    await companion.screenshot({path:join(SCREENS,'06-mac-640.png')});
    assert.equal(await quest.evaluate(() => window.__canvasRequests.some(event => ['control.setup','control.event','arm.confirm'].includes(event.type))),false);
    assert.equal(await quest.evaluate(() => window.__canvasEvents.some(event => ['driver.spec','arm.request','exec.request'].includes(event.type))),false);
    await writeFile(join(SCREENS,'canvas-state.json'),JSON.stringify(await canvasState(),null,2));
  });
  await phase('07-close-stays-closed', async () => {
    await pinch({nodeName:'canvas-close',turn:true});
    await waitQuest(() => !window.__ce.hud.root.getObjectByName('object-canvas').visible);
    await companion.locator('#canvas-play').click();
    await waitCanvas('playing',4);
    assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('object-canvas').visible),false);
    await companion.locator('#canvas-prompt').fill('Make it harder again');
    await companion.locator('#canvas-submit').click();
    await waitCanvas('preview',5);
    assert.equal(await quest.evaluate(() => window.__ce.hud.root.getObjectByName('object-canvas').visible),false);
    await pinch({nodeName:'canvas-create',turn:true});
    await waitQuest(() => {
      const panel=window.__ce.hud.root.getObjectByName('object-canvas');
      return panel.visible && panel.userData.revision === 5 && panel.userData.phase === 'preview';
    });
    await screenshot('07-reopened-latest');
    await quest.evaluate(() => window.__ce.session?.end());
  },false);
}

async function cleanup() {
  await browser?.close();
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit',resolve)); server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'),5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  if (dataDir) await rm(dataDir,{recursive:true,force:true});
}
const stop = signal => abort.abort(new Error(`Interrupted by ${signal}`));
process.on('SIGINT',stop); process.on('SIGTERM',stop);
const deadline = setTimeout(() => abort.abort(new Error('Canvas E2E exceeded 4 minutes')),240000);
try {
  await Promise.race([run(),new Promise((_,reject) => abort.signal.addEventListener('abort',() => reject(abort.signal.reason),{once:true}))]);
  console.log(`PASS editable object Canvas; screenshots: ${SCREENS}`);
} catch(error) {
  process.exitCode=1; console.error(`FAIL ${currentPhase}: ${error.stack ?? error}`);
  await writeFile(join(SCREENS,'server.log'),serverLog);
  await writeFile(join(SCREENS,'browser.log'),browserLog.join('\n'));
  if (quest && !quest.isClosed()) {
    await quest.screenshot({path:join(SCREENS,`${currentPhase}-FAIL.png`),timeout:3000}).catch(()=>{});
    await writeFile(join(SCREENS,'failure.json'),JSON.stringify(await quest.evaluate(() => ({events:window.__canvasEvents,requests:window.__canvasRequests,locked:window.__ce.lockedId,mode:window.__ce.modes.mode,canvas:window.__ce.canvas})).catch(()=>({})),null,2));
  }
} finally { clearTimeout(deadline); await cleanup(); process.off('SIGINT',stop); process.off('SIGTERM',stop); }
