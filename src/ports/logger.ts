import type { ErrorInfo } from '../core/errors.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields written alongside every log line. */
export type LogFields = Record<string, string | number | boolean | null | undefined> & {
  err?: never;
};

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields, err?: unknown): void;
  error(event: string, fields?: LogFields, err?: unknown): void;
  /** A logger that stamps `fields` onto every line it writes. */
  child(fields: LogFields): Logger;
  /** Flush buffered lines. Always called before a hook process exits. */
  close(): void;
}

export type LogLine = {
  ts: string;
  level: LogLevel;
  event: string;
  err?: ErrorInfo;
} & LogFields;

/** Drops everything. Default for tests and for code paths with no data dir yet. */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
  close: () => undefined,
};
