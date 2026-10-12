export class Store<T> {
  private readonly listeners = new Set<() => void>();

  constructor(private state: T) {}

  readonly get = (): T => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(update: (state: T) => T): void {
    const next = update(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
