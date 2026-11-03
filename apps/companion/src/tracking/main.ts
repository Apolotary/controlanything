import './style.css';
import { createDemoTake, exportTrackingJsonl, loadTrackingFile, sampleAt, trackingStats, type Hand, type TrackingTake } from './model';
import { drawCoverage, PoseRenderer, type PoseView } from './renderer';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('recording-video');
const timeline = $<HTMLInputElement>('timeline');
const play = $<HTMLButtonElement>('play');
const offsetInput = $<HTMLInputElement>('video-offset');
const takeInput = $<HTMLInputElement>('take-file');
const videoInput = $<HTMLInputElement>('video-file');
const rateInput = $<HTMLSelectElement>('play-rate');
const trailInput = $<HTMLInputElement>('show-trail');
const renderer = new PoseRenderer($<HTMLCanvasElement>('pose-canvas'));
const coverage = $<HTMLCanvasElement>('coverage-canvas');
let take: TrackingTake | null = null;
let time = 0, offsetMs = 0, rate = 1, view: PoseView = 'world';
let playing = false, raf = 0, lastTick = 0, lastDraw = 0, loadId = 0;
let videoUrl: string | null = null, videoReady = false, videoPending = false, videoFailed = false;
let attachedFile: File | null = null;
let videoRequest = 0;

function stamp(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  return `${String(Math.floor(n / 60000)).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}.${String(n % 1000).padStart(3, '0')}`;
}
function status(message: string, error = false): void {
  $('load-status').textContent = message;
  $('load-status').classList.toggle('error', error);
}
function handStatus(hand: Hand | undefined): string {
  if (!hand || hand.source === 'untracked') return 'Tracking unavailable';
  if (hand.source === 'controller') return 'Controller · no hand joints';
  const count = Object.keys(hand.joints).length;
  return `${count}/25 joints${hand.pinching ? ' · pinching' : ''}`;
}
function pause(): void {
  playing = false; cancelAnimationFrame(raf); raf = 0; pauseVideo();
  play.textContent = '▶'; play.setAttribute('aria-label', 'Play recording');
}
function pauseVideo(): void {
  // Invalidate play() before pausing: its asynchronous AbortError belongs to this old request.
  videoRequest++; videoPending = false; video.pause();
}

function clearVideo(): void {
  const oldUrl = videoUrl; videoUrl = null;
  pauseVideo(); video.removeAttribute('src'); video.load();
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  videoReady = false; videoFailed = false;
  attachedFile = null;
  video.hidden = true; $('video-empty').hidden = false; $('video-range').hidden = true;
  offsetInput.disabled = true; $('sync-badge').textContent = 'NO VIDEO';
  $('video-badge').textContent = 'VIDEO'; $('video-detail').textContent = 'Video stays in this browser.';
}

function setVideo(blob: Blob, name: string): void {
  clearVideo();
  videoUrl = URL.createObjectURL(blob); video.src = videoUrl; video.muted = true;
  video.hidden = false; $('video-empty').hidden = true; offsetInput.disabled = false;
  $('sync-badge').textContent = 'APPROXIMATE'; $('video-badge').textContent = 'RECORDED VIDEO';
  $('video-detail').textContent = name; video.load();
}

function syncVideo(force = false): void {
  if (!videoReady || !videoUrl) return;
  const seconds = (time - offsetMs) / 1000;
  const duration = Number.isFinite(video.duration) ? video.duration : take?.meta.video?.durationMs ? take.meta.video.durationMs / 1000 : Infinity;
  const available = seconds >= 0 && seconds <= duration;
  $('video-range').hidden = available;
  if (!available) { pauseVideo(); return; }
  if (force || Math.abs(video.currentTime - seconds) > .18) {
    try { video.currentTime = Math.max(0, Math.min(seconds, duration)); } catch { /* Metadata may not yet expose a seekable range. */ }
  }
  video.playbackRate = rate;
  if (playing && video.paused && !videoPending && !videoFailed) {
    const request = ++videoRequest, source = videoUrl;
    videoPending = true;
    void video.play().then(() => {
      if (request !== videoRequest || source !== videoUrl) return;
      videoPending = false; if (!playing) pauseVideo();
    }).catch((error: unknown) => {
      if (request !== videoRequest || source !== videoUrl) return;
      videoPending = false;
      if (!playing || (error instanceof DOMException && error.name === 'AbortError')) return;
      videoFailed = true;
      status('Video playback is unavailable in this browser. The tracked poses can still be reviewed.', true);
    });
  } else if (!playing && !video.paused) pauseVideo();
}

function draw(forceVideo = false): void {
  const sample = take ? sampleAt(take, time) : null;
  timeline.value = String(Math.round(time));
  $('play-time').replaceChildren(document.createTextNode(`${stamp(time)} `), Object.assign(document.createElement('span'), { textContent: `/ ${stamp(take?.durationMs ?? 0)}` }));
  $('video-time').textContent = stamp(Math.max(0, time - offsetMs));
  $('left-status').textContent = take ? handStatus(sample?.hands.left) : 'No data';
  $('right-status').textContent = take ? handStatus(sample?.hands.right) : 'No data';
  $('head-status').textContent = sample?.head ? 'Position + orientation' : take ? 'Tracking unavailable' : 'No data';
  $('sample-age').textContent = sample ? `${Math.round(time - sample.t)} ms since sample` : take ? 'Tracking gap' : '—';
  const head = sample?.head;
  $('head-values').textContent = head
    ? `XYZ ${head.position.x.toFixed(3)}, ${head.position.y.toFixed(3)}, ${head.position.z.toFixed(3)} m · q ${head.orientation.x.toFixed(2)}, ${head.orientation.y.toFixed(2)}, ${head.orientation.z.toFixed(2)}, ${head.orientation.w.toFixed(2)}`
    : 'Position and orientation appear when a tracked pose is available.';
  $('pose-empty').hidden = Boolean(take);
  $('pose-space').textContent = view === 'world' ? `${take?.meta.space === 'local' ? 'LOCAL ORIGIN' : 'LOCAL FLOOR'} · METERS${sample ? ` · SPACE ${sample.spaceId}` : ''}` : view === 'pov' ? 'HEAD-RELATIVE · ILLUSTRATIVE PROJECTION' : `${view.toUpperCase()} HAND · AUTO-FIT INSPECTION`;
  $('pose-state').textContent = !take ? 'Waiting for a recording' : !sample ? 'NO TRACKING AT THIS TIMESTAMP' : view === 'pov' && !head ? 'HEAD TRACKING UNAVAILABLE' : (view === 'left' || view === 'right') && sample.hands[view].source !== 'hand' ? `${view.toUpperCase()} HAND TRACKING UNAVAILABLE` : `${take.demo ? 'SYNTHETIC · ' : ''}${stamp(sample.t)}`;
  renderer.draw(take, sample, time, view, trailInput.checked);
  drawCoverage(coverage, take, time);
  syncVideo(forceVideo);
}

function tick(now: number): void {
  if (!playing || !take) return;
  time = Math.min(take.durationMs, time + Math.max(0, now - lastTick) * rate);
  lastTick = now;
  if (now - lastDraw >= 1000 / 30 || time >= take.durationMs) { draw(); lastDraw = now; }
  if (time >= take.durationMs) { pause(); draw(true); return; }
  raf = requestAnimationFrame(tick);
}
function begin(): void {
  if (!take || document.hidden) return;
  if (time >= take.durationMs) time = 0;
  playing = true; videoFailed = false; lastTick = performance.now(); lastDraw = 0;
  play.textContent = 'Ⅱ'; play.setAttribute('aria-label', 'Pause recording');
  draw(true); raf = requestAnimationFrame(tick);
}
function showTake(next: TrackingTake): void {
  pause(); clearVideo(); take = next; time = 0; offsetMs = next.meta.video?.startOffsetMs ?? 0;
  offsetInput.value = String(offsetMs); timeline.max = String(Math.max(1, next.durationMs)); timeline.disabled = false;
  play.disabled = next.durationMs <= 0; $<HTMLButtonElement>('rewind').disabled = false;
  $<HTMLButtonElement>('attach-video').disabled = false; $<HTMLButtonElement>('export-data').disabled = false;
  $('take-name').textContent = next.meta.take; $('session-dot').classList.add('ready');
  const source = next.meta.tracking?.source ?? 'unknown';
  $('provenance-badge').textContent = next.demo ? 'Synthetic sample' : source === 'webxr' ? 'Quest · runtime tracking' : source === 'emulator' ? 'Emulator recording' : 'Legacy / unknown source';
  $('provenance-badge').classList.toggle('demo', next.demo); $('demo-banner').hidden = !next.demo;
  $('video-empty-title').textContent = next.demo ? 'This sample contains telemetry only' : 'No continuous video in this take';
  $('video-empty-copy').textContent = next.demo ? 'Explore the generated hands in the motion view. Open a Quest take to inspect real video and tracking together.' : 'Attach the matching Quest video, or record a new take with video capture available.';
  const stats = trackingStats(next);
  $('duration-label').textContent = `${(next.durationMs / 1000).toFixed(1)} s`;
  $('sample-rate').textContent = `${stats.rateHz.toFixed(1)} Hz · ${stats.samples.toLocaleString()} samples`;
  for (const side of ['head', 'left', 'right'] as const) $(`${side}-coverage`).textContent = `${Math.round(stats[`${side}Coverage`] * 100)}%`;
  $('coverage-detail').textContent = `Time with a valid head pose or at least one hand joint. ${stats.spaces} reference ${stats.spaces === 1 ? 'space' : 'spaces'}. Coverage does not measure tracking accuracy.`;
  $('provenance-text').textContent = `${next.demo ? 'Synthetic demonstration data' : source === 'webxr' ? 'WebXR runtime pose estimates' : source === 'emulator' ? 'Desktop emulator data' : 'Tracking source not recorded'} · ${next.meta.device.name} · ${next.meta.space} · meters · right-handed Y-up, −Z forward · WebXR hand skeleton (25 joints). ${next.demo ? 'Not captured training data.' : 'Review capture quality and alignment before training use.'}`;
  const warnings = $('warnings'); warnings.replaceChildren(...next.warnings.map(w => Object.assign(document.createElement('li'), { textContent: w }))); warnings.hidden = !next.warnings.length;
  if (next.video) setVideo(new Blob([next.video.bytes as unknown as BlobPart], { type: next.video.mimeType }), next.meta.video?.file ?? 'Recorded video');
  draw(true);
}

$('open-take').onclick = () => takeInput.click();
$('attach-video').onclick = () => videoInput.click();
$('load-demo').onclick = () => { loadId++; showTake(createDemoTake()); status('Synthetic sample loaded. Press Play or scrub the timeline; the left hand has a deliberate tracking gap.'); };
takeInput.onchange = async () => {
  const file = takeInput.files?.[0]; if (!file) return;
  const request = ++loadId; pause(); status(`Opening ${file.name}…`);
  try {
    const loaded = await loadTrackingFile(file);
    if (request !== loadId) return;
    showTake(loaded); status(`Loaded ${file.name}. Files are reviewed locally in this browser.`);
  } catch (e) { if (request === loadId) status(e instanceof Error ? e.message : 'Could not read this recording.', true); }
  finally { takeInput.value = ''; }
};
videoInput.onchange = () => {
  const file = videoInput.files?.[0]; if (!file || !take) return;
  if (!/\.(mp4|webm)$/i.test(file.name)) { status('Choose a WebM or MP4 video.', true); videoInput.value = ''; return; }
  if (file.size > 512 * 1024 * 1024) { status('Use a video smaller than 512 MB for local review.', true); videoInput.value = ''; return; }
  pause(); setVideo(file, file.name);
  attachedFile = file; $<HTMLButtonElement>('export-data').disabled = true;
  status('Video attached. Adjust its start offset to align it with the tracking timeline.'); videoInput.value = ''; draw(true);
};
video.addEventListener('loadedmetadata', () => {
  if (!videoUrl || video.currentSrc !== videoUrl) return;
  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    if (take) delete take.meta.video;
    rejectVideo('This file has no video track', 'Choose a WebM or MP4 containing video. The tracked poses can still be reviewed and exported.');
    return;
  }
  videoReady = true;
  $('video-badge').textContent = `${video.videoWidth} × ${video.videoHeight}`;
  if (take && attachedFile) {
    // Metadata names the actual selected asset; never invent dimensions before decoding it.
    const name = attachedFile.name.replace(/[\\/\u0000-\u001f]/g, '_');
    take.meta.video = { file: name, mimeType: /\.mp4$/i.test(name) ? 'video/mp4' : 'video/webm', width: video.videoWidth, height: video.videoHeight, startOffsetMs: offsetMs, alignment: 'approximate', cameraExtrinsics: 'uncalibrated' };
    attachedFile = null;
  }
  if (take?.meta.video) { take.meta.video.width = video.videoWidth; take.meta.video.height = video.videoHeight; if (Number.isFinite(video.duration)) take.meta.video.durationMs = video.duration * 1000; }
  $<HTMLButtonElement>('export-data').disabled = !take;
  draw(true);
});
function rejectVideo(title: string, message: string): void {
  pauseVideo();
  videoReady = false; videoFailed = true; video.hidden = true; $('video-empty').hidden = false;
  if (attachedFile && take) { delete take.meta.video; attachedFile = null; }
  $('video-range').hidden = true; offsetInput.disabled = true;
  $('video-badge').textContent = 'UNAVAILABLE'; $('sync-badge').textContent = 'NO VIDEO';
  $<HTMLButtonElement>('export-data').disabled = !take;
  $('video-empty-title').textContent = title; $('video-empty-copy').textContent = message;
  status(`${title}. ${message}`, true);
}
video.addEventListener('error', () => {
  if (!videoUrl || video.currentSrc !== videoUrl) return;
  rejectVideo('This video could not be decoded', 'Try a browser-compatible WebM or MP4. The tracking data remains available.');
});
play.onclick = () => playing ? pause() : begin();
$('rewind').onclick = () => { pause(); time = 0; draw(true); };
timeline.oninput = () => { pause(); time = Number(timeline.value); draw(true); };
rateInput.onchange = () => { rate = Number(rateInput.value); lastTick = performance.now(); syncVideo(true); };
trailInput.onchange = () => draw();
offsetInput.oninput = () => {
  const value = offsetInput.valueAsNumber;
  if (!Number.isFinite(value) || Math.abs(value) > 3_600_000) return;
  offsetMs = value; if (take?.meta.video) take.meta.video.startOffsetMs = value; draw(true);
};
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => {
  button.onclick = () => {
    view = button.dataset.view as PoseView;
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    draw();
  };
});
$('export-data').onclick = () => {
  if (!take) return;
  const blob = new Blob([exportTrackingJsonl(take, { videoOffsetMs: offsetMs })], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `${take.meta.take.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100) || 'quest-take'}-tracking.jsonl`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  status('Tracking dataset exported with poses, validity, coordinate conventions and video alignment metadata. Keep the original video alongside it.');
};
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', () => { pause(); });
window.addEventListener('beforeunload', () => { if (videoUrl) URL.revokeObjectURL(videoUrl); });
const resize = new ResizeObserver(() => draw()); resize.observe($('pose-canvas')); resize.observe(coverage);
draw();
