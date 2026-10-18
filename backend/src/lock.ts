/**
 * One run per consultation at a time (#6). Two answers (or an answer and a
 * retry) for the same consultation arriving together would otherwise both see
 * "waiting for an answer" and both resume the graph, overwriting state and
 * paying for the model calls twice. The second caller gets null and the API
 * answers 409.
 */
export interface ConsultationLock {
  /** Take the lock for `id`, or null if someone holds it. Call the returned function to release it. */
  tryAcquire(id: string): Promise<(() => Promise<void>) | null>;
}

/** Per-process lock. Enough for one instance; use a shared lock when running several. */
export class InMemoryLock implements ConsultationLock {
  private held = new Set<string>();

  async tryAcquire(id: string) {
    if (this.held.has(id)) return null;
    this.held.add(id);
    return async () => {
      this.held.delete(id);
    };
  }
}
