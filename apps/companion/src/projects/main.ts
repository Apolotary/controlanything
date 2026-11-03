import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './style.css';
import { Connection, CLOSE_UNAUTHORIZED } from '../connection';
import { canvasIdentity, isHeadsetCanvas, prefilledPrompt, questReturnUrl } from './navigation';
import { ProjectStudio } from './model';
import { ProjectRuntime, type RuntimeIdentity } from './runtime';
import { ProjectPreviewPresence } from './presence';
import { ChordSynth } from './chord-synth';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const prompt = $<HTMLTextAreaElement>('project-prompt');
const select = $<HTMLSelectElement>('project-select');
const headset = isHeadsetCanvas(location.search, navigator.userAgent);
const selectionKey = headset ? 'ce.project.selected.quest' : 'ce.project.selected';
const identity = (() => { try { return canvasIdentity(localStorage, headset); } catch { return undefined; } })();
let previewExpanded = false;
let connection: Connection | undefined;
let controlsKey = '', catalogKey = '', sourceTab: 'html' | 'css' | 'js' = 'html';
let message = '';
let previewIdentity: RuntimeIdentity | undefined;
let soundPending = false;
let soundGeneration = 0;
let soundMessage = '';
const chordSynth = new ChordSynth(undefined, chord => {
  if (chord) soundMessage = `${chord.label} · ${chord.noteLabels.join(' · ')}`;
  else if (chordSynth.enabled) soundMessage = 'Sound enabled · point at a chord and pinch once in AR';
  renderAudio();
}, () => {
  disableSound(); soundMessage = 'Audio was interrupted. Click Enable sound, then enable pads in Quest again.';
  syncPreviewPresence(); renderAudio(); renderControls();
});
const controls = new Map<string, { input?: HTMLInputElement; output?: HTMLOutputElement; button?: HTMLButtonElement }>();
const studio = new ProjectStudio((type, payload) => connection?.send(type, payload, { to: 'server' }) ?? false, render);
const previewPresence = new ProjectPreviewPresence(payload => connection?.send('project.preview', payload, { to: 'server' }) ?? false);
const runtime = new ProjectRuntime($('preview-frame-host'), action => {
  if (!isChordDemo() || chordPreviewReady() && chordSynth.enabled) studio.action(action.actionId, action.value);
}, (text, error) => {
  $('runtime-status').textContent = text; $('runtime-status').classList.toggle('error', !!error); renderControls(); renderButtons();
}, preview => {
  previewIdentity = preview;
  if (preview) { chordSynth.bind(studio.current?.values ?? {}); syncPreviewPresence(); }
  else { disableSound(); previewPresence.stop(); }
  renderAudio();
});

function isChordDemo(): boolean { return studio.document?.source === 'preset' && studio.document.presetId === 'chord-garden-v1'; }
function chordPreviewReady(): boolean {
  return isChordDemo() && runtime.ready && studio.online && studio.writable && !studio.pending && studio.current?.status === 'ready'
    && runtime.projectId === studio.document?.projectId && runtime.revision === studio.document?.revision && !document.hidden;
}
function syncPreviewPresence(): void {
  if (previewIdentity && (!isChordDemo() || chordPreviewReady() && chordSynth.enabled)) previewPresence.start(previewIdentity);
  else previewPresence.stop();
}
function disableSound(): void {
  soundGeneration++; soundPending = false; chordSynth.disable(); soundMessage = '';
}
function renderAudio(): void {
  const chord = isChordDemo();
  $('chord-audio').hidden = !chord;
  if (!chord) return;
  const ready = chordPreviewReady();
  const enable = $<HTMLButtonElement>('chord-audio-enable');
  enable.disabled = !ready || soundPending;
  enable.hidden = chordSynth.enabled;
  enable.textContent = soundPending ? 'Enabling sound…' : 'Enable sound';
  $('chord-audio-mute').hidden = !chordSynth.enabled;
  $('chord-audio-status').textContent = soundMessage || (ready ? 'Enable sound on this page. Then in Quest: Muse Canvas → Chord Garden → Enable pads.' : 'Run the preview, then enable sound here. Keep this page visible for AR play.');
}

function savedSelection(): string | undefined {
  const query = new URLSearchParams(location.search).get('project');
  if (query) return query;
  try { return localStorage.getItem(selectionKey) || undefined; } catch { return undefined; }
}
function stop(reason = 'Preview stopped · choose Run preview to resume'): void {
  disableSound(); runtime.stop(); previewIdentity = undefined; previewPresence.stop(); setExpanded(false); $('runtime-status').textContent = reason; $('runtime-status').classList.remove('error'); renderControls(); renderButtons(); renderAudio();
}
function saveSelection(): void {
  try { if (studio.selectedId) localStorage.setItem(selectionKey, studio.selectedId); else localStorage.removeItem(selectionKey); } catch { /* Browser storage is optional. */ }
  const url = new URL(location.href); if (studio.selectedId) url.searchParams.set('project', studio.selectedId); else url.searchParams.delete('project');
  history.replaceState(null, '', url);
  if (headset) $<HTMLAnchorElement>('studio-back').href = questReturnUrl(studio.selectedId);
}
function renderButtons(): void {
  if (!runtime.running && previewExpanded) setExpanded(false);
  const busy = !!studio.pending || studio.current?.status === 'generating';
  $<HTMLButtonElement>('project-chord-demo').disabled = !studio.writable || busy;
  $<HTMLButtonElement>('project-generate').disabled = !studio.writable || busy || !prompt.value.trim() || isChordDemo();
  $('project-generate').textContent = studio.pending?.preset ? 'Opening chord demo…' : busy ? 'Muse is writing…' : isChordDemo() ? 'Built-in instrument · choose New to create' : studio.document ? 'Update with Muse ↗' : 'Generate with Muse ↗';
  prompt.disabled = isChordDemo();
  $('project-cancel').hidden = !studio.pending;
  $<HTMLButtonElement>('project-run').disabled = !studio.document || !studio.online || busy || runtime.running;
  $<HTMLButtonElement>('project-stop').disabled = !runtime.running;
  $<HTMLButtonElement>('project-expand').disabled = !runtime.running;
  $<HTMLButtonElement>('show-code').disabled = !studio.document;
  $('preview-empty').hidden = runtime.running;
}
function renderControls(): void {
  const document = studio.document;
  const key = document ? `${document.projectId}:${document.revision}` : '';
  $('shared-controls').hidden = !document?.spec.actions.length;
  if (key !== controlsKey) {
    controlsKey = key; controls.clear(); $('project-controls').replaceChildren();
    for (const action of document?.spec.actions ?? []) {
      const row = window.document.createElement('div'); row.className = 'action-control'; row.dataset.action = action.id;
      if (action.kind === 'number') {
        const label = window.document.createElement('label'); label.className = 'action-label'; label.htmlFor = `project-input-${action.id}`;
        const title = window.document.createElement('span'); title.textContent = action.label;
        const output = window.document.createElement('output'); output.dataset.value = action.id;
        label.append(title, output);
        const input = window.document.createElement('input'); input.type = 'range'; input.id = label.htmlFor; input.dataset.action = action.id;
        input.min = String(action.min); input.max = String(action.max); input.step = String((action.max! - action.min!) / 200);
        input.oninput = () => { if (runtime.ready) studio.action(action.id, Number(input.value)); };
        row.append(label, input); controls.set(action.id, { input, output });
      } else {
        const button = window.document.createElement('button'); button.type = 'button'; button.textContent = action.label; button.dataset.action = action.id;
        button.onclick = () => { if (runtime.ready) studio.action(action.id); }; row.append(button); controls.set(action.id, { button });
      }
      $('project-controls').append(row);
    }
  }
  for (const action of document?.spec.actions ?? []) {
    const control = controls.get(action.id); if (!control) continue;
    const value = studio.current?.values?.[action.id] ?? action.initial ?? 0;
    const playable = runtime.ready && studio.writable && (!isChordDemo() || chordPreviewReady() && chordSynth.enabled);
    if (control.input) { if (window.document.activeElement !== control.input) control.input.value = String(value); control.input.disabled = !playable; }
    if (control.output) control.output.value = Number(value.toFixed(3)).toString();
    if (control.button) control.button.disabled = !playable;
  }
}
function render(): void {
  const document = studio.document;
  if (runtime.running && (!studio.online || !document || runtime.projectId !== document.projectId || runtime.revision !== document.revision || studio.pending || studio.current?.status === 'generating')) {
    stop(studio.online ? 'Preview stopped · review this revision and choose Run preview' : 'Connection lost · preview stopped');
  }
  if (runtime.running) runtime.update(studio.current?.values ?? {});
  if (isChordDemo() && (chordSynth.enabled || soundPending) && !chordPreviewReady()) {
    disableSound(); soundMessage = 'Sound paused while this project is unavailable. Restore the connection, then enable sound again.'; syncPreviewPresence();
  }
  if (isChordDemo() && chordPreviewReady()) {
    if ((studio.current?.preview?.count ?? 0) > 1 && chordSynth.enabled) {
      disableSound(); soundMessage = 'Another Chord Garden preview is open. Stop extra previews, then enable sound again.'; syncPreviewPresence();
    }
    try { chordSynth.consume(studio.current?.values ?? {}); }
    catch { disableSound(); soundMessage = 'Sound stopped unexpectedly. Click Enable sound to try again.'; syncPreviewPresence(); }
  }
  const nextCatalogKey = JSON.stringify(studio.catalog);
  if (nextCatalogKey !== catalogKey) {
    catalogKey = nextCatalogKey;
    select.replaceChildren(new Option('New project', ''), ...studio.catalog.map(project => new Option(project.title, project.projectId)));
  }
  if (studio.selectedId && ![...select.options].some(option => option.value === studio.selectedId)) select.add(new Option(document?.spec.title ?? 'Creating project…', studio.selectedId));
  select.value = studio.selectedId ?? '';
  $('preview-title').textContent = document?.spec.title ?? 'Your next idea';
  $('project-provenance').textContent = document ? `${document.source === 'preset' ? 'Built-in demo · Orchid-inspired chord pads' : document.source === 'fixture' ? 'Fixture · sample output' : 'Live · Muse generated'}${document.modelId ? ` · ${document.modelId}` : ''} · Revision ${document.revision}` : 'A saved project will appear here';
  $('project-status').textContent = studio.pending?.preset ? 'Opening the built-in chord demo. No generation needed.' : studio.pending ? 'Muse is writing the page and its shared controls. Your previous saved version stays intact.'
    : message || studio.current?.message || (document ? 'Saved. Review the code or choose Run preview.' : studio.online ? 'Describe a webpage to begin. Generate first, then choose Run preview.' : identity ? 'Connecting to Muse…' : headset ? 'Return to AR and connect this headset, then open Canvas again.' : 'Pair this browser in the companion to begin.');
  if (isChordDemo() && !studio.pending && !message && studio.current?.status !== 'error') $('project-status').textContent = 'Four built-in chords, played with your hands. Run preview → Enable sound here → Enable pads in Quest. Choose New to create a different webpage with Muse.';
  $('project-status').classList.toggle('error', studio.current?.status === 'error');
  if (document) $('project-source').textContent = document.spec[sourceTab];
  renderControls(); renderButtons(); renderAudio(); saveSelection();
}

function setExpanded(expanded: boolean): void {
  previewExpanded = expanded; document.body.classList.toggle('preview-focused', expanded);
  $('project-expand').textContent = expanded ? 'Show editor' : 'Expand webpage';
  $('project-expand').setAttribute('aria-expanded', String(expanded));
}

prompt.value = prefilledPrompt(location.search);
prompt.addEventListener('input', renderButtons);
$('project-expand').onclick = () => setExpanded(!previewExpanded);
$('studio-back').addEventListener('click', () => { studio.cancel(); stop(headset ? 'Returning to AR · preview stopped' : 'Returning to companion · preview stopped'); });
select.onchange = () => { stop(); message = ''; studio.select(select.value || undefined); };
$('project-new').onclick = () => { stop(); message = ''; studio.select(undefined); prompt.value = ''; $('code-details').hidden = true; prompt.focus(); renderButtons(); };
$('project-generate').onclick = () => { message = ''; studio.request(prompt.value); };
$('project-chord-demo').onclick = () => {
  if (!studio.writable || studio.pending) return;
  stop(); message = '';
  if (!studio.createChordDemo()) { message = 'Could not open the chord demo. Reconnect and try again.'; render(); }
};
$('project-cancel').onclick = () => { studio.cancel(); message = 'Generation cancelled. Your saved project is unchanged.'; render(); };
$('project-run').onclick = () => {
  if (!studio.document || !studio.online || studio.pending || window.document.hidden) return;
  runtime.start(studio.document, studio.current?.values ?? {}); $('runtime-status').textContent = 'Starting preview…'; render();
};
$('project-stop').onclick = () => stop();
$('chord-audio-enable').onclick = async () => {
  if (!chordPreviewReady() || soundPending) return;
  chordSynth.bind(studio.current?.values ?? {});
  const generation = ++soundGeneration;
  const selected = studio.document!;
  soundPending = true; soundMessage = ''; renderAudio();
  try {
    await chordSynth.enable();
    if (generation !== soundGeneration) return;
    if (!chordPreviewReady() || studio.document?.projectId !== selected.projectId || studio.document?.revision !== selected.revision) { disableSound(); return; }
    soundMessage = chordSynth.enabled ? 'Sound enabled · in Quest open Muse Canvas, select Chord Garden, then Enable pads' : 'Sound could not start. Click Enable sound to try again.';
  } catch {
    if (generation === soundGeneration) soundMessage = 'The browser could not enable sound. Click Enable sound to try again.';
  } finally {
    if (generation === soundGeneration) { soundPending = false; syncPreviewPresence(); renderAudio(); renderControls(); }
  }
};
$('chord-audio-mute').onclick = () => { disableSound(); syncPreviewPresence(); renderAudio(); renderControls(); };
$('show-code').onclick = () => { const details = $<HTMLDetailsElement>('code-details'); details.hidden = !details.hidden; details.open = !details.hidden; };
document.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => { button.onclick = () => { prompt.value = button.dataset.prompt!; prompt.focus(); renderButtons(); }; });
document.querySelectorAll<HTMLButtonElement>('[data-code]').forEach(button => { button.onclick = () => { sourceTab = button.dataset.code as 'html' | 'css' | 'js'; render(); }; });
document.addEventListener('visibilitychange', () => { if (document.hidden) stop('Preview paused while hidden · choose Run preview to resume'); });
window.addEventListener('pagehide', () => { studio.cancel(); chordSynth.dispose(); runtime.dispose(); connection?.stop(); }, { once: true });

if (headset) {
  document.body.classList.add('headset-studio');
  $('studio-back').textContent = '← Return to AR';
  $<HTMLAnchorElement>('studio-back').href = questReturnUrl();
  $('studio-intro').textContent = 'Build and use a full webpage here in your headset. Describe your idea, generate it, then run the preview.';
  $('guide-title').textContent = 'You are in the headset browser';
  $('guide-copy').textContent = 'Use the browser pointer and pinch or controller to click the page and its sliders. AR hand-position gestures pause outside AR. Return to AR keeps your saved page and controls.';
  $('pairing-needed').replaceChildren(Object.assign(document.createElement('a'), { href: '/quest/', textContent: 'Return to AR to connect this headset, then open Muse Canvas again.' }));
  $('empty-steps').textContent = 'Describe → Generate → Run here';
  $('shared-controls-hint').textContent = 'Point and pinch · shared page state';
}
studio.selectedId = savedSelection();
if (!identity) {
  $('pairing-needed').hidden = false; $('connection-status').textContent = 'Pairing needed'; render();
} else {
  connection = new Connection(Connection.sameOrigin(), () => ({ deviceToken: identity.deviceToken, app: 'muse-canvas', executor: false }));
  connection.onState = (state, info) => {
    if (state !== 'open') {
      studio.connection(false, false); $('connection-status').textContent = state === 'connecting' ? 'Connecting' : 'Disconnected'; $('connection-status').classList.remove('online');
      if (info?.code === CLOSE_UNAUTHORIZED) { $('pairing-needed').hidden = false; message = headset ? 'This headset is no longer connected. Return to AR to reconnect.' : 'This browser is no longer paired. Open the companion to reconnect.'; render(); }
    }
  };
  connection.on('welcome', event => {
    if (event.from !== 'server') return;
    studio.connection(true, event.payload.canApprove); $('connection-status').textContent = 'Connected'; $('connection-status').classList.add('online');
    if (!event.payload.canApprove) { message = 'This browser can view saved pages. Connect as an owner to create or edit webpages.'; render(); }
  });
  connection.on('project.catalog', event => { if (event.from === 'server') studio.receiveCatalog(event.payload); });
  connection.on('project.state', event => { if (event.from === 'server') { message = ''; studio.receive(event.payload); } });
  connection.on('log', event => { if (event.from === 'server' && event.payload.level === 'error' && event.payload.ref) { message = event.payload.message; render(); } });
  connection.start(); render();
}

// Read-only development evidence: callers cannot gain an additional device capability here.
Object.assign(window, { __museCanvas: { studio, runtime, chordSynth } });
