import { HAND_BONES, worldToHead, type Pose, type TrackingSample, type TrackingTake, type Vec3 } from './model';

export type PoseView = 'world' | 'pov' | 'left' | 'right';
const COLORS = { left: '#9ce3c0', right: '#baacff', head: '#e8c78a' };
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (p: Vec3, n: number): Vec3 => ({ x: p.x * n, y: p.y * n, z: p.z * n });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (p: Vec3) => mul(p, 1 / (Math.hypot(p.x, p.y, p.z) || 1));
interface Point { x: number; y: number; depth: number }
type Project = (p: Vec3) => Point | null;

function rotate(p: Vec3, q: Pose['orientation']): Vec3 {
  const u = { x: q.x, y: q.y, z: q.z };
  const uv = cross(u, p), uuv = cross(u, uv);
  return add(p, add(mul(uv, 2 * q.w), mul(uuv, 2)));
}

function context(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}

export class PoseRenderer {
  private indexedTake: TrackingTake | null = null;
  private readonly spaceHeads = new Map<number, Pose>();
  constructor(private readonly canvas: HTMLCanvasElement) {}

  draw(take: TrackingTake | null, sample: TrackingSample | null, time: number, view: PoseView, trail: boolean): void {
    const dims = context(this.canvas);
    if (!dims) return;
    const { ctx, w, h } = dims;
    if (take !== this.indexedTake) {
      this.indexedTake = take; this.spaceHeads.clear();
      for (const s of take?.samples ?? []) if (s.head && !this.spaceHeads.has(s.spaceId)) this.spaceHeads.set(s.spaceId, s.head);
    }
    const firstHead = this.spaceHeads.get(sample?.spaceId ?? take?.samples[0]?.spaceId ?? 0);
    const focus: Vec3 = firstHead ? { x: firstHead.position.x, y: firstHead.position.y - .35, z: firstHead.position.z - .35 } : { x: 0, y: 1.1, z: -.3 };
    const eye = add(focus, { x: 1.5, y: 1.15, z: 1.85 });
    const forward = unit(sub(focus, eye)), right = unit(cross(forward, { x: 0, y: 1, z: 0 })), up = cross(right, forward);
    let project: Project = (p) => {
      const d = sub(p, eye), depth = dot(d, forward);
      if (depth <= .04) return null;
      const focal = Math.min(w, h) * 1.7;
      return { x: w / 2 + dot(d, right) / depth * focal, y: h * .49 - dot(d, up) / depth * focal, depth };
    };
    if (view === 'pov') {
      const head = sample?.head;
      project = p => {
        if (!head) return null;
        const q = worldToHead(p, head), depth = -q.z;
        if (depth <= .03) return null;
        const f = Math.min(w, h) * .85;
        return { x: w / 2 + q.x / depth * f, y: h / 2 - q.y / depth * f, depth };
      };
    } else if (view === 'left' || view === 'right') {
      const joints = Object.values(sample?.hands[view].joints ?? {});
      const point = (p: Vec3) => sample?.head ? worldToHead(p, sample.head) : p;
      const positions = joints.map(j => point(j!.position));
      const xs = positions.map(p => p.x), ys = positions.map(p => p.y);
      const minX = xs.length ? Math.min(...xs) : -.15, maxX = xs.length ? Math.max(...xs) : .15;
      const minY = ys.length ? Math.min(...ys) : -.15, maxY = ys.length ? Math.max(...ys) : .15;
      const scale = Math.min(w * .7 / Math.max(.14, maxX - minX), h * .66 / Math.max(.14, maxY - minY));
      project = p => { const q = point(p); return { x: w / 2 + (q.x - (minX + maxX) / 2) * scale, y: h * .48 - (q.y - (minY + maxY) / 2) * scale, depth: 1 }; };
    }

    const line = (a: Vec3, b: Vec3, color: string, width = 1, alpha = 1) => {
      const p = project(a), q = project(b);
      if (!p || !q) return;
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.globalAlpha = 1;
    };
    if (view === 'world') {
      for (let n = -5; n <= 5; n++) {
        line({ x: focus.x + n * .25, y: 0, z: focus.z - 1.25 }, { x: focus.x + n * .25, y: 0, z: focus.z + 1.25 }, '#34505b', .65, .7);
        line({ x: focus.x - 1.25, y: 0, z: focus.z + n * .25 }, { x: focus.x + 1.25, y: 0, z: focus.z + n * .25 }, '#34505b', .65, .7);
      }
    } else {
      ctx.strokeStyle = '#27404a'; ctx.lineWidth = .6;
      for (let x = w / 2 % 40; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = h / 2 % 40; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.strokeStyle = '#66838d'; ctx.beginPath(); ctx.moveTo(w / 2 - 5, h / 2); ctx.lineTo(w / 2 + 5, h / 2); ctx.moveTo(w / 2, h / 2 - 5); ctx.lineTo(w / 2, h / 2 + 5); ctx.stroke();
    }

    if (trail && take && sample && view === 'world') {
      const start = Math.max(0, time - 2400);
      let prev: TrackingSample | undefined;
      let lo = 0, hi = take.samples.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (take.samples[mid].t < start) lo = mid + 1; else hi = mid; }
      for (let index = lo; index < take.samples.length; index++) {
        const item = take.samples[index];
        if (item.t > time) break;
        if (item.spaceId !== sample.spaceId) { prev = undefined; continue; }
        if (prev && item.t - prev.t <= 100) {
          const alpha = .12 + .52 * ((item.t - start) / Math.max(1, time - start));
          if (item.head && prev.head) line(prev.head.position, item.head.position, COLORS.head, 1.1, alpha);
          for (const side of ['left', 'right'] as const) {
            const a = prev.hands[side].joints.wrist, b = item.hands[side].joints.wrist;
            if (a && b) line(a.position, b.position, COLORS[side], 1.2, alpha);
          }
        }
        prev = item;
      }
    }

    if (sample?.head && view === 'world') {
      const head = sample.head, p = head.position;
      const local = (v: Vec3) => add(p, rotate(v, head.orientation));
      const corners = [local({ x: -.09, y: -.045, z: -.055 }), local({ x: .09, y: -.045, z: -.055 }), local({ x: .09, y: .045, z: -.055 }), local({ x: -.09, y: .045, z: -.055 })];
      for (let i = 0; i < 4; i++) line(corners[i], corners[(i + 1) % 4], COLORS.head, 1.4);
      line(p, local({ x: .23, y: 0, z: 0 }), '#e89b8c', 1.4); line(p, local({ x: 0, y: .23, z: 0 }), '#a4ca8a', 1.4); line(p, local({ x: 0, y: 0, z: -.28 }), '#86b9db', 1.4);
      ctx.setLineDash([3, 5]);
      for (const c of [{ x: -.22, y: -.15, z: -.43 }, { x: .22, y: -.15, z: -.43 }, { x: .22, y: .15, z: -.43 }, { x: -.22, y: .15, z: -.43 }]) line(p, local(c), COLORS.head, .8, .35);
      ctx.setLineDash([]);
      const label = project(local({ x: 0, y: .13, z: 0 }));
      if (label) { ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = COLORS.head; ctx.fillText('HEAD', label.x + 5, label.y); }
    }

    if (sample) for (const side of ['left', 'right'] as const) {
      if ((view === 'left' || view === 'right') && side !== view) continue;
      const hand = sample.hands[side];
      if (hand.source !== 'hand') continue;
      const color = COLORS[side];
      ctx.lineCap = 'round';
      for (const [a, b] of HAND_BONES) {
        const ja = hand.joints[a], jb = hand.joints[b];
        if (ja && jb) line(ja.position, jb.position, color, view === 'left' || view === 'right' ? 2.6 : 1.8, .9);
      }
      for (const [name, joint] of Object.entries(hand.joints)) {
        if (!joint) continue;
        const p = project(joint.position);
        if (!p || p.x < -10 || p.y < -10 || p.x > w + 10 || p.y > h + 10) continue;
        const r = view === 'left' || view === 'right' ? (name.endsWith('tip') ? 4.4 : 3.4) : (name.endsWith('tip') ? 3 : 2.2);
        ctx.fillStyle = name.endsWith('tip') ? color : '#15252c'; ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const wrist = hand.joints.wrist;
      const projected = wrist ? project(wrist.position) : null;
      if (projected) {
        ctx.fillStyle = color; ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(`${side === 'left' ? 'L' : 'R'}${hand.pinching ? ' · PINCH' : ''}`, projected.x + 8, projected.y + 15);
      }
    }
    if (view === 'world') this.axisKey(ctx, w - 32, h - 32);
  }

  private axisKey(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.font = '8px ui-monospace, monospace'; ctx.lineWidth = 1.2;
    for (const [dx, dy, label, color] of [[18, 5, 'X', '#cf938c'], [0, -20, 'Y', '#a3bf88'], [-14, 9, 'Z', '#8daecb']] as const) {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.stroke(); ctx.fillText(label, x + dx + 2, y + dy + 3);
    }
  }
}

const coverageCache = new WeakMap<HTMLCanvasElement, { take: TrackingTake | null; width: number; height: number; data: ImageData }>();
export function drawCoverage(canvas: HTMLCanvasElement, take: TrackingTake | null, time: number): void {
  const dims = context(canvas);
  if (!dims) return;
  const { ctx, w, h } = dims;
  const cached = coverageCache.get(canvas);
  if (cached && cached.take === take && cached.width === canvas.width && cached.height === canvas.height) {
    ctx.putImageData(cached.data, 0, 0);
    if (take?.durationMs) { ctx.fillStyle = '#e9fff5'; ctx.fillRect(Math.min(w - 1, time / take.durationMs * w), 0, 1, h); }
    return;
  }
  const lane = h / 3;
  for (let i = 0; i < 3; i++) { ctx.fillStyle = '#2a383e'; ctx.fillRect(0, i * lane, w, lane - 2); }
  if (!take?.durationMs) return;
  const boundaries = take.events.filter(e => ['space', 'xr', 'reference-space-reset', 'space-reset'].includes(e.type));
  let boundaryIndex = 0;
  for (let i = 0; i < take.samples.length; i++) {
    const s = take.samples[i], next = take.samples[i + 1];
    while (boundaries[boundaryIndex]?.t <= s.t) boundaryIndex++;
    const end = Math.min(s.t + 100, next?.t ?? take.durationMs, boundaries[boundaryIndex]?.t ?? take.durationMs, take.durationMs);
    const x = s.t / take.durationMs * w, width = Math.max(.5, (end - s.t) / take.durationMs * w);
    const present = [Boolean(s.head), s.hands.left.source === 'hand' && Object.keys(s.hands.left.joints).length > 0, s.hands.right.source === 'hand' && Object.keys(s.hands.right.joints).length > 0];
    const colors = [COLORS.head, COLORS.left, COLORS.right];
    present.forEach((yes, index) => { if (yes) { ctx.fillStyle = colors[index]; ctx.globalAlpha = .6; ctx.fillRect(x, index * lane, width, lane - 2); } });
  }
  ctx.globalAlpha = 1;
  coverageCache.set(canvas, { take, width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height) });
  ctx.fillStyle = '#e9fff5'; ctx.fillRect(Math.min(w - 1, time / take.durationMs * w), 0, 1, h);
}
