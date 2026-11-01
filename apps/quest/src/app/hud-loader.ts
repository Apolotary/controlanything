/**
 * Picks the HUD: gen3d-lead's renderer (src/hud/index.ts exporting createHud) when it exists, else the shell's
 * debug HUD. `?hud=debug` forces the debug one. The chosen HUD is wrapped so a method the other side has not
 * implemented yet is a logged no-op instead of a crash.
 */
import { DebugHud } from './debug-hud';
import type { CreateHud, Hud, HudContext } from './hud-contract';

const modules = import.meta.glob('../hud/index.ts');

export async function loadHud(ctx: HudContext, force?: string | null): Promise<{ hud: Hud; kind: 'gen3d' | 'debug'; error?: string }> {
  let error: string | undefined;
  const loader = modules['../hud/index.ts'];
  if (loader && force !== 'debug') {
    try {
      const m = (await loader()) as { createHud?: CreateHud };
      if (typeof m.createHud === 'function') return { hud: tolerant(m.createHud(ctx), 'gen3d'), kind: 'gen3d' };
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
  return new Proxy(hud, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'root' || typeof prop === 'symbol') return v;
      if (v === undefined) {
        return (..._args: unknown[]) => {
          if (!warned.has(String(prop))) {
            warned.add(String(prop));
            console.warn(`[hud:${name}] ${String(prop)}() is not implemented`);
          }
          return prop === 'on' ? () => {} : undefined;
        };
      }
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
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
    },
  });
}
