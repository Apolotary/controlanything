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
async function hand(side, height, pinch=0, connected=true) {
  await quest.evaluate(async ({side,height,pinch,connected}) => {
    const a=window.__ce, remote=a.emulator.device.remote, device=`hand-${side}`;
    a.input.mouseAsHand=false; a.input.pointer.inside=a.input.pointer.down=a.input.pointer.latched=false;
    await remote.dispatch('set_input_mode',{mode:'hand'});
    await remote.dispatch('set_connected',{device,connected});
    if(!connected) return;
    const head=a.emulator.head(), xyz=v=>({x:v.x,y:v.y,z:v.z});
    const p=head.position.clone().add(head.position.clone().set(side==='left'?-.18:.25,height,-.4).applyQuaternion(head.quaternion));
    const palm=head.position.clone().sub(p).normalize(), fingers=head.position.clone().set(0,1,0).applyQuaternion(head.quaternion);
    fingers.addScaledVector(palm,-fingers.dot(palm)).normalize();
    await remote.dispatch('set_hand_pose',{device,poseId:side==='left'?'open':'default'});
    await remote.dispatch('set_transform',{device,anchor:'wrist',position:xyz(p),orientation:{fingers:xyz(fingers),palm:xyz(palm)}});
    await remote.dispatch('set_select_value',{device,value:pinch});
  },{side,height,pinch,connected});
  await frames(6);
}
const shot = (name,page=quest) => page.screenshot({path:join(OUT,`${name}.png`)});
const snapshot = () => mac.evaluate(() => window.__ceMusicalSnapshot());
const target = () => fixture.json('/api/agent/targets/musical-synth-mac');
try {
  await mkdir(OUT,{recursive:true});
  fixture=await startFixtureServer(Number(process.env.PORT||8795),'musical-e2e');
  const identity=await pairMac(fixture,'Muted musical test Mac');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  const mc=await browser.newContext({viewport:{width:1440,height:1000}});
  await mc.addInitScript(id=>localStorage.setItem('ce.device',JSON.stringify(id)),identity);
  mac=await mc.newPage(); mac.on('pageerror',e=>errors.push(`Mac: ${e.message}`));
  await mac.goto(`${fixture.base}/companion/?mute=1`);
  const qc=await browser.newContext({viewport:{width:1440,height:1000}});
  quest=await qc.newPage(); quest.on('pageerror',e=>errors.push(`Quest: ${e.message}`));
  await quest.goto(`${fixture.base}/quest/?emulate=1&camera=photo&mute=1&mic=0&tutorial=0`);
  await wait(()=>window.__ce?.welcome && window.__ce.ws.open);
  await quest.evaluate(()=>{
    window.__musicOut=[]; window.__musicIn=[];
    window.__ce.ws.tap('out',m=>window.__musicOut.push({type:m.type,payload:m.payload}));
    window.__ce.ws.tap('in',m=>{if(['wire.ready','wire.progress','arm.request','arm.result'].includes(m.type))window.__musicIn.push(m);});
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

  phase='explicit-muted-unlock-and-setup';
  await mac.locator('#musical-sound-toggle').click();
  await mac.waitForFunction(()=>window.__ceMusicalSnapshot().enabled);
  assert.equal((await snapshot()).masterGain,0,'mute=1 must prevent audible output after explicit unlock');
  await fixture.until('musical setup and Enable', async () => {
    const t = await target();
    if(t.state==='failed') throw Error(`Musical setup failed: ${t.lastError || t.detail}`);
    return quest.evaluate(()=>!!window.__ce.pendingArm || window.__ce.armedCards.has('musical-synth-mac'));
  },120000);
  if(await quest.evaluate(()=>!!window.__ce.pendingArm)) await click('confirm-yes');
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

  phase='stop-lock-and-no-replay';
  await quest.keyboard.press('x');
  await mac.waitForFunction(()=>!window.__ceMusicalSnapshot().enabled);
  assert.equal((await snapshot()).state.gate,0);
  assert.equal(await quest.evaluate(()=>window.__ce.wiring.running),false);
  assert.equal((await target()).armed,false);
  assert.deepEqual(errors,[]);
  await shot('04-stopped-mac',mac);
  await writeFile(join(OUT,'receipt.json'),JSON.stringify({status:'passed',fixture:true,physicalHeadset:false,audibleOutput:false,
    checks:['actual-wrist-menu','sound-locked-by-default','explicit-mac-unlock','muted-master','generated-worker-after-request','height-pitch','pinch-gate','tracking-loss-release','analyser-evidence','full-stop-and-relock'],...evidence},null,2));
  console.log('PASS musical synth: explicit muted unlock, generated Worker, actual tracked hands, analyser pitch/gate and full Stop');
} catch(e) {
  console.error(`FAIL ${phase}:`,e); process.exitCode=1;
  if(mac)await shot('FAIL-mac',mac).catch(()=>{}); if(quest)await shot('FAIL-quest').catch(()=>{});
  await writeFile(join(OUT,'failure.json'),JSON.stringify({phase,error:e.stack,errors,snapshot:mac?await snapshot().catch(()=>null):null,
    target:fixture?await target().catch(()=>null):null},null,2));
} finally {
  await browser?.close();
  if(fixture){await writeFile(join(OUT,'server.log'),fixture.log());await fixture.stop();}
}
