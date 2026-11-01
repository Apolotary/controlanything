/**
 * Morning spike G1(b) / S2: does a passthrough camera frame + head pose reach the server DURING immersive-ar?
 *
 *   1. "Camera" (2D, before XR): getUserMedia environment camera; prints the settings and every video input.
 *   2. "Enter AR": the live camera texture on a plane 0.6 m ahead, live stats on a panel, and 2 s in, one
 *      scan.frame (JPEG + head pose + intrinsics) posted to the server; the server's scan.result is shown.
 *   PASS = camera frames keep flowing inside the session (≥ 10 fps) AND the frame left on the socket.
 * Desktop: ?spike=camera&emulate=1&camera=photo runs the same steps against the emulator's synthetic camera.
 */
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Quaternion, Scene, SRGBColorSpace, type Texture, Vector3, VideoTexture, WebGLRenderer } from 'three';
import { api } from '../io/api';
import type { ScanResultPayload } from '../io/v1';
import { WsClient } from '../io/ws';
import { PairingFlow } from '../pair/self';
import { type CameraSource, CameraError, LiveCamera } from '../scan/camera';
import { FrameCapture } from '../scan/capture';
import { JpegEncoder } from '../scan/encode';
import { PoseRing } from '../scan/poses';
import { SyntheticCamera, VirtualRoom } from '../scan/synthetic';
import { APP_VERSION } from './app';
import { installEmulator } from './emulator';
import { PALETTE, Panel } from './panel';
import { startXr, xrSupport } from './xr';

type Check = { name: string; ok: boolean | null; detail: string };

export async function runCameraSpike(params: URLSearchParams): Promise<void> {
  const side = document.getElementById('side')!;
  side.innerHTML = `
    <header class="top"><div class="brand"><strong>CONTROL<span>EVERYTHING</span></strong><small>SPIKE · CAMERA</small></div></header>
    <section class="card"><h2>G1(b) · camera frame + pose → server during immersive-ar</h2>
      <button id="s-cam" class="primary" type="button">1 · Camera</button>
      <button id="s-ar" class="primary" type="button" disabled>2 · Enter AR</button>
      <p class="small muted">On the Mac first: <code>scripts/quest-grant-camera.sh</code> (adb grant + reverse). Then open <code>http://localhost:8787/quest/?spike=camera</code>.</p>
    </section>
    <section class="card"><h2>Checks</h2><dl id="s-checks" class="kv"></dl></section>
    <section class="card"><h2>Preview</h2><div id="s-prev" class="frame-wrap"></div></section>
    <section class="card"><h2>Log</h2><pre id="s-log" class="log"></pre></section>`;
  const logEl = document.getElementById('s-log')!;
  const log = (s: string, level: 'info' | 'ok' | 'warn' | 'error' = 'info') => {
    const line = `${new Date().toLocaleTimeString([], { hour12: false })} ${s}`;
    logEl.innerHTML += `<span class="${level}">${line.replace(/</g, '&lt;')}</span>\n`;
    logEl.scrollTop = logEl.scrollHeight;
    (level === 'error' ? console.error : console.log)(`[spike] ${s}`);
  };
  const checks = new Map<string, Check>();
  const setCheck = (name: string, ok: boolean | null, detail: string) => {
    checks.set(name, { name, ok, detail });
    document.getElementById('s-checks')!.innerHTML = [...checks.values()]
      .map((c) => `<dt>${c.ok === null ? '…' : c.ok ? '✓' : '✗'} ${c.name}</dt><dd>${c.detail.replace(/</g, '&lt;')}</dd>`)
      .join('');
  };

  // --- environment -------------------------------------------------------------------------------
  const support = await xrSupport();
  const emulate = params.has('emulate') ? params.get('emulate') !== '0' : !support.ar;
  setCheck('secure context', window.isSecureContext, `${location.origin}${window.isSecureContext ? '' : ' (use adb reverse → http://localhost, or https)'}`);
  setCheck('immersive-ar', support.ar || emulate, support.ar ? 'supported' : emulate ? 'emulated (IWER)' : 'not supported');
  const gum = typeof navigator.mediaDevices?.getUserMedia === 'function';
  setCheck('getUserMedia', gum, gum ? 'available' : 'missing (needs a secure context)');
  log(`UA: ${navigator.userAgent}`);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.xr.enabled = true;
  const stage = document.getElementById('stage')!;
  stage.appendChild(renderer.domElement);
  const resize = () => renderer.setSize(stage.clientWidth || innerWidth, stage.clientHeight || innerHeight, false);
  resize();
  addEventListener('resize', resize);
  const scene = new Scene();
  const cam = new PerspectiveCamera(70, (stage.clientWidth || 1) / (stage.clientHeight || 1), 0.01, 50);
  cam.position.set(0, 1.6, 0);

  const emulator = emulate ? await installEmulator({ canvas: renderer.domElement }) : undefined;
  if (emulator) log(`IWER ${emulator.device.version} emulating ${emulator.device.name}`, 'warn');

  // --- camera ------------------------------------------------------------------------------------
  const poses = new PoseRing();
  let head: { position: Vector3; quaternion: Quaternion } | null = null;
  let camera: CameraSource;
  let room: VirtualRoom | undefined;
  const want = params.get('camera') ?? (emulate ? 'photo' : 'live');
  if (want === 'photo' || want === 'sim') {
    room = new VirtualRoom(want === 'sim' ? { kind: 'sim', url: params.get('sim') ?? '/sim/?embed=room' } : { kind: 'photo', url: `${import.meta.env.BASE_URL}test/scan-scene.jpg` });
    if (emulator) scene.add(room.backdropGroup);
    camera = new SyntheticCamera(room, () => head);
  } else {
    camera = new LiveCamera({ eye: 'left' });
  }
  const capture = new FrameCapture({ camera, poses, encoder: new JpegEncoder(1280, 0.8), handJoints: () => [] });

  // in-XR panel + camera plane
  const panel = new Panel(300, 110, { name: 'spike-panel', depthTest: false, renderOrder: 30 });
  const plane = new Mesh(new PlaneGeometry(0.4, 0.3), new MeshBasicMaterial({ color: 0xffffff }));
  const rig = new Group();
  rig.add(plane, panel.mesh);
  plane.position.set(0, 1.45, -0.6);
  panel.mesh.position.set(0, 1.18, -0.6);
  rig.visible = false;
  scene.add(rig);
  let camTex: Texture | undefined;

  // --- server ------------------------------------------------------------------------------------
  const pairing = new PairingFlow({ name: emulate ? 'Quest (spike, emulator)' : 'Quest 3 (spike)', capabilities: ['camera', 'mic', 'hands', 'display'] });
  let token = '';
  const ws = new WsClient(WsClient.sameOrigin(), () => ({ deviceToken: token, role: 'hmd', capabilities: ['camera', 'hands', 'display'], app: `${APP_VERSION}+spike` }));
  ws.onState = (s) => setCheck('server socket', s === 'open' ? true : s === 'connecting' ? null : false, s);
  pairing.on('state', (s) => {
    if (s.kind === 'pending') log(`pairing pending: code ${s.display} — approve on the Mac or type y in the server terminal`, 'warn');
    if (s.kind === 'offline') log(s.message, 'warn');
  });
  api.health().then(
    (h) => setCheck('server', true, `${h.mode} · chat ${h.models.chat}`),
    (e) => setCheck('server', false, (e as Error).message),
  );
  void pairing.ensure().then((id) => {
    token = id.deviceToken;
    setCheck('paired', true, `${id.name} · ${id.deviceId.slice(0, 8)}`);
    ws.start();
  });
  let posted: { frameId: string; at: number } | null = null;
  ws.on('scan.result', (m) => {
    const p = m.payload as ScanResultPayload;
    if (!posted || p.frameId !== posted.frameId) return;
    const labels = p.detections.map((d) => `${d.label} ${Math.round(d.score * 100)}`).join(', ');
    setCheck('scan.result', true, `${p.detections.length} detection(s) in ${Math.round(performance.now() - posted.at)} ms · ${p.modelId} · ${p.source}${labels ? ` · ${labels}` : ''}`);
    log(`scan.result: ${p.detections.length} detection(s) · ${p.modelId} ${p.latencyMs} ms`, 'ok');
  });
  ws.on('log', (m) => {
    const p = m.payload as { level: string; message: string; ref?: string };
    if (p.level === 'error' || p.level === 'warn') log(`server: ${p.message}`, 'warn');
  });

  // --- step 1: camera -----------------------------------------------------------------------------
  const camBtn = document.getElementById('s-cam') as HTMLButtonElement;
  const arBtn = document.getElementById('s-ar') as HTMLButtonElement;
  camBtn.onclick = async () => {
    camBtn.disabled = true;
    setCheck('camera', null, 'starting…');
    try {
      const info = await camera.start();
      setCheck('camera', !info.warning, `${info.label} · ${info.width}×${info.height}${info.frameRate ? ` @ ${Math.round(info.frameRate)} fps` : ''}${info.warning ? ` · ${info.warning}` : ''}`);
      if (info.devices) log(`video inputs (${info.devices.length}): ${info.devices.map((d) => `"${d.label}"`).join(', ')}`);
      if (info.capabilities) {
        setCheck('exposure lock', info.canLockExposure ?? false, `${info.canLockExposure ? 'exposureMode manual available' : 'not available'} · ${info.capabilities}`);
        log(`track capabilities: ${info.capabilities}`);
      }
      if (camera instanceof LiveCamera) {
        camTex = new VideoTexture(camera.element);
        const prev = camera.element;
        prev.style.width = '100%';
        document.getElementById('s-prev')!.appendChild(prev);
      } else if (camera instanceof SyntheticCamera) {
        camTex = new CanvasTexture(camera.element);
        camera.element.style.width = '100%';
        document.getElementById('s-prev')!.appendChild(camera.element);
      }
      if (camTex) {
        camTex.colorSpace = SRGBColorSpace;
        (plane.material as MeshBasicMaterial).map = camTex;
        (plane.material as MeshBasicMaterial).needsUpdate = true;
      }
      arBtn.disabled = false;
      log('camera ready: now Enter AR', 'ok');
    } catch (e) {
      setCheck('camera', false, (e as Error).message);
      if (e instanceof CameraError) log(e.hint, 'error');
      log(`camera failed: ${(e as Error).message}`, 'error');
      camBtn.disabled = false;
    }
  };

  // --- step 2: AR ---------------------------------------------------------------------------------
  let refSpace: XRReferenceSpace | undefined;
  let sessionStart = 0;
  let framesAtStart = 0;
  let inSessionFps = 0;
  let sent = false;
  arBtn.onclick = async () => {
    try {
      const s = await startXr(renderer, { allowVr: emulate });
      refSpace = s.refSpace;
      sessionStart = performance.now();
      framesAtStart = camera.stats.frames;
      rig.visible = true;
      setCheck('XR session', true, `${s.mode} · ${s.attempt} · ${s.features.join(', ')}`);
      log(`XR session: ${s.mode} (${s.attempt})`, 'ok');
      s.session.addEventListener('end', () => {
        refSpace = undefined;
        rig.visible = false;
        log('XR session ended');
      });
    } catch (e) {
      setCheck('XR session', false, (e as Error).message);
      log(`XR failed: ${(e as Error).message}`, 'error');
    }
  };

  const postOne = async () => {
    sent = true;
    const r = await capture.capture('scan');
    if (!r) {
      setCheck('scan.frame posted', false, 'no camera frame or no pose yet');
      sent = false;
      return;
    }
    const id = ws.send('scan.frame', r.payload, { to: 'server' });
    if (id) {
      posted = { frameId: r.payload.frameId, at: performance.now() };
      const p = r.payload.pose!.position;
      setCheck('scan.frame posted', true, `${r.payload.width}×${r.payload.height} · ${Math.round(r.record.bytes / 1024)} KB · head (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) · fx ${r.record.intrinsics.fx.toFixed(1)}`);
      setCheck('scan.result', null, 'waiting…');
      log(`posted scan.frame ${r.payload.frameId} (${Math.round(r.record.bytes / 1024)} KB, ${camera.kind})`, 'ok');
    } else {
      setCheck('scan.frame posted', false, 'socket not open (paired? server running?)');
      sent = false;
    }
  };

  let lastPanel = 0;
  renderer.setAnimationLoop((time, frame) => {
    try {
      spikeFrame(time, frame);
    } catch (e) {
      console.error('[spike] frame error', e);
    }
  });

  function spikeFrame(time: number, frame?: XRFrame): void {
    if (frame && refSpace) {
      const vp = frame.getViewerPose(refSpace);
      if (vp) {
        const p = vp.transform.position;
        const o = vp.transform.orientation;
        poses.push(time, p, o);
        head = { position: new Vector3(p.x, p.y, p.z), quaternion: new Quaternion(o.x, o.y, o.z, o.w) };
      }
    } else if (emulator) {
      const h = emulator.head();
      cam.position.copy(h.position);
      cam.quaternion.copy(h.quaternion);
      head = h;
      poses.push(time, h.position, h.quaternion);
    }
    if (camera instanceof SyntheticCamera && time - lastPanel > 200) void camera.grab().then((g) => g?.bitmap.close());
    if (camTex && camera instanceof SyntheticCamera) camTex.needsUpdate = true;
    room?.update(time);
    if (refSpace && time - lastPanel > 250) {
      lastPanel = time;
      const secs = (time - sessionStart) / 1000;
      inSessionFps = secs > 0.5 ? (camera.stats.frames - framesAtStart) / secs : 0;
      if (secs > 2 && !sent) void postOne();
      const fpsOk = camera.kind !== 'passthrough' || inSessionFps >= 10;
      setCheck('frames in session', camera.kind === 'passthrough' ? fpsOk : true, camera.kind === 'passthrough' ? `${inSessionFps.toFixed(1)} fps · captureTime ${camera.stats.captureTime ? 'yes' : 'no'}` : 'synthetic source');
      const verdict = fpsOk && Boolean(posted);
      panel.draw((_c, p) => {
        p.text(`SPIKE · CAMERA IN AR · ${verdict ? 'PASS' : 'running…'}`, 6, 14, { size: 6, color: verdict ? PALETTE.ok : PALETTE.volt });
        p.text(`camera ${camera.info?.width ?? '?'}×${camera.info?.height ?? '?'} · ${inSessionFps.toFixed(1)} fps in session`, 6, 32, { size: 5, font: 'mono' });
        p.text(`captureTime ${camera.stats.captureTime ? 'yes' : 'no'} · source ${camera.kind}`, 6, 46, { size: 5, font: 'mono' });
        p.text(posted ? `posted scan.frame ${posted.frameId.slice(-8)}` : 'posting one scan.frame at 2 s…', 6, 60, { size: 5, font: 'mono', color: posted ? PALETTE.ok : PALETTE.dim });
        const sr = checks.get('scan.result');
        p.text(sr ? `server: ${sr.detail}` : 'server: —', 6, 74, { size: 4.2, font: 'mono', color: sr?.ok ? PALETTE.ok : PALETTE.dim, maxMm: 290 });
        p.text(`socket ${ws.state} · ${camera.info?.label ?? ''}`, 6, 88, { size: 4, font: 'mono', color: PALETTE.dim, maxMm: 290 });
      });
      if (verdict && !checks.get('VERDICT')?.ok) {
        setCheck('VERDICT', true, 'PASS: camera frames flow inside immersive-ar and a scan.frame with pose reached the socket');
        log('SPIKE PASS', 'ok');
      }
    }
    renderer.render(scene, cam);
  }
}
