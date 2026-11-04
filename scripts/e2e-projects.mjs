/** Generated webpages + shared actions + real Quest emulator input. Own silent fixture server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'research/screens/projects');
const BASE = 'http://127.0.0.1:8803';
let server, browser, dataDir, observer, studio, quest;
let log = '', phase = 'startup';
const messages = [];
async function until(label, fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (server && server.exitCode !== null) throw new Error(`Server exited: ${log.slice(-3000)}`);
    const value = await fn(); if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort(port) {
  await new Promise((yes, no) => {
    const socket = createConnection({host:'127.0.0.1',port});
    socket.once('connect', () => {socket.destroy();no(new Error(`Port ${port} occupied`));});
    socket.once('error', e => e.code === 'ECONNREFUSED' ? yes() : no(e));
    socket.setTimeout(1500,()=>{socket.destroy();no(new Error(`Port ${port} probe timed out`));});
  });
}
async function json(path, body) {
  const r = await fetch(`${BASE}${path}`, body ? {method:'POST',headers:{'content-type':'application/json',origin:BASE},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)} : {signal:AbortSignal.timeout(3000)});
  assert(r.ok, `${path}: ${r.status}`); return r.json();
}
async function identity(kind, name) {
  const p = await json('/api/pair/start',{kind,name});
  const s = p.deviceToken ? p : await json(`/api/pair/status?pairingId=${encodeURIComponent(p.pairingId)}&pollSecret=${encodeURIComponent(p.pollSecret)}`);
  assert.equal(s.status,'approved');
  return {deviceId:s.deviceId,deviceToken:s.deviceToken,kind,name};
}
function send(type,payload) {
  observer.send(JSON.stringify({v:1,type,id:`e2e-${crypto.randomUUID()}`,ts:Date.now(),from:'',to:'server',payload}));
}
const latest = id => messages.findLast(m=>m.type==='project.state' && (!id || m.payload.projectId===id))?.payload;
async function frames(count=3) {
  for(let i=0;i<count;i++) {
    const t=await quest.evaluate(()=>window.__ce.lastFrame?.time ?? 0);
    await quest.waitForFunction(t=>window.__ce.lastFrame?.time>t,t);
  }
}
async function pinch(name, navigates = false) {
  await quest.evaluate(name=>{
    const a=window.__ce,n=a.hud.root.getObjectByName(name);
    if(!n)throw Error(`Missing ${name}`);
    a.emulator.lookAt(n.getWorldPosition(a.desktopCam.position.clone()));
  },name);
  await frames(5);
  const p=await quest.evaluate(name=>{
    const a=window.__ce,n=a.hud.root.getObjectByName(name);
    for(let x=n;x;x=x.parent)if(!x.visible)throw Error(`Hidden ${name}`);
    const camera=a.renderer.xr.getCamera().cameras[0];
    const point=n.getWorldPosition(a.desktopCam.position.clone()).project(camera);
    const rect=a.renderer.domElement.getBoundingClientRect();
    return {x:rect.left+(point.x+1)*rect.width/2,y:rect.top+(1-point.y)*rect.height/2};
  },name);
  await quest.mouse.move(p.x,p.y);await quest.mouse.down();
  if (!navigates) await frames();
  await quest.mouse.up();
  if (!navigates) await frames();
}
async function shot(name,page=studio) {
  await page.screenshot({path:join(OUT,`${name}.png`)});
}
try {
  await mkdir(OUT,{recursive:true});
  await freePort(8803);await freePort(8453);
  dataDir=await mkdtemp(join(tmpdir(),'ce-projects-'));
  server=spawn(process.execPath,['--import','tsx','src/index.ts'],{
    cwd:join(ROOT,'apps/server'),stdio:['ignore','pipe','pipe'],env:{...process.env,
      HTTP_PORT:'8803',HTTPS_PORT:'8453',HTTP_HOST:'127.0.0.1',HTTPS_HOST:'127.0.0.1',PUBLIC_HOST:'127.0.0.1',
      CE_DATA_DIR:dataDir,MODEL_MODE:'fixture',MODEL_API_KEY:'',CE_MAC_SILENT:'1',CE_MAC_LOCAL:'0',
      CE_REMO:'0',REMO_HOST:'',REMO_SEND:'0',CE_TRUST_FIRST_DEVICE:'1',CE_TRUST_LOOPBACK:'1',
      CE_CONSOLE_APPROVE:'0',MUSE_REPLAY:'1',MUSE_RECORD:'0',MUSE_RECORD_DIR:'',FIXTURE_DELAY_MS:'150',GEN3D_SKIN:'0',VITEST:''}});
  for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{log=(log+b).slice(-200000);});
  await until('server startup',()=>log.includes('ControlAnything server '));
  assert.equal((await json('/api/health')).mode,'fixture');
  const mac=await identity('mac','Canvas fixture Mac');
  observer=new WebSocket(`${BASE.replace('http','ws')}/ws`);
  observer.on('message',data=>messages.push(JSON.parse(String(data))));
  await new Promise((resolve,reject)=>{observer.once('open',resolve);observer.once('error',reject);});
  send('hello',{deviceToken:mac.deviceToken,app:'canvas-e2e-observer',executor:false});
  await until('observer welcome',()=>messages.find(m=>m.type==='welcome'));
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  const macContext=await browser.newContext({viewport:{width:1440,height:1000}});
  macContext.setDefaultTimeout(30_000);
  await macContext.addInitScript(id=>{if(window===window.top)localStorage.setItem('ce.device',JSON.stringify(id));},mac);
  studio=await macContext.newPage();
  studio.on('pageerror',e=>{log+=`\nSTUDIO ERROR: ${e.message}`;});
  await studio.goto(`${BASE}/companion/canvas/`);
  phase='create';
  await studio.locator('#project-prompt').fill('Make an interactive color field with an intensity slider and a pulse button. It should respond to my hands.');
  await studio.locator('#project-generate').click();
  const created=await until('fixture generated project',()=>messages.find(m=>m.type==='project.state'&&m.payload.document?.revision===1)?.payload);
  const doc=created.document, id=doc.projectId;
  assert.equal(doc.source,'fixture');
  assert.equal(await studio.locator('#project-preview').count(),0,'Generated code must wait for Run');
  await shot('01-generated-preview');
  phase='run-and-isolation';
  await studio.locator('#project-run').click();
  await studio.locator('#project-preview').waitFor();
  const iframe=await studio.locator('#project-preview').elementHandle();
  const frame=await iframe.contentFrame();
  assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts');
  await frame.waitForFunction(()=>!!window.museCanvas);
  const isolated=await frame.evaluate(()=>{
    let parentBlocked=false,storageBlocked=false;
    try{void parent.document.body;}catch{parentBlocked=true;}
    try{void localStorage.getItem('ce.device');}catch{storageBlocked=true;}
    return {parentBlocked,storageBlocked};
  });
  assert.deepEqual(isolated,{parentBlocked:true,storageBlocked:true});
  const numeric=doc.spec.actions.find(a=>a.kind==='number');assert(numeric);
  const value=numeric.min+(numeric.max-numeric.min)*0.75;
  await frame.evaluate(({id,value})=>window.museCanvas.emit(id,value),{id:numeric.id,value});
  await until('iframe action shared with server',()=>latest(id)?.values?.[numeric.id]===value);
  const next=numeric.min+(numeric.max-numeric.min)*0.25;
  send('project.action',{requestId:'outside-action',projectId:id,revision:1,actionId:numeric.id,value:next});
  await until('second client updates shared state',()=>latest(id)?.values?.[numeric.id]===next);
  await frame.waitForFunction(({id,value})=>window.museCanvas.state[id]===value,{id:numeric.id,value:next});
  await shot('02-running-shared-state');
  phase='revision';
  await studio.locator('#project-prompt').fill('Keep the same controls but make the color field calmer.');
  await studio.locator('#project-generate').click();
  await until('revision two',()=>latest(id)?.document?.revision===2);
  assert.equal(await studio.locator('#project-preview').count(),0,'New revision must not run automatically');
  send('project.action',{requestId:'stale-action',projectId:id,revision:1,actionId:numeric.id,value});
  await until('stale revision rejected',()=>messages.find(m=>m.type==='project.state'&&m.payload.requestId==='stale-action'&&m.payload.status==='error'));
  await studio.reload();
  await studio.locator('#project-select').selectOption(id);
  await until('reload retains revision',async()=>await studio.locator('#project-run').isEnabled());
  assert.equal(await studio.locator('#project-preview').count(),0,'Reload must keep execution stopped');
  await studio.locator('#project-run').click();
  phase='quest';
  const questContext=await browser.newContext({viewport:{width:1440,height:1000}});
  questContext.setDefaultTimeout(30_000);
  quest=await questContext.newPage();
  await quest.goto(`${BASE}/quest/?emulate=1&camera=sim&mute=1&mic=0&hud=v2`);
  await quest.waitForFunction(()=>window.__ce?.welcome&&window.__ce.ws.open);
  await quest.locator('#btn-enter').click();
  await quest.waitForFunction(()=>window.__ce.renderer.xr.isPresenting);
  // Muse Canvas is a lab feature (headset: ?lab=1 → palette "More (lab)" → Canvas); open it through its HUD event.
  await quest.evaluate(()=>window.__ce.hud.events.emit('projectsOpen',{}));
  await quest.waitForFunction(()=>window.__ce.hud.root.getObjectByName('project-start')?.visible);
  await frames(10);
  await shot('03-quest-project-panel',quest);
  phase='preview-readiness';
  await studio.locator('#project-stop').click();
  await until('closed preview reported to Quest',()=>latest(id)?.preview?.count===0);
  await quest.waitForFunction(()=>window.__ce.projects.ready===false);
  await quest.evaluate(()=>window.__ce.projects.command('start'));
  assert.equal(await quest.evaluate(()=>window.__ce.projects.running),false,'A saved document without a running preview cannot start hand control');
  await shot('03a-no-preview-guidance',quest);
  await studio.locator('#project-run').click();
  await until('sandbox acknowledges actual preview',()=>latest(id)?.preview?.count===1);
  await quest.waitForFunction(()=>window.__ce.projects.ready===true);
  assert.equal(await quest.evaluate(()=>window.__ce.projects.running),false,'Preview recovery must wait for explicit Start');
  phase='quest-hands';
  await quest.evaluate(async()=>{
    const app=window.__ce,remote=app.emulator.device.remote,head=app.emulator.head();
    app.input.mouseAsHand=false;app.input.pointer.inside=app.input.pointer.down=app.input.pointer.latched=false;
    await remote.dispatch('set_input_mode',{mode:'hand'});
    for(const side of ['left','right']) {
      const position=head.position.clone().add(head.position.clone().set(side==='left'?-.2:.2,-.4,-.4).applyQuaternion(head.quaternion));
      const palm=head.position.clone().sub(position).normalize();
      const fingers=head.position.clone().set(0,1,0).applyQuaternion(head.quaternion);
      fingers.addScaledVector(palm,-fingers.dot(palm)).normalize();
      const xyz=v=>({x:v.x,y:v.y,z:v.z});
      await remote.dispatch('set_connected',{device:`hand-${side}`,connected:true});
      await remote.dispatch('set_select_value',{device:`hand-${side}`,value:0});
      await remote.dispatch('set_hand_pose',{device:`hand-${side}`,poseId:side==='left'?'fist':'open'});
      await remote.dispatch('set_transform',{device:`hand-${side}`,anchor:'wrist',position:xyz(position),orientation:{fingers:xyz(fingers),palm:xyz(palm)}});
      if(side==='right')window.__projectRightWrist=xyz(position);
    }
  });
  await frames(8);
  // UI navigation above uses actual mouse/pinch hit testing; this command avoids mouse-as-hand
  // competing with IWER's articulated hand input while exercising the same Start handler.
  const sequenceBeforeHands=latest(id)?.sequence ?? 0;
  await quest.evaluate(()=>window.__ce.projects.command('start'));
  await until('left fist sends project input',()=>latest(id)?.revision===2&&latest(id)?.sequence>sequenceBeforeHands);
  await frames(10);
  const low=latest(id)?.values?.[numeric.id];assert.equal(typeof low,'number');
  await quest.evaluate(async()=>{
    const p=window.__projectRightWrist;
    await window.__ce.emulator.device.remote.dispatch('set_transform',{device:'hand-right',anchor:'wrist',position:{...p,y:p.y+.35}});
  });
  await until('raising hand changes shared value',()=>latest(id)?.values?.[numeric.id]>low+(numeric.max-numeric.min)*.2);
  const newFrame=await (await studio.locator('#project-preview').elementHandle()).contentFrame();
  await newFrame.waitForFunction(({id,min})=>window.museCanvas.state[id]>min,{id:numeric.id,min:low+(numeric.max-numeric.min)*.2});
  await shot('04-hand-driven-webpage');
  phase='preview-loss-during-hands';
  await studio.locator('#project-stop').click();
  await quest.waitForFunction(()=>!window.__ce.projects.running&&!window.__ce.projects.ready);
  const afterPreviewLoss=latest(id)?.sequence;
  await quest.evaluate(async()=>{
    const p=window.__projectRightWrist;
    await window.__ce.emulator.device.remote.dispatch('set_transform',{device:'hand-right',anchor:'wrist',position:{...p,y:p.y+.1}});
  });
  await frames(8);assert.equal(latest(id)?.sequence,afterPreviewLoss,'Closing a running preview must stop ongoing hand updates');
  await studio.locator('#project-run').click();
  await quest.waitForFunction(()=>window.__ce.projects.ready);
  assert.equal(await quest.evaluate(()=>window.__ce.projects.running),false,'Returning preview must not resume held-fist input automatically');
  await quest.evaluate(()=>window.__ce.projects.command('start'));
  await until('explicit restart after preview loss',()=>latest(id)?.sequence>afterPreviewLoss);
  await quest.evaluate(()=>window.__ce.emulator.device.remote.dispatch('set_hand_pose',{device:'hand-left',poseId:'open'}));
  await quest.waitForFunction(()=>!window.__ce.projects.running);
  const stopped=latest(id)?.sequence;
  await quest.evaluate(async()=>{
    const p=window.__projectRightWrist;
    await window.__ce.emulator.device.remote.dispatch('set_transform',{device:'hand-right',anchor:'wrist',position:{...p,y:p.y-.2}});
  });
  await frames(8);assert.equal(latest(id)?.sequence,stopped,'Both palms must stop outgoing project inputs');
  await quest.evaluate(()=>{window.__ce.input.mouseAsHand=true;});
  phase='native-ar-scene';
  await studio.locator('#project-stop').click();
  await quest.waitForFunction(()=>!window.__ce.projects.ready);
  await pinch('project-run-spatial');
  await quest.waitForFunction(()=>window.__ce.hud.root.getObjectByName('project-spatial-preview')?.userData.rendered);
  assert.equal(latest(id)?.preview?.count,0,'Native AR preview runs without a Mac sandbox lease');
  assert.equal(await quest.evaluate(()=>window.__ce.projects.running),false,'Run AR preview does not start hands');
  await quest.evaluate(async()=>{
    const app=window.__ce;
    app.input.mouseAsHand=false;app.input.pointer.inside=app.input.pointer.down=app.input.pointer.latched=false;
    await app.emulator.device.remote.dispatch('set_hand_pose',{device:'hand-left',poseId:'fist'});
    const p=window.__projectRightWrist;
    await app.emulator.device.remote.dispatch('set_transform',{device:'hand-right',anchor:'wrist',position:{...p,y:p.y-.2}});
  });
  await frames(8);
  await quest.evaluate(()=>window.__ce.projects.command('start'));
  await quest.waitForFunction(()=>window.__ce.projects.engaged);
  await frames(10);
  const nativeBefore=await quest.evaluate(()=>({...window.__ce.hud.root.getObjectByName('project-spatial-preview').userData}));
  await quest.evaluate(async()=>{
    const p=window.__projectRightWrist;
    await window.__ce.emulator.device.remote.dispatch('set_transform',{device:'hand-right',anchor:'wrist',position:{...p,y:p.y+.25}});
  });
  await quest.waitForFunction(before=>window.__ce.hud.root.getObjectByName('project-spatial-preview').userData.radius>before+.005,nativeBefore.radius);
  const nativeAfter=await quest.evaluate(()=>({...window.__ce.hud.root.getObjectByName('project-spatial-preview').userData}));
  assert(nativeAfter.normalized>nativeBefore.normalized);
  assert(nativeAfter.radius<=.065,'Generated visual stays inside the workspace bounds');
  await shot('04b-native-ar-generated-scene',quest);
  await writeFile(join(OUT,'native-ar-evidence.json'),JSON.stringify({fixture:true,macPreviews:latest(id)?.preview?.count,before:nativeBefore,after:nativeAfter},null,2));
  await quest.evaluate(()=>{window.__ce.projects.command('stop');window.__ce.input.mouseAsHand=true;});
  await pinch('project-run-spatial');
  assert.equal(await quest.evaluate(()=>window.__ce.projects.running),false);
  assert.equal(await quest.evaluate(()=>window.__ce.hud.root.getObjectByName('project-spatial-preview').userData.rendered),false);
  // Restore the existing Mac-rendered route for the independent full-page checks.
  await studio.locator('#project-run').click();
  await quest.waitForFunction(()=>window.__ce.projects.ready);
  phase='headset-full-page';
  const questIdentityBefore = await quest.evaluate(() => JSON.parse(localStorage.getItem('ce.device') ?? localStorage.getItem('ce.device.quest') ?? 'null'));
  await pinch('project-open-page', true);
  await quest.waitForURL(url => url.pathname === '/companion/canvas/' && url.searchParams.get('headset') === '1');
  await quest.waitForFunction(() => window.__museCanvas?.studio.online);
  assert.equal(await quest.locator('#studio-back').textContent(), '← Return to AR');
  assert.equal(new URL(quest.url()).searchParams.get('project'), id);
  assert.equal(await quest.locator('#project-preview').count(), 0, 'Opening on headset must not auto-run');
  assert.equal(await quest.evaluate(() => JSON.parse(localStorage.getItem('ce.device') ?? localStorage.getItem('ce.device.quest') ?? 'null').deviceId), questIdentityBefore.deviceId);
  await quest.locator('#project-run').click();
  await quest.locator('#project-preview').waitFor();
  const headsetFrame = await (await quest.locator('#project-preview').elementHandle()).contentFrame();
  await headsetFrame.waitForFunction(() => !!window.museCanvas);
  await quest.locator('#project-expand').click();
  assert(await quest.locator('body').evaluate(node => node.classList.contains('preview-focused')));
  const previewSize = await quest.locator('#project-preview').evaluate(node => ({width:node.clientWidth,height:node.clientHeight}));
  await headsetFrame.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, previewSize);
  await headsetFrame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await shot('05-headset-full-webpage', quest);
  await headsetFrame.evaluate(({ actionId, value }) => window.museCanvas.emit(actionId, value), { actionId: numeric.id, value });
  await until('headset browser interaction updates shared state', () => latest(id)?.values?.[numeric.id] === value);
  await quest.locator('#project-expand').click();
  await quest.locator('#project-new').click();
  await quest.locator('#project-prompt').fill('A webpage created directly on the headset, with an intensity control.');
  await quest.locator('#project-generate').click();
  await quest.waitForFunction(() => window.__museCanvas.studio.document && !window.__museCanvas.studio.pending);
  const headsetProject = await quest.evaluate(() => window.__museCanvas.studio.document.projectId);
  assert.notEqual(headsetProject, id);
  assert.equal(await quest.locator('#project-preview').count(), 0, 'Headset generation also waits for Run');
  await shot('06-headset-created-page', quest);
  await quest.locator('#studio-back').click();
  await quest.waitForURL(url => url.pathname === '/quest/' && url.searchParams.get('canvasProject') === headsetProject);
  assert.equal(await quest.locator('#project-preview').count(), 0, 'Returning to AR destroys the flat runtime');
  await studio.locator('#project-stop').click();
  assert.equal(await studio.locator('#project-preview').count(),0);
  console.log('PASS generated webpage, explicit Run, isolated runtime, shared actions, revisions, reload, preview readiness/loss/restart, Quest Canvas panel, articulated hand input, Stop, full headset webpage, headset generation and return');
  await writeFile(join(OUT,'validation.json'),JSON.stringify({fixture:true,physicalHeadset:false,projectId:id,revision:2,checks:['generate','explicit-run','opaque-origin','shared-actions','stale-revision','reload','quest-panel','preview-readiness','preview-loss','explicit-restart','emulated-hand-input','stop','native-ar-scene','native-ar-hands','native-ar-stop','headset-full-page','headset-create','headset-return']},null,2));
} catch(error) {
  if(studio)await shot('failure-studio').catch(()=>{});
  if(quest)await shot('failure-quest',quest).catch(()=>{});
  console.error(`FAIL ${phase}:`,error);process.exitCode=1;
} finally {
  observer?.close();await browser?.close();
  if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
  if(dataDir)await rm(dataDir,{recursive:true,force:true});
  await mkdir(OUT,{recursive:true});await writeFile(join(OUT,'server.log'),log);
}
