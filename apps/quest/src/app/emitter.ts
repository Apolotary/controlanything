/** Minimal typed event emitter. Listener errors are caught and logged so one bad handler cannot stop the rest. */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(e: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (e: never) => void);
    return () => set!.delete(fn as (e: never) => void);
  }

  emit<K extends keyof Events>(type: K, e: Events[K]): void {
    for (const fn of this.listeners.get(type) ?? []) {
      try {
        (fn as (e: Events[K]) => void)(e);
      } catch (err) {
        console.error(`[emitter] ${String(type)} listener failed`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
