import { CollectionError } from "./errors.ts";

export interface RetryPolicy {
  /** Total tries including the first. */
  attempts: number;
  /** Delay before the n-th retry (1-based), used when the LMS gave no Retry-After. */
  backoffMs: (retry: number) => number;
  /** A Retry-After longer than this is not waited out; the error is recorded with its time instead. */
  maxWaitMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  backoffMs: (retry) => 1000 * 2 ** (retry - 1),
  maxWaitMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

/**
 * Retries only errors the contract marks retryable (network, 5xx, rate limit,
 * interrupted download). AUTH_REQUIRED and every non-retryable error fail at
 * once: no repeated login attempts (SPEC-001).
 */
export async function withRetry<T>(work: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof CollectionError) || !error.appError.retryable || attempt >= policy.attempts) throw error;
      const after = error.appError.retryAfter;
      const wait = after ? new Date(after).getTime() - policy.now().getTime() : policy.backoffMs(attempt);
      if (wait > policy.maxWaitMs) throw error;
      await policy.sleep(Math.max(0, wait));
    }
  }
}
