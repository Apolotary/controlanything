import { Group } from 'three';
import type { AssistantView } from '../contract';
import type { ObjectInformation } from '@ce/protocol';
import { GlassSurfaces } from './surface';
import { makeText, setText } from './text';
import { THEME } from './theme';
import { UIKitReader } from './uikit-reader';
export { configureAssistantRenderer } from './uikit-reader';

/** Fixed line limits keep spoken and generated text legible at the normal reading size. */
export function assistantLines(value: string, columns: number, rows: number): string {
  const words = value.replace(/→/g, ' to ').replace(/←/g, ' from ').trim().split(/\s+/).filter(Boolean);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const glyphs = segments(word);
    for (let offset = 0; offset < glyphs.length; offset += columns) {
      const part = glyphs.slice(offset, offset + columns).join('');
      if (line && segments(line).length + segments(part).length + 1 > columns) { lines.push(line); line = ''; }
      line = line ? `${line} ${part}` : part;
    }
  }
  if (line) lines.push(line);
  if (lines.length > rows) lines[rows - 1] = `${segments(lines[rows - 1]!).slice(0, columns - 1).join('').trimEnd()}…`;
  return lines.slice(0, rows).join('\n');
}

/** Every line is retained across pages; long URLs are split visually without inventing spaces. */
export function readingPages(value: string, columns = 32, rows = 6): string[] {
  const lines = assistantLines(value, columns, Number.MAX_SAFE_INTEGER).split('\n');
  return Array.from({ length: Math.max(1, Math.ceil(lines.length / rows)) }, (_, i) => lines.slice(i * rows, (i + 1) * rows).join('\n'));
}

export function informationPages(info: ObjectInformation): { label: string; text: string }[] {
  const pages: { label: string; text: string }[] = [];
  const add = (label: string, value: string) => readingPages(value).forEach((text, i, parts) => pages.push({ label: parts.length > 1 ? `${label} · ${i + 1}/${parts.length}` : label, text }));
  add('Identity evidence', info.identityNote || 'The selected identity has not been independently verified.');
  const missing: string[] = [];
  for (const [label, fact] of [['Description', info.description], ['Dimensions', info.dimensions], ['Weight', info.weight]] as const) {
    if (fact.value?.trim()) add(`${label}${fact.sourceIds.length ? ` [${fact.sourceIds.join(', ')}]` : ''}`, fact.value);
    else missing.push(label.toLowerCase());
  }
  if (info.price) add(`Price [${info.price.sourceIds.join(', ')}]`, `${info.price.currency} ${info.price.amount}\n${info.price.retailer}\nCondition: ${info.price.condition}\nAs of ${info.price.asOf}`);
  else missing.push('price');
  if (missing.length) add('Not available', `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not established by the available sources. Check the exact model or edition before inspecting again.`);
  for (const source of info.sources) {
    add(`Source [${source.id}]`, source.title);
    if (source.excerpt) add(`Excerpt [${source.id}]`, source.excerpt);
    add(`URL [${source.id}]`, source.url);
  }
  return pages;
}

const STATUS: Record<AssistantView['state'], string> = {
  idle: 'Ask about this device', listening: 'Listening · pinch Send when finished', thinking: 'Working · no new controls applied',
  reply: 'Muse', setup: 'Setup requested', proposal: 'New mapping · review before Apply', applied: 'Gesture controls ready', error: 'Could not complete request',
};
const DEFAULT_TEXT: Partial<Record<AssistantView['state'], string>> = {
  idle: 'Describe what you want to do with this device.',
  listening: 'Speak naturally. You can release your hand.',
  thinking: 'Working on your request.',
  setup: 'Follow the setup instructions on the device card.',
  applied: 'Mapping applied. Choose Use controls, then Perform. Hold your left fist to engage.',
  error: 'Try asking again.',
};

/** Contents only: the HUD anchors this panel once beside the selected device card. */
export class AssistantPanel extends Group {
  readonly width = 0.43;
  readonly height = 0.54;
  readonly buttonWidth = 0.18;
  readonly buttonHeight = 0.064;
  readonly apply: Group;
  readonly dismiss: Group;
  readonly send: Group;
  readonly sources: Group;
  readonly read: Group;
  readonly infoBack: Group;
  readonly infoClose: Group;
  private infoPage = 0;
  private readingPage = -1;
  private conversationPages: { label: string; text: string }[] = [];
  private conversationKey = '';
  private identityPage = 0;
  private infoPages: { label: string; text: string }[] = [];
  private identityPages: string[] = [];
  private view: AssistantView | null = null;
  private readonly facts = new Group();
  private readonly infoDetail = new UIKitReader();
  private readonly factText = Array.from({ length: 6 }, () => makeText({ text: '', size: THEME.font.detail, maxWidth: 0.38, maxHeight: 0.045, anchorY: 'top' }));
  private readonly heading = makeText({ text: 'Ask Muse', size: THEME.font.title, weight: 600, maxWidth: 0.38, maxHeight: 0.045 });
  private readonly status = makeText({ text: '', size: THEME.font.detail, color: THEME.color.muted, maxWidth: 0.38, singleLine: true });
  private readonly transcript = makeText({ text: '', size: THEME.font.detail, color: THEME.color.muted, maxWidth: 0.38, anchorY: 'top', maxHeight: 0.045 });
  private readonly response = makeText({ text: '', size: THEME.font.body, maxWidth: 0.38, anchorY: 'top', maxHeight: 0.066 });
  private readonly mapping = makeText({ text: '', size: THEME.font.detail, maxWidth: 0.38, anchorY: 'top', maxHeight: 0.12 });

  constructor(surfaces: GlassSurfaces) {
    super();
    this.name = 'assistant-panel'; this.visible = false;
    this.heading.name = 'assistant-title'; this.heading.position.set(-0.19, 0.23, THEME.panel.depth);
    this.status.name = 'assistant-status'; this.status.position.set(-0.19, 0.193, THEME.panel.depth);
    this.transcript.name = 'assistant-transcript'; this.transcript.position.set(-0.19, 0.16, THEME.panel.depth);
    this.response.name = 'assistant-response'; this.response.position.set(-0.19, 0.105, THEME.panel.depth);
    this.mapping.name = 'assistant-mapping'; this.mapping.position.set(-0.19, 0.02, THEME.panel.depth);
    this.apply = this.button(surfaces, 'assistant-apply', 'Apply mapping', 0.1);
    this.dismiss = this.button(surfaces, 'assistant-dismiss', 'Dismiss', -0.1);
    this.send = this.button(surfaces, 'assistant-send', 'Send', 0.1); this.send.visible = false;
    this.read = this.button(surfaces, 'assistant-read', 'Read full request / reply', 0, 0.30); this.read.position.y = -0.15;
    this.sources = this.button(surfaces, 'object-info-sources', 'Details', 0.14, 0.12); this.sources.visible = false;
    this.infoBack = this.button(surfaces, 'object-info-back', 'Back', -0.14, 0.12); this.infoBack.visible = false;
    this.infoClose = this.button(surfaces, 'object-info-close', 'Close', 0, 0.12); this.infoClose.visible = false;
    this.infoDetail.name = 'object-info-detail'; this.infoDetail.position.set(-0.19, 0.16, THEME.panel.depth); this.infoDetail.visible = false;
    this.facts.name = 'object-info-facts'; this.facts.visible = false;
    this.factText.forEach((text, index) => { text.name = ['object-info-description', 'object-info-dimensions', 'object-info-weight', 'object-info-price', 'object-info-provenance', 'object-info-unavailable'][index]!; text.position.set(-0.19, 0.16, THEME.panel.depth); this.facts.add(text); });
    this.add(surfaces.create(this.width, this.height), this.heading, this.status, this.transcript, this.response, this.mapping, this.apply, this.dismiss, this.send, this.facts, this.infoDetail, this.read, this.sources, this.infoBack, this.infoClose);
  }

  private button(surfaces: GlassSurfaces, name: string, text: string, x: number, width = this.buttonWidth): Group {
    const group = new Group(); group.name = name; group.position.set(x, -0.23, THEME.panel.depth);
    group.userData.width = width;
    const plate = surfaces.create(width, this.buttonHeight, 'button', true); plate.name = 'button-plate';
    const label = makeText({ text, anchorX: 'center', weight: 500, maxWidth: width - 0.015, singleLine: true });
    label.position.z = THEME.panel.depth; group.add(plate, label);
    return group;
  }

  setState(view: AssistantView | null): void {
    if (view?.objectInfo !== this.view?.objectInfo) { this.infoPage = 0; this.infoPages = view?.objectInfo ? informationPages(view.objectInfo) : []; }
    if (view?.proposalId !== this.view?.proposalId) this.identityPage = 0;
    const key = JSON.stringify([view?.targetId, view?.state, view?.transcript, view?.text, view?.mapping]);
    if (key !== this.conversationKey) { this.conversationKey = key; this.readingPage = -1; }
    this.conversationPages = [];
    const addPages = (label: string, text: string | undefined) => { if (text?.trim()) readingPages(text).forEach((page) => this.conversationPages.push({ label, text: page })); };
    addPages('Your full request', view?.transcript);
    addPages('Muse reply', view?.text || (view ? DEFAULT_TEXT[view.state] : ''));
    addPages('Proposed mapping', view?.mapping?.join('\n'));
    this.view = view;
    this.visible = !!view;
    if (!view) return;
    this.userData.state = view.state;
    setText(this.dismiss.children[1] as import('./text').SdfText, view.state === 'applied' ? 'Use controls' : 'Dismiss');
    this.read.visible = false;
    this.facts.visible = !!view.objectInfo;
    this.sources.visible = !!view.objectInfo;
    this.sources.userData.disabled = false;
    this.infoBack.visible = this.infoClose.visible = this.infoDetail.visible = false;
    this.response.visible = !view.objectInfo;
    setText(this.heading, view.objectInfo?.title ?? view.targetLabel ?? 'Ask Muse');
    if (view.objectInfo) { this.drawInformation(); return; }
    setText(this.apply.children[1] as import('./text').SdfText, view.proposalKind === 'identity' ? 'Confirm identity' : view.proposalKind === 'peripheral' ? 'Choose instrument' : 'Apply mapping');
    if (view.state === 'proposal' && (view.proposalKind === 'identity' || view.proposalKind === 'peripheral')) {
      this.identityPages = readingPages([view.transcript ? `Your request: ${view.transcript}` : '', view.text, ...(view.mapping ?? [])].filter(Boolean).join('\n\n'));
      this.drawIdentityReview(); return;
    }
    if (this.readingPage >= 0) { this.drawConversationPage(); return; }
    const transcript = view.transcript?.trim();
    const entries = view.mapping?.filter((line) => line.trim()) ?? [];
    const responseLines = entries.length || view.state === 'proposal' ? 3 : 6;
    setText(this.status, STATUS[view.state]);
    setText(this.transcript, transcript ? assistantLines(`You: ${transcript}`, 44, 2) : '');
    this.transcript.visible = !!transcript;
    this.response.userData.fitHeight = responseLines === 3 ? 0.066 : 0.13;
    setText(this.response, assistantLines(view.text || DEFAULT_TEXT[view.state] || '', 39, responseLines));
    this.response.position.y = transcript ? 0.105 : 0.16;
    // A long mapping remains explicitly a preview; do not make an incomplete proposal actionable.
    const mapping = entries.slice(0, 7).map((entry) => assistantLines(`• ${entry}`, 40, 7)).join('\n');
    const overflow = entries.length > 6 || mapping.split('\n').length > 6;
    setText(this.mapping, overflow ? 'Mapping is too long to review here.\nAsk for a simpler mapping.' : mapping);
    this.mapping.visible = !!entries.length;
    this.mapping.position.y = transcript ? 0.02 : 0.07;
    this.apply.visible = view.state === 'proposal' && !!view.proposalId && !overflow;
    this.send.visible = view.state === 'listening';
    this.dismiss.visible = true;
    this.dismiss.position.x = this.apply.visible || this.send.visible ? -0.1 : 0;
    this.read.visible = this.conversationPages.length > 0;
    this.userData.reviewable = !overflow;
  }

  openFullText(): void { this.readingPage = 0; this.drawConversationPage(); }

  /** Returns true when this was a reading subpage, rather than a request to dismiss Muse. */
  closeReadingPage(): boolean {
    if (this.readingPage < 0 || !this.view) return false;
    this.readingPage = -1; this.setState(this.view); return true;
  }

  private drawConversationPage(): void {
    if (!this.view || this.readingPage < 0) return;
    const page = this.conversationPages[this.readingPage];
    this.transcript.visible = this.response.visible = this.mapping.visible = this.facts.visible = false;
    this.read.visible = this.apply.visible = this.dismiss.visible = this.send.visible = false;
    this.infoDetail.visible = this.infoBack.visible = this.infoClose.visible = this.sources.visible = true;
    this.infoBack.userData.disabled = this.readingPage === 0;
    this.sources.userData.disabled = this.readingPage >= this.conversationPages.length - 1;
    setText(this.status, `${page?.label ?? 'Conversation'} · ${this.readingPage + 1}/${this.conversationPages.length}`);
    this.infoDetail.setText(page?.text ?? '');
    setText(this.sources.children[1] as import('./text').SdfText, 'Next');
    setText(this.infoClose.children[1] as import('./text').SdfText, 'Return');
    this.userData.readingPage = this.readingPage; this.userData.readingPages = this.conversationPages.length;
  }

  nextInformationPage(): void {
    if (this.readingPage >= 0) { this.readingPage = Math.min(this.conversationPages.length - 1, this.readingPage + 1); this.drawConversationPage(); return; }
    if (this.view?.state === 'proposal' && (this.view.proposalKind === 'identity' || this.view.proposalKind === 'peripheral')) {
      this.identityPage = Math.min(this.identityPages.length - 1, this.identityPage + 1); this.drawIdentityReview(); return;
    }
    const info = this.view?.objectInfo;
    if (!info) return;
    this.infoPage = (this.infoPage + 1) % (this.infoPages.length + 1);
    this.drawInformation();
  }

  previousInformationPage(): void { if (this.readingPage >= 0) { this.readingPage = Math.max(0, this.readingPage - 1); this.drawConversationPage(); return; } this.infoPage = Math.max(0, this.infoPage - 1); this.drawInformation(); }

  private drawIdentityReview(): void {
    this.transcript.visible = this.mapping.visible = this.send.visible = false;
    this.dismiss.visible = true; this.dismiss.position.x = -0.1;
    this.response.position.y = 0.16; this.response.userData.fitHeight = 0.28;
    setText(this.status, `${this.view?.proposalKind === 'peripheral' ? 'Choose connected instrument' : 'Review identity'} · ${this.identityPage + 1}/${this.identityPages.length}`);
    setText(this.response, this.identityPages[this.identityPage] ?? '');
    const reviewed = this.identityPage === this.identityPages.length - 1;
    this.apply.visible = reviewed && !!this.view?.proposalId;
    this.sources.visible = !reviewed;
    setText(this.sources.children[1] as import('./text').SdfText, 'Next');
    this.userData.reviewable = reviewed;
  }

  private drawInformation(): void {
    const info = this.view?.objectInfo;
    if (!info) return;
    this.read.visible = false;
    this.sources.userData.disabled = false;
    setText(this.infoClose.children[1] as import('./text').SdfText, 'Close');
    this.transcript.visible = this.mapping.visible = this.apply.visible = this.send.visible = false;
    this.dismiss.visible = false;
    this.infoBack.visible = this.infoClose.visible = true;
    this.infoBack.userData.disabled = this.infoPage === 0;
    this.facts.visible = this.infoPage === 0;
    this.infoDetail.visible = this.infoPage > 0;
    this.userData.reviewable = true;
    const page = this.infoPages[this.infoPage - 1];
    setText(this.status, page ? `${this.infoPage}/${this.infoPages.length} · ${page.label}` : `About · ${info.identityStatus === 'matched' ? 'Sources match supplied identity' : 'Identity uncertain'}`);
    if (page) this.infoDetail.setText(page.text);
    const refs = (ids: string[]) => ids.length ? ` [${ids.join(', ')}]` : '';
    const fact = (label: string, value: string | null, ids: string[]) => value?.trim() ? `${label}${refs(ids)}: ${value}` : '';
    const provenance = `${info.source === 'fixture' ? 'Fixture example' : info.cached ? 'Saved research' : 'Researched'} · ${new Date(info.researchedAt).toISOString().slice(0, 10)}`;
    const lines = [
      fact('Summary', info.description.value, info.description.sourceIds)
        || (!info.dimensions.value?.trim() && !info.weight.value?.trim() && !info.price ? 'No sourced details yet.' : ''),
      fact('Dimensions', info.dimensions.value, info.dimensions.sourceIds),
      fact('Weight', info.weight.value, info.weight.sourceIds),
      info.price ? `Price${refs(info.price.sourceIds)}: ${info.price.currency} ${info.price.amount}\n${info.price.retailer} · ${info.price.condition} · ${info.price.asOf}` : '',
      `${provenance}\nPhysical identity unverified; see Details.`,
    ];
    const missing = [!info.dimensions.value?.trim() && 'dimensions', !info.weight.value?.trim() && 'weight', !info.price && 'price'].filter(Boolean);
    lines.push(missing.length ? `Not available: ${missing.join(', ')}. Check exact model or edition.` : '');
    // Keep the summary and known facts first, then one missing-data note. Empty
    // rows do not consume space; full evidence remains in the unchanged paging path.
    const order = [0, 1, 2, 3, 5, 4];
    const count = lines.filter(Boolean).length;
    let y = 0.16;
    for (const index of order) {
      const text = this.factText[index]!, value = lines[index] ?? '';
      text.visible = !!value;
      const rows = index === 0 && count <= 3 ? 4 : 2;
      text.userData.fitHeight = rows * THEME.font.detail * THEME.font.lineHeight;
      setText(text, assistantLines(value, 44, rows));
      if (!value) continue;
      text.position.y = y;
      y -= text.userData.fitHeight + 0.014;
    }
    setText(this.sources.children[1] as import('./text').SdfText, this.infoPage === 0 ? 'Details' : this.infoPage < this.infoPages.length ? 'Next' : 'Overview');
    this.userData.infoPage = this.infoPage; this.userData.infoPages = this.infoPages.length;
  }

  updateUi(deltaMs: number): void { this.infoDetail.updateUi(deltaMs); }
  disposeUi(): void { this.infoDetail.disposeUi(); }
}
