/** Test-only browser fixture: real encoder, generated imagery and poses, no device permissions. */
import { Recorder, type HandInput } from '../../apps/quest/src/replay/recorder';
import { TakeVideoRecorder } from '../../apps/quest/src/replay/video';
import { JOINT_NAMES } from '../../apps/companion/src/tracking/model';

export async function recordFixture(): Promise<{ bytes: number[]; sharedTrackAlive: boolean; warnings: string[]; videoBytes: number }> {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111b27'; ctx.fillRect(0, 0, 320, 240);
  const stream = canvas.captureStream(24);
  const video = document.createElement('video'); video.srcObject = stream; video.muted = true;
  await video.play();
  const take = new Recorder(), encoder = new TakeVideoRecorder(), warnings: string[] = [];
  take.start({ take: 'browser-encoder-fixture', app: 'tracking-browser-test',
    device: { kind: 'emulator', name: 'Synthetic browser fixture' }, space: 'local-floor',
    camera: { width: 320, height: 240, fx: 220, fy: 220, cx: 160, cy: 120 },
    tracking: { source: 'emulator', sampleRateHz: 30, jointConvention: 'webxr-hand-25', units: 'meters', axes: 'right-handed-y-up-negative-z-forward' },
    notes: 'Generated image and motion for software validation, not captured human data.' });
  const error = encoder.start(video, take.elapsedMs, (warning) => warnings.push(warning), () => take.stop());
  if (error) throw new Error(error);
  const hand = (side: number, time: number): HandInput => ({ pinching: false, joints: Object.fromEntries(JOINT_NAMES.map((name, i) => [name, {
    position: { x: side * .18 + (i % 5) * .012, y: 1.2 + Math.floor(i / 5) * .015 + .03 * Math.sin(time / 300), z: -.4 - (i % 5) * .02 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }, radius: .007,
  }])) });
  let reset = false;
  try {
    await new Promise<void>((resolve) => {
      const step = () => {
        const t = take.elapsedMs;
        ctx.fillStyle = '#111b27'; ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#64e5c4'; ctx.fillRect(35 + Math.sin(t / 200) * 20, 90, 55, 55);
        ctx.fillStyle = '#9c9aff'; ctx.fillRect(210, 90 + Math.cos(t / 300) * 20, 55, 55);
        ctx.fillStyle = 'white'; ctx.font = '14px sans-serif'; ctx.fillText('SYNTHETIC ENCODER TEST', 40, 35);
        ctx.fillText(`${Math.round(t)} ms`, 120, 215);
        if (t >= 1200 && !reset) { take.spaceBoundary('reference-reset'); reset = true; }
        take.pose(t >= 900 && t < 1050 ? null : { position: { x: .02 * Math.sin(t / 300), y: 1.6, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
          { left: hand(-1, t), ...(t >= 300 && t < 600 ? {} : { right: hand(1, t) }) });
        if (t >= 1700) resolve(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    take.input('hack', { cardId: 'fixture-synth', actionId: 'warp', value: .5 });
    take.stop();
    const file = await encoder.stop();
    if (!file) throw new Error('Real browser encoder returned no video.');
    take.attachVideo(file.metadata, file.bytes);
    return { bytes: Array.from(take.toZip()), sharedTrackAlive: stream.getVideoTracks()[0].readyState === 'live', warnings, videoBytes: file.bytes.length };
  } finally {
    take.stop(); await encoder.stop(); stream.getTracks().forEach((track) => track.stop()); video.srcObject = null;
  }
}
