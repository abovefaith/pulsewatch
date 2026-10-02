/**
 * Caps how many async tasks run at once. Waiting tasks are queued FIFO and a
 * finishing task hands its slot directly to the next waiter, so the limit can
 * never be exceeded by a caller sneaking in between release and acquire.
 */
export class ConcurrencyLimiter {
  readonly #max: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];
  readonly #idleWaiters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active < this.#max) {
      this.#active++;
    } else {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) {
        next();
      } else {
        this.#active--;
        if (this.#active === 0) for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    }
  }

  /** Resolves once every running and queued task has settled. */
  onIdle(): Promise<void> {
    if (this.#active === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }
}
