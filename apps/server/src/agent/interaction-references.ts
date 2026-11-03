/** Rebuild on each query so disable, hide, version changes and Forget take effect immediately. */
import type { ForgeAction } from '../gen3d/forgeTypes';
import { boundedInteractionReferences, type InteractionReference, type InteractionReferenceQuery } from '../gen3d/interactionReferences';
import type { LibraryRecord } from './library-schema';

const text = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const normalized = (value?: string) => (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const aliases: Record<string, string> = { dimmer: 'brightness', luminance: 'brightness', loudness: 'volume', cutoff: 'filter' };
const terms = (value: string) => new Set(normalized(value.replace(/([a-z])([A-Z])/g, '$1 $2')).split(' ')
  .filter((word) => word.length > 1 && !/^\d+$/.test(word) && !/^(set|action|control|device|system|value|the|and)$/.test(word))
  .map((word) => aliases[word] ?? word));
function overlap(a: Set<string>, b: Set<string>): number {
  const common = [...a].filter((term) => b.has(term)).length;
  return common / Math.max(1, new Set([...a, ...b]).size);
}
const actionTerms = (action: ForgeAction) => terms(action.label);

export function interactionReferences(records: readonly LibraryRecord[], query: InteractionReferenceQuery): InteractionReference[] {
  const current = query.driver.actions.filter((action) => query.verification[action.actionId] === 'pass');
  if (!current.length) return [];
  const requested = terms(query.request);
  const ranked: { reference: InteractionReference; score: number; updatedAt: number; cardId: string }[] = [];
  for (const record of records) {
    if (record.hidden || !record.enabled || !record.activeVersionId) continue;
    const saved = record.versions.find((version) => version.versionId === record.activeVersionId);
    if (!saved || saved.driver.transport !== query.driver.transport || saved.driver.cardId !== record.cardId
      || saved.uiSpec.cardId !== record.cardId || saved.uiSpec.driverId !== saved.driver.driverId || saved.uiSpec.specId !== saved.specId
      || saved.uiSpec.check?.ok === false) continue;
    const verified = saved.driver.actions.filter((action) => saved.verification[action.actionId] === 'pass');
    const compatible = verified.map((action) => ({ action, score: Math.max(0, ...current
      .filter((live) => live.kind === action.kind).map((live) => overlap(actionTerms(action), actionTerms(live)))) }))
      .filter((match) => match.score > 0).sort((a, b) => b.score - a.score);
    if (!compatible.length) continue;
    const matchedIds = new Set(compatible.map(({ action }) => action.actionId));
    const verifiedIds = new Set(verified.map((action) => action.actionId));
    const ui = saved.uiSpec;
    // A multi-action control is an example only when all of its actions belonged to the completed setup.
    const hacks = (ui.hackset?.hacks ?? []).filter((hack) => hack.commands.every((command) => verifiedIds.has(command.action))
      && hack.commands.some((command) => matchedIds.has(command.action)));
    const controls: InteractionReference['controls'] = [];
    for (const control of ui.gen3d?.controls ?? []) {
      const hack = ui.hackset?.hacks.find((candidate) => candidate.id === control.id);
      if (hack ? !hacks.includes(hack) : !matchedIds.has(control.binding.action)) continue;
      const part = ui.gen3d?.parts.find((candidate) => candidate.controlId === control.id && candidate.kind === 'archetype');
      const x = part?.transform?.position?.[0];
      controls.push({ label: text(control.label), archetype: part?.archetype ?? control.kind,
        ...(hack?.control?.size ? { size: hack.control.size } : {}),
        ...(x !== undefined ? { placement: x < -0.03 ? 'left' : x > 0.03 ? 'right' : 'center' } : {}),
      });
    }
    if (!controls.length) for (const hack of hacks) {
      controls.push({ label: text(hack.name), archetype: hack.control?.archetype ?? 'button',
        ...(hack.control?.size ? { size: hack.control.size } : {}) });
    }
    if (!controls.length) for (const widget of ui.widgets ?? []) {
      if (matchedIds.has(widget.binding.action)) controls.push({ label: text(widget.label), archetype: widget.kind,
        ...(widget.layout?.size ? { size: widget.layout.size } : {}) });
    }
    if (!controls.length) continue;
    const gestures: InteractionReference['gestures'] = [...(ui.gestureMap?.axes ?? []), ...(ui.gestureMap?.postures ?? [])]
      .filter((binding) => matchedIds.has(binding.actionId))
      .map((binding) => ({ gesture: 'axis' in binding ? binding.axis : binding.posture,
        control: text(verified.find((action) => action.actionId === binding.actionId)!.label) })).slice(0, 6);
    const maker = record.identity.maker ?? record.card?.maker;
    const model = record.identity.model ?? record.card?.model;
    const category = record.identity.category ?? record.card?.category;
    const exact = Boolean(normalized(maker) && normalized(model) && normalized(maker) === normalized(query.device.maker)
      && normalized(model) === normalized(query.device.model));
    const sameCategory = Boolean(normalized(category) && normalized(category) === normalized(query.device.category));
    const semantic = compatible.reduce((sum, match) => sum + match.score, 0) / Math.max(verified.length, current.length);
    const queryOverlap = overlap(requested, terms([...compatible.map(({ action }) => action.label), ...controls.map((control) => control.label)].join(' ')));
    ranked.push({
      reference: { source: 'saved-library', origin: ui.source ?? 'unknown',
        device: { name: text(record.displayName), ...(maker ? { maker: text(maker) } : {}), ...(model ? { model: text(model) } : {}), ...(category ? { category: text(category) } : {}) },
        actions: compatible.slice(0, 6).map(({ action }) => ({ label: text(action.label), kind: action.kind,
          ...(action.range ? { range: { min: action.range.min, max: action.range.max, ...(action.range.step !== undefined ? { step: action.range.step } : {}) } } : {}) })),
        controls: controls.slice(0, 6), gestures },
      score: (exact ? 10_000 : 0) + (sameCategory ? 1000 : 0) + semantic * 100 + queryOverlap * 10,
      updatedAt: record.updatedAt, cardId: record.cardId,
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.cardId.localeCompare(b.cardId));
  return boundedInteractionReferences(ranked.map(({ reference }) => reference));
}
