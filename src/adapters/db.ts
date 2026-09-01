import fs from 'node:fs';
import path from 'node:path';
import { getSqlite, type DatabaseSyncInstance } from './sqlite.ts';
import { MIGRATIONS } from '../core/migrations.ts';
import { BugError } from '../core/errors.ts';

/**
 * SQLite access (ARCHITECTURE §8).
 *
 * One database holds both the catalog and the work queue, so a backup and the
 * job that produced it commit together.
 *
 * `busy_timeout` is the pragma that matters most: the default is 0, which makes
 * any writer contention throw `SQLITE_BUSY` instantly. Hooks and the worker
 * write concurrently by design.
 */

export type Db = DatabaseSyncInstance;

export type OpenOptions = {
  readOnly?: boolean;
  /** Skip migrations. Only for read-only inspection of a foreign database. */
  skipMigrations?: boolean;
  busyTimeoutMs?: number;
};

export function openDatabase(file: string, options: OpenOptions = {}): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new (getSqlite().DatabaseSync)(file, { readOnly: options.readOnly ?? false });
  if (file !== ':memory:' && options.readOnly !== true) restrictToOwner(file);
  applyPragmas(db, options);
  if (options.skipMigrations !== true && options.readOnly !== true) {
    migrate(db);
  }
  return db;
}

/**
 * Owner-only permissions on the catalog and its WAL sidecars.
 *
 * tokens.json and the log are already 0600; the catalog was left at the umask
 * while holding every user prompt verbatim, which is the more sensitive of the
 * two. A no-op on Windows, where the user-profile directory is already ACL'd.
 */
function restrictToOwner(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.chmodSync(`${file}${suffix}`, 0o600);
    } catch {
      // The sidecars exist only while a connection is open, and a filesystem
      // without POSIX modes is not a reason to fail to open the catalog.
    }
  }
}

function applyPragmas(db: Db, options: OpenOptions): void {
  const busyTimeout = options.busyTimeoutMs ?? 5_000;
  // WAL lets the worker write while a hook reads. It is a persistent property
  // of the file, but setting it per connection costs nothing and documents it.
  if (options.readOnly !== true) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec(`PRAGMA busy_timeout = ${String(Math.trunc(busyTimeout))}`);
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Apply every migration past the recorded version, in one transaction.
 *
 * Both the hooks and the worker call this at startup; `BEGIN IMMEDIATE` plus
 * the re-read of `user_version` makes the loser of that race a no-op.
 */
export function migrate(db: Db): number {
  const current = schemaVersion(db);
  if (current >= MIGRATIONS.length) return current;

  db.exec('BEGIN IMMEDIATE');
  try {
    const version = schemaVersion(db);
    for (let index = version; index < MIGRATIONS.length; index++) {
      const sql = MIGRATIONS[index];
      if (sql === undefined) throw new BugError(`missing migration ${String(index)}`);
      db.exec(sql);
    }
    // `PRAGMA` takes no bound parameters; the value is a checked integer.
    db.exec(`PRAGMA user_version = ${String(Math.trunc(MIGRATIONS.length))}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return MIGRATIONS.length;
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE`. Use it for every read-then-write: a
 * deferred transaction upgrades to a write lock too late and can deadlock.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Transaction already unwound by the failure itself.
    }
    throw err;
  }
}

/** Fold the WAL back into the main file. Called once, as the worker exits. */
export function checkpointAndClose(db: Db): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // A concurrent reader can block the truncate; the next run will do it.
  }
  db.close();
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

export function kvDelete(db: Db, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export function kvGetNumber(db: Db, key: string): number | undefined {
  const raw = kvGet(db, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function kvSetNumber(db: Db, key: string, value: number, now: number): void {
  kvSet(db, key, String(value), now);
}
