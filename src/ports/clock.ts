/** Time, injectable so backoff and staleness logic are testable without waiting. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or rejects if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Uniform random in `[0, 1)`. Lives here so full-jitter backoff is testable. */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason as Error);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
