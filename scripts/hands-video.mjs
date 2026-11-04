/**
 * A synthetic "webcam" clip for the hand demo's browser checks: a dim room, a person with a face, and two
 * skin-coloured hands that move in arcs; the right hand closes into a fist now and then.
 * Written straight to YUV4MPEG2 (Chrome's --use-file-for-fake-video-capture). No real person, no model.
 *   node scripts/hands-video.mjs <out.y4m> [seconds=8] [width=640] [height=480]
 */
import { createWriteStream } from 'node:fs';

export const SKIN = [214, 160, 130];

/** Draw one frame into an RGB buffer (3 bytes per pixel). */
export function drawScene(rgb, W, H, t) {
  const s = W / 640;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, g = 20 + 16 * (y / H) + 6 * Math.sin(x / W * 6) + 10 * Math.exp(-(((x / W - 0.78) ** 2) + ((y / H - 0.25) ** 2)) * 9);
    rgb[i] = g * 0.95; rgb[i + 1] = g; rgb[i + 2] = g * 1.3;
  }
  const fill = (x0, y0, x1, y1, inside, col) => {
    const xa = Math.max(0, Math.floor(x0 * s)), xb = Math.min(W - 1, Math.ceil(x1 * s)), ya = Math.max(0, Math.floor(y0 * s)), yb = Math.min(H - 1, Math.ceil(y1 * s));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      if (!inside(x / s, y / s)) continue;
      const i = (y * W + x) * 3, n = ((x * 7 + y * 13) % 9) - 4, shade = 0.9 + 0.1 * Math.sin(x * 0.05 + y * 0.03);
      rgb[i] = col[0] * shade + n; rgb[i + 1] = col[1] * shade + n; rgb[i + 2] = col[2] * shade + n;
    }
  };
  const ell = (cx, cy, rx, ry, col) => fill(cx - rx, cy - ry, cx + rx, cy + ry, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1, col);
  const cap = (x0, y0, x1, y1, r, col) => fill(Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.max(x0, x1) + r, Math.max(y0, y1) + r, (x, y) => {
    const dx = x1 - x0, dy = y1 - y0, k = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
    return (x - x0 - k * dx) ** 2 + (y - y0 - k * dy) ** 2 < r * r;
  }, col);
  // shoulders / shirt
  fill(100, 360, 540, 480, (x, y) => y > 360 && Math.abs(x - 320) < 150 + (y - 360) * 0.9, [38, 56, 104]);
  const fx = 320 + 6 * Math.sin(t * 0.7);
  cap(fx, 300, fx, 370, 32, [196, 142, 116]);
  ell(fx, 228, 60, 80, [204, 150, 122]);
  ell(fx, 160, 62, 32, [28, 20, 16]);
  drawHands(rgb, W, H, t, fill, ell, cap);
}

/** Only the two hands (and forearms), for compositing over another background. */
export function drawHands(rgb, W, H, t, fill, ell, cap, aim) {
  if (!fill) {
    const s = W / 640;
    fill = (x0, y0, x1, y1, inside, col) => {
      const xa = Math.max(0, Math.floor(x0 * s)), xb = Math.min(W - 1, Math.ceil(x1 * s)), ya = Math.max(0, Math.floor(y0 * s)), yb = Math.min(H - 1, Math.ceil(y1 * s));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        if (!inside(x / s, y / s)) continue;
        const i = (y * W + x) * 3, n = ((x * 7 + y * 13) % 9) - 4, shade = 0.9 + 0.1 * Math.sin(x * 0.05 + y * 0.03);
        rgb[i] = col[0] * shade + n; rgb[i + 1] = col[1] * shade + n; rgb[i + 2] = col[2] * shade + n;
      }
    };
    ell = (cx, cy, rx, ry, col) => fill(cx - rx, cy - ry, cx + rx, cy + ry, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1, col);
    cap = (x0, y0, x1, y1, r, col) => fill(Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.max(x0, x1) + r, Math.max(y0, y1) + r, (x, y) => {
      const dx = x1 - x0, dy = y1 - y0, k = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
      return (x - x0 - k * dx) ** 2 + (y - y0 - k * dy) ** 2 < r * r;
    }, col);
  }
  const hand = (cx, cy, closed, flip) => {
    cap(cx, cy + 40, cx + flip * 16, cy + 200, 26, SKIN);
    if (closed) { ell(cx, cy, 40, 44, SKIN); return; }
    ell(cx, cy + 6, 38, 42, SKIN);
    for (const [ax, ay, bx, by] of [[-27, -34, -40, -96], [-9, -40, -12, -114], [9, -40, 12, -112], [26, -34, 36, -92]]) cap(cx + ax, cy + ay, cx + bx, cy + by, 9, SKIN);
    cap(cx - flip * 34, cy + 10, cx - flip * 72, cy - 28, 10, SKIN);
  };
  // camera image (not mirrored): the person's right hand is on the image's left
  const at = typeof aim === 'function' ? aim(t) : null;
  if (at) hand(at.x, at.y, false, 1);
  else hand(165 + 85 * Math.sin(t * 1.3), 220 + 80 * Math.cos(t * 0.9), Math.sin(t * 1.6) > 0.55, 1);
  hand(490 + 50 * Math.sin(t * 1.1 + 1), 260 + 70 * Math.sin(t * 0.7), false, -1);
}

export async function writeY4m(path, seconds = 8, W = 640, H = 480, fps = 30) {
  const out = createWriteStream(path);
  const write = (b) => new Promise((resolve) => { if (out.write(b)) resolve(); else out.once('drain', resolve); });
  await write(`YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const rgb = new Float32Array(W * H * 3), y4 = Buffer.alloc(W * H), u4 = Buffer.alloc(W * H / 4), v4 = Buffer.alloc(W * H / 4);
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f++) {
    drawScene(rgb, W, H, f / fps);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
      y4[y * W + x] = Math.max(0, Math.min(255, 16 + 65.481 * r + 128.553 * g + 24.966 * b));
    }
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y + dy) * W + x + dx) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
      r /= 1020; g /= 1020; b /= 1020;
      const k = (y / 2) * (W / 2) + x / 2;
      u4[k] = Math.max(0, Math.min(255, 128 - 37.797 * r - 74.203 * g + 112 * b));
      v4[k] = Math.max(0, Math.min(255, 128 + 112 * r - 93.786 * g - 18.214 * b));
    }
    await write('FRAME\n'); await write(Buffer.from(y4)); await write(Buffer.from(u4)); await write(Buffer.from(v4));
  }
  await new Promise((resolve) => out.end(resolve));
  return frames;
}

/**
 * The same hands over a still background (rgb bytes, W x H), for example the sim room: SAM's FIXTURE ground truth
 * matches that image, so outlines are real. `aim(t)` can park the person's right hand (in 640 x 480 units) over a
 * device for a while, to test tagging by holding a hand over an outline.
 */
export async function writeY4mOver(path, background, W, H, seconds = 6, fps = 15, aim) {
  const out = createWriteStream(path);
  const write = (b) => new Promise((resolve) => { if (out.write(b)) resolve(); else out.once('drain', resolve); });
  await write(`YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const rgb = new Float32Array(W * H * 3), y4 = Buffer.alloc(W * H), u4 = Buffer.alloc(W * H / 4), v4 = Buffer.alloc(W * H / 4);
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < W * H * 3; i++) rgb[i] = background[i];
    drawHands(rgb, W, H, f / fps, undefined, undefined, undefined, aim);
    for (let i = 0; i < W * H; i++) { const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255; y4[i] = Math.max(0, Math.min(255, 16 + 65.481 * r + 128.553 * g + 24.966 * b)); }
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y + dy) * W + x + dx) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
      r /= 1020; g /= 1020; b /= 1020;
      const k = (y / 2) * (W / 2) + x / 2;
      u4[k] = Math.max(0, Math.min(255, 128 - 37.797 * r - 74.203 * g + 112 * b));
      v4[k] = Math.max(0, Math.min(255, 128 + 112 * r - 93.786 * g - 18.214 * b));
    }
    await write('FRAME\n'); await write(Buffer.from(y4)); await write(Buffer.from(u4)); await write(Buffer.from(v4));
  }
  await new Promise((resolve) => out.end(resolve));
  return frames;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path = '/tmp/ce-hands.y4m', seconds = '8', w = '640', h = '480'] = process.argv.slice(2);
  const frames = await writeY4m(path, Number(seconds), Number(w), Number(h));
  console.log(`wrote ${frames} frames to ${path}`);
}
