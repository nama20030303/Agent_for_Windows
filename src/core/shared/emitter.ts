export type Listener<T> = (value: T) => void;

/** Minimal typed event emitter that never throws from a listener. */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
