/** Real companion + Quest Worker; fixture Muse, virtual port only, output irrevocably muted. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, pairMac, startFixtureServer } from './harness.mjs';

const OUT = join(ROOT, 'research/screens/musical-synth');
let fixture, browser, mac, quest, phase = 'start';
const errors = [], evidence = {};
const wait = (fn, arg, timeout = 45000) => quest.waitForFunction(fn, arg, { timeout });
async function frames(n = 3) {
  for (let i=0; i<n; i++) { const t=await quest.evaluate(() => window.__ce.lastFrame.time); await wait(t => window.__ce.lastFrame.time > t, t); }
}
async function click(name) {
  await quest.evaluate(name => {
    const a=window.__ce, node=a.scene.getObjectByName(name);
    if (!node) throw Error(`Missing ${name}`);
    a.emulator.lookAt(node.getWorldPosition(a.desktopCam.position.clone()));
  }, name);
  await frames(5);
  const p=await quest.evaluate(name => {
    const a=window.__ce, node=a.scene.getObjectByName(name);
    for(let o=node;o;o=o.parent) {
      if(o.isVisible?.peek ? !o.isVisible.peek() : !o.visible) throw Error(`Hidden ${name}`);
    }
    const c=a.renderer.xr.getCamera().cameras[0], v=node.getWorldPosition(a.desktopCam.position.clone()).project(c);
    if(Math.abs(v.x)>.98 || Math.abs(v.y)>.98) throw Error(`Outside view ${name}`);
    const r=a.renderer.domElement.getBoundingClientRect();
    return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};
  },name);
  await quest.mouse.move(p.x,p.y); await frames(3);
  await quest.mouse.down(); await frames(3); await quest.mouse.up(); await frames(3);
}
async function hand(side, height, pinch=0, connected=true, stopPalm=false) {
  await quest.evaluate(async ({side,height,pinch,connected,stopPalm}) => {
    const a=window.__ce, remote=a.emulator.device.remote, device=`hand-${side}`;
    a.input.mouseAsHand=false; a.input.pointer.inside=a.input.pointer.down=a.input.pointer.latched=false;
    await remote.dispatch('set_input_mode',{mode:'hand'});
    await remote.dispatch('set_connected',{device,connected});
    if(!connected) return;
    const head=a.emulator.head(), xyz=v=>({x:v.x,y:v.y,z:v.z});
    const p=head.position.clone().add(head.position.clone().set(side==='left'?-.18:.25,height,-.4).applyQuaternion(head.quaternion));
    const palm=head.position.clone().sub(p).normalize(), fingers=head.position.clone().set(0,1,0).applyQuaternion(head.quaternion);
    fingers.addScaledVector(palm,-fingers.dot(palm)).normalize();
    if(stopPalm) palm.negate();
    await remote.dispatch('set_hand_pose',{device,poseId:side==='left'||stopPalm?'open':'default'});
    await remote.dispatch('set_transform',{device,anchor:'wrist',position:xyz(p),orientation:{fingers:xyz(fingers),palm:xyz(palm)}});
    await remote.dispatch('set_select_value',{device,value:pinch});
  },{side,height,pinch,connected,stopPalm});
  await frames(6);
}
const shot = (name,page=quest) => page.screenshot({path:join(OUT,`${name}.png`)});
const snapshot = () => mac.evaluate(() => window.__ceMusicalSnapshot());
const target = () => fixture.json('/api/agent/targets/musical-synth-mac');
try {
  await mkdir(OUT,{recursive:true});
  // This check exercises the documented demo's automatic software-device setup.
  process.env.CE_DEMO='1';
  fixture=await startFixtureServer(Number(process.env.PORT||8795),'musical-e2e');
  const identity=await pairMac(fixture,'Muted musical test Mac');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  const mc=await browser.newContext({viewport:{width:1440,height:1000}});
  await mc.addInitScript(id=>localStorage.setItem('ce.device',JSON.stringify(id)),identity);
  mac=await mc.newPage(); mac.on('pageerror',e=>errors.push(`Mac: ${e.message}`));
  await mac.goto(`${fixture.base}/companion/?mute=1`);
  const qc=await browser.newContext({viewport:{width:1440,height:1000}});
  quest=await qc.newPage(); quest.on('pageerror',e=>errors.push(`Quest: ${e.message}`));
  await quest.goto(`${fixture.base}/quest/?emulate=1&camera=photo&mute=1&mic=0`);
  await wait(()=>window.__ce?.welcome && window.__ce.ws.open);
  await quest.evaluate(()=>{
    window.__musicOut=[]; window.__musicIn=[];
    window.__ce.ws.tap('out',m=>window.__musicOut.push({type:m.type,payload:m.payload}));
    window.__ce.ws.tap('in',m=>{if(['wire.ready','wire.progress','wire.stopped','arm.request','arm.result'].includes(m.type))window.__musicIn.push(m);});
  });
  await quest.locator('#btn-enter').click(); await wait(()=>window.__ce.renderer.xr.isPresenting);

  phase='actual-menu-and-sound-lock';
  await hand('left',-.12);
  await wait(()=>{const p=window.__ce.hud.root.getObjectByName('wrist-palette');return p?.visible&&p.anchor.open;});
  await click('musical-synth');
  await mac.locator('#musical-launcher').waitFor({state:'visible'});
  const locked=await snapshot(); assert.equal(locked.enabled,false); assert.equal(locked.masterGain,0);
  assert.equal(await quest.evaluate(()=>window.__musicOut.some(m=>m.type==='wire.request')),false);
  assert.equal((await fixture.json('/api/agent/exec')).sent.length,0,'Opening must not play or verify while sound is locked');
  await shot('01-locked-mac',mac); await shot('01-locked-quest');
  assert.equal(await mac.locator('#musical-note').innerText(), 'Sound is off');

  phase='explicit-muted-unlock-and-setup';
  await mac.locator('#musical-sound-toggle').click();
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().enabled);
  assert.equal((await snapshot()).masterGain,0,'mute=1 must prevent audible output after explicit unlock');
  await fixture.until('musical setup and Enable', async () => {
    const t = await target();
    if(t.state==='failed') throw Error(`Musical setup failed: ${t.lastError || t.detail}`);
    return quest.evaluate(()=>!!window.__ce.pendingArm || window.__ce.armedCards.has('musical-synth-mac'));
  },120000);
  if(await quest.evaluate(()=>!!window.__ce.pendingArm)) {
    await frames(8); // Allow the state-driven coach's 100ms probe to reflect the confirmation.
    await shot('01b-enable-controls');
    await click('confirm-yes');
  }
  await wait(()=>window.__ce.canControl('musical-synth-mac'));
  await hand('left',-.7,0,false);
  assert.equal(await quest.evaluate(()=>window.__ce.wiring.running),false,'Setup alone must not install a hand interaction');
  evidence.setup=await target();

  phase='ask-muse-worker';
  await wait(()=>window.__ce.hud.root.userData.wire?.chips?.includes('Play like a theremin'));
  await click('wire-chip:Play like a theremin');
  await wait(()=>window.__ce.wiring.running,undefined,120000);
  evidence.ready=await quest.evaluate(()=>window.__musicIn.findLast(m=>m.type==='wire.ready').payload);
  assert.equal(evidence.ready.source,'fixture');
  assert(!evidence.ready.needs.includes('screen'),'Hand music must not require screen calibration');
  assert.match(evidence.ready.code,/out\.set/);
  await wait(()=>window.__ce.hud.root.getObjectByName('wire-code-card')?.state?.code.includes('mem.played = false'));
  await frames(6);
  await shot('02-generated-wiring');

  phase='tracked-hand-music';
  await hand('right',-.3,1);
  await mac.waitForFunction(()=>{
    const a=window.__ceMusicalSnapshot().analyser, hz=440*2**((a.currentNote-69)/12);
    return a.rms>.001 && Math.abs(a.frequency/hz-1)<.03;
  });
  const low=await snapshot();
  await hand('right',.05,1);
  await mac.waitForFunction(low=>{
    const a=window.__ceMusicalSnapshot().analyser, hz=440*2**((a.currentNote-69)/12);
    return a.frequency>low*1.12 && Math.abs(a.frequency/hz-1)<.03;
  },low.analyser.frequency);
  const high=await snapshot();
  assert(high.state.noteIndex>low.state.noteIndex,'Actual tracked hand height must change the scale note');
  assert.equal(high.masterGain,0); assert.equal(high.muted,true);
  await shot('03-analyser-performance',mac);
  await hand('right',.05,0);
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().state.gate===0);
  await hand('right',-.2,1);
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().analyser.rms>.001);
  await hand('right',-.2,0,false);
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().state.gate===0);
  evidence.performance={low,high,released:await snapshot()};

  phase='palms-stop-and-ask-again';
  const beforeStop=await target();
  await hand('left',-.12,0,true,true); await hand('right',-.12,0,true,true); await frames(20);
  await wait(()=>window.__ce.wiring.phase==='stopped'&&!window.__ce.wiring.running);
  await wait(()=>window.__musicIn.some(m=>m.type==='wire.stopped'&&m.payload.ok&&m.payload.releaseConfirmed));
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().state.gate===0);
  assert.equal((await snapshot()).enabled,true,'Stopping wiring preserves the explicit Mac sound permission');
  assert.equal((await target()).armed,true,'Palms Stop preserves the checked device');
  await shot('03b-stopped-ready-to-ask',mac);
  await hand('left',-.7,0,false); await hand('right',-.3,1);
  assert.equal((await snapshot()).state.gate,0,'Hand motion is inert again until the next ask');
  await click('wire-chip:Play like a theremin');
  await wait(()=>window.__ce.wiring.running,undefined,120000);
  const again=await quest.evaluate(()=>window.__musicIn.findLast(m=>m.type==='wire.ready').payload);
  assert.notEqual(again.wiringId,evidence.ready.wiringId); assert.notEqual(again.requestId,evidence.ready.requestId);
  const afterAsk=await target();
  assert.equal(afterAsk.driver.driverId,beforeStop.driver.driverId); assert.equal(afterAsk.runId,beforeStop.runId);
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().state.gate>=64);
  evidence.askAgain={stoppedWithoutDisarm:true,soundPermissionPreserved:true,noSetupAgain:true,newWiringId:again.wiringId};

  phase='read-full-request-in-ar';
  const longRequest=('Play like a theremin. '+Array.from({length:9},(_,i)=>`Part ${i+1}: let hand height choose notes and pinch play them. `).join('')).slice(0,465)+' Last words stay visible.';
  await quest.evaluate(text=>window.__ce.wiring.ask(text,'voice'),longRequest);
  await wait(()=>window.__ce.wiring.running,undefined,120000);
  const requestsBeforeRead=await quest.evaluate(()=>window.__musicOut.filter(m=>m.type==='wire.request').length);
  await click('wire-read-request');
  assert.equal(await quest.evaluate(()=>window.__ce.wiring.running),true,'Read request never interrupts active generation/play');
  assert.equal(await quest.evaluate(()=>window.__ce.hud.root.getObjectByName('wire-request-reader').visible),false);
  await hand('left',-.12,0,true,true); await hand('right',-.12,0,true,true); await frames(20);
  await wait(()=>window.__ce.wiring.phase==='stopped');
  await hand('left',-.7,0,false); await hand('right',-.7,0);
  await click('wire-read-request');
  const reading=()=>quest.evaluate(()=>window.__ce.hud.root.getObjectByName('wire-request-reader').userData.reading);
  await wait(()=>window.__ce.hud.root.getObjectByName('wire-request-reader').visible);
  const first=await reading(), pages=[first.text];
  await shot('03c-full-request-first');
  for(let i=1;i<first.pages;i++){
    await click('wire-request-next');
    await wait(i=>window.__ce.hud.root.getObjectByName('wire-request-reader').userData.reading.page===i,i);
    pages.push((await reading()).text);
  }
  assert.equal(pages.join(' ').replace(/\s+/g,' ').trim(),longRequest.replace(/\s+/g,' ').trim(),'Every accepted request word is readable across pages');
  await shot('03d-full-request-last');
  await click('wire-request-return');
  assert.equal(await quest.evaluate(()=>window.__ce.wiring.running),false,'Return never resumes or rewrites a stopped interaction');
  assert.equal(await quest.evaluate(()=>window.__musicOut.filter(m=>m.type==='wire.request').length),requestsBeforeRead,'Reading never asks Muse again');
  evidence.requestReader={simulatedTranscript:true,characters:longRequest.length,pages:first.pages,allWordsRetained:true,readOnly:true};

  phase='wrong-device-request-is-explicit';
  const callsBeforeWrongTarget=(await fixture.json('/api/muse/calls')).length;
  const readyBeforeWrongTarget=await quest.evaluate(()=>window.__musicIn.filter(m=>m.type==='wire.ready').length);
  await quest.evaluate(()=>window.__ce.wiring.ask('I have an OP-1 Field connected to this laptop. Create gesture controls for it.','voice'));
  await wait(()=>window.__ce.wiring.phase==='failed');
  const rejected=await quest.evaluate(()=>window.__musicIn.findLast(m=>m.type==='wire.progress'&&m.payload.phase==='failed').payload);
  assert.equal(rejected.model,'not-called');
  assert.match(rejected.note,/Select the OP-1 in Annotate/);
  assert.match(rejected.note,/Correct device/);
  assert.equal((await fixture.json('/api/muse/calls')).length,callsBeforeWrongTarget,'Wrong physical target must not invoke Muse or a visual fallback');
  assert.equal(await quest.evaluate(()=>window.__musicIn.filter(m=>m.type==='wire.ready').length),readyBeforeWrongTarget);
  assert.equal(await quest.evaluate(()=>window.__ce.wiring.running),false);
  assert.equal((await snapshot()).state.gate,0);
  assert.equal((await target()).armed,true,'Wrong-target guidance retains the checked software device without controlling it');
  await frames(6); await shot('03e-wrong-device-request');
  evidence.wrongTarget={simulatedTranscript:true,modelNotCalled:true,noFallback:true,noNewReady:true,physicalCommands:false};

  phase='stop-all-lock-and-no-replay';
  await quest.keyboard.press('x');
  await mac.waitForFunction(()=>!window.__ceMusicalSnapshot().enabled);
  assert.equal((await snapshot()).state.gate,0);
  assert.equal(await quest.evaluate(()=>window.__ce.wiring.running),false);
  assert.equal((await target()).armed,false);
  assert.deepEqual(errors,[]);
  await shot('04-stopped-mac',mac);
  await writeFile(join(OUT,'receipt.json'),JSON.stringify({status:'passed',fixture:true,physicalHeadset:false,audibleOutput:false,
    checks:['actual-wrist-menu','sound-locked-by-default','explicit-mac-unlock','muted-master','generated-worker-after-request','height-pitch','pinch-gate','tracking-loss-release','analyser-evidence','palms-stop-preserves-device','ask-again-without-setup','full-request-reader','wrong-device-guidance-without-generation','stop-all-and-relock'],...evidence},null,2));
  console.log('PASS musical synth: explicit muted unlock, generated Worker, tracked hands, pitch/gate, palms Stop/Ask again and Stop all');
} catch(e) {
  console.error(`FAIL ${phase}:`,e); process.exitCode=1;
  if(mac)await shot('FAIL-mac',mac).catch(()=>{}); if(quest)await shot('FAIL-quest').catch(()=>{});
  await writeFile(join(OUT,'failure.json'),JSON.stringify({phase,error:e.stack,errors,snapshot:mac?await snapshot().catch(()=>null):null,
    target:fixture?await target().catch(()=>null):null},null,2));
} finally {
  await browser?.close();
  if(fixture){await writeFile(join(OUT,'server.log'),fixture.log());await fixture.stop();}
}
