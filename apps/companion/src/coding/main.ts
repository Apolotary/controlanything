import './style.css';
import { loadIdentity } from '../identity';

interface CodingStatus { installed?: boolean; available?: boolean; requestedModel?: string; version?: string; reason?: string; message?: string }
interface CodingJob {
  jobId: string; state: string; requestedModel?: string; observedModels?: string[];
  createdAt: number; startedAt?: number; finishedAt?: number; workspace?: string; branch?: string;
  changedFiles?: string[]; exitCode?: number | null; reason?: string; logsTruncated?: boolean;
  lastEvent?: string; terminalReported?: string; operationsObserved?: string[]; modelSummary?: string;
}
interface CodingOverview { status: CodingStatus; jobs: CodingJob[] }
interface ConnectorOverview {
  generator: { available: boolean; active: boolean; model: string };
  connectors: { cardId: string; connectorId: string; model: string; source: string; hash: string; gestureHash: string;
    invocationCount: number; currentlyAuthorized: boolean; lastBytes?: number[]; lastPortId?: string; lastEncodedAt?: number }[];
}
const API = '/api/agent/coding';
const terminal = new Set(['completed_unverified', 'failed', 'cancelled']);
const descriptions: Record<string, string> = {
  queued: 'Queued on the Mac', preparing: 'Preparing a separate task workspace', running: 'Muse Code is working',
  completed_unverified: 'Agent finished · review patch/check results', failed: 'Task failed · review the reported reason', cancelled: 'Task cancelled',
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const task = $<HTMLTextAreaElement>('task'), start = $<HTMLButtonElement>('start'), cancel = $<HTMLButtonElement>('cancel');
let overview: CodingOverview | undefined, selected: string | undefined, selectedDetail: CodingJob | undefined;
let connectorOverview: ConnectorOverview | undefined;
let pending = false, refreshing = false, statusAvailable = false, patchRequest = 0, refreshController: AbortController | undefined;
let poll: ReturnType<typeof setTimeout> | undefined;

function notify(message: string, error = false): void {
  $('action-message').textContent = message; $('action-message').classList.toggle('error', error);
}
async function request(path: string, body?: object, signal?: AbortSignal): Promise<Response> {
  const token = loadIdentity()?.deviceToken;
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(15000) });
  if (!response.ok) {
    let message = response.status === 403 ? 'Open this page on the Mac bridge or pair this browser with an owner account.' : `The Mac bridge returned ${response.status}.`;
    try { const detail = await response.json() as { message?: string; error?: string }; message = detail.message ?? detail.error ?? message; } catch { /* Keep the status explanation. */ }
    throw Error(message);
  }
  return response;
}
function timestamp(value?: number): string {
  return value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not started';
}
function isActive(job: CodingJob): boolean { return !terminal.has(job.state); }
function currentJob(): CodingJob | undefined {
  return overview?.jobs.find(job => job.jobId === selected) ?? (selectedDetail?.jobId === selected ? selectedDetail : undefined);
}
function updateControls(): void {
  start.disabled = pending || !statusAvailable || overview?.status.installed !== true || overview?.status.available === false || Boolean(overview?.jobs.some(isActive)) || connectorOverview?.generator.active === true;
  cancel.disabled = pending;
  $<HTMLButtonElement>('refresh').disabled = refreshing;
}
function drawJob(): void {
  const job = currentJob(); $('job-detail').hidden = !job;
  if (!job) return;
  $('job-title').textContent = `Task ${job.jobId.slice(0, 10)}`;
  $('job-badge').textContent = job.state === 'completed_unverified' ? 'Review patch' : job.state.replaceAll('_', ' '); $('job-badge').dataset.state = job.state;
  $('job-state').textContent = descriptions[job.state] ?? `Agent state: ${job.state}`;
  $('job-reason').hidden = !job.reason; $('job-reason').textContent = job.reason ?? '';
  $('job-requested-model').textContent = job.requestedModel ?? 'Not reported';
  $('job-observed-model').textContent = job.observedModels?.length ? [...new Set(job.observedModels)].join(', ') : 'No model reported yet';
  $('job-started').textContent = job.startedAt ? timestamp(job.startedAt) : `Queued ${timestamp(job.createdAt)}`;
  $('job-exit').textContent = job.exitCode === undefined || job.exitCode === null ? 'Not reported' : `${job.exitCode}${job.exitCode === 0 ? ' · turn ended, not proof of passing checks' : ''}`;
  const seconds = Math.max(0, Math.round(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000));
  $('job-progress').textContent = `${seconds}s elapsed${job.finishedAt ? ` · ended ${timestamp(job.finishedAt)}` : ''}${job.lastEvent ? ` · last event: ${job.lastEvent}` : ''}`;
  cancel.hidden = !isActive(job);
  const patch = $<HTMLAnchorElement>('view-patch'); patch.hidden = isActive(job) && !job.changedFiles?.length;
  patch.href = `${API}/tasks/${encodeURIComponent(job.jobId)}/patch`;
  $('job-branch').textContent = job.branch ?? 'Not reported'; $('job-workspace').textContent = job.workspace ?? 'Not reported';
  $('job-last-event').textContent = [job.lastEvent, job.terminalReported ? `terminal: ${job.terminalReported}` : ''].filter(Boolean).join(' · ') || 'No native event reported';
  $('changed-files').replaceChildren(...(job.changedFiles ?? []).map(file => {
    const item = document.createElement('li'); item.textContent = file; return item;
  }));
  $('no-changed-files').hidden = Boolean(job.changedFiles?.length);
  $('operations').hidden = !job.operationsObserved?.length;
  $('operations').textContent = job.operationsObserved?.length ? `Tool intentions observed: ${job.operationsObserved.join(', ')}. These are not execution receipts.` : '';
  $('logs-truncated').hidden = !job.logsTruncated;
  $('summary-details').hidden = !job.modelSummary; $('model-summary').textContent = job.modelSummary ?? '';
}
function draw(): void {
  if (!overview) return;
  const status = overview.status;
  $('host-badge').textContent = status.installed ? 'Muse Code installed' : 'Coding agent unavailable';
  $('host-badge').dataset.state = status.installed ? 'available' : 'failed';
  $('host-message').textContent = status.message ?? status.reason ?? (status.installed
    ? 'Coding starts only when you submit a task. Changes stay in its task workspace for review.'
    : 'Muse Code is not available to the bridge. No coding task has been started from this page.');
  $('requested-model').textContent = status.requestedModel ?? 'Not reported'; $('agent-version').textContent = status.version ?? 'Not reported';
  const jobs = [...overview.jobs].sort((a, b) => b.createdAt - a.createdAt);
  $('jobs-empty').hidden = Boolean(jobs.length); $('job-count').textContent = jobs.length ? `${jobs.length} retained` : '';
  if (!selected && jobs[0]) selected = jobs[0].jobId;
  $('jobs').replaceChildren(...jobs.map(job => {
    const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'job-choice';
    choice.setAttribute('aria-pressed', String(selected === job.jobId));
    const name = document.createElement('span'); name.textContent = descriptions[job.state] ?? job.state;
    const when = document.createElement('small'); when.textContent = timestamp(job.createdAt);
    choice.append(name, when); choice.addEventListener('click', () => {
      if (selected !== job.jobId) { patchRequest++; $('patch-panel').hidden = true; }
      selected = job.jobId; draw(); void loadDetail(job.jobId);
    });
    return choice;
  }));
  drawJob(); updateControls();
}
function drawConnectors(): void {
  if (!connectorOverview) return;
  const { generator, connectors } = connectorOverview;
  $('runtime-badge').textContent = generator.active ? 'Muse is writing' : generator.available ? 'Ready for your request' : 'Generation unavailable';
  $('runtime-badge').dataset.state = generator.active ? 'running' : generator.available ? 'available' : 'failed';
  $('runtime-message').textContent = generator.active
    ? 'Muse Code is writing new connector and gesture files. Host checks must pass before they can load.'
    : generator.available ? `Fresh generation uses ${generator.model}. No connector starts until you ask Muse in Quest.`
    : 'Fresh generation needs the installed Muse Code host and Meta API access. No template is substituted.';
  $('runtime-connectors').replaceChildren(...connectors.map(connector => {
    const row = document.createElement('article'); row.className = 'runtime-connector';
    const title = document.createElement('h3'); title.textContent = connector.cardId;
    const status = document.createElement('p'); status.className = 'quiet';
    status.textContent = `${connector.currentlyAuthorized ? 'Authorized for current wiring' : 'Not authorized to run'} · ${connector.model} · ${connector.source}`;
    const facts = document.createElement('dl'); facts.className = 'job-facts';
    const add = (label: string, value: string) => { const pair = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; pair.append(dt, dd); facts.append(pair); };
    add('Connector SHA-256', connector.hash); add('Hand program SHA-256', connector.gestureHash);
    add('Actual generated encodings', String(connector.invocationCount));
    add('Last encoded packet', connector.lastBytes?.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ') ?? 'None yet');
    if (connector.lastPortId) add('Generated output binding', connector.lastPortId);
    if (connector.lastEncodedAt) add('Last encoded', timestamp(connector.lastEncodedAt));
    row.append(title, status, facts); return row;
  }));
}
function schedule(): void {
  clearTimeout(poll); poll = undefined;
  if (!document.hidden && (overview?.jobs.some(isActive) || connectorOverview?.generator.active)) poll = setTimeout(() => { void refresh(); }, 2000);
}
async function refresh(): Promise<void> {
  if (document.hidden || refreshing) return;
  refreshing = true; refreshController = new AbortController(); updateControls();
  try {
    const signal = AbortSignal.any([refreshController.signal, AbortSignal.timeout(10000)]);
    const [coding, connectors] = await Promise.allSettled([
      request(API, undefined, signal).then(response => response.json() as Promise<CodingOverview>),
      request('/api/agent/connectors', undefined, signal).then(response => response.json() as Promise<ConnectorOverview>),
    ]);
    if (connectors.status === 'fulfilled') { connectorOverview = connectors.value; drawConnectors(); }
    else if (!document.hidden && !refreshController.signal.aborted) {
      connectorOverview = undefined; $('runtime-badge').textContent = 'Status unavailable';
      $('runtime-badge').dataset.state = 'failed'; $('runtime-message').textContent = (connectors.reason as Error).message;
      $('runtime-connectors').replaceChildren();
    }
    if (coding.status === 'rejected') throw coding.reason;
    overview = coding.value; statusAvailable = true; draw();
  } catch (error) {
    if (!document.hidden && !refreshController.signal.aborted) {
      statusAvailable = false;
      $('host-badge').textContent = 'Status unavailable'; $('host-message').textContent = (error as Error).message;
      start.disabled = true;
    }
  } finally { refreshing = false; refreshController = undefined; updateControls(); schedule(); }
}
async function loadDetail(id: string): Promise<void> {
  try {
    const response = await request(`${API}/tasks/${encodeURIComponent(id)}`);
    const job = await response.json() as CodingJob;
    if (selected === id) {
      selectedDetail = job;
      const index = overview?.jobs.findIndex(item => item.jobId === id) ?? -1;
      if (overview && index >= 0) overview.jobs[index] = job;
      drawJob();
    }
  } catch (error) { notify((error as Error).message, true); }
}

$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  if (pending || start.disabled) return;
  const text = task.value.trim();
  if (!text) { notify('Describe a coding task first.', true); task.focus(); return; }
  pending = true; updateControls(); notify('Sending your coding task to the Mac…');
  void (async () => {
    try {
      const response = await request(`${API}/tasks`, { task: text });
      const job = await response.json() as CodingJob;
      selected = job.jobId; selectedDetail = job;
      if (overview && !overview.jobs.some(item => item.jobId === job.jobId)) overview.jobs.unshift(job);
      draw();
      notify('Task submitted. Follow the agent state and review the resulting patch below.');
      await refresh();
    } catch (error) { notify(`${(error as Error).message} Refresh the task list before retrying if the request may have reached the Mac.`, true); }
    finally { pending = false; updateControls(); schedule(); }
  })();
});
$('example').addEventListener('click', () => {
  task.value = 'Debug the OP-1 Field USB-MIDI bridge. Inspect output-port selection and fix ambiguous name matches so they cannot choose the wrong instrument. Preserve exact-ID routing and the unique Ableton Move Standalone preference. Add a focused fake-MIDI regression and run the relevant check without opening devices, sending real MIDI or playing sound.';
  task.focus(); notify('Example added. Edit it, then choose Start coding.');
});
cancel.addEventListener('click', () => {
  const job = currentJob(); if (!job || pending || !isActive(job)) return;
  pending = true; updateControls();
  void request(`${API}/tasks/${encodeURIComponent(job.jobId)}/cancel`, {}).then(async () => {
    notify('Cancellation requested. Waiting for the Mac agent to report its final state.'); await refresh();
  }).catch((error: Error) => notify(error.message, true)).finally(() => { pending = false; updateControls(); });
});
$('view-patch').addEventListener('click', event => {
  event.preventDefault();
  const job = currentJob(); if (!job) return;
  const generation = ++patchRequest;
  $('patch-panel').hidden = false; $('patch-title').textContent = `Patch · ${job.jobId.slice(0, 10)}`; $('patch').textContent = 'Loading the recorded patch…';
  void request(`${API}/tasks/${encodeURIComponent(job.jobId)}/patch`).then(response => response.text()).then(text => {
    if (generation !== patchRequest) return;
    $('patch').textContent = text.trim() ? text : 'No file changes were recorded for this task.';
  }).catch((error: Error) => { if (generation === patchRequest) $('patch').textContent = error.message; });
});
$('close-patch').addEventListener('click', () => { patchRequest++; $('patch-panel').hidden = true; });
$('refresh').addEventListener('click', () => { void refresh(); });
document.addEventListener('visibilitychange', () => {
  clearTimeout(poll); poll = undefined;
  if (document.hidden) refreshController?.abort(); else void refresh();
});
window.addEventListener('pagehide', () => { clearTimeout(poll); refreshController?.abort(); });
void refresh();
