import { button, el } from './dom';

interface Connector {
  cardId: string; entry: string; alive: boolean; ops: number; failures: number;
  actions: { id: string; label: string }[]; logs: string[]; wiring?: { title: string };
}

/** Owner-only diagnostics; opening Details never starts a connector or a model call. */
export class AgentConnectorsPanel {
  private readonly status = el('p', { className: 'small dim', text: 'Open Details to view Muse connectors.' });
  private readonly list = el('div');
  private readonly refreshButton = button('Refresh', () => void this.refresh(), 'ghost');
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private active = false;
  private pending = false;

  constructor(host: HTMLElement, private readonly options: { token: () => string | undefined; replay: boolean }) {
    host.append(this.status, this.refreshButton, this.list);
    this.refreshButton.disabled = options.replay;
    document.addEventListener('visibilitychange', () => this.setActive(this.active));
    window.addEventListener('pagehide', () => this.setActive(false));
  }

  setActive(active: boolean): void {
    this.active = active;
    clearTimeout(this.timer);
    if (!active || document.hidden) { this.controller?.abort(); return; }
    void this.refresh();
  }

  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const token = this.options.token();
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'Use the paired owner companion to view Muse connectors.' : `Connector status unavailable (HTTP ${response.status}).`);
    return response;
  }

  private async refresh(): Promise<void> {
    if (!this.active || document.hidden || this.pending || this.options.replay) return;
    clearTimeout(this.timer);
    this.pending = true; this.refreshButton.disabled = true;
    const controller = this.controller = new AbortController();
    try {
      const response = await this.request('/api/agent/connectors', undefined, controller.signal);
      const data = await response.json() as { mode: string; connectors: Connector[] };
      if (controller.signal.aborted) return;
      this.status.textContent = `${data.mode === 'fixture' ? 'FIXTURE · ' : ''}${data.connectors.filter(c => c.alive).length} running · Refreshes while Details is visible`;
      this.list.replaceChildren(...data.connectors.map(connector => this.row(connector)));
      if (!data.connectors.length) this.list.append(el('p', { className: 'small dim', text: 'No connectors. Select a device and ask Muse to create an interaction.' }));
    } catch (error) {
      if (!controller.signal.aborted) { this.status.textContent = (error as Error).message; this.list.replaceChildren(); }
    } finally {
      this.pending = false; this.refreshButton.disabled = false;
      if (this.controller === controller) this.controller = undefined;
      if (this.active && !document.hidden) this.timer = setTimeout(() => void this.refresh(), 2500);
    }
  }

  private row(connector: Connector): HTMLElement {
    const row = el('article', { className: 'agent-connector' });
    const stop = button('Stop', () => {
      stop.disabled = true;
      this.status.textContent = 'Stopping this connector…';
      void this.request('/api/agent/panic', { cardId: connector.cardId, reason: 'Stop connector on Mac Details' }).then(() => {
        this.status.textContent = 'Connector stopped.'; void this.refresh();
      }).catch((error: Error) => { this.status.textContent = error.message; stop.disabled = false; });
    }, 'ghost');
    stop.disabled = !connector.alive;
    const header = el('div', { className: 'row' }, el('strong', { text: connector.wiring?.title ?? connector.cardId }), stop);
    row.append(header,
      el('p', { className: 'small dim', text: `${connector.alive ? 'Running' : 'Exited'} · ${connector.ops} commands · ${connector.failures} failed` }),
      el('p', { className: 'small connector-entry', text: connector.entry }),
      el('p', { className: 'small', text: `Actions: ${connector.actions.map(a => a.label || a.id).join(', ') || 'None reported'}` }),
      el('pre', { className: 'monitor connector-logs', text: connector.logs.slice(-12).join('\n') || 'Waiting for connector output…' }));
    return row;
  }
}
