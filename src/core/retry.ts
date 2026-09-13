/** Exponential backoff with jitter; a provider's `Retry-After` wins when present. */

export interface RetryOptions {
  /** Attempts after the first. Default 2. */
  retries?: number;
  /** Default 500. */
  baseDelayMs?: number;
  /** Default 8000. */
  maxDelayMs?: number;
}

export const DEFAULT_RETRY: Required<RetryOptions> = { retries: 2, baseDelayMs: 500, maxDelayMs: 8000 };

/** Delay before retry number `attempt` (1-based). */
export function retryDelay(attempt: number, opts: Required<RetryOptions>, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, opts.maxDelayMs);
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/** Resolves after `ms`; rejects with the signal's reason if aborted first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    // Not unref'd on purpose: during a backoff this timer may be the only
    // thing keeping the process alive, and an unref'd one lets Node exit
    // with the request still pending.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
