import { isDeepStrictEqual } from 'node:util';
import { UiSpecPayload } from '@ce/protocol';
import { ForgeSnapshot, type Forge, type UiSpec } from '../gen3d/forge';
import type { StoredTag } from './tags';

type SavedInterface = Pick<StoredTag, 'cardId' | 'label' | 'card' | 'driver' | 'verification' | 'uiSpec' | 'forgeContext'>;

/** Restore editing before clients connect; one damaged history cannot prevent another device loading. */
export function restoreSavedForge(forge: Pick<Forge, 'restore'> | undefined, saved: SavedInterface, log: (line: string) => void = () => {}): UiSpec | undefined {
  if (!forge?.restore || !saved.driver || !saved.uiSpec) return undefined;
  const ui = UiSpecPayload.safeParse(saved.uiSpec);
  if (!ui.success || ui.data.cardId !== saved.cardId || ui.data.driverId !== saved.driver.driverId) return undefined;
  const context = ForgeSnapshot.safeParse(saved.forgeContext);
  if (context.success && context.data.device.cardId === saved.cardId
    && isDeepStrictEqual(context.data.revs[context.data.cursor], ui.data)
    && isDeepStrictEqual(context.data.verification, saved.verification)) {
    try { return forge.restore(context.data); }
    catch (error) { log(`[library] could not restore editing for ${saved.cardId}: ${(error as Error).message}`); }
  }
  // Older saves have a complete interface but no editing history. Preserve that exact interface.
  const card = saved.card;
  const legacy = {
    version: 1, specId: ui.data.specId,
    device: {
      cardId: saved.cardId, name: (card?.name ?? saved.label).slice(0, 80),
      ...(card ? { maker: card.maker.slice(0, 80), model: card.model.slice(0, 80), category: card.category, notes: card.notes?.slice(0, 600) } : {}),
    },
    driver: saved.driver, verification: saved.verification, room: [],
    revs: [ui.data], cursor: 0,
    ...(ui.data.gen3d?.skin ? { skin: ui.data.gen3d.skin } : {}),
  };
  try { return forge.restore(legacy); }
  catch (error) { log(`[library] could not restore editing for ${saved.cardId}: ${(error as Error).message}`); return undefined; }
}
