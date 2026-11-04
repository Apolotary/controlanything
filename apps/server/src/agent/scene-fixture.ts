/**
 * FIXTURE scene programs: what the scripted (no-key) Muse agent run returns for "visualize …" asks, so the emulator and
 * reviewers without a Meta key see a real XR scene. Labelled FIXTURE in the code; no Meta model wrote these.
 * They use exactly the API Muse gets (scene-check.ts SCENE_API) and pass the same checks.
 */

/** A galaxy of particles the palms push around, with glowing fingertip trails and palm rings. */
export const FIXTURE_SCENE_GALAXY = `// FIXTURE scene (scripted, no Meta model): a galaxy you push with your palms, fingertip light trails.
var N = 1600, R = 0.24;                                      // stars, galaxy radius (m)
if (!mem.p) {
  mem.p = new Float32Array(N * 3); mem.v = new Float32Array(N * 3); mem.o = new Float32Array(N * 3);
  for (var i = 0; i < N; i++) {
    // three spiral arms; stars crowd towards the centre
    var r = 0.02 + Math.pow(Math.random(), 0.85) * R, a = (i % 3) * 2.094 + r * 14 + (Math.random() - 0.5) * 0.7;
    mem.o[i * 3] = r; mem.o[i * 3 + 1] = a; mem.o[i * 3 + 2] = (Math.random() - 0.5) * 0.03 * (1 - r / R * 0.7);
  }
}
var cx = 0, cy = 0.05, cz = -0.04, tilt = 0.45, dt = Math.min(s.dt, 0.05), hands = [s.right, s.left];
for (var i = 0; i < N; i++) {
  var j = i * 3, r = mem.o[j];
  mem.o[j + 1] += dt * 0.08 / Math.sqrt(r + 0.02);           // inner stars orbit faster
  var a = mem.o[j + 1], ox = Math.cos(a) * r, oz = Math.sin(a) * r;
  var hx = cx + ox, hy = cy + mem.o[j + 2] - oz * tilt, hz = cz + oz;   // the disc tilts toward the wearer
  if (!mem.ready) { mem.p[j] = hx; mem.p[j + 1] = hy; mem.p[j + 2] = hz; }
  var px = mem.p[j], py = mem.p[j + 1], pz = mem.p[j + 2], vx = mem.v[j], vy = mem.v[j + 1], vz = mem.v[j + 2];
  var ax = (hx - px) * 18 - vx * 5, ay = (hy - py) * 18 - vy * 5, az = (hz - pz) * 18 - vz * 5;   // spring home
  for (var h = 0; h < 2; h++) {                              // palms push stars away and drag them along
    var p = hands[h]; if (!p) continue;
    var dx = px - p.x, dy = py - p.y, dz = pz - p.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
    if (d < 0.14) { var w = 1 - d / 0.14; ax += dx / d * 7 * w + p.vx * 5 * w; ay += dy / d * 7 * w + p.vy * 5 * w; az += dz / d * 7 * w + p.vz * 5 * w; }
  }
  vx += ax * dt; vy += ay * dt; vz += az * dt; px += vx * dt; py += vy * dt; pz += vz * dt;
  mem.p[j] = px; mem.p[j + 1] = py; mem.p[j + 2] = pz; mem.v[j] = vx; mem.v[j + 1] = vy; mem.v[j + 2] = vz;
  var heat = Math.min(1, Math.max(0, Math.sqrt(vx * vx + vy * vy + vz * vz) - 0.04) * 6);
  var twinkle = 0.75 + 0.25 * Math.sin(s.t * 3 + i);
  draw.point(px, py, pz, 0.008 + heat * 0.01, draw.hsl(0.6 + r * 1.2 - heat * 0.45, 0.9, 0.55 + heat * 0.2), (0.45 + heat * 0.55) * twinkle);
}
mem.ready = true;
draw.sphere(cx, cy, cz, 0.018 + Math.sin(s.t * 2) * 0.002, 0xffcf8a, 0.9);   // the warm core
for (var k = 0; k < 48; k++) {                               // a faint orbit ring in the disc's plane
  var a1 = k / 48 * 6.2832, a2 = (k + 1) / 48 * 6.2832, rr = R + 0.03;
  draw.line(cx + Math.cos(a1) * rr, cy - Math.sin(a1) * rr * tilt, cz + Math.sin(a1) * rr, cx + Math.cos(a2) * rr, cy - Math.sin(a2) * rr * tilt, cz + Math.sin(a2) * rr, 0x4a7dff, 0.35);
}
var hues = [0.08, 0.5, 0.58, 0.72, 0.88];
for (var h = 0; h < 2; h++) {                                // fingertip trails and a palm ring
  var p = hands[h]; if (!p) continue;
  for (var f = 0; f < 5; f++) draw.trail((h ? 'L' : 'R') + f, p.tips[f * 3], p.tips[f * 3 + 1], p.tips[f * 3 + 2], draw.hsl(hues[f], 0.95, 0.6), 0.01 + Math.min(0.015, p.speed * 0.02));
  draw.ring(p.x, p.y, p.z, 0.045 + Math.min(0.05, p.speed * 0.04), h ? 0xff5ad0 : 0x40d8ff, 0.5 + p.pinch * 0.5, false);
}
`;

/** The visual synth's parameters as a floating light field: ripple strength, warp and zoom shape the waves. */
export const FIXTURE_SCENE_FIELD = `// FIXTURE scene (scripted, no Meta model): the visual synth's ripple parameters as a floating 3D field.
var G = 26, W = 0.6, v = s.values;
var ripples = (v.cc21 === undefined ? 64 : v.cc21) / 127, warp = (v.cc71 === undefined ? 40 : v.cc71) / 127, zoom = (v.cc74 === undefined ? 50 : v.cc74) / 127;
var tx = v.cc22 === undefined ? 0.5 : v.cc22 / 127, ty = v.cc23 === undefined ? 0.5 : v.cc23 / 127;
var k = 18 + zoom * 40, amp = 0.012 + ripples * 0.05, sx = (tx - 0.5) * W, sz = (ty - 0.5) * W - 0.05;
if (!mem.y) mem.y = new Float32Array(G * G);
for (var i = 0; i < G; i++) for (var j = 0; j < G; j++) {
  var x = (i / (G - 1) - 0.5) * W, z = (j / (G - 1) - 0.5) * W - 0.05;
  var dx = x - sx, dz = z - sz, d = Math.sqrt(dx * dx + dz * dz);
  var y = Math.sin(d * k - s.t * 3 + Math.atan2(dz, dx) * warp * 3) * amp * Math.exp(-d * 3);
  for (var h = 0; h < 2; h++) {                                // fingertips dent the field
    var p = h ? s.left : s.right; if (!p) continue;
    var fx = x - p.tip.x, fz = z - p.tip.z, fd = fx * fx + fz * fz;
    if (Math.abs(p.tip.y) < 0.12) y += Math.sin(Math.sqrt(fd) * 60 - s.t * 8) * 0.02 * Math.exp(-fd * 120);
  }
  mem.y[i * G + j] = y;
  var glow = Math.min(1, Math.abs(y) / (amp + 0.01));
  draw.point(x, y, z, 0.007 + glow * 0.006, draw.hsl(0.55 - glow * 0.12 + warp * 0.2, 0.9, 0.45 + glow * 0.25), 0.6 + glow * 0.4);
  if (i > 0) draw.line((i - 1) / (G - 1) * W - W / 2, mem.y[(i - 1) * G + j], z, x, y, z, 0x2a8cff, 0.35);
}
draw.sphere(sx, 0, sz, 0.012 + ripples * 0.012, 0xffffff, 0.8);   // where the touch lands
draw.text(-0.3, 0.12, -0.05, 'Ripples ' + Math.round(ripples * 127), 0x8ad8ff, 0.018);
draw.text(-0.05, 0.12, -0.05, 'Warp ' + Math.round(warp * 127), 0xc49bff, 0.018);
draw.text(0.18, 0.12, -0.05, 'Zoom ' + Math.round(zoom * 127), 0x7ddc98, 0.018);
`;

/** Which fixture scene a request gets, or undefined when it is not a visualization ask. */
export function fixtureScene(request: string): { title: string; code: string; explanation: string; values: boolean } | undefined {
  if (!/visuali[sz]|\b3d\b|trail|galaxy|particle|sculpture|glow|hologram|field|scene/i.test(request)) return undefined;
  if (/ripple|visual synth|parameter|field/i.test(request)) {
    return { title: 'Ripple field', code: FIXTURE_SCENE_FIELD, values: true,
      explanation: 'The floating field shows Ripples, Warp and Zoom; twist the knobs or dip a fingertip into it. Hold both palms out still to stop.' };
  }
  return { title: 'Galaxy and light trails', code: FIXTURE_SCENE_GALAXY, values: false,
    explanation: 'Push the galaxy with your palms; your fingertips leave light trails. Hold both palms out still to stop.' };
}
