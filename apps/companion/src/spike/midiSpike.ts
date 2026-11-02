/**
 * Morning spike G1(c): /companion/?spike=midi. Standalone: no server connection, no agent.
 *   1. MIDI access (with SysEx)  2. pick the OP-1 Field (or EP-133 / Move) port and chart
 *   3. identity request → reply bytes + verdict (EP-133 on the cable while expecting the OP-1 = "wrong device · refused")
 *   4. optional: listen to the synth's USB audio (or the mic)
 *   5. sweep the chart's safe CCs one by one with a prompt to listen; answer Y / N / S
 *   6. A-B-A-B audio check on one CC, plus the negative control on an unassigned CC
 * Everything is logged with timestamps; COPY and DOWNLOAD keep the run.
 */
import { AudioOracle } from '../audio/oracle';
import { ccEffect, type CcEffect, type Features, specDistance } from '../audio/features';
import { MidiBridge } from '../midi';
import { describeIdentity, describeMidi, toHex } from '../midiDecode';
import { MidiExecutor } from '../midiExec';
import { $, appendLine, button, el } from '../ui/dom';
import { type Chart, CHARTS, chartForPort, checkIdentity, type IdentityCheck, type SweepCc } from './charts';
import { SIM_PORT, SimSynth, SpikeIO } from './simSynth';

type Verdict = 'yes' | 'no' | 'skip' | 'auto-yes' | 'auto-no' | 'unknown';

interface SweepResult {
  cc: number;
  name: string;
  channel: number;
  sent: number;
  you?: Verdict;
  audio?: { changed: boolean; text: string };
}

interface LogEntry {
  t: number;
  at: string;
  kind: 'info' | 'warn' | 'error' | 'midi.out' | 'midi.in' | 'prompt' | 'answer' | 'audio' | 'verdict';
  text: string;
  port?: string;
  hex?: string;
}

const t0 = performance.now();
const realMidi = new MidiBridge();
/** real Web MIDI plus the optional built-in sim synth */
const midi = new SpikeIO(realMidi);
const exec = new MidiExecutor(midi, { identityTimeoutMs: 800 });
let sim: SimSynth | undefined;
const oracle = new AudioOracle();
const entries: LogEntry[] = [];
const results: SweepResult[] = [];
let portId = '';
let chart: Chart = CHARTS[0];
let chartPinned = false;
let channel = 1;
let identityResult: { check: IdentityCheck; hex?: string; describe?: string; port: string } | undefined;
let abab: { cc: number; r: CcEffect }[] = [];
let sweeping = false;
let stopRequested = false;
let answer: ((v: Verdict) => void) | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(kind: LogEntry['kind'], text: string, extra: { port?: string; bytes?: ArrayLike<number> } = {}): void {
  const e: LogEntry = { t: Math.round(performance.now() - t0), at: new Date().toISOString(), kind, text };
  if (extra.port) e.port = extra.port;
  if (extra.bytes) e.hex = toHex(extra.bytes);
  entries.push(e);
  const cls = kind === 'midi.out' ? 'out' : kind === 'midi.in' ? 'in' : kind === 'error' ? 'lvl-error' : kind === 'warn' ? 'lvl-warn' : kind === 'verdict' ? 'lvl-info' : '';
  const time = `+${(e.t / 1000).toFixed(3)}s`.padStart(10);
  appendLine($('spike-log'), `${time} ${kind.padEnd(8)} ${e.port ? `${e.port.slice(0, 14).padEnd(14)} ` : ''}${e.hex ? `${e.hex.padEnd(9)} ` : ''}${text}`, cls, 3000);
}

function portName(): string {
  return midi.outputs().find((o) => o.id === portId)?.name ?? '';
}

// --- layout ---------------------------------------------------------------------------------

function section(n: string, title: string, sub: string, ...body: Node[]): HTMLElement {
  return el('section', { className: 'panel step' }, el('div', { className: 'n', text: n }), el('div', { className: 'stack' }, el('h2', {}, title, el('small', { text: sub })), ...body));
}

function check(id: string, label: string, checked: boolean): HTMLElement {
  const input = el('input', { id });
  input.type = 'checkbox';
  input.checked = checked;
  return el('label', { className: 'small' }, input, ` ${label}`);
}

function build(): void {
  const root = $('spike');
  root.hidden = false;
  const panicBtn = button('Panic · all off', () => panic(), 'panic');
  root.append(
    el(
      'header',
      { className: 'topbar' },
      el('div', { className: 'wordmark' }, 'CONTROLEVERYTHING', el('span', { text: 'SPIKE · MIDI' })),
      el('div', { className: 'session', text: 'G1(c): the synth answers MIDI from this Mac' }),
      el('div', { className: 'grow' }),
      el('span', { className: 'pill' }, el('span', { className: 'dot on' }), 'standalone · no server needed'),
      panicBtn,
    ),
    el(
      'main',
      {},
      section(
        '1',
        'MIDI access',
        'Chrome asks once; allow SysEx for the identity check',
        el('div', { className: 'row' }, button('Enable MIDI + SysEx', () => void enable(), 'primary'), button('No hardware? Use the sim synth', () => void useSim()), el('span', { id: 'midi-status', className: 'small' })),
        el('div', { id: 'midi-ports', className: 'small dim' }),
      ),
      section(
        '2',
        'Target',
        'port, expected device (the camera’s guess) and channel',
        el(
          'div',
          { className: 'row' },
          el('label', { className: 'small', text: 'port' }),
          el('select', { id: 'port' }),
          el('label', { className: 'small', text: 'expected' }),
          el('select', { id: 'chart' }),
          el('label', { className: 'small', text: 'note channel' }),
          el('select', { id: 'channel' }),
          button('Note test', () => void noteTest()),
        ),
        el('ul', { id: 'setup', className: 'small dim' }),
      ),
      section('3', 'Identity', 'F0 7E 7F 06 01 F7 → what the device says it is', el('div', { className: 'row' }, button('Send identity request', () => void identify(), 'primary')), el('div', { id: 'id-hex', className: 'hex' }), el('div', { id: 'id-verdict', className: 'big-verdict' }), el('div', { id: 'id-detail', className: 'small dim' })),
      section(
        '4',
        'Listen',
        'optional: the synth’s own USB audio input (OP-1: USB MODE 2CH), or the Mac mic',
        el('div', { className: 'row' }, button('Listen', () => void listen(), 'primary'), el('select', { id: 'input' }), el('span', { className: 'meter' }, el('i', { data: { meter: '1' } })), el('span', { id: 'input-status', className: 'small dim' })),
      ),
      section(
        '5',
        'CC sweep',
        'one CC at a time, 0 → 127 → 64, with a held note; answer Y heard it · N nothing · S skip',
        el(
          'div',
          { className: 'row' },
          button('Start sweep', () => void sweep(), 'primary'),
          button('Stop', () => {
            stopRequested = true;
            answer?.('skip');
          }),
          check('hold', 'hold a note', true),
          check('auto', 'auto (judge by audio)', false),
          el('label', { className: 'small', text: 'msg/s' }),
          el('select', { id: 'rate' }),
        ),
        el('div', { id: 'prompt', className: 'prompt' }),
        el('div', { id: 'prompt-sub', className: 'small dim' }),
        el('div', { className: 'row' }, button('Heard it (Y)', () => answer?.('yes'), 'primary'), button('Nothing (N)', () => answer?.('no')), button('Skip (S)', () => answer?.('skip'), 'ghost')),
        el('table', { id: 'sweep-table', className: 'sweep' }),
        el('div', { id: 'skipped', className: 'tiny dim' }),
      ),
      section(
        '6',
        'A-B-A-B check',
        'research §5.3: CC low/high/low/high with a held note, measured by the oracle; the negative control must not change',
        el('div', { className: 'row' }, el('select', { id: 'abab-cc' }), button('Run check', () => void runAbab(false), 'primary'), button('Negative control', () => void runAbab(true))),
        el('div', { id: 'abab-out', className: 'stack mono small' }),
      ),
      el('section', { className: 'panel' }, el('div', { id: 'summary', className: 'big-verdict', text: 'G1(c): not run yet' }), el('div', { id: 'summary-sub', className: 'small dim' })),
      el('section', { className: 'panel' }, el('div', { className: 'row between' }, el('h2', { text: 'Log' }), el('div', { className: 'row' }, button('Copy', () => void copyLog()), button('Download JSON', () => download()))), el('pre', { id: 'spike-log', className: 'monitor' })),
    ),
  );

  for (const c of CHARTS) $('chart').append(Object.assign(el('option', { text: `${c.name} (${c.maker})` }), { value: c.id }));
  for (let i = 1; i <= 16; i++) $('channel').append(Object.assign(el('option', { text: String(i) }), { value: String(i) }));
  for (const r of [20, 40, 60]) $('rate').append(Object.assign(el('option', { text: String(r) }), { value: String(r), selected: r === 40 }));
  $('port').addEventListener('change', () => {
    portId = ($('port') as HTMLSelectElement).value;
    if (!chartPinned) setChart(chartForPort(portName()) ?? chart);
    log('info', `port: ${portName()}`);
  });
  $('chart').addEventListener('change', () => {
    chartPinned = true;
    setChart(CHARTS.find((c) => c.id === ($('chart') as HTMLSelectElement).value) ?? chart);
    log('info', `expected device: ${chart.name}`);
  });
  $('channel').addEventListener('change', () => (channel = Number(($('channel') as HTMLSelectElement).value)));
  $('input').addEventListener('change', () => void listen(($('input') as HTMLSelectElement).value));
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k === 'y') answer?.('yes');
    if (k === 'n') answer?.('no');
    if (k === 's') answer?.('skip');
    if (k === 'escape') {
      stopRequested = true;
      answer?.('skip');
    }
  });
  setChart(chart);
  renderTable();
  summary();
}

function setChart(c: Chart): void {
  chart = c;
  ($('chart') as HTMLSelectElement).value = c.id;
  channel = c.noteChannel;
  ($('channel') as HTMLSelectElement).value = String(channel);
  $('setup').replaceChildren(...c.setup.map((s) => el('li', { text: s })), el('li', { text: c.identity.note }));
  const sel = $('abab-cc') as HTMLSelectElement;
  sel.replaceChildren(...c.sweep.map((s) => Object.assign(el('option', { text: `CC ${s.cc} · ${s.name}` }), { value: String(s.cc) })));
  $('skipped').textContent = c.skipped.length ? `Never sent: ${c.skipped.map((s) => (s.cc ? `CC ${s.cc} (${s.why})` : s.why)).join(' · ')}` : '';
  if ($('sweep-table')) renderTable();
}

// --- MIDI -------------------------------------------------------------------------------------

function renderPorts(): void {
  const outs = midi.outputs();
  const ins = midi.inputs();
  $('midi-status').className = 'small';
  $('midi-status').textContent = midi.enabled ? `${realMidi.enabled ? `Web MIDI on${realMidi.sysex ? ' with SysEx' : ' WITHOUT SysEx (no identity check)'}` : 'Web MIDI off'}${sim ? ' · sim synth on' : ''} · ${outs.length} out · ${ins.length} in` : '';
  $('midi-ports').textContent = outs.length ? `outputs: ${outs.map((o) => `${o.name}${o.manufacturer ? ` (${o.manufacturer})` : ''}`).join(', ')}` : midi.enabled ? 'No MIDI outputs. Plug the synth in over USB-C (OP-1: no MTP/disk mode).' : '';
  const sel = $('port') as HTMLSelectElement;
  sel.replaceChildren(...outs.map((o) => Object.assign(el('option', { text: o.name ?? o.id }), { value: o.id })));
  if (!outs.some((o) => o.id === portId)) {
    // auto-pick: OP-1 Field, then EP-133, then the Move standalone port, then anything
    const pick = outs.find((o) => /op-1/i.test(o.name ?? '')) ?? outs.find((o) => /ep-133/i.test(o.name ?? '')) ?? outs.find((o) => /move.*standalone/i.test(o.name ?? '')) ?? outs[0];
    portId = pick?.id ?? '';
    if (pick) {
      log('info', `picked port "${pick.name}"${pick.manufacturer ? ` (${pick.manufacturer})` : ''}`);
      if (!chartPinned) setChart(chartForPort(pick.name ?? '') ?? chart);
    }
  }
  sel.value = portId;
}

async function enable(): Promise<void> {
  if (!MidiBridge.supported) {
    $('midi-status').textContent = 'Web MIDI is not available here. Use Chrome on http://localhost (or https).';
    log('error', 'no Web MIDI in this browser');
    return;
  }
  try {
    await realMidi.enable();
    log('info', `Web MIDI enabled${realMidi.sysex ? ' with SysEx' : ' without SysEx'}`);
  } catch (e) {
    const msg = (e as Error).message;
    log('error', msg);
    renderPorts();
    $('midi-status').textContent = `MIDI permission refused (${msg}). Allow MIDI for this site (lock icon › Site settings), reload, and press again.`;
    $('midi-status').className = 'small fail-text';
    return;
  }
  renderPorts();
}

/** The built-in Web Audio synth on a virtual port: the whole spike runs without hardware. */
async function useSim(): Promise<void> {
  if (!sim) {
    sim = new SimSynth();
    midi.attachSim(sim);
    log('info', 'sim synth on: a Web Audio synth with the OP-1 CC numbers (it answers identity as manufacturer 7D, never as TE)');
  }
  await sim.resume();
  portId = SIM_PORT.id;
  renderPorts();
  if (!chartPinned) setChart(chartForPort(SIM_PORT.name ?? '') ?? chart);
}

function needPort(): boolean {
  if (!midi.enabled) {
    log('warn', 'enable MIDI first (step 1)');
    return false;
  }
  if (!portId) {
    log('warn', 'no MIDI output: plug in the synth');
    return false;
  }
  return true;
}

async function noteTest(): Promise<void> {
  if (!needPort()) return;
  const notes = chart.id === 'op-1-field' ? [60, 64, 67] : [chart.holdNote, chart.holdNote + 2, chart.holdNote + 6];
  log('prompt', `note test on ch ${channel}: ${notes.join(', ')} (if silent: wrong channel, or NOTES filter off)`);
  for (const n of notes) {
    await exec.execute({ execId: `t${n}`, executorDeviceId: 'spike', port: portId, op: { kind: 'midi', msg: 'note', channel, number: n, velocity: 100, durationMs: 220 } });
    await sleep(260);
  }
}

async function identify(): Promise<void> {
  if (!needPort()) return;
  const port = portName();
  if (!chart.identity.sendRequest || /move/i.test(port)) {
    const check = checkIdentity(chart, port, undefined);
    identityResult = { check, port };
    log('warn', `not sending SysEx to ${port}: ${chart.identity.note}`);
    showIdentity();
    return;
  }
  if (portId !== SIM_PORT.id && !realMidi.sysex) {
    log('warn', 'SysEx was not granted: reload, enable MIDI and allow SysEx');
    return;
  }
  log('info', `identity request → ${port}`, { port, bytes: [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7] });
  const r = await exec.identify(portId, 800);
  if (r.bytes) log('midi.in', r.reply ? describeIdentity(r.reply) : 'identity-shaped reply', { port: r.inputName, bytes: r.bytes });
  else log('info', `no identity reply within 800 ms`);
  const check = checkIdentity(chart, port, r.reply);
  identityResult = { check, hex: r.hex, describe: r.reply ? describeIdentity(r.reply) : undefined, port };
  log('verdict', `IDENTITY ${check.verdict.toUpperCase()}: ${check.text}`);
  showIdentity();
  summary();
}

function showIdentity(): void {
  const r = identityResult;
  if (!r) return;
  $('id-hex').textContent = r.hex ? `← ${r.hex}` : '← (no reply)';
  const v = $('id-verdict');
  v.textContent = r.check.verdict === 'mismatch' ? 'wrong device · refused' : `identity ${r.check.verdict}`;
  v.className = `big-verdict ${r.check.verdict === 'mismatch' ? 'fail-text' : r.check.verdict === 'confirmed' ? 'ok-text' : 'accent-text'}`;
  $('id-detail').textContent = [r.describe, r.check.text].filter(Boolean).join(' · ');
}

function panic(): void {
  stopRequested = true;
  answer?.('skip');
  const n = exec.panic();
  log('warn', `PANIC: ${n} messages (note-offs, CC 64=0, CC 123, CC 120 on 16 channels)`);
}

// --- listening --------------------------------------------------------------------------------

async function listen(deviceId?: string): Promise<void> {
  if (portId === SIM_PORT.id && sim && !deviceId) await oracle.startFromNode(sim.ctx, sim.out, 'CE Sim Synth (direct)');
  else await oracle.start(deviceId);
  const st = $('input-status');
  if (oracle.state !== 'on') {
    st.textContent = oracle.error ?? 'could not listen';
    log('warn', `listen: ${oracle.error}`);
    return;
  }
  st.textContent = `${oracle.input?.synth ? 'synth USB audio' : 'microphone (thresholds are higher)'} · ${oracle.sampleRate} Hz`;
  log('audio', `listening to "${oracle.input?.label}" (${oracle.input?.synth ? 'synth USB audio' : 'microphone'})`);
  const sel = $('input') as HTMLSelectElement;
  const inputs = await AudioOracle.inputs();
  sel.replaceChildren(...inputs.map((i) => Object.assign(el('option', { text: `${i.label}${i.synth ? ' (synth)' : ''}` }), { value: i.deviceId, selected: i.deviceId === oracle.input?.deviceId })));
}

function meterLoop(): void {
  const m = document.querySelector<HTMLElement>('[data-meter]');
  if (m && oracle.state === 'on') m.style.width = `${Math.max(0, Math.min(100, ((oracle.levelDb() + 70) / 70) * 100))}%`;
  requestAnimationFrame(meterLoop);
}

/** Did the sound move during the sweep? Compare four sub-windows of it with each other and with before. */
function judgeSweep(before: Features, parts: Features[], mic: boolean): { changed: boolean; text: string } {
  const all = [before, ...parts];
  let maxDist = 0;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) maxDist = Math.max(maxDist, specDistance(all[i].spec, all[j].spec));
  const cents = all.map((f) => f.centroidHz).filter((x) => x > 0);
  const oct = cents.length > 1 ? Math.log2(Math.max(...cents) / Math.min(...cents)) : 0;
  const lv = all.map((f) => f.rmsDb);
  const range = Math.max(...lv) - Math.min(...lv);
  const audible = Math.max(...lv) > -60;
  const need = mic ? 4 : 3;
  const changed = audible && (maxDist >= need || oct >= 0.3 || range >= 4);
  return { changed, text: audible ? `spectra ${maxDist.toFixed(1)} dB apart · centroid span ${oct.toFixed(2)} oct · level span ${range.toFixed(1)} dB` : 'too quiet to judge (is the note sounding?)' };
}

// --- sweep --------------------------------------------------------------------------------------

function renderTable(current?: number): void {
  const t = $('sweep-table');
  t.replaceChildren(el('tr', {}, ...['CC', 'parameter', 'ch', 'sent', 'you', 'audio'].map((h) => el('th', { text: h }))));
  for (const s of chart.sweep) {
    const r = results.find((x) => x.cc === s.cc && x.channel === (s.channel ?? channel));
    const you = r?.you;
    const tr = el(
      'tr',
      { className: current === s.cc ? 'current' : '' },
      el('td', { text: String(s.cc) }),
      el('td', { text: s.name }),
      el('td', { text: String(s.channel ?? channel) }),
      el('td', { text: r ? String(r.sent) : '' }),
      el('td', { className: you === 'yes' || you === 'auto-yes' ? 'ok-text' : you === 'no' || you === 'auto-no' ? 'fail-text' : 'dim', text: you ? { yes: 'heard ✓', no: 'nothing ✗', skip: 'skipped', 'auto-yes': 'changed ✓', 'auto-no': 'no change ✗', unknown: '?' }[you] : '' }),
      el('td', { className: r?.audio ? (r.audio.changed ? 'ok-text' : 'dim') : 'dim', text: r?.audio?.text ?? '' }),
    );
    t.append(tr);
  }
}

async function sweepOne(s: SweepCc, rate: number, hold: boolean, auto: boolean): Promise<SweepResult> {
  const ch = s.channel ?? channel;
  const port = portName();
  const res: SweepResult = { cc: s.cc, name: s.name, channel: ch, sent: 0 };
  $('prompt').textContent = `Listen: CC ${s.cc} · ${s.name}`;
  $('prompt-sub').textContent = `${s.look ? `look at the ${s.look} · ` : ''}0 → 127 → 64 on channel ${ch}`;
  log('prompt', `listen: CC ${s.cc} ${s.name}${s.look ? ` (${s.look})` : ''}`);
  renderTable(s.cc);
  if (hold) await exec.holdNote(portId, chart.noteChannel, chart.holdNote, 100);
  await sleep(hold ? 350 : 50);
  const listening = oracle.state === 'on';
  const before = listening ? await oracle.measure(300, -300).catch(() => undefined) : undefined;
  const values: number[] = [];
  for (let v = 0; v <= 127; v += 4) values.push(v);
  values.push(127);
  for (let v = 120; v >= 64; v -= 8) values.push(v);
  const started = performance.now();
  for (const v of values) {
    if (stopRequested) break;
    await exec.cc(portId, ch, s.cc, v);
    res.sent++;
    await sleep(1000 / rate);
  }
  const ms = performance.now() - started;
  if (listening && before && ms > 400) {
    const q = ms / 4;
    const parts: Features[] = [];
    for (let i = 0; i < 4; i++) {
      const f = await oracle.measure(q, -(ms - i * q)).catch(() => undefined);
      if (f) parts.push(f);
    }
    if (parts.length >= 2) {
      res.audio = judgeSweep(before, parts, !oracle.input?.synth);
      log('audio', `CC ${s.cc}: ${res.audio.changed ? 'sound changed' : 'no change heard'} (${res.audio.text})`);
    }
  }
  if (hold) await exec.releaseNote(portId, chart.noteChannel, chart.holdNote);
  log('info', `CC ${s.cc}: sent ${res.sent} values in ${Math.round(ms)} ms to ${port}`);
  if (stopRequested) {
    res.you = 'skip';
    return res;
  }
  if (auto && res.audio) res.you = res.audio.changed ? 'auto-yes' : 'auto-no';
  else {
    $('prompt').textContent = `Did CC ${s.cc} change the sound or the screen? Y / N / S`;
    res.you = await new Promise<Verdict>((resolve) => {
      answer = (v) => {
        answer = undefined;
        resolve(v);
      };
    });
  }
  log('answer', `CC ${s.cc}: ${res.you}`);
  return res;
}

async function sweep(): Promise<void> {
  if (sweeping || !needPort()) return;
  if (!chart.sweep.length) {
    log('warn', `${chart.name} ignores incoming CCs: use the note test instead`);
    return;
  }
  sweeping = true;
  stopRequested = false;
  const rate = Number(($('rate') as HTMLSelectElement).value) || 40;
  const hold = ($('hold') as HTMLInputElement).checked;
  const auto = ($('auto') as HTMLInputElement).checked && oracle.state === 'on';
  log('info', `sweep start: ${chart.sweep.length} CCs on "${portName()}" at ${rate} msg/s${hold ? `, holding note ${chart.holdNote} on ch ${chart.noteChannel}` : ''}${auto ? ', judged by audio' : ''}`);
  for (const s of chart.sweep) {
    if (stopRequested) break;
    const r = await sweepOne(s, rate, hold, auto);
    const i = results.findIndex((x) => x.cc === r.cc && x.channel === r.channel);
    if (i >= 0) results[i] = r;
    else results.push(r);
    renderTable();
    summary();
  }
  $('prompt').textContent = stopRequested ? 'Stopped.' : 'Sweep done.';
  $('prompt-sub').textContent = '';
  log('info', stopRequested ? 'sweep stopped' : 'sweep done');
  sweeping = false;
  stopRequested = false;
  renderTable();
  summary();
}

// --- A-B-A-B ------------------------------------------------------------------------------------

async function runAbab(negative: boolean): Promise<void> {
  if (!needPort() || sweeping) return;
  if (oracle.state !== 'on') {
    log('warn', 'the A-B-A-B check needs LISTEN (step 4)');
    return;
  }
  const cc = negative ? chart.negativeCc : Number(($('abab-cc') as HTMLSelectElement).value);
  if (!Number.isFinite(cc)) return;
  sweeping = true;
  const ch = chart.sweep.find((s) => s.cc === cc)?.channel ?? channel;
  log('prompt', `A-B-A-B on CC ${cc}${negative ? ' (negative control: unassigned)' : ''}: 10 / 117 / 10 / 117`);
  try {
    const floor = await oracle.measure(300, -300);
    await exec.holdNote(portId, chart.noteChannel, chart.holdNote, 100);
    await sleep(300);
    const states: Features[] = [];
    for (const v of [10, 117, 10, 117]) {
      await exec.cc(portId, ch, cc, v);
      await sleep(350);
      states.push(await oracle.measure(600));
    }
    await exec.releaseNote(portId, chart.noteChannel, chart.holdNote);
    const r = ccEffect([states[0], states[1], states[2], states[3]], floor.rmsDb, !oracle.input?.synth);
    abab = abab.filter((x) => x.cc !== cc).concat({ cc, r });
    const good = negative ? !r.pass : r.pass;
    log('verdict', `CC ${cc}${negative ? ' (negative control)' : ''}: ${r.reason} → ${negative ? (r.pass ? 'control FAILED (something changed)' : 'no change ✓') : r.pass ? 'changed ✓' : 'no change ✗'} [cross ${r.cross} dB, same ${r.same} dB, ${r.oct} oct, ${r.lvl} dB, audible ${r.audible}]`);
    const out = $('abab-out');
    out.replaceChildren(
      ...abab.map((x) => {
        const neg = x.cc === chart.negativeCc;
        const ok = neg ? !x.r.pass : x.r.pass;
        return el('div', { className: ok ? 'ok-text' : 'fail-text', text: `CC ${x.cc}${neg ? ' (negative control)' : ''}: ${neg ? (x.r.pass ? 'changed — the control failed ✗' : 'no change ✓') : x.r.pass ? `${x.r.reason} ✓` : `${x.r.reason} ✗`}` });
      }),
    );
    void good;
  } catch (e) {
    log('error', `A-B-A-B failed: ${(e as Error).message}`);
    await exec.releaseNote(portId, chart.noteChannel, chart.holdNote).catch(() => {});
  } finally {
    sweeping = false;
    summary();
  }
}

// --- summary and log --------------------------------------------------------------------------

function summary(): void {
  const heard = results.filter((r) => r.you === 'yes' || r.you === 'auto-yes');
  const asked = results.filter((r) => r.you && r.you !== 'skip');
  const ababPass = abab.find((x) => x.cc !== chart.negativeCc && x.r.pass);
  const negOk = abab.find((x) => x.cc === chart.negativeCc && !x.r.pass);
  const pass = heard.length > 0 || Boolean(ababPass);
  const s = $('summary');
  if (!asked.length && !abab.length) {
    s.textContent = 'G1(c): not run yet';
    s.className = 'big-verdict dim';
  } else {
    s.textContent = pass ? `G1(c) PASS · ${chart.name} answered MIDI from this Mac` : 'G1(c) FAIL · no CC change heard yet';
    s.className = `big-verdict ${pass ? 'ok-text' : 'fail-text'}`;
  }
  const lines = [
    asked.length ? `CCs heard: ${heard.map((r) => r.cc).join(', ') || 'none'} (${heard.length} of ${asked.length} answered)` : '',
    ababPass ? `A-B-A-B: CC ${ababPass.cc} ${ababPass.r.reason}` : '',
    negOk ? `negative control CC ${chart.negativeCc}: no change ✓` : '',
    identityResult ? `identity: ${identityResult.check.verdict} (${identityResult.check.text})` : '',
    !pass && asked.length ? 'If nothing is heard: firmware ≥ 1.7.0? SYSTEM › MIDI channel and OTHER = in? A note sounding (note test)? Try another engine page.' : '',
  ].filter(Boolean);
  $('summary-sub').textContent = lines.join(' · ');
}

function report() {
  return {
    spike: 'midi',
    gate: 'G1(c)',
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    port: portName(),
    outputs: midi.outputs().map((o) => ({ name: o.name, manufacturer: o.manufacturer })),
    inputs: midi.inputs().map((o) => ({ name: o.name, manufacturer: o.manufacturer })),
    sysex: midi.sysex,
    expected: chart.name,
    channel,
    identity: identityResult ? { verdict: identityResult.check.verdict, text: identityResult.check.text, reply: identityResult.hex ?? null } : null,
    audioInput: oracle.input?.label ?? null,
    sweep: results,
    abab: abab.map((x) => ({ cc: x.cc, negativeControl: x.cc === chart.negativeCc, ...x.r })),
    summary: $('summary').textContent,
    log: entries,
  };
}

async function copyLog(): Promise<void> {
  const text = JSON.stringify(report(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    log('info', `copied the run (${entries.length} log lines) to the clipboard`);
  } catch {
    log('warn', 'clipboard refused; use Download JSON');
  }
}

function download(): void {
  const blob = new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spike-midi-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function bootSpike(): Promise<void> {
  document.title = 'MIDI spike · ControlEverything';
  build();
  log('info', 'MIDI spike ready (standalone). Step 1: enable MIDI.');
  realMidi.onChange = () => renderPorts();
  midi.addListener((m) => {
    if (m.data.length === 1 && (m.data[0] === 0xf8 || m.data[0] === 0xfe)) return;
    log('midi.in', describeMidi(m.data), { port: m.portName, bytes: m.data });
  });
  exec.onTape = (e) => {
    if (e.dir === 'out') log('midi.out', describeMidi(e.bytes), { port: e.port, bytes: e.bytes });
  };
  requestAnimationFrame(meterLoop);
  if (!MidiBridge.supported) {
    $('midi-status').textContent = 'Web MIDI is not available in this browser. Use Chrome on http://localhost.';
    log('error', 'no Web MIDI here');
  } else if (await MidiBridge.alreadyGranted()) await enable();
  if (new URLSearchParams(location.search).get('sim') === '1') log('info', 'press "Use the sim synth" (a click is needed before audio can start)');
  if (!AudioOracle.supported) $('input-status').textContent = 'no microphone API here';
}
