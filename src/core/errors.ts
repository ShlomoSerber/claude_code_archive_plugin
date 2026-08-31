/**
 * Error taxonomy (ARCHITECTURE §11).
 *
 * Three shapes, because three different things should happen:
 *  - RetryableError: back off and try again later.
 *  - FatalError:     stop retrying, tell the user how to fix it.
 *  - BugError:       an invariant broke; log the full stack.
 */

export type ErrorInfo = {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
};

export class ArchiveError extends Error {
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.cause = options?.cause;
  }
}

/** Transient: network blips, 429, 5xx. Retried with backoff, logged at `warn`. */
export class RetryableError extends ArchiveError {
  readonly status: number | undefined;
  /** Seconds from a `Retry-After` header, when the server supplied one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number; retryAfterSeconds?: number },
  ) {
    super(message, options);
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

/** Permanent until the user acts: revoked token, missing config, full Drive. */
export class FatalError extends ArchiveError {
  /** Shown verbatim to the user by `/archive:status`. Always actionable. */
  readonly remediation: string;

  constructor(message: string, remediation: string, options?: { cause?: unknown }) {
    super(message, options);
    this.remediation = remediation;
  }
}

/** An invariant we control was violated. Never expected; always a code defect. */
export class BugError extends ArchiveError {}

const RETRYABLE_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 509]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status) || (status >= 500 && status < 600);
}

/** True for the network-level failures worth another attempt. */
export function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  const code = errorCode(err);
  if (code !== undefined && RETRYABLE_SYSCALL_CODES.has(code)) return true;
  if (err instanceof Error && err.name === 'TimeoutError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  // fetch() wraps the real cause; dig one level.
  if (err instanceof Error && err.cause !== undefined && err.cause !== err) {
    return isRetryableNetworkError(err.cause);
  }
  return false;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Flatten any thrown value into the shape the NDJSON logger writes. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    const info: ErrorInfo = { name: err.name, message: err.message };
    const code = errorCode(err);
    if (code !== undefined) info.code = code;
    if (err instanceof RetryableError && err.status !== undefined) info.status = err.status;
    if (err.stack !== undefined) info.stack = err.stack;
    return info;
  }
  return { name: 'NonError', message: safeStringify(err) };
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    // `JSON.stringify` returns undefined for undefined, functions and symbols;
    // the lib types do not say so, hence the assertion.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The resumable-upload session URI is gone (Drive answered 404/410).
 *
 * Not retryable and not fatal: the fix is to start a fresh upload session,
 * which the caller does after checking whether the file already landed.
 */
export class UploadSessionExpired extends ArchiveError {}
