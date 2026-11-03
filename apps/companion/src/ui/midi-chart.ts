import type { DeviceCardPayload } from '@ce/protocol';
import './midi-chart.css';

export interface MidiChart {
  maker: string; model: string; source: { title: string; url: string; section: string }; channel: number;
  parameters: { cc: number; name: string; min: number; max: number }[];
}
export interface ChartResponse {
  card: Pick<DeviceCardPayload, 'cardId' | 'maker' | 'model' | 'name'>;
  revision: number;
  chart: { cardId: string; revision: number; reviewedAt: number; reviewedBy: string; chart: MidiChart } | null;
}
type ChartRequest = (path: string, body?: unknown) => Promise<ChartResponse>;

/** Chart review saves permissions for the next setup; it never selects, enables or executes a device. */
export class MidiChartPanel {
  private readonly select = document.createElement('select');
  private readonly form = document.createElement('form');
  private readonly fields = document.createElement('fieldset');
  private readonly identity = document.createElement('p');
  private readonly message = document.createElement('p');
  private readonly title = this.input('Manual title');
  private readonly url = this.input('Source URL', 'url');
  private readonly section = this.input('Page or section');
  private readonly channel = this.input('MIDI channel', 'number', '1');
  private readonly rows = document.createElement('div');
  private readonly confirmed = document.createElement('input');
  private readonly save = document.createElement('button');
  private readonly reload = document.createElement('button');
  private readonly parameters: { cc: HTMLInputElement; name: HTMLInputElement; min: HTMLInputElement; max: HTMLInputElement; row: HTMLDivElement }[] = [];
  private snapshot?: ChartResponse;
  private cards: DeviceCardPayload[] = [];
  private signature = '';
  private generation = 0;
  private writable = false;
  private busy = false;

  constructor(host: HTMLElement, private readonly request: ChartRequest) {
    const label = document.createElement('label'); label.textContent = 'Selected MIDI instrument';
    this.select.setAttribute('aria-label', 'MIDI chart instrument'); label.append(this.select);
    this.select.addEventListener('change', () => { void this.load(); });
    this.identity.className = 'small dim'; this.message.className = 'small'; this.message.setAttribute('role', 'status');
    this.url.placeholder = 'https://manufacturer.example/manual';
    this.title.maxLength = 120; this.url.maxLength = 500; this.section.maxLength = 240;
    this.channel.min = '1'; this.channel.max = '16';
    const source = document.createElement('div'); source.className = 'chart-source-fields';
    source.append(this.labeled(this.title), this.labeled(this.url), this.labeled(this.section), this.labeled(this.channel));
    this.rows.className = 'chart-parameters';
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add parameter';
    add.addEventListener('click', () => { if (this.parameters.length < 12) this.addRow(); });
    const consent = document.createElement('label'); consent.className = 'chart-review-check';
    this.confirmed.type = 'checkbox'; consent.append(this.confirmed, 'I checked this exact instrument model, channel and incoming CC ranges against the cited manual.');
    this.confirmed.addEventListener('change', () => this.buttons());
    this.fields.addEventListener('input', (event) => { if (event.target !== this.confirmed) { this.confirmed.checked = false; this.buttons(); } });
    this.save.type = 'submit'; this.save.textContent = 'Save reviewed chart';
    this.reload.type = 'button'; this.reload.textContent = 'Reload saved chart';
    this.reload.addEventListener('click', () => { void this.load(); });
    const actions = document.createElement('div'); actions.className = 'row'; actions.append(this.save, this.reload);
    const hint = document.createElement('p'); hint.className = 'small dim';
    hint.textContent = 'Add 1–12 incoming CC parameters from the manual. Bank-select and channel-mode messages are excluded. Saving keeps controls off; retry setup in Quest to verify the device’s response.';
    this.fields.append(source, hint, this.rows, add, consent);
    this.form.append(this.fields, actions);
    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.submit(); });
    host.replaceChildren(label, this.identity, this.form, this.message);
    this.addRow(); this.buttons();
  }

  update(cards: DeviceCardPayload[], writable: boolean, preferred?: string): void {
    this.writable = writable;
    this.cards = cards.filter(card => card.requires?.includes('midi') || card.protocols.includes('midi'));
    const signature = JSON.stringify(this.cards.map(card => [card.cardId, card.maker, card.model, card.name]));
    if (signature !== this.signature) {
      this.signature = signature;
      const old = this.select.value;
      this.select.replaceChildren(...this.cards.map(card => {
        const option = document.createElement('option'); option.value = card.cardId; option.textContent = card.name; return option;
      }));
      this.select.value = this.cards.find(card => card.cardId === old)?.cardId
        ?? this.cards.find(card => card.cardId === preferred)?.cardId ?? this.cards[0]?.cardId ?? '';
      const card = this.cards.find(item => item.cardId === this.select.value);
      if (!card || card.cardId !== this.snapshot?.card.cardId || card.maker !== this.snapshot?.card.maker || card.model !== this.snapshot?.card.model) void this.load();
    }
    if (!this.cards.length) this.message.textContent = 'Tag and identify a MIDI instrument in Quest to review its chart here.';
    this.buttons();
  }

  private input(name: string, type = 'text', value = ''): HTMLInputElement {
    const input = document.createElement('input'); input.type = type; input.value = value; input.required = true;
    input.setAttribute('aria-label', name); input.maxLength = type === 'url' ? 2000 : 160;
    return input;
  }
  private labeled(input: HTMLInputElement): HTMLLabelElement {
    const label = document.createElement('label'); label.textContent = input.getAttribute('aria-label') ?? ''; label.append(input); return label;
  }
  private addRow(parameter?: MidiChart['parameters'][number]): void {
    const row = document.createElement('div'); row.className = 'chart-parameter';
    const cc = this.input('CC number', 'number', parameter ? String(parameter.cc) : ''); cc.min = '1'; cc.max = '119';
    const name = this.input('Parameter name', 'text', parameter?.name ?? '');
    const min = this.input('Minimum', 'number', String(parameter?.min ?? 0)); min.min = '0'; min.max = '127';
    const max = this.input('Maximum', 'number', String(parameter?.max ?? 127)); max.min = '0'; max.max = '127';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove parameter');
    const item = { row, cc, name, min, max }; this.parameters.push(item);
    remove.addEventListener('click', () => { const index = this.parameters.indexOf(item); if (index >= 0) this.parameters.splice(index, 1); row.remove(); this.confirmed.checked = false; this.buttons(); });
    row.append(this.labeled(cc), this.labeled(name), this.labeled(min), this.labeled(max), remove); this.rows.append(row);
    this.confirmed.checked = false; this.buttons();
  }
  private buttons(): void {
    this.select.disabled = !this.cards.length || this.busy;
    this.fields.disabled = !this.snapshot || !this.writable || this.busy;
    this.save.disabled = !this.snapshot || !this.writable || this.busy || !this.confirmed.checked || !this.parameters.length;
    this.reload.disabled = !this.select.value || this.busy;
  }
  private async load(): Promise<void> {
    const generation = ++this.generation, cardId = this.select.value;
    this.snapshot = undefined; this.confirmed.checked = false; this.busy = Boolean(cardId); this.buttons();
    if (!cardId) { this.busy = false; this.identity.textContent = ''; this.buttons(); return; }
    this.message.textContent = 'Loading this instrument’s chart…';
    try {
      const response = await this.request(`/api/agent/midi-charts/${encodeURIComponent(cardId)}`);
      if (generation !== this.generation) return;
      if (response.card.cardId !== cardId) throw new Error('The response belongs to another instrument. Reload the chart.');
      this.snapshot = response;
      this.identity.textContent = `${response.card.maker} · ${response.card.model} · ${response.card.cardId}`;
      const saved = response.chart?.chart;
      const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
      const chart = saved && normalize(saved.maker) === normalize(response.card.maker) && normalize(saved.model) === normalize(response.card.model) ? saved : undefined;
      this.title.value = chart?.source.title ?? ''; this.url.value = chart?.source.url ?? ''; this.section.value = chart?.source.section ?? '';
      this.channel.value = String(chart?.channel ?? 1);
      this.rows.replaceChildren(); this.parameters.length = 0;
      if (chart) chart.parameters.forEach(parameter => this.addRow(parameter)); else this.addRow();
      this.message.textContent = chart ? `Reviewed chart revision ${response.revision}. Changes apply on the next setup.`
        : saved ? 'The saved chart belongs to a previous identification. Confirm this instrument’s exact model and enter its own manual and CC parameters.'
          : 'No reviewed chart for this exact instrument. Cite its manual and enter the supported incoming CC parameters.';
    } catch (error) { if (generation === this.generation) this.message.textContent = error instanceof Error ? error.message : 'Could not load the chart.'; }
    finally { if (generation === this.generation) { this.busy = false; this.buttons(); } }
  }
  private async submit(): Promise<void> {
    if (!this.snapshot || this.busy || !this.writable || !this.confirmed.checked) return;
    const snapshot = this.snapshot, generation = this.generation;
    const chart: MidiChart = { maker: snapshot.card.maker, model: snapshot.card.model,
      source: { title: this.title.value.trim(), url: this.url.value.trim(), section: this.section.value.trim() }, channel: Number(this.channel.value),
      parameters: this.parameters.map(item => ({ cc: Number(item.cc.value), name: item.name.value.trim(), min: Number(item.min.value), max: Number(item.max.value) })) };
    this.busy = true; this.buttons(); this.message.textContent = 'Saving the reviewed chart…';
    try {
      const response = await this.request('/api/agent/midi-charts', { cardId: snapshot.card.cardId, expectedRevision: snapshot.revision, reviewed: true, chart });
      if (generation !== this.generation) return;
      if (response.card.cardId !== snapshot.card.cardId) throw new Error('The response belongs to another instrument. Reload the chart.');
      this.snapshot = response; this.confirmed.checked = false;
      this.message.textContent = `Chart revision ${response.revision} saved. Controls remain off. Retry setup in Quest, check the response, then choose Enable controls.`;
    } catch (error) {
      if (generation === this.generation) { this.confirmed.checked = false; this.message.textContent = `${error instanceof Error ? error.message : 'Could not save the chart.'} Your draft is kept; reload if the saved revision changed.`; }
    } finally { if (generation === this.generation) { this.busy = false; this.buttons(); } }
  }
}

export async function chartRequest(path: string, body?: unknown, token?: string): Promise<ChartResponse> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `Chart request failed (HTTP ${response.status}).`);
  return data as ChartResponse;
}
