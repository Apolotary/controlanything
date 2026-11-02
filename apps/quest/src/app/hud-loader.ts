/**
 * The compact v2 HUD is the default. ?hud=v1 keeps the original renderer; ?hud=debug uses the shell HUD.
 * Wait for SDF text before creating v2 so its first labels render correctly.
 */
import { DebugHud } from './debug-hud';
import type { CreateHud, Hud, HudContext } from './hud-contract';

const modules = import.meta.glob(['../hud/index.ts', '../hud/v2/index.ts']);

export type HudKind = 'v2' | 'gen3d' | 'debug';

export async function loadHud(ctx: HudContext, force?: string | null): Promise<{ hud: Hud; kind: HudKind; error?: string }> {
  let error: string | undefined;
  if (force !== 'v1' && force !== 'debug') {
    try {
      const loader = modules['../hud/v2/index.ts'];
      if (!loader) throw new Error('v2 module unavailable');
      const m = (await loader()) as { createHud: CreateHud; whenSdfReady: () => Promise<void> };
      await m.whenSdfReady();
      return { hud: tolerant(m.createHud(ctx), 'v2'), kind: 'v2' };
    } catch (e) {
      error = `v2 HUD failed to load: ${(e as Error).message}`;
      console.error(e);
    }
  }
  const loader = modules['../hud/index.ts'];
  if (loader && force !== 'debug') {
    try {
      const m = (await loader()) as { createHud?: CreateHud };
      if (typeof m.createHud === 'function') return { hud: tolerant(m.createHud(ctx), 'gen3d'), kind: 'gen3d', error };
      error = 'src/hud/index.ts has no createHud export';
    } catch (e) {
      error = `gen3d HUD failed to load: ${(e as Error).message}`;
      console.error(e);
    }
  }
  return { hud: tolerant(new DebugHud(), 'debug'), kind: 'debug', error };
}

/** Missing methods become no-ops (logged once); exceptions inside HUD calls are caught and logged. */
export function tolerant(hud: Hud, name: string): Hud {
  const warned = new Set<string>();
  const wrappers = new Map<PropertyKey, { source: unknown; wrapped: unknown }>();
  return new Proxy(hud, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'root' || typeof prop === 'symbol') return v;
      // Cache by the current value: the app re-assigns some methods (upsertTarget/removeTarget) after loading,
      // and a stale wrapper of the original method would silently bypass the override.
      const cached = wrappers.get(prop);
      if (cached && cached.source === v) return cached.wrapped;
      if (v === undefined) {
        const missing = (..._args: unknown[]) => {
          if (!warned.has(String(prop))) {
            warned.add(String(prop));
            console.warn(`[hud:${name}] ${String(prop)}() is not implemented`);
          }
          return prop === 'on' ? () => {} : undefined;
        };
        wrappers.set(prop, { source: v, wrapped: missing });
        return missing;
      }
      if (typeof v !== 'function') return v;
      const wrapped = (...args: unknown[]) => {
        try {
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          if (!warned.has(`err:${String(prop)}`)) {
            warned.add(`err:${String(prop)}`);
            console.error(`[hud:${name}] ${String(prop)}() threw`, e);
          }
          return prop === 'on' ? () => {} : undefined;
        }
      };
      wrappers.set(prop, { source: v, wrapped });
      return wrapped;
    },
  });
}
