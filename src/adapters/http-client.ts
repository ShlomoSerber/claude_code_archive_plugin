import { fullJitterDelay, parseRetryAfter } from '../core/backoff.ts';
import { RetryableError, isRetryableHttpStatus, isRetryableNetworkError } from '../core/errors.ts';
import { systemClock, type Clock } from '../ports/clock.ts';
import { nullLogger, type Logger } from '../ports/logger.ts';

/**
 * The one place that speaks HTTP (ARCHITECTURE §6).
 *
 * It handles the retries that make sense *inside* a single run: a connection
 * reset, a 503, a 429 with a `Retry-After`. Failures that outlive a run are the
 * queue's problem, because this process will not be alive to see them.
 *
 * Every request carries a timeout. A hung socket with no timeout is how a
 * background worker becomes a process that never exits.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpClientOptions = {
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /** Per-request timeout. */
  timeoutMs?: number;
  maxAttempts?: number;
  /** Total time this client may spend retrying across one run. */
  budgetMs?: number;
};

export type SendOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Statuses to return rather than retry, on top of the 2xx range. */
  expect?: number[];
  /** Set false for requests that must not be repeated. */
  retry?: boolean;
};

export type HttpClient = {
  send(url: string, options?: SendOptions): Promise<Response>;
  /** Milliseconds of retry budget left in this run. */
  remainingBudgetMs(): number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BUDGET_MS = 10 * 60_000;

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = clock.now();

  const remainingBudgetMs = (): number => Math.max(0, budgetMs - (clock.now() - startedAt));

  return {
    remainingBudgetMs,

    async send(url: string, sendOptions: SendOptions = {}): Promise<Response> {
      const expect = new Set(sendOptions.expect ?? []);
      const allowRetry = sendOptions.retry !== false;
      let lastError: unknown;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const timeout = AbortSignal.timeout(
          sendOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        const signal =
          sendOptions.signal === undefined
            ? timeout
            : AbortSignal.any([timeout, sendOptions.signal]);

        let response: Response;
        try {
          const init: RequestInit = { method: sendOptions.method ?? 'GET', signal };
          if (sendOptions.headers !== undefined) init.headers = sendOptions.headers;
          if (sendOptions.body !== undefined && sendOptions.body !== null) {
            init.body = sendOptions.body;
          }
          response = await doFetch(url, init);
        } catch (err) {
          sendOptions.signal?.throwIfAborted();
          lastError = err;
          if (!allowRetry || !isRetryableNetworkError(err)) throw err;
          if (!(await waitBeforeRetry({ attempt, clock, remainingBudgetMs, logger, url })))
            throw err;
          continue;
        }

        if (response.ok || expect.has(response.status)) return response;
        if (!allowRetry || !isRetryableHttpStatus(response.status)) return response;

        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), clock.now());
        lastError = new RetryableError(`HTTP ${response.status} from ${hostOf(url)}`, {
          status: response.status,
          ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
        });
        // The body must be drained or the connection leaks.
        await response.body?.cancel().catch(() => undefined);
        // No point sleeping sixteen seconds when there is no attempt left.
        if (attempt + 1 >= maxAttempts) throw asThrowable(lastError, url);
        const waited = await waitBeforeRetry({
          attempt,
          clock,
          remainingBudgetMs,
          logger,
          url,
          retryAfterSeconds: retryAfter,
          status: response.status,
        });
        // Not `return response`: its body was drained above, so every caller
        // died on `Body is unusable` — a TypeError that is neither fatal nor a
        // network error, so the queue treated a rate limit as a local bug, kept
        // hammering Drive without opening the circuit breaker, and showed the
        // user that TypeError with no remediation. The status and Retry-After
        // are already captured in lastError, which is what should surface.
        if (!waited) throw asThrowable(lastError, url);
      }

      throw asThrowable(lastError, url);
    },
  };
}

async function waitBeforeRetry(args: {
  attempt: number;
  clock: Clock;
  remainingBudgetMs: () => number;
  logger: Logger;
  url: string;
  retryAfterSeconds?: number | undefined;
  status?: number;
}): Promise<boolean> {
  const delay =
    args.retryAfterSeconds !== undefined
      ? args.retryAfterSeconds * 1000
      : fullJitterDelay(args.attempt, () => args.clock.random());
  if (delay >= args.remainingBudgetMs()) {
    args.logger.warn('http.budget_exhausted', {
      host: hostOf(args.url),
      status: args.status ?? null,
    });
    return false;
  }
  args.logger.debug('http.retry', {
    host: hostOf(args.url),
    attempt: args.attempt,
    delay_ms: delay,
    status: args.status ?? null,
  });
  await args.clock.sleep(delay);
  return true;
}

/** Never rethrow a bare unknown: the logger needs a name and a message. */
function asThrowable(error: unknown, url: string): Error {
  if (error instanceof Error) return error;
  return new RetryableError(`gave up on ${hostOf(url)}`, { cause: error });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/** Read a JSON body without letting a malformed one throw a parse error. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Google's error envelope: `{ error: { message } }` or `{ error, error_description }`. */
export function describeApiError(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return `HTTP ${status}: ${message}`;
    }
    if (typeof error === 'string') {
      const description = record['error_description'];
      return typeof description === 'string'
        ? `HTTP ${status}: ${error} (${description})`
        : `HTTP ${status}: ${error}`;
    }
  }
  return `HTTP ${status}`;
}
