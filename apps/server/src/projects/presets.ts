import type { ProjectSpec } from '@ce/protocol';

/** This authored starter only renders shared state. The trusted Mac host owns opt-in audio. */
export const CHORD_GARDEN_PRESET: ProjectSpec = {
  title: 'Chord Garden',
  description: 'A built-in hand-played chord demo inspired by chord instruments. Enable sound on the Mac, then pinch a chord pad in AR. This starter was authored in the project, not generated live by Muse.',
  html: `<main>
    <header><p class="eyebrow">MUSE · BUILT-IN DEMO</p><h1>Chord Garden</h1><p class="intro">A whole chord at your fingertips.</p></header>
    <section class="stage" aria-live="polite"><div class="bloom" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p id="chord-name">Ready to play</p><p id="chord-notes">Enable sound on your Mac. Point at a pad and pinch.</p></section>
    <nav class="pads" aria-label="Chord pads"><button data-chord="chord_c"><b>Cmaj7</b><span>C · E · G · B</span></button><button data-chord="chord_am"><b>Am7</b><span>A · C · E · G</span></button><button data-chord="chord_f"><b>Fmaj7</b><span>F · A · C · E</span></button><button data-chord="chord_g"><b>G7</b><span>G · B · D · F</span></button></nav>
    <footer><button id="silence">Stop sound</button><p>One pinch plays a short chord. Sound stays off until you enable it on the Mac.</p></footer>
  </main>`,
  css: `body{background:#101820;color:#edf8f3;font-family:system-ui,sans-serif}main{max-width:900px;margin:auto;padding:clamp(18px,4vw,40px)}header{text-align:center}.eyebrow{color:#a4d3bd;font-size:11px;letter-spacing:.18em}h1{font-size:clamp(30px,5vw,48px);letter-spacing:-.04em;margin:10px 0}.intro{color:#a7b9b1;margin:0}.stage{min-height:220px;padding:30px 12px 20px;text-align:center;position:relative}.bloom{position:relative;width:120px;height:92px;margin:auto}.bloom i{position:absolute;width:62px;height:62px;left:28px;top:15px;border:1px solid #9be4ba66;border-radius:50%;background:#76d49a12;transition:transform .2s,background .2s}.bloom i:nth-child(1){transform:translateX(-20px)}.bloom i:nth-child(2){transform:translateX(20px)}.bloom i:nth-child(3){transform:translateY(-18px)}.bloom i:nth-child(4){transform:translateY(18px)}.playing .bloom i{background:#a1e4bc44}.playing .bloom i:nth-child(1){transform:translateX(-30px)}.playing .bloom i:nth-child(2){transform:translateX(30px)}.playing .bloom i:nth-child(3){transform:translateY(-26px)}.playing .bloom i:nth-child(4){transform:translateY(26px)}#chord-name{font-size:28px;font-weight:650;margin:18px 0 6px}#chord-notes{color:#a7b9b1;margin:0}.pads{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}button{font:inherit;color:inherit;border:1px solid #627d6d;background:#21372d;border-radius:16px;cursor:pointer;padding:20px 12px;touch-action:manipulation}button:hover,button:focus-visible{background:#2e4c3c;outline:2px solid #a2dfbb;outline-offset:3px}.pads button.active{background:#a2dfbb;color:#17251d;box-shadow:0 0 32px #a2dfbb22}.pads b{display:block;font-size:24px}.pads span{display:block;font-size:12px;margin-top:10px;opacity:.8}footer{display:flex;align-items:center;gap:18px;margin-top:22px}footer button{flex:none;background:transparent;padding:12px 18px}footer p{font-size:13px;color:#a7b9b1;line-height:1.5}@media(max-width:560px){.pads{grid-template-columns:repeat(2,minmax(0,1fr))}.stage{min-height:200px}footer{align-items:flex-start}.pads button{padding:16px 8px}}@media(prefers-reduced-motion:reduce){.bloom i{transition:none}}`,
  js: `const chords={chord_c:['Cmaj7','C · E · G · B'],chord_am:['Am7','A · C · E · G'],chord_f:['Fmaj7','F · A · C · E'],chord_g:['G7','G · B · D · F']};
const main=document.querySelector('main'),title=document.getElementById('chord-name'),notes=document.getElementById('chord-notes');let previous,timer;
document.querySelectorAll('[data-chord]').forEach(button=>button.addEventListener('click',()=>museCanvas.emit(button.dataset.chord)));
document.getElementById('silence').addEventListener('click',()=>museCanvas.emit('silence'));
function clear(){clearTimeout(timer);main.classList.remove('playing');document.querySelectorAll('[data-chord]').forEach(button=>button.classList.remove('active'));}
museCanvas.subscribe(state=>{if(!previous){previous={...state};return;}const stopped=(state.silence||0)>(previous.silence||0);const changed=Object.keys(chords).filter(id=>(state[id]||0)>(previous[id]||0));previous={...state};if(stopped){clear();title.textContent='Stopped';notes.textContent='Choose another chord when you are ready.';return;}if(changed.length){const id=changed[changed.length-1];clear();title.textContent=chords[id][0];notes.textContent=chords[id][1];main.classList.add('playing');document.querySelector('[data-chord="'+id+'"]').classList.add('active');timer=setTimeout(clear,800);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});`,
  actions: [
    { id: 'chord_c', label: 'Cmaj7', kind: 'trigger' },
    { id: 'chord_am', label: 'Am7', kind: 'trigger' },
    { id: 'chord_f', label: 'Fmaj7', kind: 'trigger' },
    { id: 'chord_g', label: 'G7', kind: 'trigger' },
    { id: 'silence', label: 'Stop sound', kind: 'trigger' },
  ],
};
