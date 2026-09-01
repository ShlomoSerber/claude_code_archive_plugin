import fs from 'node:fs';
import path from 'node:path';
import { toErrorInfo } from '../core/errors.ts';
import type { LogFields, LogLevel, Logger } from '../ports/logger.ts';

/**
 * Synchronous NDJSON appender (ARCHITECTURE §11).
 *
 * Synchronous on purpose: a hook process lives for ~200 ms and must have its
 * lines on disk before it exits. An async logger would lose exactly the lines
 * that explain a crash.
 *
 * Nothing here may throw. A logger that breaks a session is worse than no log.
 */

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type NdjsonLoggerOptions = {
  file: string;
  level?: LogLevel;
  /** Rotate once the file passes this size. One generation is kept. */
  maxBytes?: number;
  base?: LogFields;
};

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export function createNdjsonLogger(options: NdjsonLoggerOptions): Logger {
  const state: WriterState = {
    file: options.file,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    minLevel: LEVEL_ORDER[options.level ?? 'info'],
    ready: false,
    bytesSinceCheck: Number.MAX_SAFE_INTEGER,
  };
  return makeLogger(state, options.base ?? {});
}

type WriterState = {
  file: string;
  maxBytes: number;
  minLevel: number;
  ready: boolean;
  /** Bytes written since the last size check, so we do not stat on every line. */
  bytesSinceCheck: number;
};

function makeLogger(state: WriterState, base: LogFields): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields, err?: unknown): void => {
    if (LEVEL_ORDER[level] < state.minLevel) return;
    write(state, serialize(level, event, { ...base, ...fields }, err));
  };
  return {
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
    info: (event, fields) => {
      emit('info', event, fields);
    },
    warn: (event, fields, err) => {
      emit('warn', event, fields, err);
    },
    error: (event, fields, err) => {
      emit('error', event, fields, err);
    },
    child: (fields) => makeLogger(state, { ...base, ...fields }),
    close: () => undefined,
  };
}

function serialize(level: LogLevel, event: string, fields: LogFields, err: unknown): string {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value;
  }
  if (err !== undefined) line['err'] = toErrorInfo(err);
  try {
    return `${JSON.stringify(line)}\n`;
  } catch {
    return `${JSON.stringify({ ts: line['ts'], level, event, err: 'unserializable' })}\n`;
  }
}

function write(state: WriterState, line: string): void {
  try {
    if (!state.ready) {
      fs.mkdirSync(path.dirname(state.file), { recursive: true });
      state.ready = true;
    }
    if (state.bytesSinceCheck > 64 * 1024) {
      rotateIfLarge(state);
      state.bytesSinceCheck = 0;
    }
    fs.appendFileSync(state.file, line, { encoding: 'utf8', mode: 0o600 });
    state.bytesSinceCheck += line.length;
  } catch {
    // A broken log must never break the archive, let alone the session.
  }
}

function rotateIfLarge(state: WriterState): void {
  let size: number;
  try {
    size = fs.statSync(state.file).size;
  } catch {
    return;
  }
  if (size <= state.maxBytes) return;
  try {
    // rename, without removing the previous backup first. POSIX rename
    // replaces atomically; the old two-step let a second process delete the
    // backup another had just written and then fail its own rename, leaving
    // neither file. Windows needs the remove, so it is the fallback.
    fs.renameSync(state.file, `${state.file}.1`);
  } catch (err) {
    // ENOENT means another process rotated first — its backup is the one to
    // keep, and removing it here would destroy a generation of the log for
    // nothing. Only Windows' "cannot rename onto an existing file" is worth
    // the destructive retry.
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return;
    try {
      fs.rmSync(`${state.file}.1`, { force: true });
      fs.renameSync(state.file, `${state.file}.1`);
    } catch {
      // Keep appending to the file we have.
    }
  }
}
