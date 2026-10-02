import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
  /** Retries after the first attempt (total attempts = retries + 1). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  random?: () => number;
}

/** Marks an error as permanent so `retry` gives up immediately. */
export class NonRetryableError extends Error {
  override name = 'NonRetryableError';
}

/**
 * Retries an async operation with exponential backoff and "equal jitter",
 * which spreads retries out so many failing clients don't hammer a recovering
 * server in lockstep.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    signal,
    shouldRetry = (error) => !(error instanceof NonRetryableError),
    onRetry,
    random = Math.random,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || signal?.aborted || !shouldRetry(error)) throw error;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.round(ceiling / 2 + random() * (ceiling / 2));
      onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs, undefined, { signal });
    }
  }
}
