import { Group } from 'three';
import { Container, Text, withOpacity } from '@pmndrs/uikit';
import type { Panel } from '@pmndrs/uikit-horizon';
import { glassPanel, isBrowser } from './look';

/**
 * The wrist dashboard: a compact "what is going on" panel beside the wrist menu, so a first-time wearer (or a
 * reviewer watching the video) can read the current layer, the selected object, the Mac and devices, what Muse is
 * doing, and the next step, without guessing. Text only, updated when a value changes (never a relayout per frame).
 */
export type DashboardTone = 'ok' | 'busy' | 'warn' | 'off';
export interface DashboardRow { key: string; label: string; value: string; tone?: DashboardTone }
export interface DashboardView { rows: DashboardRow[]; next: string }

export const DASHBOARD_W = 0.3;
const MAX_ROWS = 4;
const TONE: Record<DashboardTone, string> = { ok: '#7ee2a8', busy: '#7cc8ff', warn: '#ffc46b', off: withOpacity('#ffffff', 0.35) as unknown as string };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface RowUi { dot: Container; label: Text; value: Text; key: string; text: string; tone: string }

export class WristDashboard extends Group {
  private ui?: Panel;
  private rows: RowUi[] = [];
  private next?: Text;
  private nextText = '';
  private clock = 0;
  height = 0.2;

  constructor() {
    super();
    this.name = 'wrist-dashboard';
    if (!isBrowser) return;
    const ui = glassPanel({ width: DASHBOARD_W, padding: 14, gap: 7, renderOrder: 33, pointerEvents: 'none' } as never);
    ui.name = 'wrist-dashboard-plate';
    ui.add(new Text({ text: 'Now', fontSize: 15, fontWeight: 'medium', color: withOpacity('#ffffff', 0.6) } as never));
    for (let i = 0; i < MAX_ROWS; i++) {
      const line = new Container({ flexDirection: 'row', alignItems: 'center', gap: 7, width: '100%' } as never);
      const dot = new Container({ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: TONE.off } as never);
      const label = new Text({ text: '', fontSize: 14, color: withOpacity('#ffffff', 0.6), width: 60, flexShrink: 0 } as never);
      const value = new Text({ text: '', fontSize: 15, fontWeight: 'medium', color: '#ffffff', whiteSpace: 'pre', flexShrink: 1, overflow: 'hidden' } as never);
      line.add(dot, label, value);
      ui.add(line);
      this.rows.push({ dot, label, value, key: '', text: '', tone: '' });
    }
    const divider = new Container({ height: 1, width: '100%', backgroundColor: withOpacity('#ffffff', 0.14) } as never);
    this.next = new Text({ text: '', fontSize: 15, fontWeight: 'medium', color: '#ffffff', wordBreak: 'break-word' } as never);
    ui.add(divider, this.next);
    this.ui = ui;
    this.add(ui);
  }

  /** Paint the view (cheap when nothing changed) and advance uikit. */
  update(dtMs: number, view: DashboardView | undefined): void {
    if (!this.ui || !view) return;
    this.clock += dtMs;
    // Text changes at most ~6 times a second; layout still settles every frame.
    if (this.clock >= 160) {
      this.clock = 0;
      view.rows.slice(0, MAX_ROWS).forEach((row, i) => {
        const ui = this.rows[i]!;
        const text = clip(row.value, 22), tone = TONE[row.tone ?? 'off'];
        if (ui.key !== row.label) { ui.key = row.label; ui.label.setProperties({ text: row.label } as never); }
        if (ui.text !== text) { ui.text = text; ui.value.setProperties({ text } as never); }
        if (ui.tone !== tone) { ui.tone = tone; ui.dot.setProperties({ backgroundColor: tone } as never); }
      });
      const next = clip(view.next, 90);
      if (next !== this.nextText) { this.nextText = next; this.next!.setProperties({ text: `Next: ${next}` } as never); }
    }
    this.ui.update(Math.min(100, Math.max(0, dtMs)));
    this.height = (this.ui.size.peek()?.[1] ?? 200) / 1000;
  }

  override dispose(): void { this.ui?.dispose(); }
}
