/** Renderer presence is distinct from the headless virtual MIDI port's saved state. */
export const VISUAL_PRESENCE_CHANNEL = 'ce-visual-synth-presence-v1';
export const VISUAL_HEARTBEAT_MS = 1000;
export const VISUAL_STALE_MS = 4000;

type Presence = { type: 'renderer'; owner: string; renderer: string; visible: boolean };
function presence(value: unknown): value is Presence {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<Presence>;
  return p.type === 'renderer' && typeof p.owner === 'string' && p.owner.length > 0 && p.owner.length < 300
    && typeof p.renderer === 'string' && p.renderer.length > 0 && p.renderer.length < 300 && typeof p.visible === 'boolean';
}
function channel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(VISUAL_PRESENCE_CHANNEL);
}

/** Only the paired identity that opened a currently visible renderer advertises a connected output. */
export class VisualSynthPresence {
  private readonly channel = channel();
  private readonly renderers = new Map<string, { owner: string; at: number }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private reported = false;

  constructor(private readonly owner: () => string | undefined, private readonly onChange: () => void) {
    if (this.channel) this.channel.onmessage = ({ data }) => {
      if (!presence(data)) return;
      if (data.visible) this.renderers.set(data.renderer, { owner: data.owner, at: Date.now() });
      else this.renderers.delete(data.renderer);
      this.update();
    };
    this.channel?.postMessage({ type: 'request' });
    this.timer = setInterval(() => this.update(), VISUAL_HEARTBEAT_MS);
  }

  connected(owner = this.owner()): boolean {
    return !!owner && [...this.renderers.values()].some((renderer) => renderer.owner === owner && Date.now() - renderer.at < VISUAL_STALE_MS);
  }

  private update(): void {
    for (const [id, renderer] of this.renderers) if (Date.now() - renderer.at >= VISUAL_STALE_MS) this.renderers.delete(id);
    const connected = this.connected();
    if (connected !== this.reported) { this.reported = connected; this.onChange(); }
  }

  dispose(): void { clearInterval(this.timer); this.channel?.close(); this.renderers.clear(); }
}

/** One low-frequency heartbeat; no animation/render loop or audio is created here. */
export function announceVisualRenderer(owner: string | null, visible: () => boolean): { update(): void; dispose(): void } {
  if (!owner) return { update() {}, dispose() {} };
  const wire = channel();
  const renderer = globalThis.crypto.randomUUID();
  let active = false;
  const update = () => {
    const next = !!owner && visible();
    if (next || active !== next) wire?.postMessage({ type: 'renderer', owner, renderer, visible: next } satisfies Presence);
    active = next;
  };
  if (wire) wire.onmessage = ({ data }) => { if (data?.type === 'request') update(); };
  update();
  const timer = setInterval(update, VISUAL_HEARTBEAT_MS);
  return { update, dispose() {
    if (active) wire?.postMessage({ type: 'renderer', owner, renderer, visible: false });
    active = false; clearInterval(timer); wire?.close();
  } };
}
