import { Group } from 'three';
import { Container, Text, withOpacity } from '@pmndrs/uikit';
import { Button, ButtonIcon, ButtonLabel, Panel } from '@pmndrs/uikit-horizon';
import { FlatMaterial, ICONS, glassPanel, isBrowser, type IconName } from './look';
import { LOOK } from './theme';

/**
 * The selected device's card in the Meta Horizon OS style (pmndrs uikit-horizon, dark scheme):
 * name + one status line, one oversized round Perform/Stop toggle, at most three pill buttons and an
 * agent pill (NVIDIA XR AI response contract: "Thinking…" only after 700 ms, then streamed text, model id small).
 * No JSON, provenance, Details or paragraphs. One uikit root = one instanced panel batch + one glyph batch, so the
 * plate and its buttons can never depth-sort against each other (the head-turn blink).
 */
export type CardIcon = IconName;
export interface CardAction { id: string; label: string; icon?: CardIcon; selected?: boolean; primary?: boolean }
export interface CardAgent { state: 'listening' | 'thinking' | 'reply' | 'done' | 'error'; text: string; model?: string }
export interface CardView {
  title: string;
  subtitle: string;
  /** The round toggle. `name` is kept for scripts that address the control by name ('hand-control'). */
  toggle: { on: boolean; label: string; name: string } | null;
  actions: CardAction[];
  agent: CardAgent | null;
}
export interface CardHandlers { toggle(): void; action(id: string): void }
const browser = isBrowser;
const flatPanel = FlatMaterial;

/** Agent pill timing (NVIDIA xr-ai `acknowledgment_delay`): fast answers never show a spinner. */
export function agentPillText(agent: CardAgent | null, sinceMs: number): string | null {
  if (!agent) return null;
  if (agent.state === 'listening') return agent.text ? clip(agent.text) : 'Listening…';
  if (agent.state === 'thinking') return sinceMs >= LOOK.motion.ackMs ? 'Thinking…' : agent.text ? clip(agent.text) : 'Sent';
  if (agent.state === 'error') return clip(agent.text || 'Could not finish that');
  return clip(agent.text || 'Done');
}
function clip(text: string, max = 44): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

interface ActionSlot { button: Button; icon: ButtonIcon; label: Text; iconKind?: CardIcon; id?: string }

export class DeviceCard extends Group {
  readonly widthM = LOOK.card.width * LOOK.pixelSize;
  private readonly root?: Panel;
  private readonly title?: Text;
  private readonly subtitle?: Text;
  private readonly toggle?: Button;
  private readonly toggleIcon?: ButtonIcon;
  private readonly toggleLabel?: Text;
  private readonly toggleColumn?: Container;
  private readonly agentRow?: Container;
  private readonly agentDot?: Container;
  private readonly agentText?: Text;
  private readonly agentModel?: Text;
  private readonly actionsRow?: Container;
  private readonly slots: ActionSlot[] = [];
  private toggleIconKind?: CardIcon;
  private view: CardView = { title: '', subtitle: '', toggle: null, actions: [], agent: null };
  private agentSince = 0;
  private agentKey = '';
  private now = 0;
  private shownVisibility?: boolean;
  private shownAgent: string | null = null;
  private disposed = false;

  constructor(private readonly handlers: CardHandlers) {
    super();
    this.name = 'device-card-v3';
    this.userData.view = this.view;
    if (!browser) return;
    const { card } = LOOK;
    this.root = glassPanel({ width: this.widthM, pointerEventsOrder: 1, anchorY: 'center' } as never);
    const header = new Container({ flexDirection: 'row', alignItems: 'center', gap: 12 });
    const titles = new Container({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, gap: 4 });
    this.title = new Text({ text: '', fontSize: card.titleSize, fontWeight: 'semi-bold', color: LOOK.text.primary, wordBreak: 'keep-all' });
    this.subtitle = new Text({ text: '', fontSize: card.subtitleSize, fontWeight: 'medium', color: LOOK.text.secondary });
    titles.add(this.title, this.subtitle);
    this.toggleColumn = new Container({ flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 });
    this.toggle = new Button({ variant: 'secondary', icon: true, size: 'lg', width: card.toggle, height: card.toggle,
      backgroundColor: withOpacity('#ffffff', 0.14), panelMaterialClass: flatPanel, onClick: () => this.handlers.toggle() });
    this.toggle.name = 'hand-control';
    this.toggleIcon = new ButtonIcon({ '*': { width: 30, height: 30 } } as never);
    this.toggle.add(this.toggleIcon);
    this.toggleLabel = new Text({ text: 'Perform', fontSize: 12, fontWeight: 'medium', color: LOOK.text.secondary });
    this.toggleColumn.add(this.toggle, this.toggleLabel);
    header.add(titles, this.toggleColumn);
    this.agentRow = new Container({ flexDirection: 'row', alignItems: 'center', gap: 8, height: LOOK.pill.height + 4, paddingX: 14,
      borderRadius: 1000, backgroundColor: withOpacity('#ffffff', 0.08), panelMaterialClass: flatPanel, display: 'none' });
    this.agentRow.name = 'agent-pill';
    this.agentDot = new Container({ width: 8, height: 8, borderRadius: 4, backgroundColor: '#ffffff', panelMaterialClass: flatPanel, flexShrink: 0 });
    this.agentText = new Text({ text: '', fontSize: LOOK.pill.fontSize, fontWeight: 'medium', flexGrow: 1, flexShrink: 1, color: LOOK.text.primary, whiteSpace: 'nowrap' } as never);
    this.agentModel = new Text({ text: '', fontSize: 11, color: LOOK.text.secondary, flexShrink: 0 });
    this.agentRow.add(this.agentDot, this.agentText, this.agentModel);
    this.actionsRow = new Container({ flexDirection: 'row', gap: 8, display: 'none' });
    for (let i = 0; i < 3; i++) {
      const button = new Button({ variant: 'secondary', size: 'lg', flexGrow: 1, flexBasis: 0, paddingX: 10, gap: 6, panelMaterialClass: flatPanel,
        onClick: () => { const id = this.slots[i]?.id; if (id) this.handlers.action(id); } });
      const icon = new ButtonIcon({ '*': { width: 18, height: 18 } } as never);
      const labelBox = new ButtonLabel();
      const label = new Text({ text: '', fontSize: 14, fontWeight: 'medium', whiteSpace: 'nowrap' } as never);
      labelBox.add(label); button.add(icon, labelBox);
      this.actionsRow.add(button);
      this.slots.push({ button, icon, label });
    }
    this.root.add(header, this.agentRow, this.actionsRow);
    this.add(this.root);
  }

  /** Height of the laid-out card in metres (0 until the first layout). */
  get heightM(): number { return (this.root?.size.peek()?.[1] ?? 180) * LOOK.pixelSize; }
  /** uikit root for the shared spatial-input updater. */
  get uiRoot(): { update(dtMs: number): void } | undefined { return this.root; }

  private viewKey = '';
  set(view: CardView): void {
    const key = JSON.stringify(view);
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.view = view; this.userData.view = view;
    const agentKey = view.agent ? view.agent.state : '';
    if (agentKey !== this.agentKey) { this.agentKey = agentKey; this.agentSince = this.now; }
    if (!this.root) return;
    this.title!.setProperties({ text: view.title });
    this.subtitle!.setProperties({ text: view.subtitle });
    const toggle = view.toggle;
    this.toggleColumn!.setProperties({ display: toggle ? 'flex' : 'none' });
    if (toggle) {
      this.toggle!.name = toggle.name;
      // White = on (inspiration §6); dark glass = off.
      // Explicit hover/active layers: the kit's variant-computed hover colour can lag a variant switch.
      this.toggle!.setProperties(toggle.on
        ? { variant: 'primary', color: '#272727', backgroundColor: withOpacity('#ffffff', 0.92), hover: { backgroundColor: '#d9d9d9', color: '#272727' }, active: { backgroundColor: '#c0c0c0', color: '#272727' } }
        : { variant: 'secondary', color: withOpacity('#ffffff', 0.92), backgroundColor: withOpacity('#ffffff', 0.14), hover: { backgroundColor: withOpacity('#ffffff', 0.22), color: '#ffffff' }, active: { backgroundColor: withOpacity('#ffffff', 0.3), color: '#ffffff' } } as never);
      this.toggleLabel!.setProperties({ text: toggle.label });
      this.setIcon(this.toggleIcon!, toggle.on ? 'stop' : 'hand', (kind) => { this.toggleIconKind = kind; }, this.toggleIconKind);
    }
    const actions = view.actions.slice(0, 3);
    this.actionsRow!.setProperties({ display: actions.length ? 'flex' : 'none' });
    this.slots.forEach((slot, index) => {
      const action = actions[index];
      slot.id = action?.id;
      const on = !!(action?.selected || action?.primary);
      slot.button.setProperties((on
        ? { display: action ? 'flex' : 'none', variant: 'primary', color: '#272727', backgroundColor: withOpacity('#ffffff', 0.92), hover: { backgroundColor: '#d9d9d9', color: '#272727' }, active: { backgroundColor: '#c0c0c0', color: '#272727' } }
        : { display: action ? 'flex' : 'none', variant: 'secondary', color: withOpacity('#ffffff', 0.92), backgroundColor: withOpacity('#ffffff', 0.08), hover: { backgroundColor: withOpacity('#ffffff', 0.16), color: '#ffffff' }, active: { backgroundColor: withOpacity('#ffffff', 0.24), color: '#ffffff' } }) as never);
      if (!action) return;
      slot.button.name = action.id;
      slot.label.setProperties({ text: action.label });
      slot.icon.setProperties({ display: action.icon ? 'flex' : 'none' });
      if (action.icon) this.setIcon(slot.icon, action.icon, (kind) => { slot.iconKind = kind; }, slot.iconKind);
    });
    this.refreshAgent();
  }

  private setIcon(holder: ButtonIcon, kind: CardIcon, remember: (kind: CardIcon) => void, current?: CardIcon): void {
    if (current === kind) return;
    for (const child of [...holder.children]) if (child instanceof Container || 'dispose' in child) { holder.remove(child); (child as { dispose?: () => void }).dispose?.(); }
    holder.add(new ICONS[kind]());
    remember(kind);
  }

  private refreshAgent(): void {
    const text = agentPillText(this.view.agent, this.now - this.agentSince);
    if (text === this.shownAgent) return;
    this.shownAgent = text;
    this.userData.agentText = text;
    if (!this.agentRow) return;
    this.agentRow.setProperties({ display: text ? 'flex' : 'none' });
    if (!text) return;
    const state = this.view.agent!.state;
    this.agentText!.setProperties({ text });
    this.agentModel!.setProperties({ text: this.view.agent!.model ? this.view.agent!.model.replace(/^.*\//, '').slice(0, 22) : '' });
    this.agentDot!.setProperties({ backgroundColor: state === 'error' ? '#FDA4AF' : state === 'listening' ? '#7DD3FC' : state === 'thinking' ? '#FDE68A' : '#86EFAC' });
  }

  /** Per frame: agent timing plus uikit visibility (a hidden three.js parent must also stop the pointer target). */
  update(dtMs: number, visible: boolean, updateRoot = true): void {
    if (this.disposed) return;
    this.now += Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this.refreshAgent();
    if (!this.root) return;
    if (this.shownVisibility !== visible) {
      this.shownVisibility = visible;
      this.root.setProperties({ visibility: visible ? 'visible' : 'hidden', pointerEvents: visible ? 'auto' : 'none' });
    }
    if (updateRoot) this.root.update(Math.min(100, Math.max(0, dtMs)));
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root?.traverse((child) => { if (child !== this.root && 'dispose' in child && child instanceof Container) (child as Container).dispose(); });
    this.root?.dispose();
    this.clear();
  }
}
