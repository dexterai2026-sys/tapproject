export type TapListener = (chipId: string) => void;

/** Anything that can report "a chip with this ID was tapped". */
export interface CardInput {
  start(): Promise<void> | void;
  stop(): void;
  subscribe(listener: TapListener): () => void;
}

export class TapEmitter {
  private listeners = new Set<TapListener>();
  subscribe(listener: TapListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected emit(chipId: string): void {
    for (const l of [...this.listeners]) l(chipId);
  }
}
