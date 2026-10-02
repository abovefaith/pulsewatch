export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until at least one token is available again (0 when allowed). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token-bucket limiter keyed by client (e.g. IP). Allows short bursts
 * up to `capacity` while enforcing a steady average rate.
 *
 * For a multi-instance deployment this state would move to Redis; the
 * interface stays the same.
 */
export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();
  #callsSincePrune = 0;

  constructor(options: { capacity: number; refillPerMinute: number; now?: () => number }) {
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerMinute / 60_000;
    this.#now = options.now ?? Date.now;
  }

  get trackedKeys(): number {
    return this.#buckets.size;
  }

  take(key: string): RateLimitResult {
    if (++this.#callsSincePrune >= 1_000) this.prune();

    const now = this.#now();
    const bucket = this.#refill(this.#buckets.get(key), now);
    this.#buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        limit: this.#capacity,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
      };
    }

    return {
      allowed: false,
      limit: this.#capacity,
      remaining: 0,
      retryAfterSeconds: Math.ceil((1 - bucket.tokens) / this.#refillPerMs / 1000),
    };
  }

  /** Drops buckets that have fully refilled — they carry no information. */
  prune(): void {
    this.#callsSincePrune = 0;
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (this.#refill(bucket, now).tokens >= this.#capacity) this.#buckets.delete(key);
    }
  }

  #refill(bucket: Bucket | undefined, now: number): Bucket {
    if (!bucket) return { tokens: this.#capacity, updatedAt: now };
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerMs);
    bucket.updatedAt = now;
    return bucket;
  }
}
