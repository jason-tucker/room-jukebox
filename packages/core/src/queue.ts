/**
 * Minimal typed FIFO with a monotonically increasing revision counter.
 * Every mutation that changes the queue bumps `revision` exactly once.
 * Pure data structure: no I/O, no timers, no randomness.
 */
export class Queue<T extends { id: string }> {
  #items: T[] = [];
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#items.length;
  }

  /** Snapshot of the queued items in play order. */
  toArray(): readonly T[] {
    return [...this.#items];
  }

  enqueue(item: T): void {
    this.#items.push(item);
    this.#revision += 1;
  }

  /** Removes and returns the head of the queue, or `undefined` when empty (no revision bump). */
  next(): T | undefined {
    const head = this.#items.shift();
    if (head !== undefined) this.#revision += 1;
    return head;
  }

  /** Removes the item with `id`. Returns true when something was removed. */
  remove(id: string): boolean {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.#items.splice(index, 1);
    this.#revision += 1;
    return true;
  }
}
