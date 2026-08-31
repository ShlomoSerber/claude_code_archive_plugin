/**
 * Retry pacing (ARCHITECTURE §6).
 *
 * Full jitter, not exponential-with-jitter: when many jobs fail at once — the
 * normal case, since they all share one network and one token — synchronized
 * retries are what turns a blip into a rate-limit ban.
 */

export type BackoffOptions = {
  baseMs?: number;
  capMs?: number;
};

const DEFAULT_BASE_MS = 1_000;
const DEFAULT_CAP_MS = 90_000;

/** `random(0, min(cap, base * 2^attempt))`, with `attempt` zero-based. */
export function fullJitterDelay(
  attempt: number,
  random: () => number,
  options: BackoffOptions = {},
): number {
  const base = options.baseMs ?? DEFAULT_BASE_MS;
  const cap = options.capMs ?? DEFAULT_CAP_MS;
  const exponent = Math.min(attempt, 31);
  const ceiling = Math.min(cap, base * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/**
 * A server's `Retry-After` always wins over our own guess: it is the only
 * number that reflects when the quota actually resets.
 */
export function nextAttemptAt(args: {
  now: number;
  attempt: number;
  random: () => number;
  retryAfterSeconds?: number | undefined;
  options?: BackoffOptions;
}): number {
  if (args.retryAfterSeconds !== undefined && args.retryAfterSeconds >= 0) {
    return args.now + Math.ceil(args.retryAfterSeconds * 1000);
  }
  return args.now + fullJitterDelay(args.attempt, args.random, args.options ?? {});
}

/**
 * The persisted circuit breaker. Short-lived processes cannot hold breaker
 * state in memory, so consecutive failures push a wake-up time into the
 * database and every process checks it before doing anything.
 *
 * 30 min, 1 h, 2 h, 4 h, capped at 6 h.
 */
export function circuitBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const thirtyMinutes = 30 * 60 * 1000;
  const sixHours = 6 * 60 * 60 * 1000;
  return Math.min(sixHours, thirtyMinutes * 2 ** (consecutiveFailures - 1));
}

/** Parse `Retry-After`, which is either a delay in seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
