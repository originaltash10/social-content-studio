/**
 * Holds one value and tells listeners when it changes. The board keeps its render controller in
 * one: the controller is made and disposed of inside an effect, and the component reads the
 * current one with useSyncExternalStore, so no React state is set from the effect.
 */
export class Slot<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  readonly get = (): T => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces the value and tells every listener, unless it is the same value. */
  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
}
