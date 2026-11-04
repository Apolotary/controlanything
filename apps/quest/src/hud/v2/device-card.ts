import { Group } from 'three';
import { Container, Text, withOpacity } from '@pmndrs/uikit';
import { Button, ButtonIcon, ButtonLabel, Panel } from '@pmndrs/uikit-horizon';
import { FlatMaterial, ICONS, glassPanel, isBrowser, type IconName } from './look';
import { LOOK } from './theme';

/**
 * The selected device's card in the Meta Horizon OS style (pmndrs uikit-horizon, dark scheme):
 * name + one status line, generous full-width request/action rows and an
 * agent pill (NVIDIA XR AI response contract: "Thinking…" only after 700 ms, then streamed text, model id small).
 * No JSON, provenance, Details or paragraphs. One uikit root = one instanced panel batch + one glyph batch, so the
 * plate and its buttons can never depth-sort against each other (the head-turn blink).
 */
export type CardIcon = IconName;
export interface CardAction { id: string; label: string; icon?: CardIcon; selected?: boolean; primary?: boolean }
export interface CardAgent { state: 'listening' | 'thinking' | 'reply' | 'done' | 'error'; text: string; model?: string }
/** "Muse writes the glue": suggestions send a request; the labelled mic row is hold-to-talk. */
export interface CardAsk {
  chips: { id: string; label: string; active?: boolean; icon?: CardIcon }[];
  mic: 'off' | 'idle' | 'listening' | 'busy';
}
export interface CardView {
  title: string;
  subtitle: string;
  /** The round toggle. `name` is kept for scripts that address the control by name ('hand-control'). */
  toggle: { on: boolean; label: string; name: string; icon?: CardIcon } | null;
  actions: CardAction[];
  agent: CardAgent | null;
  ask?: CardAsk | null;
}
export interface CardHandlers { toggle(): void; action(id: string): void; chip?(id: string): void; mic?(down: boolean): void }
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
  readonly widthM = .36;
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
  private readonly micColumn?: Container;
  private readonly mic?: Button;
  private readonly micIcon?: ButtonIcon;
  private readonly micLabel?: Text;
  private micIconKind?: CardIcon;
  private readonly chipsRow?: Container;
  private readonly chipSlots: ActionSlot[] = [];
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
    this.subtitle = new Text({ text: '', fontSize: 18, lineHeight: '125%', fontWeight: 'medium', color: LOOK.text.secondary,
      whiteSpace: 'normal', wordBreak: 'break-word' } as never);
    titles.add(this.title, this.subtitle);
    this.toggleColumn = new Container({ flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 });
    this.toggle = new Button({ variant: 'secondary', icon: true, size: 'lg', width: card.toggle, height: card.toggle,
      backgroundColor: withOpacity('#ffffff', 0.14), panelMaterialClass: flatPanel, onClick: () => this.handlers.toggle() });
    this.toggle.name = 'hand-control';
    this.toggleIcon = new ButtonIcon({ '*': { width: 30, height: 30 } } as never);
    this.toggle.add(this.toggleIcon);
    this.toggleLabel = new Text({ text: 'Perform', fontSize: 12, fontWeight: 'medium', color: LOOK.text.secondary });
    this.toggleColumn.add(this.toggle, this.toggleLabel);
    this.micColumn = new Container({ flexDirection: 'column', alignItems: 'stretch', flexShrink: 0, display: 'none' });
    this.mic = new Button({ variant: 'secondary', size: 'lg', width: '100%', height: 52, borderRadius: 12, gap: 10,
      backgroundColor: withOpacity('#ffffff', 0.14), panelMaterialClass: flatPanel,
      onPointerDown: () => this.handlers.mic?.(true), onPointerUp: () => this.handlers.mic?.(false) } as never);
    this.mic.name = 'wire-mic';
    this.micIcon = new ButtonIcon({ '*': { width: 24, height: 24 } } as never);
    this.mic.add(this.micIcon);
    this.micLabel = new Text({ text: 'Hold to ask Muse', fontSize: 18, fontWeight: 'medium', whiteSpace: 'nowrap' } as never);
    const micLabelBox = new ButtonLabel(); micLabelBox.add(this.micLabel); this.mic.add(micLabelBox);
    this.micColumn.add(this.mic);
    header.add(titles, this.toggleColumn);
    this.agentRow = new Container({ flexDirection: 'row', alignItems: 'center', gap: 8, height: LOOK.pill.height + 4, paddingX: 14,
      borderRadius: 1000, backgroundColor: withOpacity('#ffffff', 0.08), panelMaterialClass: flatPanel, display: 'none' });
    this.agentRow.name = 'agent-pill';
    this.agentDot = new Container({ width: 8, height: 8, borderRadius: 4, backgroundColor: '#ffffff', panelMaterialClass: flatPanel, flexShrink: 0 });
    this.agentText = new Text({ text: '', fontSize: LOOK.pill.fontSize, fontWeight: 'medium', flexGrow: 1, flexShrink: 1, color: LOOK.text.primary, whiteSpace: 'nowrap' } as never);
    this.agentModel = new Text({ text: '', fontSize: 11, color: LOOK.text.secondary, flexShrink: 0 });
    this.agentRow.add(this.agentDot, this.agentText, this.agentModel);
    this.actionsRow = new Container({ flexDirection: 'column', gap: 8, display: 'none' });
    for (let i = 0; i < 3; i++) {
      const button = new Button({ variant: 'secondary', size: 'lg', width: '100%', height: 48, borderRadius: 12, paddingX: 16, gap: 8, panelMaterialClass: flatPanel,
        onClick: () => { const id = this.slots[i]?.id; if (id) this.handlers.action(id); } });
      const icon = new ButtonIcon({ '*': { width: 18, height: 18 } } as never);
      const labelBox = new ButtonLabel();
      const label = new Text({ text: '', fontSize: 18, fontWeight: 'medium', whiteSpace: 'nowrap' } as never);
      labelBox.add(label); button.add(icon, labelBox);
      this.actionsRow.add(button);
      this.slots.push({ button, icon, label });
    }
    this.chipsRow = new Container({ flexDirection: 'column', gap: 8, display: 'none' } as never);
    this.chipsRow.name = 'wire-chips';
    for (let i = 0; i < 4; i++) {
      const button = new Button({ variant: 'secondary', size: 'lg', width: '100%', height: 52, borderRadius: 12, paddingX: 16, gap: 8, panelMaterialClass: flatPanel,
        onClick: () => { const id = this.chipSlots[i]?.id; if (id) this.handlers.chip?.(id); } });
      const chipIcon = new ButtonIcon({ '*': { width: 20, height: 20 } } as never);
      const chipLabelBox = new ButtonLabel();
      const chipLabel = new Text({ text: '', fontSize: 18, fontWeight: 'medium', whiteSpace: 'nowrap' } as never);
      chipLabelBox.add(chipLabel); button.add(chipIcon, chipLabelBox);
      this.chipsRow.add(button);
      this.chipSlots.push({ button, icon: chipIcon, label: chipLabel });
    }
    this.root.add(header, this.chipsRow, this.micColumn, this.agentRow, this.actionsRow);
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
      this.setIcon(this.toggleIcon!, toggle.icon ?? (toggle.on ? 'stop' : 'hand'), (kind) => { this.toggleIconKind = kind; }, this.toggleIconKind);
    }
    this.setAsk(view.ask ?? null);
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

  private setAsk(ask: CardAsk | null): void {
    const mic = ask?.mic ?? 'off';
    this.micColumn!.setProperties({ display: mic === 'off' ? 'none' : 'flex' });
    if (mic !== 'off') {
      const on = mic === 'listening';
      this.mic!.setProperties(on
        ? { variant: 'primary', color: '#272727', backgroundColor: withOpacity('#ffffff', 0.92), hover: { backgroundColor: '#d9d9d9', color: '#272727' }, active: { backgroundColor: '#c0c0c0', color: '#272727' } }
        : { variant: 'secondary', color: withOpacity('#ffffff', 0.92), backgroundColor: withOpacity('#ffffff', 0.14), hover: { backgroundColor: withOpacity('#ffffff', 0.22), color: '#ffffff' }, active: { backgroundColor: withOpacity('#ffffff', 0.3), color: '#ffffff' } } as never);
      this.micLabel!.setProperties({ text: mic === 'listening' ? 'Listening… release to send' : mic === 'busy' ? 'Transcribing your request…' : 'Hold to ask Muse' });
      this.setIcon(this.micIcon!, 'mic', (kind) => { this.micIconKind = kind; }, this.micIconKind);
    }
    const chips = ask?.chips.slice(0, 4) ?? [];
    this.chipsRow!.setProperties({ display: chips.length ? 'flex' : 'none' });
    this.chipSlots.forEach((slot, index) => {
      const chip = chips[index];
      slot.id = chip?.id;
      const on = !!chip?.active || !!chip && index === 0 && !chips.some(item => item.active) && chip.id !== 'recalibrate';
      slot.button.setProperties((on
        ? { display: chip ? 'flex' : 'none', variant: 'primary', color: '#272727', backgroundColor: withOpacity('#ffffff', 0.92), hover: { backgroundColor: '#d9d9d9', color: '#272727' }, active: { backgroundColor: '#c0c0c0', color: '#272727' } }
        : { display: chip ? 'flex' : 'none', variant: 'secondary', color: withOpacity('#ffffff', 0.92), backgroundColor: withOpacity('#ffffff', 0.08), hover: { backgroundColor: withOpacity('#ffffff', 0.16), color: '#ffffff' }, active: { backgroundColor: withOpacity('#ffffff', 0.24), color: '#ffffff' } }) as never);
      if (!chip) return;
      slot.button.name = `wire-chip:${chip.id}`;
      slot.label.setProperties({ text: chip.label });
      slot.icon.setProperties({ display: chip.icon ? 'flex' : 'none' });
      if (chip.icon) this.setIcon(slot.icon, chip.icon, (kind) => { slot.iconKind = kind; }, slot.iconKind);
    });
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
