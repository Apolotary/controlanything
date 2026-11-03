import type { ProjectSpec } from '@ce/protocol';
import type { FixtureMuse } from '../muse/adapter';

export const PROJECT_FIXTURE: ProjectSpec = {
  title: 'FIXTURE · Gesture garden', description: 'A silent sample app. Move Amount or send a Quest hand input to change the orb. No live model was called.',
  html: '<main><p class="eyebrow">MUSE CANVAS · FIXTURE</p><h1>Gesture garden</h1><p>Your hands shape a living color field.</p><div id="orb"></div><label>Amount <input id="amount" type="range" min="0" max="1" step="0.01" value="0.5"></label><button id="shuffle">Shuffle colors</button><output id="value">0.50</output></main>',
  css: 'body{margin:0;background:#0c1724;color:#f4f9fc;font-family:system-ui}main{max-width:760px;margin:auto;padding:28px}.eyebrow{color:#80eec2;letter-spacing:.15em;font-size:12px}h1{font-size:40px;margin:12px 0}#orb{width:200px;height:200px;margin:24px auto;border-radius:50%;background:radial-gradient(circle at 30% 30%,#b0ffe9,#4c80ff 60%,#741eed);box-shadow:0 0 80px #697dff66;transition:transform .12s,filter .12s}label{display:flex;gap:20px;align-items:center}input{flex:1;accent-color:#80eec2}button{padding:12px 20px;margin:20px 20px 0 0;border:0;border-radius:24px;background:#80eec2;color:#0c1724;font-weight:700}output{font-variant-numeric:tabular-nums}',
  js: "const orb=document.getElementById('orb'), amount=document.getElementById('amount'), value=document.getElementById('value');amount.addEventListener('input',()=>museCanvas.emit('amount',Number(amount.value)));document.getElementById('shuffle').addEventListener('click',()=>museCanvas.emit('shuffle'));museCanvas.subscribe(s=>{amount.value=String(s.amount);value.textContent=Number(s.amount).toFixed(2);orb.style.transform='scale('+(0.5+s.amount)+')';orb.style.filter='hue-rotate('+((s.shuffle||0)*67)+'deg)';});",
  spatial: { kind: 'orb', color: '#80eec2', actionId: 'amount' },
  actions: [{ id: 'amount', label: 'Amount', kind: 'number', min: 0, max: 1, initial: 0.5 }, { id: 'shuffle', label: 'Shuffle colors', kind: 'trigger' }],
};
export function registerProjectFixture(muse: FixtureMuse): void { muse.register('canvas_project', PROJECT_FIXTURE); }
