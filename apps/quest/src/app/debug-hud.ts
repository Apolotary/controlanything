/**
 * The shell's own minimal HUD: implements the HUD contract with canvas plates and lines so every data flow
 * (scan → tags → lock → hack menu → controls → evidence, pairing, voice) can be exercised and screenshot
 * before gen3d-lead's renderer lands, and as a fallback on the headset. Not the product look.
 */
import type { ControlValue, Gen3dSpec, HackItem, ModelChip, Patch } from '@ce/gen3d';
import QRCode from 'qrcode';
import {
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Quaternion,
  Raycaster,
  SphereGeometry,
  Vector3,
} from 'three';
import { Emitter } from './emitter';
import type {
  AgentStepLike,
  ApprovalView,
  ConfirmView,
  DeckKey,
  EvidenceView,
  Hud,
  HudEvents,
  HudFrame,
  HudTarget,
  PingLine,
  UploadState,
  V3,
} from './hud-contract';
import { hexA, PALETTE, Panel } from './panel';

interface TargetView {
  t: HudTarget;
  group: Group;
  label: Panel;
  /** label placement: along the target plane's up axis, above the outline's top edge */
  labelUp: Vector3;
  labelTop: number;
  outline?: Line;
  brackets?: LineLoop[];
  dot: Mesh;
}

interface SpecView {
  spec: Gen3dSpec;
  panel: Panel;
  values: Record<string, ControlValue>;
  armed: boolean;
  armedReason?: string;
  at: { targetId?: string; position?: V3; yawDeg?: number };
}

const STATUS_COLOR: Record<string, string> = {
  scanned: PALETTE.cyan,
  candidate: PALETTE.volt,
  locked: PALETTE.volt,
  linking: PALETTE.magenta,
  linked: PALETTE.cyan,
  pinging: PALETTE.cyan,
  uploading: PALETTE.volt,
  verified: PALETTE.ok,
  controlled: PALETTE.ok,
  running: PALETTE.magenta,
  failed: PALETTE.fail,
  offline: PALETTE.dim,
};

export class DebugHud implements Hud {
  readonly root = new Group();
  private readonly events = new Emitter<HudEvents>();
  private readonly targets = new Map<string, TargetView>();
  private readonly specs = new Map<string, SpecView>();
  private readonly steps = new Map<string, AgentStepLike>();
  private readonly world = new Group();
  private readonly pingGroup = new Group();
  private readonly raycaster = new Raycaster();
  private candidate: string | null = null;
  private locked: string | null = null;
  private scanning = false;
  private scanInfo: { prompts?: number; startedAt?: number; modelId?: string; pending?: number } = {};
  private chips: ModelChip[] = [];
  private voice: { listening: boolean; level?: number; partial?: string; final?: string } = { listening: false };
  private toastText = '';
  private toastLevel: 'info' | 'ok' | 'warn' | 'error' = 'info';
  private toastUntil = 0;
  private placed = false;
  private readonly head = { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion() };
  // panels
  private readonly deck = new Panel(250, 96, { name: 'deck' });
  private readonly log = new Panel(250, 150, { name: 'worklog' });
  private readonly toastPanel = new Panel(220, 26, { name: 'toast', depthTest: false, renderOrder: 50 });
  private readonly menu = new Panel(150, 150, { name: 'hack-menu' });
  private readonly evidence = new Panel(230, 26, { name: 'evidence' });
  private readonly center = new Panel(210, 130, { name: 'center-card' });
  private menuState: { targetId: string; title: string; subtitle?: string; items: HackItem[] } | null = null;
  private upload: UploadState | null = null;
  private evidenceView: EvidenceView | null = null;
  private pairing: { display: string; qr: string; message?: string } | null = null;
  private qrImage?: HTMLCanvasElement;
  private approvals: ApprovalView[] = [];
  private confirm: ConfirmView | null = null;
  private deckState = { scanning: false, daemons: false };
  private dirty = new Set<string>(['deck', 'log']);
  private holdStart = 0;

  constructor() {
    this.root.name = 'debug-hud';
    this.root.add(this.world, this.pingGroup);
    for (const p of [this.deck, this.log, this.menu, this.evidence, this.center]) this.world.add(p.mesh);
    this.root.add(this.toastPanel.mesh);
    this.menu.mesh.visible = false;
    this.evidence.mesh.visible = false;
    this.center.mesh.visible = false;
    this.toastPanel.mesh.visible = false;
  }

  on<K extends keyof HudEvents>(type: K, fn: (e: HudEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  // --- frame ---------------------------------------------------------------------------------

  update(f: HudFrame): void {
    this.head.position.copy(f.head.position);
    this.head.quaternion.copy(f.head.quaternion);
    if (!this.placed && f.head.position.lengthSq() > 0) this.placeFixedPanels(f);
    // billboard labels toward the head (yaw only), at a constant angular size (legible at the ceiling too)
    for (const v of this.targets.values()) {
      const d = v.group.position.distanceTo(this.head.position);
      const k = Math.min(4, Math.max(1, d / 0.7));
      v.label.mesh.scale.setScalar(k);
      v.label.mesh.position.copy(v.labelUp).multiplyScalar(v.labelTop + 0.03 * k);
      faceYaw(v.label.mesh, this.head.position);
    }
    if (this.menu.mesh.visible) faceYaw(this.menu.mesh, this.head.position);
    for (const s of this.specs.values()) faceYaw(s.panel.mesh, this.head.position);
    // toast follows the head lazily
    const now = performance.now();
    if (this.toastPanel.mesh.visible && now > this.toastUntil) this.toastPanel.mesh.visible = false;
    if (this.toastPanel.mesh.visible) {
      const fwd = new Vector3(0, 0, -1).applyQuaternion(this.head.quaternion);
      const target = this.head.position.clone().addScaledVector(fwd, 0.7).add(new Vector3(0, -0.12, 0));
      this.toastPanel.mesh.position.lerp(target, 0.2);
      faceYaw(this.toastPanel.mesh, this.head.position);
    }
    if (this.scanning) this.dirty.add('deck');
    // pinch picking on our plates
    for (const hand of ['left', 'right'] as const) {
      const h = f.hands[hand];
      if (!h) continue;
      if (h.justPinched) {
        this.holdStart = now;
        const hit = this.pickAt(h.ray.origin, h.ray.dir);
        if (hit) this.events.emit('consumed', { hand, widget: hit === this.deck ? 'deck' : hit === this.menu ? 'hack' : 'control' });
      }
      if (h.justReleased && this.deckPressed) {
        this.events.emit('deck', { key: this.deckPressed, phase: 'release' });
        this.deckPressed = null;
      }
    }
    this.redraw();
  }

  private deckPressed: DeckKey | null = null;

  private pickAt(origin: Vector3, dir: Vector3): Panel | null {
    this.raycaster.set(origin, dir.clone().normalize());
    const meshes: Object3D[] = [];
    for (const p of this.allPanels()) if (p.mesh.visible) meshes.push(p.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit?.uv) return null;
    const panel = hit.object.userData.panel as Panel | undefined;
    if (!panel) return null;
    return panel.pick(hit.uv) ? panel : null;
  }

  private allPanels(): Panel[] {
    return [this.deck, this.log, this.menu, this.evidence, this.center, ...[...this.specs.values()].map((s) => s.panel)];
  }

  /** World-lock the deck and the work log relative to the first head pose. */
  private placeFixedPanels(f: HudFrame): void {
    this.placed = true;
    const yaw = yawOf(f.head.quaternion);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    const at = (x: number, y: number, z: number) => new Vector3(x, y, z).applyQuaternion(q).add(f.head.position);
    this.deck.mesh.position.copy(at(-0.32, -0.32, -0.55));
    this.deck.mesh.quaternion.copy(q).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.5));
    this.log.mesh.position.copy(at(0.55, -0.05, -0.75));
    this.log.mesh.quaternion.copy(q).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.5));
    this.center.mesh.position.copy(at(0, -0.05, -0.65));
    this.center.mesh.quaternion.copy(q);
    this.toastPanel.mesh.position.copy(at(0, -0.12, -0.7));
  }

  // --- SCAN ----------------------------------------------------------------------------------

  setScanning(on: boolean, info: { prompts?: number; startedAt?: number; modelId?: string; pending?: number } = {}): void {
    this.scanning = on;
    this.scanInfo = { ...this.scanInfo, ...info };
    this.deckState.scanning = on;
    this.dirty.add('deck');
  }

  upsertTarget(t: HudTarget): void {
    let v = this.targets.get(t.id);
    if (!v) {
      const group = new Group();
      group.name = `target:${t.id}`;
      const label = new Panel(150, 32, { name: `tag:${t.id}` });
      const dot = new Mesh(new SphereGeometry(0.008, 12, 8), new MeshBasicMaterial({ color: PALETTE.cyan }));
      group.add(label.mesh, dot);
      this.world.add(group);
      v = { t, group, label, dot, labelUp: new Vector3(0, 1, 0), labelTop: 0.05 };
      this.targets.set(t.id, v);
    }
    v.t = t;
    v.group.position.set(...t.position);
    this.rebuildOutline(v);
    this.drawTag(v);
  }

  removeTarget(id: string): void {
    const v = this.targets.get(id);
    if (!v) return;
    this.world.remove(v.group);
    v.label.dispose();
    this.targets.delete(id);
  }

  clearTargets(): void {
    for (const id of [...this.targets.keys()]) this.removeTarget(id);
  }

  setCandidate(id: string | null): void {
    if (this.candidate === id) return;
    const prev = this.candidate;
    this.candidate = id;
    for (const tid of [prev, id]) {
      const v = tid ? this.targets.get(tid) : undefined;
      if (v) {
        this.rebuildOutline(v);
        this.drawTag(v);
      }
    }
  }

  setLocked(id: string | null): void {
    const prev = this.locked;
    this.locked = id;
    for (const tid of [prev, id]) {
      const v = tid ? this.targets.get(tid) : undefined;
      if (v) {
        this.rebuildOutline(v);
        this.drawTag(v);
      }
    }
  }

  private rebuildOutline(v: TargetView): void {
    if (v.outline) v.group.remove(v.outline);
    for (const b of v.brackets ?? []) v.group.remove(b);
    v.brackets = undefined;
    const t = v.t;
    const isLocked = this.locked === t.id;
    const isCandidate = this.candidate === t.id;
    const color = isLocked || isCandidate ? PALETTE.volt : (STATUS_COLOR[t.status] ?? PALETTE.cyan);
    const facing = new Vector3(...(t.facing ?? [0, 0, 1])).normalize();
    const { right, up } = basis(facing);
    const contour = t.contour?.length ? t.contour : box2(t.sizeM?.[0] ?? 0.2, t.sizeM?.[1] ?? 0.1);
    const pts = contour.map(([x, y]) => right.clone().multiplyScalar(x).addScaledVector(up, y));
    pts.push(pts[0].clone());
    const geo = new BufferGeometry().setFromPoints(pts);
    const mat = t.confirmed
      ? new LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false })
      : new LineDashedMaterial({ color, dashSize: 0.015, gapSize: 0.01, transparent: true, opacity: 0.9, depthTest: false });
    const line = new Line(geo, mat);
    if (!t.confirmed) line.computeLineDistances();
    line.renderOrder = 20;
    v.outline = line;
    v.group.add(line);
    // tag above the outline's top edge
    const top = Math.max(...contour.map(([, y]) => y), 0.03);
    v.labelUp.copy(up);
    v.labelTop = top;
    v.label.mesh.position.copy(up.clone().multiplyScalar(top + 0.03));
    (v.dot.material as MeshBasicMaterial).color.set(color);
    if (isLocked || isCandidate) {
      const xs = contour.map(([x]) => x);
      const ys = contour.map(([, y]) => y);
      const pad = isLocked ? 0.01 : 0.025;
      const x0 = Math.min(...xs) - pad;
      const x1 = Math.max(...xs) + pad;
      const y0 = Math.min(...ys) - pad;
      const y1 = Math.max(...ys) + pad;
      const leg = Math.min(0.03, (x1 - x0) / 3, (y1 - y0) / 3);
      const corners: [number, number, number, number][] = [
        [x0, y0, 1, 1],
        [x1, y0, -1, 1],
        [x1, y1, -1, -1],
        [x0, y1, 1, -1],
      ];
      v.brackets = corners.map(([cx, cy, sx, sy]) => {
        const p = (x: number, y: number) => right.clone().multiplyScalar(x).addScaledVector(up, y);
        const g = new BufferGeometry().setFromPoints([p(cx + sx * leg, cy), p(cx, cy), p(cx, cy + sy * leg)]);
        const l = new LineLoop(g, new LineBasicMaterial({ color: PALETTE.volt, depthTest: false }));
        l.renderOrder = 21;
        v.group.add(l);
        return l;
      });
    }
  }

  private drawTag(v: TargetView): void {
    const t = v.t;
    const isLocked = this.locked === t.id;
    const edge = isLocked || this.candidate === t.id ? PALETTE.volt : (STATUS_COLOR[t.status] ?? PALETTE.cyan);
    v.label.draw(
      (_c, p) => {
        p.text(t.label.toUpperCase(), 5, 13, { size: 6.5, color: PALETTE.bone, maxMm: 140 });
        const sub = [t.channel?.toUpperCase(), isLocked ? 'locked' : t.subtitle ?? t.status, t.confirmed ? '' : 'depth ~'].filter(Boolean).join(' · ');
        p.text(sub, 5, 26, { size: 4.5, color: PALETTE.dim, font: 'mono', maxMm: 140 });
      },
      { edge },
    );
  }

  // --- PING ----------------------------------------------------------------------------------

  setPing(lines: PingLine[]): void {
    this.pingGroup.clear();
    const hub = this.head.position.clone().add(new Vector3(-0.6, -0.9, -0.3));
    for (const l of lines) {
      const tv = this.targets.get(l.targetId);
      if (!tv) continue;
      const from = l.from ? new Vector3(...l.from) : hub;
      const to = tv.group.position.clone();
      const mid = from.clone().lerp(to, 0.5).add(new Vector3(0, -0.15, 0));
      const pts = [from, mid, to];
      const geo = new BufferGeometry().setFromPoints(pts);
      const color = l.proven ? (l.channel === 'ir' ? PALETTE.magenta : PALETTE.cyan) : PALETTE.dim;
      const mat = l.proven ? new LineBasicMaterial({ color }) : new LineDashedMaterial({ color, dashSize: 0.04, gapSize: 0.03 });
      const line = new Line(geo, mat);
      if (!l.proven) line.computeLineDistances();
      this.pingGroup.add(line);
    }
  }

  // --- work log ------------------------------------------------------------------------------

  logStep(step: AgentStepLike): void {
    this.steps.set(step.stepId, step);
    if (this.steps.size > 40) this.steps.delete(this.steps.keys().next().value as string);
    this.dirty.add('log');
  }

  setModelChips(chips: ModelChip[]): void {
    this.chips = chips;
    this.dirty.add('deck');
  }

  // --- HACKS ---------------------------------------------------------------------------------

  showHackMenu(targetId: string, menu: { title: string; subtitle?: string; items: HackItem[] }): void {
    this.menuState = { targetId, ...menu };
    const tv = this.targets.get(targetId);
    const base = tv ? tv.group.position.clone() : this.head.position.clone().add(new Vector3(0.25, -0.1, -0.6));
    const toHead = this.head.position.clone().sub(base).setY(0).normalize();
    const right = new Vector3(0, 1, 0).cross(toHead).normalize();
    this.menu.mesh.position.copy(base).addScaledVector(right, 0.22).add(new Vector3(0, 0.02, 0));
    this.menu.mesh.visible = true;
    this.dirty.add('menu');
  }

  hideHackMenu(): void {
    this.menuState = null;
    this.menu.mesh.visible = false;
  }

  setUpload(u: UploadState | null): void {
    this.upload = u;
    this.dirty.add('menu');
  }

  showEvidence(e: EvidenceView | null): void {
    this.evidenceView = e;
    if (!e) {
      this.evidence.mesh.visible = false;
      return;
    }
    const tv = e.targetId ? this.targets.get(e.targetId) : undefined;
    const base = tv ? tv.group.position.clone().add(new Vector3(0, -0.12, 0)) : this.head.position.clone().add(new Vector3(0, -0.25, -0.6));
    this.evidence.mesh.position.copy(base);
    faceYaw(this.evidence.mesh, this.head.position);
    this.evidence.mesh.visible = true;
    this.dirty.add('evidence');
  }

  // --- generated controls ----------------------------------------------------------------------

  renderSpec(spec: Gen3dSpec, at: { targetId?: string; position?: V3; yawDeg?: number }): void {
    let sv = this.specs.get(spec.specId);
    const rows = Math.max(1, spec.controls.length);
    if (!sv || sv.spec.controls.length !== spec.controls.length) {
      if (sv) {
        this.world.remove(sv.panel.mesh);
        sv.panel.dispose();
      }
      const panel = new Panel(200, 24 + rows * 22, { name: `spec:${spec.specId}` });
      this.world.add(panel.mesh);
      sv = { spec, panel, values: {}, armed: spec.state?.armed ?? true, at };
      this.specs.set(spec.specId, sv);
    }
    sv.spec = spec;
    sv.at = at;
    sv.armed = spec.state?.armed ?? sv.armed;
    sv.armedReason = spec.state?.reason;
    for (const c of spec.controls) if (sv.values[c.id] === undefined) sv.values[c.id] = c.default ?? (c.kind === 'toggle' ? false : c.kind === 'trigger' ? false : (c.range?.min ?? 0));
    // place: beside the target, at an explicit position, or in front of the user
    const tv = at.targetId ? this.targets.get(at.targetId) : undefined;
    if (at.position) sv.panel.mesh.position.set(...at.position);
    else if (tv) {
      const base = tv.group.position.clone();
      const toHead = this.head.position.clone().sub(base).setY(0).normalize();
      const left = toHead.clone().cross(new Vector3(0, 1, 0)).normalize();
      sv.panel.mesh.position.copy(base).addScaledVector(left, 0.25).addScaledVector(toHead, 0.1);
    } else {
      const fwd = new Vector3(0, 0, -1).applyQuaternion(this.head.quaternion).setY(0).normalize();
      sv.panel.mesh.position.copy(this.head.position).addScaledVector(fwd, 0.6).add(new Vector3(0, -0.15, 0));
    }
    this.drawSpec(sv);
  }

  removeSpec(specId: string): void {
    const sv = this.specs.get(specId);
    if (!sv) return;
    this.world.remove(sv.panel.mesh);
    sv.panel.dispose();
    this.specs.delete(specId);
  }

  patchSpec(specId: string, _patch: Patch): { ok: boolean; errors?: string[] } {
    // the debug HUD does not apply patches itself; the server re-sends the full spec as ui.spec rev+1
    this.toast(`edit for ${specId} received`, 'info');
    return { ok: false, errors: ['the debug HUD does not apply patches'] };
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    for (const p of this.allPanels()) p.dispose();
    this.toastPanel.dispose();
    for (const v of this.targets.values()) v.label.dispose();
  }

  setArmed(specId: string, armed: boolean, reason?: string): void {
    const sv = this.specs.get(specId);
    if (!sv) return;
    sv.armed = armed;
    sv.armedReason = reason;
    this.drawSpec(sv);
  }

  setControlValue(specId: string, controlId: string, value: ControlValue): void {
    const sv = this.specs.get(specId);
    if (!sv) return;
    sv.values[controlId] = value;
    this.drawSpec(sv);
  }

  private drawSpec(sv: SpecView): void {
    const spec = sv.spec;
    sv.panel.draw(
      (c, p) => {
        p.text(spec.title.toUpperCase(), 5, 13, { size: 6, maxMm: 120 });
        p.text(sv.armed ? 'ARMED' : `DISARMED${sv.armedReason ? ` · ${sv.armedReason}` : ''}`, 195, 13, { size: 4, align: 'right', font: 'mono', color: sv.armed ? PALETTE.ok : PALETTE.dim, maxMm: 70 });
        spec.controls.forEach((ctl, i) => {
          const y = 22 + i * 22;
          const v = sv.values[ctl.id];
          const armed = sv.armed && ctl.armed !== false;
          c.fillStyle = hexA(PALETTE.void, 0.9);
          c.fillRect(10, y * 2, 380, 36);
          p.text(ctl.label, 8, y + 12, { size: 5, color: armed ? PALETTE.bone : PALETTE.dim, maxMm: 60 });
          if (ctl.kind === 'continuous' || ctl.kind === 'stepped') {
            const min = ctl.range?.min ?? 0;
            const max = ctl.range?.max ?? 1;
            const frac = typeof v === 'number' ? (v - min) / (max - min || 1) : 0;
            c.fillStyle = hexA(PALETTE.cyan, 0.25);
            c.fillRect(140, y * 2 + 8, 200, 20);
            c.fillStyle = armed ? PALETTE.volt : PALETTE.dim;
            c.fillRect(140, y * 2 + 8, 200 * Math.max(0, Math.min(1, frac)), 20);
            const label = ctl.stepLabels && typeof v === 'number' ? (ctl.stepLabels[Math.round(v - min)] ?? String(v)) : `${typeof v === 'number' ? Math.round(v * 100) / 100 : ''}${ctl.unit ?? ''}`;
            p.text(label, 195, y + 12, { size: 4.5, align: 'right', font: 'mono', color: PALETTE.bone });
            p.region(`ctl:${ctl.id}`, 70, y, 100, 18, (fx) => armed && this.setFromPanel(sv, ctl.id, min + fx * (max - min), ctl.range?.step));
          } else if (ctl.kind === 'toggle') {
            p.button(`ctl:${ctl.id}`, v ? 'ON' : 'OFF', 140, y + 1, 50, 16, () => armed && this.setFromPanel(sv, ctl.id, !v), { active: Boolean(v) });
          } else if (ctl.kind === 'trigger') {
            p.button(`ctl:${ctl.id}`, 'RUN', 140, y + 1, 50, 16, () => armed && this.setFromPanel(sv, ctl.id, true));
          } else {
            p.text('xy', 195, y + 12, { size: 4.5, align: 'right', font: 'mono', color: PALETTE.dim });
          }
        });
      },
      { edge: sv.armed ? PALETTE.cyan : PALETTE.dim },
    );
  }

  private setFromPanel(sv: SpecView, controlId: string, value: ControlValue, step?: number): void {
    let v = value;
    if (typeof v === 'number' && step) v = Math.round(v / step) * step;
    if (typeof v !== 'boolean' || sv.spec.controls.find((c) => c.id === controlId)?.kind !== 'trigger') sv.values[controlId] = v;
    this.drawSpec(sv);
    this.events.emit('control', { controlId, value: v, phase: 'end', ts: Date.now(), specId: sv.spec.specId });
  }

  // --- pairing, voice, deck, toast -----------------------------------------------------------------

  showPairing(p: { display: string; qr: string; message?: string } | null): void {
    this.pairing = p;
    this.qrImage = undefined;
    if (p) {
      const canvas = document.createElement('canvas');
      void QRCode.toCanvas(canvas, p.qr, { margin: 1, width: 180, color: { dark: '#0A0E12', light: '#F3F7FA' } }).then(() => {
        this.qrImage = canvas;
        this.dirty.add('center');
      });
    }
    this.dirty.add('center');
  }

  showApprovals(list: ApprovalView[]): void {
    this.approvals = list;
    this.dirty.add('center');
  }

  showConfirm(c: ConfirmView | null): void {
    this.confirm = c;
    this.dirty.add('center');
  }

  setVoice(v: { listening: boolean; level?: number; partial?: string; final?: string }): void {
    this.voice = { ...this.voice, ...v };
    if (v.listening) this.voice.final = v.final;
    this.dirty.add('deck');
  }

  setDeck(d: { open?: boolean; scanning?: boolean; daemons?: boolean; at?: V3 }): void {
    if (d.scanning !== undefined) this.deckState.scanning = d.scanning;
    if (d.daemons !== undefined) this.deckState.daemons = d.daemons;
    if (d.at) {
      this.deck.mesh.position.set(...d.at);
      faceYaw(this.deck.mesh, this.head.position);
    }
    if (d.open !== undefined) this.deck.mesh.visible = d.open || true;
    this.dirty.add('deck');
  }

  toast(text: string, level: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
    this.toastText = text;
    this.toastLevel = level;
    this.toastUntil = performance.now() + 3500;
    this.toastPanel.mesh.visible = true;
    this.dirty.add('toast');
  }

  // --- drawing ---------------------------------------------------------------------------------------

  private redraw(): void {
    if (this.dirty.has('deck')) this.drawDeck();
    if (this.dirty.has('log')) this.drawLog();
    if (this.dirty.has('menu')) this.drawMenu();
    if (this.dirty.has('evidence')) this.drawEvidence();
    if (this.dirty.has('center')) this.drawCenter();
    if (this.dirty.has('toast')) this.drawToast();
    this.dirty.clear();
  }

  private drawDeck(): void {
    const press = (key: DeckKey) => () => {
      this.deckPressed = key;
      this.events.emit('deck', { key, phase: 'press' });
    };
    this.deck.draw((_c, p) => {
      const keys: [DeckKey, string][] = [
        ['scan', 'SCAN'],
        ['ping', 'PING'],
        ['daemons', 'DAEMONS'],
        ['undo', 'UNDO'],
        ['mic', this.voice.listening ? 'MIC ●' : 'MIC'],
      ];
      keys.forEach(([k, label], i) => p.button(`deck:${k}`, label, 5 + i * 48.5, 6, 44, 22, press(k), { active: (k === 'scan' && this.deckState.scanning) || (k === 'mic' && this.voice.listening) || (k === 'daemons' && this.deckState.daemons) }));
      const s = this.scanInfo;
      const scanLine = this.scanning
        ? `SCANNING · ${s.pending ?? 0} pending · ${s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0} s${s.modelId ? ` · ${s.modelId}` : ''}`
        : 'idle · pinch SCAN';
      p.text(scanLine, 6, 40, { size: 5, font: 'mono', color: this.scanning ? PALETTE.cyan : PALETTE.dim, maxMm: 238 });
      const chips = this.chips.map((c) => `${c.id}${c.state === 'live' ? ' ●' : c.state === 'error' ? ' ✗' : ''}`).join('  ');
      p.text(chips || 'no model calls yet', 6, 52, { size: 4.5, font: 'mono', color: PALETTE.dim, maxMm: 238 });
      const v = this.voice;
      const voiceLine = v.listening ? `● listening${v.partial ? ` · ${v.partial}` : ''}` : v.final ? `“${v.final}”` : v.partial ? v.partial : '';
      if (voiceLine) p.text(voiceLine, 6, 64, { size: 5, color: v.listening ? PALETTE.volt : PALETTE.bone, maxMm: 238 });
      p.button('deck:panic', 'STOP ALL', 196, 72, 49, 18, press('panic'), { color: PALETTE.fail });
    });
  }

  private drawLog(): void {
    const steps = [...this.steps.values()].slice(-9);
    this.log.draw((_c, p) => {
      p.text('AGENT · WORK LOG', 5, 11, { size: 5.5, color: PALETTE.cyan });
      steps.forEach((s, i) => {
        const y = 24 + i * 14;
        const color = s.status === 'ok' ? PALETTE.ok : s.status === 'fail' ? PALETTE.fail : s.status === 'running' ? PALETTE.volt : PALETTE.dim;
        p.text(s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : s.status === 'running' ? '…' : '·', 5, y, { size: 5, color });
        p.text(s.title, 12, y, { size: 4.6, color: PALETTE.bone, maxMm: s.model ? 150 : 232 });
        if (s.model) p.text(s.model, 245, y, { size: 3.8, font: 'mono', align: 'right', color: PALETTE.cyan, maxMm: 80 });
      });
      if (!steps.length) p.text('waiting for the agent…', 5, 26, { size: 4.5, color: PALETTE.dim });
    });
  }

  private drawMenu(): void {
    const m = this.menuState;
    if (!m) return;
    const items = m.items.slice(0, 6);
    this.menu.draw((_c, p) => {
      p.text(m.title.toUpperCase(), 5, 12, { size: 5.5, color: PALETTE.bone, maxMm: 140 });
      if (m.subtitle) p.text(m.subtitle, 5, 21, { size: 3.8, color: PALETTE.dim, font: 'mono', maxMm: 140 });
      items.forEach((it, i) => {
        const y = 26 + i * 18;
        const pip = it.status === 'verified' ? '✓' : it.status === 'failed' ? '✗' : '—';
        p.button(`hack:${it.id}`, `${it.kind === 'control' ? '◎' : it.kind === 'daemon' ? '∞' : '▸'} ${it.label}  ${pip}`, 5, y, 140, 15, () =>
          this.events.emit('hack', { targetId: m.targetId, itemId: it.id, controlId: it.controlId, index: i, hold: performance.now() - this.holdStart > 600 }),
        );
      });
      const u = this.upload;
      if (u) {
        const steps = u.steps ?? ['GEN', 'CHECK', 'SEND', 'SEEN'];
        steps.forEach((s, i) => {
          const done = i < u.stepsDone;
          const color = i === steps.length - 1 && done ? (u.verdict === 'fail' ? PALETTE.fail : PALETTE.ok) : done ? PALETTE.volt : PALETTE.dim;
          p.text(s, 5 + i * 36, 140, { size: 4.2, font: 'mono', color });
        });
        if (u.modelId) p.text(`${u.modelId}${u.elapsedS ? ` · ${u.elapsedS} s` : ''}`, 145, 132, { size: 3.5, font: 'mono', align: 'right', color: PALETTE.cyan, maxMm: 140 });
      }
    });
  }

  private drawEvidence(): void {
    const e = this.evidenceView;
    if (!e) return;
    this.evidence.draw(
      (_c, p) => {
        const color = e.verdict === 'ok' ? PALETTE.ok : e.verdict === 'fail' ? PALETTE.fail : PALETTE.volt;
        p.text(`sent ${e.sent} → ${e.expect} · ${e.seen}`, 5, 16, { size: 5, color, maxMm: 220 });
      },
      { edge: e.verdict === 'ok' ? PALETTE.ok : e.verdict === 'fail' ? PALETTE.fail : PALETTE.volt },
    );
  }

  private drawCenter(): void {
    const show = Boolean(this.pairing || this.approvals.length || this.confirm);
    this.center.mesh.visible = show;
    if (!show) return;
    this.center.draw((c, p) => {
      if (this.confirm) {
        const cf = this.confirm;
        p.text('CONFIRM', 6, 12, { size: 5, color: PALETTE.volt });
        p.text(cf.title, 6, 26, { size: 6, maxMm: 198 });
        if (cf.summary) p.text(cf.summary, 6, 38, { size: 4.2, color: PALETTE.dim, maxMm: 198 });
        p.button('confirm:yes', cf.hold ? 'HOLD TO ARM' : 'ARM', 6, 48, 95, 22, () => this.events.emit('confirm', { id: cf.id, approve: true, hold: cf.hold }), { color: PALETTE.ok });
        p.button('confirm:no', 'CANCEL', 108, 48, 95, 22, () => this.events.emit('confirm', { id: cf.id, approve: false }));
        return;
      }
      if (this.approvals.length) {
        p.text('WANTS TO JOIN · look at its QR or pinch', 6, 12, { size: 4.5, color: PALETTE.magenta, maxMm: 198 });
        this.approvals.slice(0, 3).forEach((a, i) => {
          const y = 18 + i * 34;
          p.text(`${a.name} (${a.kind})`, 6, y + 10, { size: 5.5, maxMm: 120 });
          p.text(a.display, 6, y + 22, { size: 6, font: 'mono', color: PALETTE.volt });
          p.button(`approve:${a.pairingId}`, 'APPROVE', 120, y + 3, 40, 22, () => this.events.emit('approve', { pairingId: a.pairingId, approve: true }), { color: PALETTE.ok });
          p.button(`deny:${a.pairingId}`, 'DENY', 164, y + 3, 40, 22, () => this.events.emit('approve', { pairingId: a.pairingId, approve: false }));
        });
        return;
      }
      if (this.pairing) {
        p.text('PAIR THIS HEADSET', 6, 13, { size: 5.5, color: PALETTE.cyan });
        p.text(this.pairing.display, 6, 36, { size: 12, font: 'mono', color: PALETTE.volt });
        p.text(this.pairing.message ?? 'approve on the Mac (companion) or type y in the server terminal', 6, 50, { size: 3.8, color: PALETTE.dim, maxMm: 110 });
        if (this.qrImage) c.drawImage(this.qrImage, 250, 20, 160, 160);
      }
    });
  }

  private drawToast(): void {
    const color = this.toastLevel === 'error' ? PALETTE.fail : this.toastLevel === 'warn' ? PALETTE.volt : this.toastLevel === 'ok' ? PALETTE.ok : PALETTE.cyan;
    this.toastPanel.draw((_c, p) => p.text(this.toastText, 5, 16, { size: 5, color: PALETTE.bone, maxMm: 210 }), { edge: color });
  }
}

// --- helpers ---------------------------------------------------------------------------------------

function box2(w: number, h: number): [number, number][] {
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

function basis(facing: Vector3): { right: Vector3; up: Vector3 } {
  const worldUp = new Vector3(0, 1, 0);
  const ref = Math.abs(facing.dot(worldUp)) > 0.95 ? new Vector3(0, 0, -1) : worldUp;
  const right = new Vector3().crossVectors(ref, facing).normalize();
  const up = new Vector3().crossVectors(facing, right).normalize();
  return { right, up };
}

function yawOf(q: Quaternion): number {
  const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-fwd.x, -fwd.z);
}

/** Turn an object (its +Z) toward a point, yaw only. */
function faceYaw(o: Object3D, toward: Vector3): void {
  const wp = new Vector3();
  o.getWorldPosition(wp);
  const d = toward.clone().sub(wp);
  const yaw = Math.atan2(d.x, d.z);
  const parentQ = new Quaternion();
  o.parent?.getWorldQuaternion(parentQ);
  o.quaternion.copy(parentQ.invert()).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw));
}
