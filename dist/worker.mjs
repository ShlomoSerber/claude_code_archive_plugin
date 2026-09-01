import { createRequire as __archiveCreateRequire } from 'node:module';
const require = __archiveCreateRequire(import.meta.url);

// src/core/quiet.ts
var applied = false;
function silenceSqliteWarning() {
  if (applied) return;
  applied = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...rest) => {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    original(warning, ...rest);
  };
}
function isSqliteExperimentalWarning(warning, rest) {
  const type = warningType(warning, rest);
  if (type !== "ExperimentalWarning") return false;
  const text = warning instanceof Error ? warning.message : String(warning);
  return text.includes("SQLite");
}
function warningType(warning, rest) {
  const [second] = rest;
  if (typeof second === "string") return second;
  if (typeof second === "object" && second !== null) {
    const type = second.type;
    if (typeof type === "string") return type;
  }
  return warning instanceof Error ? warning.name : "";
}
silenceSqliteWarning();

// src/adapters/lock.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// src/ports/clock.ts
var systemClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms2, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms2);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  })
};

// src/ports/logger.ts
var nullLogger = {
  debug: () => void 0,
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
  child: () => nullLogger,
  close: () => void 0
};

// src/adapters/lock.ts
var META_FILE = "owner.json";
var DEFAULT_HEARTBEAT_MS = 5e3;
var MIN_STALE_MS = 1e4;
function acquireLock(dir, options = {}) {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = Math.max(MIN_STALE_MS, options.staleMs ?? heartbeatMs * 4);
  const owner = { pid: process.pid, hostname: os.hostname(), startedAt: clock.now() };
  if (!tryMkdir(dir)) {
    const existing = readOwner(dir);
    if (!isStale(dir, staleMs, clock, existing)) {
      logger.debug("lock.busy", { holder_pid: existing?.pid ?? null });
      return null;
    }
    logger.warn("lock.breaking_stale", { holder_pid: existing?.pid ?? null });
    if (!breakLock(dir)) return null;
    if (!tryMkdir(dir)) return null;
  }
  try {
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(owner), { mode: 384 });
  } catch {
  }
  const timer = setInterval(() => {
    heartbeat(dir, clock);
  }, heartbeatMs);
  timer.unref();
  let released = false;
  return {
    dir,
    owner,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (!stillOurs(dir, owner)) {
        logger.debug("lock.not_ours_on_release", { dir });
        return;
      }
      releaseWithRetry(dir, logger);
    }
  };
}
function tryMkdir(dir) {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    if (err.code === "ENOENT") {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      return tryMkdir(dir);
    }
    throw err;
  }
}
function heartbeat(dir, clock) {
  const now = new Date(clock.now());
  try {
    fs.utimesSync(dir, now, now);
  } catch {
  }
}
function readOwner(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, hostname, startedAt } = parsed;
    if (typeof pid !== "number" || typeof hostname !== "string") return null;
    return { pid, hostname, startedAt: typeof startedAt === "number" ? startedAt : 0 };
  } catch {
    return null;
  }
}
function isStale(dir, staleMs, clock, owner) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    return true;
  }
  const age = clock.now() - mtimeMs;
  if (age > staleMs) return true;
  if (owner !== null && owner.hostname === os.hostname() && !isPidAlive(owner.pid)) return true;
  return false;
}
function isPidAlive(pid) {
  if (pid <= 0 || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function breakLock(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
function stillOurs(dir, owner) {
  const current = readOwner(dir);
  return current !== null && current.pid === owner.pid && current.startedAt === owner.startedAt;
}
function releaseWithRetry(dir, logger) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        logger.warn("lock.release_failed", {}, err);
        return;
      }
      sleepSync(Math.min(500, 10 * 3 ** attempt));
    }
  }
  logger.warn("lock.release_gave_up", { dir });
}
function sleepSync(ms2) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms2);
}

// src/hooks/last-resort.ts
import fs2 from "node:fs";
import path3 from "node:path";

// src/core/paths.ts
import path2 from "node:path";
import { existsSync } from "node:fs";
import os2 from "node:os";
function resolveClaudeDir(env, homedir = os2.homedir) {
  const configured = trimmed(env["CLAUDE_CONFIG_DIR"]);
  if (configured !== void 0) return path2.resolve(configured);
  return path2.join(homedir(), ".claude");
}
function resolveDataDir(env, claudeDir) {
  const override = trimmed(env["ARCHIVE_DATA_DIR"]);
  if (override !== void 0) return path2.resolve(override);
  const provided = trimmed(env["CLAUDE_PLUGIN_DATA"]);
  if (provided !== void 0) return path2.resolve(provided);
  const root = path2.join(claudeDir, "plugins", "data");
  const canonical = path2.join(root, PLUGIN_DATA_SLUG);
  if (existsSync(canonical)) return canonical;
  const legacy = path2.join(root, LEGACY_PLUGIN_SLUG);
  if (existsSync(legacy)) return legacy;
  return canonical;
}
var PLUGIN_DATA_SLUG = "archive-claude-code-archive";
var LEGACY_PLUGIN_SLUG = "claude-code-archive-plugin";
function resolvePaths(env, homedir = os2.homedir) {
  const claudeDir = resolveClaudeDir(env, homedir);
  const dataDir = resolveDataDir(env, claudeDir);
  return {
    claudeDir,
    projectsDir: path2.join(claudeDir, "projects"),
    settingsFile: path2.join(claudeDir, "settings.json"),
    dataDir,
    dbFile: path2.join(dataDir, "archive.sqlite"),
    logFile: path2.join(dataDir, "archive.log"),
    tokenFile: path2.join(dataDir, "tokens.json"),
    statusFile: path2.join(dataDir, "status.json"),
    lockDir: path2.join(dataDir, "worker.lock"),
    runtimeCacheFile: path2.join(dataDir, "runtime.json"),
    stagingDir: path2.join(dataDir, "staging"),
    restoreDir: path2.join(dataDir, "restoring")
  };
}
function trimmed(value) {
  if (value === void 0) return void 0;
  const out = value.trim();
  return out.length > 0 ? out : void 0;
}

// src/hooks/last-resort.ts
function clearLastResort(event) {
  try {
    fs2.rmSync(path3.join(resolvePaths(process.env).dataDir, markerName(event)), { force: true });
  } catch {
  }
}
function markerName(event) {
  if (event.startsWith("worker.")) return "worker-error.json";
  return event.startsWith("hook.session_start") ? "hook-error-start.json" : "hook-error-end.json";
}
function logLastResort(event, err) {
  try {
    const paths = resolvePaths(process.env);
    fs2.mkdirSync(paths.dataDir, { recursive: true });
    const line = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level: "error",
      event,
      err: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err)
      }
    });
    fs2.appendFileSync(paths.logFile, `${line}
`, { mode: 384 });
    fs2.writeFileSync(
      path3.join(paths.dataDir, markerName(event)),
      `${JSON.stringify({ at: Date.now(), event, message: line })}
`,
      { mode: 384 }
    );
  } catch {
  }
}

// src/adapters/db.ts
import fs3 from "node:fs";
import path4 from "node:path";

// src/adapters/sqlite.ts
import { createRequire } from "node:module";

// src/core/errors.ts
var ArchiveError = class extends Error {
  cause;
  constructor(message, options) {
    super(message);
    this.name = new.target.name;
    this.cause = options?.cause;
  }
};
var RetryableError = class extends ArchiveError {
  status;
  /** Seconds from a `Retry-After` header, when the server supplied one. */
  retryAfterSeconds;
  constructor(message, options) {
    super(message, options);
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
};
var FatalError = class extends ArchiveError {
  /** Shown verbatim to the user by `/archive:status`. Always actionable. */
  remediation;
  /**
   * The HTTP status that produced it, when there was one.
   *
   * The reaper needs to tell "Drive says that file is not there" (404) from
   * "Drive would not talk to us" (401, 403, a full quota). It used to read
   * every FatalError as the first, and so withdrew the verification of a
   * perfectly good archive on every session, every sweep, whenever a token
   * expired.
   */
  status;
  constructor(message, remediation, options) {
    super(message, options);
    this.remediation = remediation;
    this.status = options?.status;
  }
};
var BugError = class extends ArchiveError {
};
var RETRYABLE_SYSCALL_CODES = /* @__PURE__ */ new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
var RETRYABLE_HTTP_STATUS = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504, 509]);
function isRetryableHttpStatus(status) {
  return RETRYABLE_HTTP_STATUS.has(status) || status >= 500 && status < 600;
}
function isRetryableNetworkError(err) {
  if (err instanceof RetryableError) return err.status !== void 0;
  const code = errorCode(err);
  if (code !== void 0 && RETRYABLE_SYSCALL_CODES.has(code)) return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && err.cause !== void 0 && err.cause !== err) {
    return isRetryableNetworkError(err.cause);
  }
  return false;
}
function errorCode(err) {
  if (typeof err !== "object" || err === null) return void 0;
  const code = err.code;
  return typeof code === "string" ? code : void 0;
}
function toErrorInfo(err) {
  if (err instanceof Error) {
    const info = { name: err.name, message: err.message };
    const code = errorCode(err);
    if (code !== void 0) info.code = code;
    if (err instanceof RetryableError && err.status !== void 0) info.status = err.status;
    if (err.stack !== void 0) info.stack = err.stack;
    return info;
  }
  return { name: "NonError", message: safeStringify(err) };
}
function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
var UploadSessionExpired = class extends ArchiveError {
};

// src/core/runtime-check.ts
var MIN_NODE_VERSION = "22.16.0";
var NODE_REMEDIATION = `Install Node ${MIN_NODE_VERSION} or newer (24 LTS recommended) and make sure the \`node\` on your PATH is that version \u2014 Claude Code runs plugin hooks with whatever \`node\` resolves to, not with the newest version installed.`;
function nodeVersionProblem(version = process.versions.node) {
  const comparison = compareVersions(version, MIN_NODE_VERSION);
  if (comparison > 0 || comparison === 0 && !version.includes("-")) return null;
  return `the archive plugin needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${version}`;
}
function compareVersions(a, b2) {
  const left = parts(a);
  const right = parts(b2);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
function parts(version) {
  const core = version.replace(/^v/, "").split("-")[0] ?? "";
  return core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

// src/adapters/sqlite.ts
var requireModule = createRequire(import.meta.url);
var cached;
var attempted = false;
function getSqlite() {
  if (cached !== void 0) return cached;
  if (!attempted) {
    attempted = true;
    try {
      cached = requireModule("node:sqlite");
      return cached;
    } catch {
    }
  }
  throw new FatalError(
    nodeVersionProblem() ?? "node:sqlite is missing from this Node build",
    NODE_REMEDIATION
  );
}

// src/core/migrations.ts
var MIGRATIONS = [
  // 1 — catalog, queue and key/value state.
  `
  CREATE TABLE sessions (
    session_id        TEXT PRIMARY KEY,
    encoded_dir       TEXT NOT NULL,
    project_cwd       TEXT,
    title             TEXT,
    summary           TEXT,
    git_branch        TEXT,
    started_at        INTEGER,
    ended_at          INTEGER,
    message_count     INTEGER,
    transcript_bytes  INTEGER,
    transcript_sha256 TEXT,
    sidecar_bytes     INTEGER,
    bundle_name       TEXT,
    bundle_bytes      INTEGER,
    bundle_sha256     TEXT,
    remote_file_id    TEXT,
    remote_path       TEXT,
    backed_up_at      INTEGER,
    verified_at       INTEGER,
    archiver_version  TEXT,
    local_present     INTEGER NOT NULL DEFAULT 1,
    local_deleted_at  INTEGER,
    last_local_mtime  INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX sessions_encoded_dir ON sessions (encoded_dir);
  CREATE INDEX sessions_ended_at    ON sessions (ended_at DESC);
  CREATE INDEX sessions_pending     ON sessions (verified_at) WHERE verified_at IS NULL;
  CREATE INDEX sessions_reapable    ON sessions (last_local_mtime)
    WHERE local_present = 1 AND verified_at IS NOT NULL;

  -- Every user prompt, verbatim. This is what natural-language search reads.
  CREATE TABLE prompts (
    session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    ts         INTEGER,
    text       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) STRICT;

  CREATE TABLE session_files (
    session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
  ) STRICT;

  -- At-least-once work queue with a visibility timeout. One live row per
  -- (kind, session): repeated hook fires coalesce instead of piling up.
  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key  TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    session_id  TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    not_before  INTEGER NOT NULL DEFAULT 0,
    visible_at  INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    payload     TEXT,
    upload_uri  TEXT,
    last_error  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX jobs_claimable ON jobs (not_before, id) WHERE blocked = 0;

  CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 2 — record the local state that was actually archived.
  //
  // Change detection used to compare against `last_local_mtime`, which several
  // writers touch for reasons that have nothing to do with a successful backup.
  // These two columns are written only by markVerified, so "has this file
  // changed since the copy on Drive was made" has an honest answer.
  `
  ALTER TABLE sessions ADD COLUMN verified_local_mtime INTEGER;
  ALTER TABLE sessions ADD COLUMN verified_local_bytes INTEGER;
  `,
  // 3 — the hash of the bundle that verification actually passed on.
  //
  // `bundle_sha256` describes the most recent bundle *built*, which a failed
  // upload leaves pointing at bytes Drive never received, while
  // `remote_file_id` still names the previous good copy. Restore then refuses
  // a bundle that is perfectly fine. This column is written only by
  // markVerified, so it always describes the copy Drive holds.
  `
  ALTER TABLE sessions ADD COLUMN verified_bundle_sha256 TEXT;
  `,
  // 4 — the transcript hash belonging to the copy Drive holds.
  //
  // `transcript_sha256` is written by every indexing pass, before a bundle
  // exists and whether or not the upload ever lands. Restoring against it meant
  // one failed upload made a session permanently unrestorable: the pointer
  // described the archived copy, the hash described the newer local one, and
  // every restore attempt failed the check and deleted what it had unpacked.
  `
  ALTER TABLE sessions ADD COLUMN verified_transcript_sha256 TEXT;
  `,
  // 5 — the remaining measurements of the archived copy.
  //
  // Every safety guard must read a column that only markVerified writes. Three
  // separate defects have now come from a guard consulting a column some
  // earlier step of the same attempt rewrites: the guard fires once, erases its
  // own evidence, and waves the retry through. transcript_bytes, sidecar_bytes
  // and bundle_bytes all describe the last attempt, not the archived copy.
  `
  ALTER TABLE sessions ADD COLUMN verified_transcript_bytes INTEGER;
  ALTER TABLE sessions ADD COLUMN verified_sidecar_bytes INTEGER;
  ALTER TABLE sessions ADD COLUMN verified_bundle_bytes INTEGER;
  `,
  // 6 — the file list of the archived copy.
  //
  // Retiring a bundle was gated on three integer comparisons: transcript bytes,
  // sidecar bytes, total bytes. Sizes are not containment. One sidecar file
  // removed and a larger one added passes every size check while the archived
  // subagent transcript exists nowhere else. This column lets the retire gate
  // prove the old bundle's contents are still present in the new one.
  `
  ALTER TABLE sessions ADD COLUMN verified_manifest TEXT;
  `,
  // 7 — the weaker hash of the archived copy, and the bundles we chose to keep.
  //
  // Drive returns sha256Checksum "if available" and computes it asynchronously,
  // so a Drive that only ever answers with md5 left every session unreapable
  // for ever while the plugin reported itself healthy. md5 is enough to confirm
  // the file Drive holds is the one we uploaded, once sha256 has proved the
  // bundle matches the disk.
  //
  // retained_bundles remembers a superseded bundle that was NOT retired because
  // the replacement did not contain it. Nothing pointed at those, so their
  // unique contents were reachable only by browsing Drive by hand.
  `
  ALTER TABLE sessions ADD COLUMN verified_bundle_md5 TEXT;

  CREATE TABLE retained_bundles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    remote_path TEXT,
    bundle_sha256 TEXT,
    manifest    TEXT,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (file_id)
  ) STRICT;

  CREATE INDEX retained_bundles_session ON retained_bundles (session_id);
  `,
  // 8 — when a job was parked.
  //
  // unblockStale matched on updated_at, and every sweep's rescan re-enqueues
  // each unarchived session, which refreshes updated_at on the blocked row.
  // So for anyone who opens Claude Code daily the retry could never fire: a
  // session parked by one transient failure was never archived again.
  `
  ALTER TABLE jobs ADD COLUMN blocked_at INTEGER;
  `,
  // 9 — why the reaper last passed a row over, and until when.
  //
  // listReapable takes the 500 oldest candidates. A row the reaper always
  // skips — an orphan sidecar, a sidecar it cannot read — keeps its old
  // verified_local_mtime for ever, so it sorts to the front of that window on
  // every run. Past 500 of them, no session that could actually be reclaimed
  // was ever looked at again: deletion stopped completely, and the only sign
  // was that nothing was ever freed.
  //
  // The backfill covers jobs blocked before migration 8, which added
  // blocked_at: without it unblockStale can never fire for them, which is the
  // very bug migration 8 exists to fix.
  `
  ALTER TABLE sessions ADD COLUMN reap_skip_reason TEXT;
  ALTER TABLE sessions ADD COLUMN reap_skip_until INTEGER;

  UPDATE jobs SET blocked_at = updated_at WHERE blocked = 1 AND blocked_at IS NULL;
  `,
  // 10 — the size and weaker hash of a kept bundle.
  //
  // verifyRetained could only compare sha256, and counted "Drive did not say"
  // as intact — for bundles /archive:status describes as holding data nothing
  // else holds. With these it can do what verifyArchive does: compare the
  // size, fall back to md5, and report what it could not check as unchecked.
  `
  ALTER TABLE retained_bundles ADD COLUMN bundle_bytes INTEGER;
  ALTER TABLE retained_bundles ADD COLUMN bundle_md5 TEXT;
  `,
  // 11 — when a reaped session's bundle was last re-checked on Drive.
  `
  ALTER TABLE sessions ADD COLUMN audited_at INTEGER;
  `
];
var SCHEMA_VERSION = MIGRATIONS.length;

// src/adapters/db.ts
function openDatabase(file, options = {}) {
  if (file !== ":memory:") {
    fs3.mkdirSync(path4.dirname(file), { recursive: true });
  }
  const db = new (getSqlite()).DatabaseSync(file, { readOnly: options.readOnly ?? false });
  if (file !== ":memory:" && options.readOnly !== true) restrictToOwner(file);
  applyPragmas(db, options);
  if (options.skipMigrations !== true && options.readOnly !== true) {
    migrate(db);
  }
  return db;
}
function restrictToOwner(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs3.chmodSync(`${file}${suffix}`, 384);
    } catch {
    }
  }
}
function applyPragmas(db, options) {
  const busyTimeout = options.busyTimeoutMs ?? 5e3;
  db.exec(`PRAGMA busy_timeout = ${String(Math.trunc(busyTimeout))}`);
  if (options.readOnly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}
function schemaVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}
function migrate(db) {
  const current = schemaVersion(db);
  if (current >= MIGRATIONS.length) return current;
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = schemaVersion(db);
    for (let index = version; index < MIGRATIONS.length; index++) {
      const sql = MIGRATIONS[index];
      if (sql === void 0) throw new BugError(`missing migration ${String(index)}`);
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${String(Math.trunc(MIGRATIONS.length))}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return MIGRATIONS.length;
}
function inTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw err;
  }
}
function checkpointAndClose(db) {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
  }
  db.close();
}
function kvGet(db, key) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row?.value;
}
function kvSet(db, key, value, now) {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}
function kvGetNumber(db, key) {
  const raw = kvGet(db, key);
  if (raw === void 0) return void 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : void 0;
}
function kvSetNumber(db, key, value, now) {
  kvSet(db, key, String(value), now);
}

// src/core/state-keys.ts
var KV = {
  /** No network work before this timestamp. */
  circuitUntil: "circuit.until",
  /** Consecutive failed runs, which set the length of the next cool-down. */
  circuitFailures: "circuit.failures",
  /** Last completed sweep, for the minimum-interval check. */
  lastSweepAt: "sweep.last_at",
  /** Last time the catalog copy reached Drive. */
  catalogUploadedAt: "catalog.uploaded_at",
  /** Drive file id of the catalog copy, so it is replaced and not duplicated. */
  catalogFileId: "catalog.file_id",
  /** Sessions counted at the last full scan, shown by /archive:status. */
  lastScanAt: "scan.last_at",
  /** Sessions or projects the last scan could not archive, for /archive:status. */
  skippedCount: "scan.skipped_count",
  /** How many of those were unreadable rather than badly named. */
  unreadableCount: "scan.unreadable_count",
  /** Stable id for this installation, so two machines never share a catalog file. */
  machineId: "machine.id",
  /** Last time a hook started a worker. Compared with workerRanAt. */
  workerSpawnedAt: "worker.spawned_at",
  /** Last time a worker actually reached its main loop. */
  workerRanAt: "worker.ran_at",
  /** Sidecar directories left on disk by a transcript that vanished. */
  orphanSidecars: "reap.orphan_sidecars",
  /** Reaped sessions whose Drive copy failed a re-check. */
  auditMismatched: "audit.mismatched",
  /** Last time a session was told the plugin is installed but not set up. */
  setupWarnedAt: "setup.warned_at",
  /** When the reap last actually ran, so stale counters can say so. */
  reapRanAt: "reap.ran_at",
  /** Why the last reap stopped asking Drive, if it did. */
  reapBlockedReason: "reap.blocked_reason",
  /** Archived sessions the last reap found missing or changed on Drive. */
  reapUnverified: "reap.unverified_count",
  /** Sessions the last reap could not confirm on Drive, so nothing was freed. */
  unconfirmableCount: "reap.unconfirmable_count"
};
function activeSessionKey(sessionId) {
  return `active.${sessionId}`;
}
var ACTIVE_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1e3;

// src/composition.ts
import fsp5 from "node:fs/promises";
import path9 from "node:path";

// src/adapters/ndjson-logger.ts
import fs4 from "node:fs";
import path5 from "node:path";
var LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
var DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
function createNdjsonLogger(options) {
  const state = {
    file: options.file,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    minLevel: LEVEL_ORDER[options.level ?? "info"],
    ready: false,
    bytesSinceCheck: Number.MAX_SAFE_INTEGER
  };
  return makeLogger(state, options.base ?? {});
}
function makeLogger(state, base) {
  const emit = (level, event, fields, err) => {
    if (LEVEL_ORDER[level] < state.minLevel) return;
    write(state, serialize(level, event, { ...base, ...fields }, err));
  };
  return {
    debug: (event, fields) => {
      emit("debug", event, fields);
    },
    info: (event, fields) => {
      emit("info", event, fields);
    },
    warn: (event, fields, err) => {
      emit("warn", event, fields, err);
    },
    error: (event, fields, err) => {
      emit("error", event, fields, err);
    },
    child: (fields) => makeLogger(state, { ...base, ...fields }),
    close: () => void 0
  };
}
function serialize(level, event, fields, err) {
  const line = { ts: (/* @__PURE__ */ new Date()).toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== void 0) line[key] = value;
  }
  if (err !== void 0) line["err"] = toErrorInfo(err);
  try {
    return `${JSON.stringify(line)}
`;
  } catch {
    return `${JSON.stringify({ ts: line["ts"], level, event, err: "unserializable" })}
`;
  }
}
function write(state, line) {
  try {
    if (!state.ready) {
      fs4.mkdirSync(path5.dirname(state.file), { recursive: true });
      state.ready = true;
    }
    if (state.bytesSinceCheck > 64 * 1024) {
      rotateIfLarge(state);
      state.bytesSinceCheck = 0;
    }
    fs4.appendFileSync(state.file, line, { encoding: "utf8", mode: 384 });
    state.bytesSinceCheck += line.length;
  } catch {
  }
}
function rotateIfLarge(state) {
  let size;
  try {
    size = fs4.statSync(state.file).size;
  } catch {
    return;
  }
  if (size <= state.maxBytes) return;
  try {
    fs4.renameSync(state.file, `${state.file}.1`);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") return;
    try {
      fs4.rmSync(`${state.file}.1`, { force: true });
      fs4.renameSync(state.file, `${state.file}.1`);
    } catch {
    }
  }
}

// src/adapters/token-file.ts
import fs5 from "node:fs";
import fsp2 from "node:fs/promises";

// src/adapters/atomic.ts
import fsp from "node:fs/promises";
import path6 from "node:path";
import { randomBytes } from "node:crypto";
var RENAME_ATTEMPTS = 6;
var defaultSleep = (ms2) => new Promise((resolve) => setTimeout(resolve, ms2));
function renameRetryDelay(attempt) {
  return Math.min(1e3, 10 * 3 ** attempt);
}
function isTransientRenameError(err) {
  const code = err?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}
async function renameWithRetry(from, to2, options = {}) {
  const attempts = options.attempts ?? RENAME_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to2);
      return;
    } catch (err) {
      if (attempt >= attempts - 1 || !isTransientRenameError(err)) throw err;
      await sleep(renameRetryDelay(attempt));
    }
  }
}
function siblingTempPath(finalPath, suffix = ".partial") {
  const dir = path6.dirname(finalPath);
  const base = path6.basename(finalPath);
  return path6.join(dir, `${base}.${randomBytes(6).toString("hex")}${suffix}`);
}
async function fsyncFile(handle) {
  await handle.sync();
}
async function fsyncDir(dir) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await fsp.open(dir, "r");
    await handle.sync();
  } catch {
  } finally {
    await handle?.close();
  }
}
async function writeFileAtomic(finalPath, data, options = {}) {
  await fsp.mkdir(path6.dirname(finalPath), { recursive: true });
  const temp = siblingTempPath(finalPath);
  let handle;
  try {
    handle = await fsp.open(temp, "wx", options.mode ?? 384);
    await handle.writeFile(data);
    await fsyncFile(handle);
    await handle.close();
    handle = void 0;
    await renameWithRetry(temp, finalPath);
    await fsyncDir(path6.dirname(finalPath));
  } catch (err) {
    await handle?.close().catch(() => void 0);
    await fsp.rm(temp, { force: true }).catch(() => void 0);
    throw err;
  }
}
var PARTIAL_GRACE_MS = 5 * 6e4;
var DISPOSABLE = [
  ".partial",
  ".building.tar.zst",
  ".restore.tar.zst",
  ".recover.tar.zst",
  ".retained.tar.zst"
];
var RESTORE_GRACE_MS = 60 * 6e4;
var RESTORE_SUFFIXES = [".restore.tar.zst", ".recover.tar.zst", ".retained.tar.zst"];
async function removePartials(dir, now = Date.now()) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (!DISPOSABLE.some((suffix) => entry.endsWith(suffix))) continue;
    const full = path6.join(dir, entry);
    try {
      const stat = await fsp.stat(full);
      const restoring = RESTORE_SUFFIXES.some((suffix) => entry.includes(suffix));
      const grace = restoring ? RESTORE_GRACE_MS : PARTIAL_GRACE_MS;
      if (now - stat.mtimeMs < grace) continue;
    } catch {
      continue;
    }
    try {
      await fsp.rm(full, { force: true });
      removed.push(full);
    } catch {
    }
  }
  return removed;
}

// src/adapters/token-file.ts
function createFileTokenStore(file, logger = nullLogger) {
  return {
    location: file,
    async read() {
      let raw;
      try {
        raw = await fsp2.readFile(file, "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
      warnIfWorldReadable(file, logger);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn("tokens.unreadable", { file });
        return null;
      }
      return normalize(parsed);
    },
    async write(tokens) {
      await writeFileAtomic(file, `${JSON.stringify(tokens, null, 2)}
`, { mode: 384 });
    },
    async clear() {
      await fsp2.rm(file, { force: true });
    }
  };
}
function warnIfWorldReadable(file, logger) {
  if (process.platform === "win32") return;
  try {
    const mode = fs5.statSync(file).mode & 511;
    if ((mode & 63) !== 0) {
      logger.warn("tokens.permissions_too_open", { file, mode: mode.toString(8) });
      fs5.chmodSync(file, 384);
    }
  } catch {
  }
}
function normalize(parsed) {
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed;
  if (typeof candidate.accessToken !== "string" || typeof candidate.expiresAt !== "number") {
    return null;
  }
  return {
    accessToken: candidate.accessToken,
    refreshToken: typeof candidate.refreshToken === "string" ? candidate.refreshToken : null,
    expiresAt: candidate.expiresAt,
    scope: typeof candidate.scope === "string" ? candidate.scope : "",
    tokenType: typeof candidate.tokenType === "string" ? candidate.tokenType : "Bearer",
    clientId: typeof candidate.clientId === "string" ? candidate.clientId : ""
  };
}

// src/core/backoff.ts
var DEFAULT_BASE_MS = 1e3;
var DEFAULT_CAP_MS = 9e4;
function fullJitterDelay(attempt, random, options = {}) {
  const base = options.baseMs ?? DEFAULT_BASE_MS;
  const cap = options.capMs ?? DEFAULT_CAP_MS;
  const exponent = Math.min(attempt, 31);
  const ceiling = Math.min(cap, base * 2 ** exponent);
  return Math.floor(random() * ceiling);
}
var MAX_RETRY_AFTER_MS = 60 * 60 * 1e3;
function nextAttemptAt(args) {
  if (args.retryAfterSeconds !== void 0 && args.retryAfterSeconds >= 0) {
    const wait = Math.min(Math.ceil(args.retryAfterSeconds * 1e3), MAX_RETRY_AFTER_MS);
    return args.now + wait;
  }
  return args.now + fullJitterDelay(args.attempt, args.random, args.options ?? {});
}
function circuitBackoffMs(consecutiveFailures) {
  if (consecutiveFailures <= 0) return 0;
  const thirtyMinutes = 30 * 60 * 1e3;
  const sixHours = 6 * 60 * 60 * 1e3;
  return Math.min(sixHours, thirtyMinutes * 2 ** (consecutiveFailures - 1));
}
function parseRetryAfter(header, now) {
  if (header === null) return void 0;
  const trimmed2 = header.trim();
  if (trimmed2.length === 0) return void 0;
  if (/^\d+$/.test(trimmed2)) return Number(trimmed2);
  const date = Date.parse(trimmed2);
  if (Number.isNaN(date)) return void 0;
  return Math.max(0, Math.ceil((date - now) / 1e3));
}

// src/adapters/http-client.ts
var DEFAULT_TIMEOUT_MS = 6e4;
var DEFAULT_MAX_ATTEMPTS = 5;
var DEFAULT_BUDGET_MS = 10 * 6e4;
function createHttpClient(options = {}) {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = clock.now();
  const remainingBudgetMs = () => Math.max(0, budgetMs - (clock.now() - startedAt));
  return {
    remainingBudgetMs,
    async send(url, sendOptions = {}) {
      const expect = new Set(sendOptions.expect ?? []);
      const allowRetry = sendOptions.retry !== false;
      let lastError;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const timeout = AbortSignal.timeout(
          sendOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const signal = sendOptions.signal === void 0 ? timeout : AbortSignal.any([timeout, sendOptions.signal]);
        let response;
        try {
          const init = { method: sendOptions.method ?? "GET", signal };
          if (sendOptions.headers !== void 0) init.headers = sendOptions.headers;
          if (sendOptions.body !== void 0 && sendOptions.body !== null) {
            init.body = sendOptions.body;
          }
          response = await doFetch(url, init);
        } catch (err) {
          sendOptions.signal?.throwIfAborted();
          lastError = err;
          if (!allowRetry || !isRetryableNetworkError(err)) throw err;
          if (!await waitBeforeRetry({ attempt, clock, remainingBudgetMs, logger, url }))
            throw err;
          continue;
        }
        if (response.ok || expect.has(response.status)) return response;
        if (!allowRetry || !isRetryableHttpStatus(response.status)) return response;
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), clock.now());
        lastError = new RetryableError(`HTTP ${response.status} from ${hostOf(url)}`, {
          status: response.status,
          ...retryAfter === void 0 ? {} : { retryAfterSeconds: retryAfter }
        });
        await response.body?.cancel().catch(() => void 0);
        if (attempt + 1 >= maxAttempts) throw asThrowable(lastError, url);
        const waited = await waitBeforeRetry({
          attempt,
          clock,
          remainingBudgetMs,
          logger,
          url,
          retryAfterSeconds: retryAfter,
          status: response.status
        });
        if (!waited) throw asThrowable(lastError, url);
      }
      throw asThrowable(lastError, url);
    }
  };
}
async function waitBeforeRetry(args) {
  const delay = args.retryAfterSeconds !== void 0 ? args.retryAfterSeconds * 1e3 : fullJitterDelay(args.attempt, () => args.clock.random());
  if (delay >= args.remainingBudgetMs()) {
    args.logger.warn("http.budget_exhausted", {
      host: hostOf(args.url),
      status: args.status ?? null
    });
    return false;
  }
  args.logger.debug("http.retry", {
    host: hostOf(args.url),
    attempt: args.attempt,
    delay_ms: delay,
    status: args.status ?? null
  });
  await args.clock.sleep(delay);
  return true;
}
function asThrowable(error, url) {
  if (error instanceof Error) return error;
  return new RetryableError(`gave up on ${hostOf(url)}`, { cause: error });
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}
async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
function describeApiError(status, body) {
  if (typeof body === "object" && body !== null) {
    const record = body;
    const error = record["error"];
    if (typeof error === "object" && error !== null) {
      const message = error["message"];
      if (typeof message === "string") return `HTTP ${status}: ${message}`;
    }
    if (typeof error === "string") {
      const description = record["error_description"];
      return typeof description === "string" ? `HTTP ${status}: ${error} (${description})` : `HTTP ${status}: ${error}`;
    }
  }
  return `HTTP ${status}`;
}

// src/adapters/google-auth.ts
import fsp3 from "node:fs/promises";
import path7 from "node:path";

// src/core/oauth.ts
var DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
var TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
var REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
function parseTokenResponse(body, now, previousRefreshToken = null) {
  if (typeof body.access_token !== "string") return null;
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    // A refresh response usually omits the refresh token; keep the one we have.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previousRefreshToken,
    expiresAt: now + Math.max(0, expiresIn - 60) * 1e3,
    scope: typeof body.scope === "string" ? body.scope : DRIVE_FILE_SCOPE,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer"
  };
}
var UNRECOVERABLE = /* @__PURE__ */ new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
function isUnrecoverableAuthError(error) {
  return typeof error === "string" && UNRECOVERABLE.has(error);
}
function needsRefresh(expiresAt, now, skewMs = 6e4) {
  return expiresAt - skewMs <= now;
}

// src/adapters/google-auth.ts
var REAUTH_REMEDIATION = "Run /archive:setup to sign in to Google again.";
function createAuthProvider(deps) {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? nullLogger;
  return {
    async hasCredentials() {
      const tokens = await deps.tokenStore.read();
      return tokens !== null && tokens.refreshToken !== null;
    },
    currentTokens: () => deps.tokenStore.read(),
    async getAccessToken(signal) {
      const tokens = await deps.tokenStore.read();
      if (tokens === null) {
        throw new FatalError("not signed in to Google", REAUTH_REMEDIATION);
      }
      if (tokens.clientId !== "" && tokens.clientId !== deps.client.clientId) {
        throw new FatalError(
          "the stored token belongs to a different OAuth client",
          REAUTH_REMEDIATION
        );
      }
      if (!needsRefresh(tokens.expiresAt, clock.now())) return tokens.accessToken;
      if (tokens.refreshToken === null) {
        throw new FatalError(
          "the access token expired and there is no refresh token",
          REAUTH_REMEDIATION
        );
      }
      const refreshed = await refreshTokens(deps, tokens, clock, signal);
      logger.debug("auth.refreshed", { expires_at: refreshed.expiresAt });
      return refreshed.accessToken;
    },
    async signOut(signal) {
      const tokens = await deps.tokenStore.read();
      await deps.tokenStore.clear();
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token === void 0) return;
      try {
        await deps.http.send(REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
          ...signal === void 0 ? {} : { signal }
        });
      } catch {
      }
    }
  };
}
async function refreshTokens(deps, tokens, clock, signal) {
  const response = await deps.http.send(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.client.clientId,
      client_secret: deps.client.clientSecret,
      refresh_token: tokens.refreshToken ?? "",
      grant_type: "refresh_token"
    }).toString(),
    expect: [400, 401],
    ...signal === void 0 ? {} : { signal }
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = body?.["error"];
    if (isUnrecoverableAuthError(error)) {
      throw new FatalError(
        `Google rejected the refresh token (${String(error)})`,
        REAUTH_REMEDIATION
      );
    }
    throw new RetryableError(`token refresh failed with HTTP ${response.status}`, {
      status: response.status
    });
  }
  const parsed = parseTokenResponse(body ?? {}, clock.now(), tokens.refreshToken);
  if (parsed === null) {
    throw new RetryableError("token refresh returned no access token");
  }
  const next = { ...parsed, clientId: deps.client.clientId };
  await deps.tokenStore.write(next);
  return next;
}
async function resolveOAuthClient(env, dataDir) {
  const envId = env["ARCHIVE_GOOGLE_CLIENT_ID"];
  const envSecret = env["ARCHIVE_GOOGLE_CLIENT_SECRET"];
  if (envId !== void 0 && envId.length > 0) {
    return { clientId: envId, clientSecret: envSecret ?? "" };
  }
  const fromFile = await readClientFile(path7.join(dataDir, "oauth-client.json"));
  if (fromFile !== null) return fromFile;
  if (BUNDLED_CLIENT.clientId.length > 0) return BUNDLED_CLIENT;
  throw new FatalError(
    "no Google OAuth client is configured",
    `Create a Desktop-app OAuth client in Google Cloud Console, then save it as ${path7.join(dataDir, "oauth-client.json")} with {"clientId":"...","clientSecret":"..."}, or set ARCHIVE_GOOGLE_CLIENT_ID and ARCHIVE_GOOGLE_CLIENT_SECRET.`
  );
}
var BUNDLED_CLIENT = {
  clientId: "23933894059-4sbrl2ejv8ifcjqt4r4r51vtg6n025ki.apps.googleusercontent.com",
  clientSecret: "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",
  audience: "Google accounts on the greelow.com domain"
};
async function readClientFile(file) {
  let raw;
  try {
    raw = await fsp3.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed;
    const installed = record["installed"];
    const source = typeof installed === "object" && installed !== null ? installed : record;
    const clientId = asString(source["clientId"]) ?? asString(source["client_id"]);
    if (clientId === null || clientId.length === 0) return null;
    const clientSecret = asString(source["clientSecret"]) ?? asString(source["client_secret"]) ?? "";
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}
function asString(value) {
  return typeof value === "string" ? value : null;
}

// src/adapters/drive-http.ts
import fs6 from "node:fs";
import fsp4 from "node:fs/promises";
import path8 from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
var API = "https://www.googleapis.com/drive/v3";
var UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
var FOLDER_MIME = "application/vnd.google-apps.folder";
var FILE_FIELDS = "id,name,size,sha256Checksum,md5Checksum,trashed,appProperties";
var CHUNK_SIZE = 8 * 1024 * 1024;
var CHUNK_ALIGNMENT = 256 * 1024;
function createDriveTransport(deps) {
  const logger = deps.logger ?? nullLogger;
  const authorized = async (url, options = {}) => {
    const send = async () => {
      const token = await deps.auth.getAccessToken(options.signal);
      return deps.http.send(url, {
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${token}` },
        expect: [...options.expect ?? [], 401]
      });
    };
    const first = await send();
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => void 0);
    logger.debug("drive.token_rejected_retrying");
    const second = await send();
    if (second.status === 401) {
      await second.body?.cancel().catch(() => void 0);
      throw new FatalError("Google rejected the access token", REAUTH_REMEDIATION, {
        status: 401
      });
    }
    return second;
  };
  const failIfNotOk = async (response, what) => {
    const body = await readJson(response);
    if (response.ok) return body;
    const message = `${what}: ${describeApiError(response.status, body)}`;
    if (response.status === 403 && isQuotaExhausted(body)) {
      throw new FatalError(message, "Free space in Google Drive, then run /archive:now.", {
        status: response.status
      });
    }
    if (response.status === 403 && isRateLimited(body)) {
      throw new RetryableError(message, { status: response.status });
    }
    if (isRetryableHttpStatus(response.status)) {
      throw new RetryableError(message, {
        status: response.status,
        ...retryAfterOf(response)
      });
    }
    if (response.status >= 400 && response.status < 500) {
      throw new FatalError(message, "Run /archive:status for details.", {
        status: response.status
      });
    }
    throw new RetryableError(message, { status: response.status });
  };
  const listOne = async (query, signal) => {
    const url = new URL(`${API}/files`);
    url.searchParams.set("q", query);
    url.searchParams.set("fields", `files(${FILE_FIELDS})`);
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("spaces", "drive");
    const response = await authorized(url.toString(), signal === void 0 ? {} : { signal });
    const body = await failIfNotOk(response, "listing Drive files");
    const files = body?.files;
    if (!Array.isArray(files) || files.length === 0) return null;
    return toRemoteFile(files[0]);
  };
  const createFolder = async (name, parentId, signal) => {
    const url = new URL(`${API}/files`);
    url.searchParams.set("fields", "id");
    const response = await authorized(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      ...signal === void 0 ? {} : { signal }
    });
    const body = await failIfNotOk(response, `creating the folder ${name}`);
    const id = body?.id;
    if (typeof id !== "string") throw new RetryableError("Drive created a folder with no id");
    return id;
  };
  return {
    async ensureFolder(pathSegments, signal) {
      let parentId = "root";
      for (const segment of pathSegments) {
        const existing = await listOne(
          `name = '${escapeQuery(segment)}' and mimeType = '${FOLDER_MIME}' and '${escapeQuery(parentId)}' in parents and trashed = false`,
          signal
        );
        parentId = existing?.id ?? await createFolder(segment, parentId, signal);
      }
      return parentId;
    },
    async listFiles(args, signal) {
      const url = new URL(`${API}/files`);
      url.searchParams.set(
        "q",
        `name contains '${escapeQuery(args.namePrefix)}' and '${escapeQuery(args.parentId)}' in parents and trashed = false`
      );
      url.searchParams.set("fields", `files(${FILE_FIELDS})`);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("spaces", "drive");
      const response = await authorized(url.toString(), signal === void 0 ? {} : { signal });
      const body = await failIfNotOk(response, "listing Drive files");
      const files = body?.files;
      if (!Array.isArray(files)) return [];
      return files.map(toRemoteFile).filter((file) => file.name.startsWith(args.namePrefix));
    },
    findFile(args, signal) {
      return listOne(
        `name = '${escapeQuery(args.name)}' and '${escapeQuery(args.parentId)}' in parents and trashed = false`,
        signal
      );
    },
    async startResumableUpload(args, signal) {
      const url = new URL(UPLOAD_API);
      url.searchParams.set("uploadType", "resumable");
      url.searchParams.set("fields", FILE_FIELDS);
      const metadata = { name: args.name, parents: [args.parentId] };
      if (args.appProperties !== void 0) metadata["appProperties"] = args.appProperties;
      const response = await authorized(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": args.mimeType,
          "x-upload-content-length": String(args.totalBytes)
        },
        body: JSON.stringify(metadata),
        ...signal === void 0 ? {} : { signal }
      });
      if (!response.ok) {
        await failIfNotOk(response, "starting a Drive upload");
      }
      await response.body?.cancel().catch(() => void 0);
      const location = response.headers.get("location");
      if (location === null) {
        throw new RetryableError("Drive started an upload without returning a session URI");
      }
      return location;
    },
    async uploadChunk(args, signal) {
      const end = args.offset + args.body.length - 1;
      const response = await authorized(args.uploadUri, {
        method: "PUT",
        headers: {
          "content-range": `bytes ${String(args.offset)}-${String(end)}/${String(args.totalBytes)}`
        },
        body: args.body,
        // 308 is the normal "keep going" answer, not an error.
        expect: [308, 404, 410],
        retry: false,
        ...signal === void 0 ? {} : { signal }
      });
      return interpretUploadResponse(response, args.totalBytes);
    },
    async probeUpload(args, signal) {
      const response = await authorized(args.uploadUri, {
        method: "PUT",
        headers: { "content-range": `bytes */${String(args.totalBytes)}` },
        body: "",
        expect: [308, 404, 410],
        ...signal === void 0 ? {} : { signal }
      });
      try {
        return await interpretUploadResponse(response, args.totalBytes);
      } catch (err) {
        if (err instanceof UploadSessionExpired) return null;
        throw err;
      }
    },
    async uploadSmallFile(args, signal) {
      const metadata = { name: args.name };
      if (args.replaceFileId === void 0) metadata["parents"] = [args.parentId];
      if (args.appProperties !== void 0) metadata["appProperties"] = args.appProperties;
      const boundary = `archive-${Math.random().toString(36).slice(2)}-${String(Date.now())}`;
      const body = multipartBody(boundary, metadata, args.mimeType, args.body);
      const url = new URL(
        args.replaceFileId === void 0 ? UPLOAD_API : `${UPLOAD_API}/${args.replaceFileId}`
      );
      url.searchParams.set("uploadType", "multipart");
      url.searchParams.set("fields", FILE_FIELDS);
      const response = await authorized(url.toString(), {
        method: args.replaceFileId === void 0 ? "POST" : "PATCH",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
        ...signal === void 0 ? {} : { signal }
      });
      return toRemoteFile(await failIfNotOk(response, `uploading ${args.name}`));
    },
    async getFile(fileId, signal) {
      const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set("fields", FILE_FIELDS);
      const response = await authorized(url.toString(), signal === void 0 ? {} : { signal });
      return toRemoteFile(await failIfNotOk(response, "reading Drive file metadata"));
    },
    async deleteFile(fileId, signal) {
      const response = await authorized(`${API}/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
        expect: [404],
        ...signal === void 0 ? {} : { signal }
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => void 0);
        return;
      }
      await failIfNotOk(response, "deleting a Drive file");
    },
    async trashFile(fileId, signal) {
      const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set("fields", "id,trashed");
      const response = await authorized(url.toString(), {
        method: "PATCH",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ trashed: true }),
        expect: [404],
        ...signal === void 0 ? {} : { signal }
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => void 0);
        return;
      }
      await failIfNotOk(response, "moving a Drive file to the wastebasket");
    },
    async downloadToFile(args, signal) {
      const url = new URL(`${API}/files/${encodeURIComponent(args.fileId)}`);
      url.searchParams.set("alt", "media");
      const response = await authorized(url.toString(), signal === void 0 ? {} : { signal });
      if (!response.ok) await failIfNotOk(response, "downloading from Drive");
      if (response.body === null) throw new RetryableError("Drive returned an empty body");
      await fsp4.mkdir(path8.dirname(args.destination), { recursive: true });
      const temp = siblingTempPath(args.destination);
      const declared = asNumber(response.headers.get("content-length"));
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          fs6.createWriteStream(temp, { flags: "wx", mode: 384 })
        );
        const written = (await fsp4.stat(temp)).size;
        if (declared !== null && written !== declared) {
          throw new RetryableError(
            `Drive sent ${String(written)} bytes of ${String(declared)} for ${args.fileId}`
          );
        }
        if (written === 0) throw new RetryableError(`Drive sent nothing for ${args.fileId}`);
        await renameWithRetry(temp, args.destination);
      } catch (err) {
        await fsp4.rm(temp, { force: true }).catch(() => void 0);
        throw err;
      }
    },
    async storageQuota(signal) {
      const url = new URL(`${API}/about`);
      url.searchParams.set("fields", "storageQuota");
      const response = await authorized(url.toString(), signal === void 0 ? {} : { signal });
      const body = await failIfNotOk(response, "reading Drive storage quota");
      const quota = body?.storageQuota;
      if (typeof quota !== "object" || quota === null)
        return { limitBytes: null, usageBytes: null };
      const record = quota;
      return {
        limitBytes: asNumber(record["limit"]),
        usageBytes: asNumber(record["usage"])
      };
    }
  };
}
async function interpretUploadResponse(response, totalBytes) {
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => void 0);
    throw new UploadSessionExpired(`the upload session is gone (HTTP ${String(response.status)})`);
  }
  if (response.status === 308) {
    await response.body?.cancel().catch(() => void 0);
    return {
      confirmedBytes: confirmedFromRange(response.headers.get("range")),
      done: false,
      file: null
    };
  }
  if (response.ok) {
    const body2 = await readJson(response);
    return { confirmedBytes: totalBytes, done: true, file: toRemoteFile(body2) };
  }
  const body = await readJson(response);
  const message = describeApiError(response.status, body);
  if (response.status === 403 && isQuotaExhausted(body)) {
    throw new FatalError(
      `Drive refused the upload: ${message}`,
      "Free space in Google Drive, then run /archive:now.",
      { status: response.status }
    );
  }
  if (response.status === 403 && isRateLimited(body)) {
    throw new RetryableError(`Drive upload failed: ${message}`, {
      status: response.status,
      ...retryAfterOf(response)
    });
  }
  if (isRetryableHttpStatus(response.status)) {
    throw new RetryableError(`Drive upload failed: ${message}`, {
      status: response.status,
      ...retryAfterOf(response)
    });
  }
  if (response.status >= 400 && response.status < 500) {
    throw new FatalError(
      `Drive refused the upload: ${message}`,
      "Run /archive:status for details."
    );
  }
  throw new RetryableError(`Drive upload failed: ${message}`, { status: response.status });
}
function retryAfterOf(response) {
  const seconds = parseRetryAfter(response.headers.get("retry-after"), Date.now());
  return seconds === void 0 ? {} : { retryAfterSeconds: seconds };
}
function confirmedFromRange(header) {
  if (header === null) return 0;
  const match = /bytes=(\d+)-(\d+)/.exec(header.trim());
  if (match === null) return 0;
  if (Number(match[1]) !== 0) return 0;
  return Number(match[2]) + 1;
}
function alignChunkSize(size) {
  const aligned = Math.floor(size / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
  return aligned > 0 ? aligned : CHUNK_ALIGNMENT;
}
function multipartBody(boundary, metadata, mimeType, content) {
  const head = Buffer.from(
    `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(metadata)}\r
--${boundary}\r
Content-Type: ${mimeType}\r
\r
`,
    "utf8"
  );
  const tail = Buffer.from(`\r
--${boundary}--\r
`, "utf8");
  return Buffer.concat([head, Buffer.from(content), tail]);
}
function escapeQuery(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function toRemoteFile(value) {
  if (typeof value !== "object" || value === null) {
    throw new RetryableError("Drive returned a file with no metadata");
  }
  const record = value;
  const id = record["id"];
  if (typeof id !== "string") throw new RetryableError("Drive returned a file with no id");
  return {
    id,
    name: typeof record["name"] === "string" ? record["name"] : "",
    size: asNumber(record["size"]),
    sha256: typeof record["sha256Checksum"] === "string" ? record["sha256Checksum"] : null,
    md5: typeof record["md5Checksum"] === "string" ? record["md5Checksum"] : null,
    // Unknown, not false: false is the direction that would let the reaper
    // authorise a deletion against a file in the wastebasket.
    trashed: typeof record["trashed"] === "boolean" ? record["trashed"] : null,
    appProperties: asStringRecord(record["appProperties"])
  };
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function asStringRecord(value) {
  if (typeof value !== "object" || value === null) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
function isRateLimited(body) {
  const text = JSON.stringify(body ?? "");
  return text.includes("rateLimitExceeded") || text.includes("userRateLimitExceeded") || text.includes("sharingRateLimitExceeded") || // Not a permanent refusal either: the window resets.
  text.includes("dailyLimitExceeded") || text.includes("rateLimitExceeded");
}
function isQuotaExhausted(body) {
  const text = JSON.stringify(body ?? "");
  if (isRateLimited(body)) return false;
  return text.includes("storageQuotaExceeded") || text.includes("quotaExceeded");
}

// src/core/config.ts
var DEFAULT_CONFIG = {
  retentionDays: 30,
  driveRootFolder: "ClaudeArchive",
  zstdLevel: 19,
  debounceMs: 5e3,
  sweepMinIntervalMs: 10 * 6e4,
  workerBudgetMs: 20 * 6e4,
  jobVisibilityMs: 15 * 6e4,
  archiveGraceDays: 7,
  enabled: true,
  keepLocalForever: false
};
var DAY_MS = 864e5;
var KNOWN_CONFIG_KEYS = [
  "retentionDays",
  "driveRootFolder",
  "zstdLevel",
  "debounceMs",
  "sweepMinIntervalMs",
  "workerBudgetMs",
  "jobVisibilityMs",
  "enabled",
  "keepLocalForever",
  "archiveGraceDays"
];
function unknownConfigKeys(source) {
  return Object.keys(source).filter((key) => !KNOWN_CONFIG_KEYS.includes(key));
}
function resolveConfig(file, env) {
  const config = { ...DEFAULT_CONFIG };
  const fromEnv = envSource(env);
  applySource(config, file ?? {});
  applySource(config, fromEnv);
  if (file !== null && unreadableSafetyValues(file).length > 0 || unreadableSafetyValues(fromEnv).length > 0) {
    config.keepLocalForever = true;
  }
  return clamp(config);
}
function unreadableSafetyValues(source) {
  const bad = [];
  for (const key of ["keepLocalForever", "enabled"]) {
    const value = source[key];
    if (value !== void 0 && asBoolean(value) === null) bad.push(key);
  }
  return bad;
}
function applySource(config, source) {
  const retention = asNumber2(source["retentionDays"]);
  if (retention !== null) config.retentionDays = retention;
  const folder = asString2(source["driveRootFolder"]);
  if (folder !== null && folder.length > 0) config.driveRootFolder = folder;
  const level = asNumber2(source["zstdLevel"]);
  if (level !== null) config.zstdLevel = level;
  const debounce = asNumber2(source["debounceMs"]);
  if (debounce !== null) config.debounceMs = debounce;
  const sweepInterval = asNumber2(source["sweepMinIntervalMs"]);
  if (sweepInterval !== null) config.sweepMinIntervalMs = sweepInterval;
  const budget = asNumber2(source["workerBudgetMs"]);
  if (budget !== null) config.workerBudgetMs = budget;
  const visibility = asNumber2(source["jobVisibilityMs"]);
  if (visibility !== null) config.jobVisibilityMs = visibility;
  const grace = asNumber2(source["archiveGraceDays"]);
  if (grace !== null) config.archiveGraceDays = grace;
  const enabled = asBoolean(source["enabled"]);
  if (enabled !== null) config.enabled = enabled;
  const keepLocal = asBoolean(source["keepLocalForever"]);
  if (keepLocal !== null) config.keepLocalForever = keepLocal;
}
function envSource(env) {
  return {
    retentionDays: env["ARCHIVE_RETENTION_DAYS"],
    driveRootFolder: env["ARCHIVE_DRIVE_FOLDER"],
    zstdLevel: env["ARCHIVE_ZSTD_LEVEL"],
    debounceMs: env["ARCHIVE_DEBOUNCE_MS"],
    sweepMinIntervalMs: env["ARCHIVE_SWEEP_INTERVAL_MS"],
    workerBudgetMs: env["ARCHIVE_WORKER_BUDGET_MS"],
    jobVisibilityMs: env["ARCHIVE_JOB_VISIBILITY_MS"],
    archiveGraceDays: env["ARCHIVE_ARCHIVE_GRACE_DAYS"],
    enabled: env["ARCHIVE_ENABLED"],
    keepLocalForever: env["ARCHIVE_KEEP_LOCAL_FOREVER"]
  };
}
function clamp(config) {
  const keepLocalForever = config.keepLocalForever || config.retentionDays <= 0;
  return {
    ...config,
    keepLocalForever,
    retentionDays: clampNumber(config.retentionDays, 1, 36500, DEFAULT_CONFIG.retentionDays),
    archiveGraceDays: clampNumber(
      config.archiveGraceDays,
      0,
      3650,
      DEFAULT_CONFIG.archiveGraceDays
    ),
    zstdLevel: clampNumber(config.zstdLevel, 1, 22, DEFAULT_CONFIG.zstdLevel),
    debounceMs: clampNumber(config.debounceMs, 0, 6e4, DEFAULT_CONFIG.debounceMs),
    sweepMinIntervalMs: clampNumber(
      config.sweepMinIntervalMs,
      0,
      24 * 36e5,
      DEFAULT_CONFIG.sweepMinIntervalMs
    ),
    workerBudgetMs: clampNumber(
      config.workerBudgetMs,
      1e4,
      6 * 36e5,
      DEFAULT_CONFIG.workerBudgetMs
    ),
    jobVisibilityMs: clampNumber(
      config.jobVisibilityMs,
      3e4,
      6 * 36e5,
      DEFAULT_CONFIG.jobVisibilityMs
    )
  };
}
function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
function asNumber2(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function asString2(value) {
  return typeof value === "string" ? value : null;
}
function asBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}
function reapCutoff(now, retentionDays) {
  return now - retentionDays * DAY_MS;
}

// src/version.ts
var ARCHIVER_VERSION = "0.1.0";

// src/composition.ts
async function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const paths = resolvePaths(env);
  const configRead = await readConfigFile(paths.dataDir);
  let config = resolveConfig(configRead.status === "ok" ? configRead.source : null, env);
  if (configRead.status === "unusable") {
    config = { ...config, keepLocalForever: true };
  }
  const logger = createNdjsonLogger({
    file: paths.logFile,
    level: options.logLevel ?? env["ARCHIVE_LOG_LEVEL"] ?? "info",
    base: { pid: process.pid, v: ARCHIVER_VERSION }
  });
  if (configRead.status === "unusable") {
    logger.error("config.unusable", {
      reason: configRead.reason,
      effect: "local copies will not be deleted until this is fixed"
    });
  } else if (configRead.status === "ok") {
    const unreadable = unreadableSafetyValues(configRead.source);
    if (unreadable.length > 0) {
      logger.error("config.unreadable_safety_value", {
        keys: unreadable.join(", "),
        effect: "local copies will not be deleted until this is fixed"
      });
    }
    const unknown = unknownConfigKeys(configRead.source);
    if (unknown.length > 0) {
      logger.warn("config.unknown_keys", { keys: unknown.join(", ") });
    }
  }
  let database;
  let httpClient;
  let authProvider;
  let transport;
  const tokenStore = createFileTokenStore(paths.tokenFile, logger);
  const runtime = {
    env,
    paths,
    config,
    logger,
    clock,
    version: ARCHIVER_VERSION,
    tokenStore,
    db() {
      database ??= openDatabase(paths.dbFile);
      return database;
    },
    http() {
      httpClient ??= createHttpClient({ clock, logger });
      return httpClient;
    },
    async auth() {
      if (authProvider === void 0) {
        const client = await resolveOAuthClient(env, paths.dataDir);
        authProvider = createAuthProvider({
          client,
          tokenStore,
          http: runtime.http(),
          clock,
          logger
        });
      }
      return authProvider;
    },
    async drive() {
      transport ??= createDriveTransport({
        http: runtime.http(),
        auth: await runtime.auth(),
        logger
      });
      return transport;
    },
    close() {
      if (database !== void 0) {
        checkpointAndClose(database);
        database = void 0;
      }
      logger.close();
    }
  };
  return runtime;
}
async function readConfigFile(dataDir) {
  let raw;
  try {
    raw = await fsp5.readFile(path9.join(dataDir, "config.json"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { status: "absent" };
    return { status: "unusable", reason: `config.json could not be read: ${String(err)}` };
  }
  if (raw.trim().length === 0) return { status: "absent" };
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "unusable", reason: "config.json is not a JSON object" };
    }
    return { status: "ok", source: parsed };
  } catch {
    return { status: "unusable", reason: "config.json is not valid JSON" };
  }
}

// src/adapters/node-locator.ts
import fs7 from "node:fs";
import os3 from "node:os";
import path10 from "node:path";
import { spawnSync } from "node:child_process";

// src/core/node-discovery.ts
function versionFromPath(candidatePath) {
  const segments = candidatePath.split(/[\\/]/);
  for (let index = segments.length - 1; index >= 0; index--) {
    const match = /^v?(\d+\.\d+\.\d+)$/.exec(segments[index] ?? "");
    if (match?.[1] !== void 0) return match[1];
  }
  return null;
}
function rankCandidates(candidates, minVersion = MIN_NODE_VERSION) {
  const known = [];
  const unknown = [];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    if (candidate.version === null) {
      unknown.push(candidate);
    } else if (compareVersions(candidate.version, minVersion) >= 0) {
      known.push(candidate);
    }
  }
  known.sort((a, b2) => compareVersions(b2.version ?? "0", a.version ?? "0"));
  return [...known, ...unknown];
}
function satisfiesFloor(version, minVersion = MIN_NODE_VERSION) {
  return compareVersions(version, minVersion) >= 0;
}

// src/adapters/node-locator.ts
function probeVersion(candidatePath) {
  try {
    const result = spawnSync(candidatePath, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 5e3,
      windowsHide: true
    });
    if (result.status !== 0) return null;
    const version = result.stdout.trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}
function findCompatibleNode(options = {}) {
  const env = options.env ?? process.env;
  const homedir = (options.homedir ?? os3.homedir)();
  const verify = options.verify ?? probeVersion;
  const minVersion = options.minVersion ?? MIN_NODE_VERSION;
  const now = (options.now ?? Date.now)();
  const cached2 = readCache(options.cacheFile);
  if (cached2 !== null && fs7.existsSync(cached2.path) && satisfiesFloor(cached2.version, minVersion)) {
    return cached2;
  }
  if (recentMiss(options.cacheFile, now)) return null;
  for (const candidate of rankCandidates(collectCandidates(env, homedir), minVersion)) {
    const version = verify(candidate.path);
    if (version === null || !satisfiesFloor(version, minVersion)) continue;
    const found = { path: candidate.path, version };
    writeCache(options.cacheFile, found);
    return found;
  }
  writeMiss(options.cacheFile, (options.now ?? Date.now)());
  return null;
}
function collectCandidates(env, homedir) {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [];
  const add = (candidatePath) => {
    candidates.push({ path: candidatePath, version: versionFromPath(candidatePath) });
  };
  const addVersioned = (root, ...tail) => {
    let entries;
    try {
      entries = fs7.readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path10.join(root, entry, ...tail, exe);
      if (fs7.existsSync(full)) add(full);
    }
  };
  if (process.platform === "win32") {
    const appData = env["APPDATA"];
    const localAppData = env["LOCALAPPDATA"];
    const programFiles = env["ProgramFiles"];
    if (appData !== void 0) addVersioned(path10.join(appData, "nvm"));
    if (localAppData !== void 0) {
      addVersioned(path10.join(localAppData, "fnm", "node-versions"), "installation");
      addVersioned(path10.join(localAppData, "Volta", "tools", "image", "node"));
      addIfPresent(path10.join(localAppData, "Programs", "nodejs", exe), add);
    }
    if (programFiles !== void 0) addIfPresent(path10.join(programFiles, "nodejs", exe), add);
  } else {
    const nvm = env["NVM_DIR"] ?? path10.join(homedir, ".nvm");
    addVersioned(path10.join(nvm, "versions", "node"), "bin");
    for (const fnm of [
      env["FNM_DIR"],
      path10.join(homedir, ".fnm"),
      path10.join(homedir, ".local", "share", "fnm")
    ]) {
      if (fnm !== void 0) addVersioned(path10.join(fnm, "node-versions"), "installation", "bin");
    }
    addVersioned(path10.join(homedir, ".volta", "tools", "image", "node"), "bin");
    addVersioned(path10.join(homedir, ".local", "share", "mise", "installs", "node"), "bin");
    addVersioned(path10.join(homedir, ".asdf", "installs", "nodejs"), "bin");
    for (const fixed of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
      addIfPresent(fixed, add);
    }
  }
  return candidates;
}
function addIfPresent(candidatePath, add) {
  if (fs7.existsSync(candidatePath)) add(candidatePath);
}
function reexec(nodePath, env = process.env) {
  const result = spawnSync(nodePath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...env, ARCHIVE_REEXEC: "1" },
    windowsHide: true
  });
  return result.status ?? 1;
}
function alreadyReexeced(env) {
  const value = env["ARCHIVE_REEXEC"];
  return value !== void 0 && value !== "" && value !== "0";
}
function readCache(file) {
  if (file === void 0) return null;
  try {
    const parsed = JSON.parse(fs7.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { path: cachedPath, version } = parsed;
    if (typeof cachedPath !== "string" || typeof version !== "string") return null;
    return { path: cachedPath, version };
  } catch {
    return null;
  }
}
var MISS_TTL_MS = 10 * 6e4;
function recentMiss(file, now) {
  if (file === void 0) return false;
  try {
    const parsed = JSON.parse(fs7.readFileSync(file, "utf8"));
    const missedAt = parsed?.missedAt;
    return typeof missedAt === "number" && now - missedAt < MISS_TTL_MS;
  } catch {
    return false;
  }
}
function writeMiss(file, now) {
  if (file === void 0) return;
  try {
    fs7.mkdirSync(path10.dirname(file), { recursive: true });
    fs7.writeFileSync(file, `${JSON.stringify({ missedAt: now })}
`, { mode: 384 });
  } catch {
  }
}
function writeCache(file, found) {
  if (file === void 0) return;
  try {
    fs7.mkdirSync(path10.dirname(file), { recursive: true });
    fs7.writeFileSync(file, `${JSON.stringify(found)}
`, { mode: 384 });
  } catch {
  }
}

// src/worker/sweep.ts
import fsp12 from "node:fs/promises";
import os5 from "node:os";
import { createHash as createHash3, randomBytes as randomBytes3 } from "node:crypto";
import path16 from "node:path";

// src/adapters/session-scan.ts
import fsp6 from "node:fs/promises";
import path12 from "node:path";

// src/core/identifiers.ts
import path11 from "node:path";
var SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,253}$/;
function isSafePathSegment(value) {
  if (!SAFE_SEGMENT.test(value)) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  return true;
}
var isSafeSessionId = isSafePathSegment;
var isSafeEncodedDir = isSafePathSegment;
function assertInside(root, target, what) {
  const resolvedRoot = path11.resolve(root);
  const resolvedTarget = path11.resolve(target);
  if (resolvedTarget === resolvedRoot) {
    throw new BugError(`${what} resolved to the root itself: ${resolvedTarget}`);
  }
  if (!resolvedTarget.startsWith(resolvedRoot + path11.sep)) {
    throw new BugError(`${what} escaped ${resolvedRoot}: ${resolvedTarget}`);
  }
}

// src/adapters/session-scan.ts
async function statSession(paths, encodedDir, sessionId) {
  const dir = path12.join(paths.projectsDir, encodedDir);
  const transcriptPath = path12.join(dir, `${sessionId}.jsonl`);
  const sidecarDir = path12.join(dir, sessionId);
  let transcript;
  try {
    transcript = await fsp6.lstat(transcriptPath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!transcript.isFile()) return null;
  const sidecar = await measureDirectory(sidecarDir);
  return {
    sessionId,
    encodedDir,
    transcriptPath,
    sidecarDir,
    hasSidecar: sidecar !== null,
    sidecarUnreadable: sidecar?.unreadable === true,
    transcriptBytes: transcript.size,
    sidecarBytes: sidecar?.bytes ?? 0,
    mtimeMs: Math.max(transcript.mtimeMs, sidecar?.mtimeMs ?? 0)
  };
}
async function* scanSessions(paths, skipped) {
  let projectDirs;
  try {
    projectDirs = await fsp6.readdir(paths.projectsDir);
  } catch (err) {
    if (err.code !== "ENOENT") {
      skipped?.push({ kind: "project", name: paths.projectsDir, reason: "unreadable" });
    }
    return;
  }
  for (const encodedDir of projectDirs) {
    if (!isSafeEncodedDir(encodedDir)) {
      skipped?.push({ kind: "project", name: encodedDir, reason: "name" });
      continue;
    }
    let entries;
    try {
      entries = await fsp6.readdir(path12.join(paths.projectsDir, encodedDir));
    } catch (err) {
      if (err.code !== "ENOENT") {
        skipped?.push({ kind: "project", name: encodedDir, reason: "unreadable" });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      if (!isSafeSessionId(sessionId)) {
        skipped?.push({ kind: "session", name: entry, reason: "name" });
        continue;
      }
      let session;
      try {
        session = await statSession(paths, encodedDir, sessionId);
      } catch {
        skipped?.push({ kind: "session", name: entry, reason: "unreadable" });
        continue;
      }
      if (session !== null) {
        yield session;
      } else {
        skipped?.push({ kind: "session", name: entry, reason: "unreadable" });
      }
    }
  }
}
async function measureDirectory(dir) {
  try {
    if ((await fsp6.lstat(dir)).isSymbolicLink()) return { bytes: 0, mtimeMs: 0, unreadable: true };
  } catch {
  }
  let entries;
  try {
    entries = await fsp6.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return { bytes: 0, mtimeMs: 0, unreadable: true };
  }
  let bytes = 0;
  let mtimeMs = 0;
  const stack = entries.map((entry) => path12.join(dir, entry));
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === void 0) break;
    let stat;
    try {
      stat = await fsp6.lstat(current);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      return { bytes, mtimeMs, unreadable: true };
    }
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    if (stat.isDirectory()) {
      try {
        for (const child of await fsp6.readdir(current)) stack.push(path12.join(current, child));
      } catch (err) {
        if (err.code !== "ENOENT")
          return { bytes, mtimeMs, unreadable: true };
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
    }
  }
  return { bytes, mtimeMs };
}
function bundleEntries(session) {
  const entries = [`${session.sessionId}.jsonl`];
  if (session.hasSidecar) entries.push(session.sessionId);
  return entries;
}

// src/core/catalog.ts
var SESSION_COLUMNS = `session_id, encoded_dir, project_cwd, title, summary, git_branch,
  started_at, ended_at, message_count, transcript_bytes, transcript_sha256, sidecar_bytes,
  bundle_name, bundle_bytes, bundle_sha256, remote_file_id, remote_path, backed_up_at,
  verified_at, archiver_version, local_present, local_deleted_at, last_local_mtime,
  verified_local_mtime, verified_local_bytes, verified_bundle_sha256,
  verified_transcript_sha256, verified_transcript_bytes, verified_sidecar_bytes,
  verified_bundle_bytes, verified_manifest, verified_bundle_md5, created_at, updated_at`;
function upsertSession(db, session, now) {
  db.prepare(
    `INSERT INTO sessions (
       session_id, encoded_dir, project_cwd, title, summary, git_branch, started_at, ended_at,
       message_count, transcript_bytes, transcript_sha256, sidecar_bytes, last_local_mtime,
       local_present, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       -- A row that moves to a different project directory is describing
       -- different local files, so the fingerprint that authorises deleting
       -- them stops applying. Only those two columns, and verified_at, are
       -- about the disk.
       --
       -- The rest describe the copy on Drive, which did not move. Nulling them
       -- here was the fourth appearance of one defect: a guard reading a column
       -- that an earlier step of the same attempt rewrites. indexSession calls
       -- this on every backup attempt, so the shrink guard destroyed its own
       -- floors as it fired and let the retry replace a good archive with a
       -- damaged one. This statement no longer mentions those columns at all.
       verified_at = CASE WHEN sessions.encoded_dir = excluded.encoded_dir
                          THEN sessions.verified_at ELSE NULL END,
       verified_local_mtime = CASE WHEN sessions.encoded_dir = excluded.encoded_dir
                                   THEN sessions.verified_local_mtime ELSE NULL END,
       verified_local_bytes = CASE WHEN sessions.encoded_dir = excluded.encoded_dir
                                   THEN sessions.verified_local_bytes ELSE NULL END,
       encoded_dir       = excluded.encoded_dir,
       project_cwd       = COALESCE(excluded.project_cwd, sessions.project_cwd),
       title             = COALESCE(excluded.title, sessions.title),
       summary           = COALESCE(excluded.summary, sessions.summary),
       git_branch        = COALESCE(excluded.git_branch, sessions.git_branch),
       started_at        = COALESCE(excluded.started_at, sessions.started_at),
       ended_at          = COALESCE(excluded.ended_at, sessions.ended_at),
       message_count     = COALESCE(excluded.message_count, sessions.message_count),
       transcript_bytes  = COALESCE(excluded.transcript_bytes, sessions.transcript_bytes),
       transcript_sha256 = COALESCE(excluded.transcript_sha256, sessions.transcript_sha256),
       sidecar_bytes     = COALESCE(excluded.sidecar_bytes, sessions.sidecar_bytes),
       last_local_mtime  = COALESCE(excluded.last_local_mtime, sessions.last_local_mtime),
       updated_at        = excluded.updated_at`
  ).run(
    session.sessionId,
    session.encodedDir,
    session.projectCwd ?? null,
    session.title ?? null,
    session.summary ?? null,
    session.gitBranch ?? null,
    session.startedAt ?? null,
    session.endedAt ?? null,
    session.messageCount ?? null,
    session.transcriptBytes ?? null,
    session.transcriptSha256 ?? null,
    session.sidecarBytes ?? null,
    session.lastLocalMtime ?? null,
    now,
    now
  );
}
function replacePrompts(db, sessionId, prompts) {
  inTransaction(db, () => {
    db.prepare("DELETE FROM prompts WHERE session_id = ?").run(sessionId);
    const insert = db.prepare(
      // OR REPLACE: an extractor that ever hands back two prompts with the
      // same seq should lose one line of index, not the session's whole
      // backup.
      "INSERT OR REPLACE INTO prompts (session_id, seq, ts, text) VALUES (?, ?, ?, ?)"
    );
    for (const prompt of prompts) {
      insert.run(sessionId, prompt.seq, prompt.ts, prompt.text);
    }
  });
}
function replaceFiles(db, sessionId, files) {
  inTransaction(db, () => {
    db.prepare("DELETE FROM session_files WHERE session_id = ?").run(sessionId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO session_files (session_id, path) VALUES (?, ?)"
    );
    for (const file of files) insert.run(sessionId, file);
  });
}
function markBundled(db, sessionId, backup, now) {
  db.prepare(
    `UPDATE sessions
        SET bundle_name = ?, bundle_bytes = ?, bundle_sha256 = ?, archiver_version = ?,
            verified_at = NULL, updated_at = ?
      WHERE session_id = ?`
  ).run(
    backup.bundleName,
    backup.bundleBytes,
    backup.bundleSha256,
    backup.archiverVersion,
    now,
    sessionId
  );
}
function countPrompts(db, sessionId) {
  const row = db.prepare("SELECT count(*) AS n FROM prompts WHERE session_id = ?").get(sessionId);
  return row?.n ?? 0;
}
function countSessionFiles(db, sessionId) {
  const row = db.prepare("SELECT count(*) AS n FROM session_files WHERE session_id = ?").get(sessionId);
  return row?.n ?? 0;
}
function recordRetainedBundle(db, entry, now) {
  db.prepare(
    `INSERT INTO retained_bundles
       (session_id, file_id, remote_path, bundle_sha256, bundle_bytes, bundle_md5,
        manifest, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id) DO UPDATE SET reason = excluded.reason`
  ).run(
    entry.sessionId,
    entry.fileId,
    entry.remotePath,
    entry.bundleSha256,
    entry.bundleBytes,
    entry.bundleMd5,
    entry.manifest,
    entry.reason,
    now
  );
}
function markVerified(db, sessionId, remote, now) {
  db.prepare(
    `UPDATE sessions
        SET remote_file_id = ?, remote_path = ?, backed_up_at = ?, verified_at = ?,
            verified_local_mtime = ?, verified_local_bytes = ?, verified_bundle_sha256 = ?,
            verified_transcript_sha256 = ?, verified_transcript_bytes = ?,
            verified_sidecar_bytes = ?, verified_bundle_bytes = ?, verified_manifest = ?,
            verified_bundle_md5 = ?, updated_at = ?
      WHERE session_id = ?`
  ).run(
    remote.fileId,
    remote.path,
    now,
    now,
    remote.localMtime,
    remote.localBytes,
    remote.bundleSha256,
    remote.transcriptSha256,
    remote.transcriptBytes,
    remote.sidecarBytes,
    remote.bundleBytes,
    remote.manifest,
    remote.bundleMd5,
    now,
    sessionId
  );
}
function clearVerification(db, sessionId, now) {
  db.prepare(`UPDATE sessions SET verified_at = NULL, updated_at = ? WHERE session_id = ?`).run(
    now,
    sessionId
  );
}
function markReapSkipped(db, sessionId, reason, until, now) {
  db.prepare(
    `UPDATE sessions SET reap_skip_reason = ?, reap_skip_until = ?, updated_at = ?
      WHERE session_id = ?`
  ).run(reason, until, now, sessionId);
}
function markLocalDeleted(db, sessionId, now) {
  db.prepare(
    `UPDATE sessions SET local_present = 0, local_deleted_at = ?,
            reap_skip_reason = NULL, reap_skip_until = NULL, updated_at = ?
      WHERE session_id = ?`
  ).run(now, now, sessionId);
}
function markLocalPresent(db, sessionId, mtime, now) {
  db.prepare(
    `UPDATE sessions
        SET local_present = 1, local_deleted_at = NULL, last_local_mtime = ?,
            reap_skip_reason = NULL, reap_skip_until = NULL, updated_at = ?
      WHERE session_id = ?`
  ).run(mtime, now, sessionId);
}
function getSession(db, sessionId) {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`).get(sessionId);
  return row === void 0 ? null : toRecord(row);
}
function listReapable(db, idleBefore, now, limit = 500) {
  const rows = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE local_present = 1
          AND verified_at IS NOT NULL
          AND bundle_sha256 IS NOT NULL
          AND remote_file_id IS NOT NULL
          AND verified_local_mtime IS NOT NULL
          AND verified_local_mtime < ?
          -- A row the reaper keeps passing over does not get to occupy the
          -- window for ever; it comes back when its cool-off expires.
          AND (reap_skip_until IS NULL OR reap_skip_until <= ?)
        ORDER BY verified_local_mtime ASC
        LIMIT ?`
  ).all(idleBefore, now, limit);
  return rows.map(toRecord);
}
function listReapedForAudit(db, limit) {
  const rows = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE local_present = 0
          AND remote_file_id IS NOT NULL
          AND verified_bundle_sha256 IS NOT NULL
        ORDER BY COALESCE(audited_at, 0) ASC, COALESCE(verified_at, 0) ASC
        LIMIT ?`
  ).all(limit);
  return rows.map(toRecord);
}
function restoreVerification(db, sessionId, now) {
  db.prepare(
    `UPDATE sessions SET verified_at = ?, updated_at = ?
      WHERE session_id = ? AND verified_at IS NULL AND local_present = 0
        AND remote_file_id IS NOT NULL AND verified_bundle_sha256 IS NOT NULL`
  ).run(now, now, sessionId);
}
function markAudited(db, sessionIds, now) {
  if (sessionIds.length === 0) return;
  const statement = db.prepare("UPDATE sessions SET audited_at = ? WHERE session_id = ?");
  inTransaction(db, () => {
    for (const sessionId of sessionIds) statement.run(now, sessionId);
  });
}
function catalogStats(db) {
  const row = db.prepare(
    `SELECT
         count(*) AS sessions,
         sum(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
         sum(CASE WHEN local_present = 1 THEN 1 ELSE 0 END) AS local_present,
         sum(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END) AS pending_backup,
         -- An orphan-sidecar row is local_present = 1 with no transcript, so
         -- counting its transcript_bytes overstated the disk by the size of a
         -- file that is not there.
         sum(CASE WHEN local_present = 1 AND reap_skip_reason IS NOT 'orphan-sidecar'
                  THEN COALESCE(transcript_bytes, 0) + COALESCE(sidecar_bytes, 0)
                  WHEN local_present = 1
                  THEN COALESCE(sidecar_bytes, 0)
                  ELSE 0 END) AS local_bytes,
         -- verified_bundle_bytes, not bundle_bytes: the latter describes a
         -- bundle that was *built*, so a session that never uploaded still
         -- counted towards "On Drive".
         sum(COALESCE(verified_bundle_bytes, 0)) AS archived_bytes,
         -- local_deleted_at, not local_present = 0: rows recovered from
         -- another machine's catalog are also not local here, and counting
         -- them told the user we had reclaimed space we never held.
         sum(CASE WHEN local_deleted_at IS NOT NULL
                  THEN COALESCE(transcript_bytes, 0) + COALESCE(sidecar_bytes, 0)
                  ELSE 0 END) AS reclaimed_bytes,
         min(COALESCE(started_at, ended_at)) AS oldest,
         max(COALESCE(ended_at, started_at)) AS newest
       FROM sessions`
  ).get();
  return {
    sessions: row?.["sessions"] ?? 0,
    verified: row?.["verified"] ?? 0,
    localPresent: row?.["local_present"] ?? 0,
    pendingBackup: row?.["pending_backup"] ?? 0,
    localBytes: row?.["local_bytes"] ?? 0,
    archivedBytes: row?.["archived_bytes"] ?? 0,
    reclaimedBytes: row?.["reclaimed_bytes"] ?? 0,
    oldestSession: row?.["oldest"] ?? null,
    newestSession: row?.["newest"] ?? null
  };
}
function toRecord(row) {
  return {
    sessionId: row.session_id,
    encodedDir: row.encoded_dir,
    projectCwd: row.project_cwd,
    title: row.title,
    summary: row.summary,
    gitBranch: row.git_branch,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    messageCount: row.message_count,
    transcriptBytes: row.transcript_bytes,
    transcriptSha256: row.transcript_sha256,
    sidecarBytes: row.sidecar_bytes,
    bundleName: row.bundle_name,
    bundleBytes: row.bundle_bytes,
    bundleSha256: row.bundle_sha256,
    remoteFileId: row.remote_file_id,
    remotePath: row.remote_path,
    backedUpAt: row.backed_up_at,
    verifiedAt: row.verified_at,
    archiverVersion: row.archiver_version,
    localPresent: row.local_present !== 0,
    localDeletedAt: row.local_deleted_at,
    lastLocalMtime: row.last_local_mtime,
    verifiedLocalMtime: row.verified_local_mtime,
    verifiedLocalBytes: row.verified_local_bytes,
    verifiedBundleSha256: row.verified_bundle_sha256,
    verifiedTranscriptSha256: row.verified_transcript_sha256,
    verifiedTranscriptBytes: row.verified_transcript_bytes,
    verifiedSidecarBytes: row.verified_sidecar_bytes,
    verifiedBundleBytes: row.verified_bundle_bytes,
    verifiedManifest: row.verified_manifest,
    verifiedBundleMd5: row.verified_bundle_md5,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// src/core/queue.ts
import { randomBytes as randomBytes2 } from "node:crypto";
var JOB_COLUMNS = `id, dedupe_key, kind, session_id, attempts, not_before, visible_at,
  blocked, claim_token, payload, upload_uri, last_error, created_at, updated_at`;
function dedupeKey(kind, sessionId) {
  return `${kind}:${sessionId ?? ""}`;
}
function enqueue(db, args, now) {
  const sessionId = args.sessionId ?? null;
  const key = dedupeKey(args.kind, sessionId);
  const notBefore = args.notBefore ?? now;
  const payload = args.payload === void 0 ? null : JSON.stringify(args.payload);
  const row = db.prepare(
    `INSERT INTO jobs (dedupe_key, kind, session_id, payload, not_before, visible_at,
                         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         payload     = excluded.payload,
         -- max(), so neither an ordinary hook fire nor a session closing can
         -- pull a backing-off job forward: a server that answered Retry-After
         -- gets the wait it asked for. runNow is the one exception, and only
         -- /archive:now sets it \u2014 that is a person saying "try again, now".
         not_before  = CASE WHEN ? THEN excluded.not_before
                            ELSE max(jobs.not_before, excluded.not_before) END,
         blocked     = CASE WHEN ? THEN 0 ELSE jobs.blocked END,
         blocked_at  = CASE WHEN ? THEN NULL ELSE jobs.blocked_at END,
         -- A block leaves the claim's visibility timeout in place, so without this
         -- an unblocked job stayed invisible for up to fifteen minutes and
         -- /archive:now appeared to have done nothing.
         visible_at  = CASE WHEN ? THEN 0 ELSE jobs.visible_at END,
         claim_token = NULL,
         -- The URI is kept. It is stored tagged with the hash of the bundle it
         -- was opened for, and uploadWithResume discards it when the rebuilt
         -- bundle differs \u2014 so nothing can be resumed against the wrong bytes.
         -- Nulling it here meant every sweep re-enqueued a session with an
         -- upload in flight and destroyed its resume point, so a large bundle
         -- on a link that drops mid-transfer restarted from zero for ever and
         -- was never archived.
         updated_at  = excluded.updated_at
       RETURNING id`
  ).get(
    key,
    args.kind,
    sessionId,
    payload,
    notBefore,
    now,
    now,
    args.runNow === true ? 1 : 0,
    args.unblock === true ? 1 : 0,
    args.unblock === true ? 1 : 0,
    args.unblock === true ? 1 : 0
  );
  return row?.id ?? 0;
}
function claim(db, now, visibilityMs) {
  const token = randomBytes2(8).toString("hex");
  const row = db.prepare(
    `UPDATE jobs
          SET visible_at  = ?,
              attempts    = attempts + 1,
              claim_token = ?,
              updated_at  = ?
        WHERE id = (
          SELECT id FROM jobs
           WHERE blocked = 0 AND not_before <= ? AND visible_at <= ?
           ORDER BY not_before ASC, id ASC
           LIMIT 1
        )
       RETURNING ${JOB_COLUMNS}`
  ).get(now + visibilityMs, token, now, now, now);
  return row === void 0 ? null : toJob(row);
}
function heartbeatClaim(db, job, now, visibilityMs) {
  db.prepare(`UPDATE jobs SET visible_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?`).run(
    now + visibilityMs,
    now,
    job.id,
    job.claimToken
  );
}
function complete(db, job) {
  const deleted = db.prepare("DELETE FROM jobs WHERE id = ? AND claim_token = ?").run(job.id, job.claimToken);
  if (deleted.changes > 0) return "deleted";
  db.prepare("UPDATE jobs SET visible_at = 0 WHERE id = ? AND claim_token IS NULL").run(job.id);
  return "superseded";
}
function retryLater(db, job, args) {
  db.prepare(
    `UPDATE jobs
        SET not_before  = ?,
            visible_at  = 0,
            claim_token = NULL,
            last_error  = ?,
            updated_at  = ?
      WHERE id = ? AND claim_token IS ?`
  ).run(args.at, args.error, args.at, job.id, job.claimToken);
}
function block(db, job, args) {
  db.prepare(
    `UPDATE jobs
        SET blocked = 1, blocked_at = ?, claim_token = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND claim_token IS ?`
  ).run(args.now, args.error, args.now, job.id, job.claimToken);
}
function unblockStale(db, now, olderThanMs) {
  const result = db.prepare(
    `UPDATE jobs SET blocked = 0, blocked_at = NULL, visible_at = 0,
              not_before = ?, updated_at = ?
        WHERE blocked = 1 AND COALESCE(blocked_at, updated_at) <= ?`
  ).run(now, now, now - olderThanMs);
  return Number(result.changes);
}
function setUploadUri(db, job, uri, now) {
  db.prepare(
    "UPDATE jobs SET upload_uri = ?, updated_at = ? WHERE id = ? AND claim_token IS ?"
  ).run(uri, now, job.id, job.claimToken);
}
function nextRunnableAt(db, now) {
  const row = db.prepare(
    `SELECT min(not_before) AS at FROM jobs
        WHERE blocked = 0 AND attempts = 0 AND visible_at <= ?`
  ).get(now);
  return row?.at ?? null;
}
function listJobs(db) {
  const rows = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY not_before ASC, id ASC`).all();
  return rows.map(toJob);
}
function countJobs(db, now) {
  const row = db.prepare(
    `SELECT
         count(*) AS total,
         sum(CASE WHEN blocked = 0 AND not_before <= ? AND visible_at <= ? THEN 1 ELSE 0 END)
           AS runnable,
         sum(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked,
         -- attempts >= 1: a job that has failed once has attempts = 1, and
         -- counting from 2 made every first failure invisible to the status
         -- report \u2014 including one parked for hours by a Retry-After.
         sum(CASE WHEN blocked = 0 AND attempts >= 1 AND not_before > ?
                  THEN 1 ELSE 0 END) AS failing
       FROM jobs`
  ).get(now, now, now);
  return {
    total: row?.total ?? 0,
    runnable: row?.runnable ?? 0,
    blocked: row?.blocked ?? 0,
    failing: row?.failing ?? 0
  };
}
function parsePayload(job) {
  if (job.payload === null) return null;
  try {
    return JSON.parse(job.payload);
  } catch {
    return null;
  }
}
function toJob(row) {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    sessionId: row.session_id,
    attempts: row.attempts,
    notBefore: row.not_before,
    visibleAt: row.visible_at,
    blocked: row.blocked !== 0,
    claimToken: row.claim_token,
    payload: row.payload,
    uploadUri: row.upload_uri,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// src/worker/backup.ts
import fsp10 from "node:fs/promises";
import path14 from "node:path";

// src/adapters/bundle.ts
import fsp8 from "node:fs/promises";
import fs9 from "node:fs";
import path13 from "node:path";
import zlib from "node:zlib";
import { pipeline as pipeline3 } from "node:stream/promises";
import { createHash as createHash2 } from "node:crypto";

// node_modules/tar/dist/esm/index.min.js
import Qr from "events";
import I from "fs";
import { EventEmitter as Di } from "node:events";
import Cs from "node:stream";
import { StringDecoder as Hr } from "node:string_decoder";
import cr from "node:path";
import Kt from "node:fs";
import { dirname as Fn, parse as kn } from "path";
import { EventEmitter as Dn } from "events";
import zi from "assert";
import { Buffer as Ot } from "buffer";
import * as Ps from "zlib";
import en from "zlib";
import { posix as Zt } from "node:path";
import { basename as _n } from "node:path";
import mi from "fs";
import X from "fs";
import js from "path";
import { win32 as Pn } from "node:path";
import ar from "path";
import Br from "node:fs";
import co from "node:assert";
import { randomBytes as Mr } from "node:crypto";
import u from "node:fs";
import R from "node:path";
import pr from "fs";
import wi from "node:fs";
import we from "node:path";
import k from "node:fs";
import ro from "node:fs/promises";
import Si from "node:path";
import { join as xr } from "node:path";
import v from "node:fs";
import Pr from "node:path";
var zr = Object.defineProperty;
var Ur = (s3, t) => {
  for (var e in t) zr(s3, e, { get: t[e], enumerable: true });
};
var Ds = typeof process == "object" && process ? process : { stdout: null, stderr: null };
var Wr = (s3) => !!s3 && typeof s3 == "object" && (s3 instanceof A || s3 instanceof Cs || Gr(s3) || Zr(s3));
var Gr = (s3) => !!s3 && typeof s3 == "object" && s3 instanceof Di && typeof s3.pipe == "function" && s3.pipe !== Cs.Writable.prototype.pipe;
var Zr = (s3) => !!s3 && typeof s3 == "object" && s3 instanceof Di && typeof s3.write == "function" && typeof s3.end == "function";
var Q = /* @__PURE__ */ Symbol("EOF");
var J = /* @__PURE__ */ Symbol("maybeEmitEnd");
var nt = /* @__PURE__ */ Symbol("emittedEnd");
var De = /* @__PURE__ */ Symbol("emittingEnd");
var qt = /* @__PURE__ */ Symbol("emittedError");
var Ne = /* @__PURE__ */ Symbol("closed");
var Ns = /* @__PURE__ */ Symbol("read");
var Ae = /* @__PURE__ */ Symbol("flush");
var As = /* @__PURE__ */ Symbol("flushChunk");
var z = /* @__PURE__ */ Symbol("encoding");
var Mt = /* @__PURE__ */ Symbol("decoder");
var g = /* @__PURE__ */ Symbol("flowing");
var Qt = /* @__PURE__ */ Symbol("paused");
var Bt = /* @__PURE__ */ Symbol("resume");
var b = /* @__PURE__ */ Symbol("buffer");
var N = /* @__PURE__ */ Symbol("pipes");
var _ = /* @__PURE__ */ Symbol("bufferLength");
var bi = /* @__PURE__ */ Symbol("bufferPush");
var Ie = /* @__PURE__ */ Symbol("bufferShift");
var L = /* @__PURE__ */ Symbol("objectMode");
var S = /* @__PURE__ */ Symbol("destroyed");
var _i = /* @__PURE__ */ Symbol("error");
var Oi = /* @__PURE__ */ Symbol("emitData");
var Is = /* @__PURE__ */ Symbol("emitEnd");
var Ti = /* @__PURE__ */ Symbol("emitEnd2");
var Z = /* @__PURE__ */ Symbol("async");
var xi = /* @__PURE__ */ Symbol("abort");
var Ce = /* @__PURE__ */ Symbol("aborted");
var Jt = /* @__PURE__ */ Symbol("signal");
var Rt = /* @__PURE__ */ Symbol("dataListeners");
var C = /* @__PURE__ */ Symbol("discarded");
var jt = (s3) => Promise.resolve().then(s3);
var Yr = (s3) => s3();
var Kr = (s3) => s3 === "end" || s3 === "finish" || s3 === "prefinish";
var Vr = (s3) => s3 instanceof ArrayBuffer || !!s3 && typeof s3 == "object" && s3.constructor && s3.constructor.name === "ArrayBuffer" && s3.byteLength >= 0;
var $r = (s3) => !Buffer.isBuffer(s3) && ArrayBuffer.isView(s3);
var Fe = class {
  src;
  dest;
  opts;
  ondrain;
  constructor(t, e, i) {
    this.src = t, this.dest = e, this.opts = i, this.ondrain = () => t[Bt](), this.dest.on("drain", this.ondrain);
  }
  unpipe() {
    this.dest.removeListener("drain", this.ondrain);
  }
  proxyErrors(t) {
  }
  end() {
    this.unpipe(), this.opts.end && this.dest.end();
  }
};
var Li = class extends Fe {
  unpipe() {
    this.src.removeListener("error", this.proxyErrors), super.unpipe();
  }
  constructor(t, e, i) {
    super(t, e, i), this.proxyErrors = (r) => this.dest.emit("error", r), t.on("error", this.proxyErrors);
  }
};
var Xr = (s3) => !!s3.objectMode;
var qr = (s3) => !s3.objectMode && !!s3.encoding && s3.encoding !== "buffer";
var A = class extends Di {
  [g] = false;
  [Qt] = false;
  [N] = [];
  [b] = [];
  [L];
  [z];
  [Z];
  [Mt];
  [Q] = false;
  [nt] = false;
  [De] = false;
  [Ne] = false;
  [qt] = null;
  [_] = 0;
  [S] = false;
  [Jt];
  [Ce] = false;
  [Rt] = 0;
  [C] = false;
  writable = true;
  readable = true;
  constructor(...t) {
    let e = t[0] || {};
    if (super(), e.objectMode && typeof e.encoding == "string") throw new TypeError("Encoding and objectMode may not be used together");
    Xr(e) ? (this[L] = true, this[z] = null) : qr(e) ? (this[z] = e.encoding, this[L] = false) : (this[L] = false, this[z] = null), this[Z] = !!e.async, this[Mt] = this[z] ? new Hr(this[z]) : null, e && e.debugExposeBuffer === true && Object.defineProperty(this, "buffer", { get: () => this[b] }), e && e.debugExposePipes === true && Object.defineProperty(this, "pipes", { get: () => this[N] });
    let { signal: i } = e;
    i && (this[Jt] = i, i.aborted ? this[xi]() : i.addEventListener("abort", () => this[xi]()));
  }
  get bufferLength() {
    return this[_];
  }
  get encoding() {
    return this[z];
  }
  set encoding(t) {
    throw new Error("Encoding must be set at instantiation time");
  }
  setEncoding(t) {
    throw new Error("Encoding must be set at instantiation time");
  }
  get objectMode() {
    return this[L];
  }
  set objectMode(t) {
    throw new Error("objectMode must be set at instantiation time");
  }
  get async() {
    return this[Z];
  }
  set async(t) {
    this[Z] = this[Z] || !!t;
  }
  [xi]() {
    this[Ce] = true, this.emit("abort", this[Jt]?.reason), this.destroy(this[Jt]?.reason);
  }
  get aborted() {
    return this[Ce];
  }
  set aborted(t) {
  }
  write(t, e, i) {
    if (this[Ce]) return false;
    if (this[Q]) throw new Error("write after end");
    if (this[S]) return this.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" })), true;
    typeof e == "function" && (i = e, e = "utf8"), e || (e = "utf8");
    let r = this[Z] ? jt : Yr;
    if (!this[L] && !Buffer.isBuffer(t)) {
      if ($r(t)) t = Buffer.from(t.buffer, t.byteOffset, t.byteLength);
      else if (Vr(t)) t = Buffer.from(t);
      else if (typeof t != "string") throw new Error("Non-contiguous data written to non-objectMode stream");
    }
    return this[L] ? (this[g] && this[_] !== 0 && this[Ae](true), this[g] ? this.emit("data", t) : this[bi](t), this[_] !== 0 && this.emit("readable"), i && r(i), this[g]) : t.length ? (typeof t == "string" && !(e === this[z] && !this[Mt]?.lastNeed) && (t = Buffer.from(t, e)), Buffer.isBuffer(t) && this[z] && (t = this[Mt].write(t)), this[g] && this[_] !== 0 && this[Ae](true), this[g] ? this.emit("data", t) : this[bi](t), this[_] !== 0 && this.emit("readable"), i && r(i), this[g]) : (this[_] !== 0 && this.emit("readable"), i && r(i), this[g]);
  }
  read(t) {
    if (this[S]) return null;
    if (this[C] = false, this[_] === 0 || t === 0 || t && t > this[_]) return this[J](), null;
    this[L] && (t = null), this[b].length > 1 && !this[L] && (this[b] = [this[z] ? this[b].join("") : Buffer.concat(this[b], this[_])]);
    let e = this[Ns](t || null, this[b][0]);
    return this[J](), e;
  }
  [Ns](t, e) {
    if (this[L]) this[Ie]();
    else {
      let i = e;
      t === i.length || t === null ? this[Ie]() : typeof i == "string" ? (this[b][0] = i.slice(t), e = i.slice(0, t), this[_] -= t) : (this[b][0] = i.subarray(t), e = i.subarray(0, t), this[_] -= t);
    }
    return this.emit("data", e), !this[b].length && !this[Q] && this.emit("drain"), e;
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, t = void 0), typeof e == "function" && (i = e, e = "utf8"), t !== void 0 && this.write(t, e), i && this.once("end", i), this[Q] = true, this.writable = false, (this[g] || !this[Qt]) && this[J](), this;
  }
  [Bt]() {
    this[S] || (!this[Rt] && !this[N].length && (this[C] = true), this[Qt] = false, this[g] = true, this.emit("resume"), this[b].length ? this[Ae]() : this[Q] ? this[J]() : this.emit("drain"));
  }
  resume() {
    return this[Bt]();
  }
  pause() {
    this[g] = false, this[Qt] = true, this[C] = false;
  }
  get destroyed() {
    return this[S];
  }
  get flowing() {
    return this[g];
  }
  get paused() {
    return this[Qt];
  }
  [bi](t) {
    this[L] ? this[_] += 1 : this[_] += t.length, this[b].push(t);
  }
  [Ie]() {
    return this[L] ? this[_] -= 1 : this[_] -= this[b][0].length, this[b].shift();
  }
  [Ae](t = false) {
    do
      ;
    while (this[As](this[Ie]()) && this[b].length);
    !t && !this[b].length && !this[Q] && this.emit("drain");
  }
  [As](t) {
    return this.emit("data", t), this[g];
  }
  pipe(t, e) {
    if (this[S]) return t;
    this[C] = false;
    let i = this[nt];
    return e = e || {}, t === Ds.stdout || t === Ds.stderr ? e.end = false : e.end = e.end !== false, e.proxyErrors = !!e.proxyErrors, i ? e.end && t.end() : (this[N].push(e.proxyErrors ? new Li(this, t, e) : new Fe(this, t, e)), this[Z] ? jt(() => this[Bt]()) : this[Bt]()), t;
  }
  unpipe(t) {
    let e = this[N].find((i) => i.dest === t);
    e && (this[N].length === 1 ? (this[g] && this[Rt] === 0 && (this[g] = false), this[N] = []) : this[N].splice(this[N].indexOf(e), 1), e.unpipe());
  }
  addListener(t, e) {
    return this.on(t, e);
  }
  on(t, e) {
    let i = super.on(t, e);
    if (t === "data") this[C] = false, this[Rt]++, !this[N].length && !this[g] && this[Bt]();
    else if (t === "readable" && this[_] !== 0) super.emit("readable");
    else if (Kr(t) && this[nt]) super.emit(t), this.removeAllListeners(t);
    else if (t === "error" && this[qt]) {
      let r = e;
      this[Z] ? jt(() => r.call(this, this[qt])) : r.call(this, this[qt]);
    }
    return i;
  }
  removeListener(t, e) {
    return this.off(t, e);
  }
  off(t, e) {
    let i = super.off(t, e);
    return t === "data" && (this[Rt] = this.listeners("data").length, this[Rt] === 0 && !this[C] && !this[N].length && (this[g] = false)), i;
  }
  removeAllListeners(t) {
    let e = super.removeAllListeners(t);
    return (t === "data" || t === void 0) && (this[Rt] = 0, !this[C] && !this[N].length && (this[g] = false)), e;
  }
  get emittedEnd() {
    return this[nt];
  }
  [J]() {
    !this[De] && !this[nt] && !this[S] && this[b].length === 0 && this[Q] && (this[De] = true, this.emit("end"), this.emit("prefinish"), this.emit("finish"), this[Ne] && this.emit("close"), this[De] = false);
  }
  emit(t, ...e) {
    let i = e[0];
    if (t !== "error" && t !== "close" && t !== S && this[S]) return false;
    if (t === "data") return !this[L] && !i ? false : this[Z] ? (jt(() => this[Oi](i)), true) : this[Oi](i);
    if (t === "end") return this[Is]();
    if (t === "close") {
      if (this[Ne] = true, !this[nt] && !this[S]) return false;
      let n = super.emit("close");
      return this.removeAllListeners("close"), n;
    } else if (t === "error") {
      this[qt] = i, super.emit(_i, i);
      let n = !this[Jt] || this.listeners("error").length ? super.emit("error", i) : false;
      return this[J](), n;
    } else if (t === "resume") {
      let n = super.emit("resume");
      return this[J](), n;
    } else if (t === "finish" || t === "prefinish") {
      let n = super.emit(t);
      return this.removeAllListeners(t), n;
    }
    let r = super.emit(t, ...e);
    return this[J](), r;
  }
  [Oi](t) {
    for (let i of this[N]) i.dest.write(t) === false && this.pause();
    let e = this[C] ? false : super.emit("data", t);
    return this[J](), e;
  }
  [Is]() {
    return this[nt] ? false : (this[nt] = true, this.readable = false, this[Z] ? (jt(() => this[Ti]()), true) : this[Ti]());
  }
  [Ti]() {
    if (this[Mt]) {
      let e = this[Mt].end();
      if (e) {
        for (let i of this[N]) i.dest.write(e);
        this[C] || super.emit("data", e);
      }
    }
    for (let e of this[N]) e.end();
    let t = super.emit("end");
    return this.removeAllListeners("end"), t;
  }
  async collect() {
    let t = Object.assign([], { dataLength: 0 });
    this[L] || (t.dataLength = 0);
    let e = this.promise();
    return this.on("data", (i) => {
      t.push(i), this[L] || (t.dataLength += i.length);
    }), await e, t;
  }
  async concat() {
    if (this[L]) throw new Error("cannot concat in objectMode");
    let t = await this.collect();
    return this[z] ? t.join("") : Buffer.concat(t, t.dataLength);
  }
  async promise() {
    return new Promise((t, e) => {
      this.on(S, () => e(new Error("stream destroyed"))), this.on("error", (i) => e(i)), this.on("end", () => t());
    });
  }
  [Symbol.asyncIterator]() {
    this[C] = false;
    let t = false, e = async () => (this.pause(), t = true, { value: void 0, done: true });
    return { next: () => {
      if (t) return e();
      let r = this.read();
      if (r !== null) return Promise.resolve({ done: false, value: r });
      if (this[Q]) return e();
      let n, o, h = (d) => {
        this.off("data", a), this.off("end", l), this.off(S, c), e(), o(d);
      }, a = (d) => {
        this.off("error", h), this.off("end", l), this.off(S, c), this.pause(), n({ value: d, done: !!this[Q] });
      }, l = () => {
        this.off("error", h), this.off("data", a), this.off(S, c), e(), n({ done: true, value: void 0 });
      }, c = () => h(new Error("stream destroyed"));
      return new Promise((d, y) => {
        o = y, n = d, this.once(S, c), this.once("error", h), this.once("end", l), this.once("data", a);
      });
    }, throw: e, return: e, [Symbol.asyncIterator]() {
      return this;
    }, [Symbol.asyncDispose]: async () => {
    } };
  }
  [Symbol.iterator]() {
    this[C] = false;
    let t = false, e = () => (this.pause(), this.off(_i, e), this.off(S, e), this.off("end", e), t = true, { done: true, value: void 0 }), i = () => {
      if (t) return e();
      let r = this.read();
      return r === null ? e() : { done: false, value: r };
    };
    return this.once("end", e), this.once(_i, e), this.once(S, e), { next: i, throw: e, return: e, [Symbol.iterator]() {
      return this;
    }, [Symbol.dispose]: () => {
    } };
  }
  destroy(t) {
    if (this[S]) return t ? this.emit("error", t) : this.emit(S), this;
    this[S] = true, this[C] = true, this[b].length = 0, this[_] = 0;
    let e = this;
    return typeof e.close == "function" && !this[Ne] && e.close(), t ? this.emit("error", t) : this.emit(S), this;
  }
  static get isStream() {
    return Wr;
  }
};
var Jr = I.writev;
var ht = /* @__PURE__ */ Symbol("_autoClose");
var H = /* @__PURE__ */ Symbol("_close");
var te = /* @__PURE__ */ Symbol("_ended");
var m = /* @__PURE__ */ Symbol("_fd");
var Ni = /* @__PURE__ */ Symbol("_finished");
var tt = /* @__PURE__ */ Symbol("_flags");
var Ai = /* @__PURE__ */ Symbol("_flush");
var ki = /* @__PURE__ */ Symbol("_handleChunk");
var vi = /* @__PURE__ */ Symbol("_makeBuf");
var ie = /* @__PURE__ */ Symbol("_mode");
var ke = /* @__PURE__ */ Symbol("_needDrain");
var Ut = /* @__PURE__ */ Symbol("_onerror");
var Ht = /* @__PURE__ */ Symbol("_onopen");
var Ii = /* @__PURE__ */ Symbol("_onread");
var Pt = /* @__PURE__ */ Symbol("_onwrite");
var at = /* @__PURE__ */ Symbol("_open");
var U = /* @__PURE__ */ Symbol("_path");
var ot = /* @__PURE__ */ Symbol("_pos");
var Y = /* @__PURE__ */ Symbol("_queue");
var zt = /* @__PURE__ */ Symbol("_read");
var Ci = /* @__PURE__ */ Symbol("_readSize");
var j = /* @__PURE__ */ Symbol("_reading");
var ee = /* @__PURE__ */ Symbol("_remain");
var Fi = /* @__PURE__ */ Symbol("_size");
var ve = /* @__PURE__ */ Symbol("_write");
var gt = /* @__PURE__ */ Symbol("_writing");
var Me = /* @__PURE__ */ Symbol("_defaultFlag");
var bt = /* @__PURE__ */ Symbol("_errored");
var _t = class extends A {
  [bt] = false;
  [m];
  [U];
  [Ci];
  [j] = false;
  [Fi];
  [ee];
  [ht];
  constructor(t, e) {
    if (e = e || {}, super(e), this.readable = true, this.writable = false, typeof t != "string") throw new TypeError("path must be a string");
    this[bt] = false, this[m] = typeof e.fd == "number" ? e.fd : void 0, this[U] = t, this[Ci] = e.readSize || 16 * 1024 * 1024, this[j] = false, this[Fi] = typeof e.size == "number" ? e.size : 1 / 0, this[ee] = this[Fi], this[ht] = typeof e.autoClose == "boolean" ? e.autoClose : true, typeof this[m] == "number" ? this[zt]() : this[at]();
  }
  get fd() {
    return this[m];
  }
  get path() {
    return this[U];
  }
  write() {
    throw new TypeError("this is a readable stream");
  }
  end() {
    throw new TypeError("this is a readable stream");
  }
  [at]() {
    I.open(this[U], "r", (t, e) => this[Ht](t, e));
  }
  [Ht](t, e) {
    t ? this[Ut](t) : (this[m] = e, this.emit("open", e), this[zt]());
  }
  [vi]() {
    return Buffer.allocUnsafe(Math.min(this[Ci], this[ee]));
  }
  [zt]() {
    if (!this[j]) {
      this[j] = true;
      let t = this[vi]();
      if (t.length === 0) return process.nextTick(() => this[Ii](null, 0, t));
      I.read(this[m], t, 0, t.length, null, (e, i, r) => this[Ii](e, i, r));
    }
  }
  [Ii](t, e, i) {
    this[j] = false, t ? this[Ut](t) : this[ki](e, i) && this[zt]();
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = void 0, I.close(t, (e) => e ? this.emit("error", e) : this.emit("close"));
    }
  }
  [Ut](t) {
    this[j] = true, this[H](), this.emit("error", t);
  }
  [ki](t, e) {
    let i = false;
    return this[ee] -= t, t > 0 && (i = super.write(t < e.length ? e.subarray(0, t) : e)), (t === 0 || this[ee] <= 0) && (i = false, this[H](), super.end()), i;
  }
  emit(t, ...e) {
    switch (t) {
      case "prefinish":
      case "finish":
        return false;
      case "drain":
        return typeof this[m] == "number" && this[zt](), false;
      case "error":
        return this[bt] ? false : (this[bt] = true, super.emit(t, ...e));
      default:
        return super.emit(t, ...e);
    }
  }
};
var Be = class extends _t {
  [at]() {
    let t = true;
    try {
      this[Ht](null, I.openSync(this[U], "r")), t = false;
    } finally {
      t && this[H]();
    }
  }
  [zt]() {
    let t = true;
    try {
      if (!this[j]) {
        this[j] = true;
        do {
          let e = this[vi](), i = e.length === 0 ? 0 : I.readSync(this[m], e, 0, e.length, null);
          if (!this[ki](i, e)) break;
        } while (true);
        this[j] = false;
      }
      t = false;
    } finally {
      t && this[H]();
    }
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = void 0, I.closeSync(t), this.emit("close");
    }
  }
};
var et = class extends Qr {
  readable = false;
  writable = true;
  [bt] = false;
  [gt] = false;
  [te] = false;
  [Y] = [];
  [ke] = false;
  [U];
  [ie];
  [ht];
  [m];
  [Me];
  [tt];
  [Ni] = false;
  [ot];
  constructor(t, e) {
    e = e || {}, super(e), this[U] = t, this[m] = typeof e.fd == "number" ? e.fd : void 0, this[ie] = e.mode === void 0 ? 438 : e.mode, this[ot] = typeof e.start == "number" ? e.start : void 0, this[ht] = typeof e.autoClose == "boolean" ? e.autoClose : true;
    let i = this[ot] !== void 0 ? "r+" : "w";
    this[Me] = e.flags === void 0, this[tt] = e.flags === void 0 ? i : e.flags, this[m] === void 0 && this[at]();
  }
  emit(t, ...e) {
    if (t === "error") {
      if (this[bt]) return false;
      this[bt] = true;
    }
    return super.emit(t, ...e);
  }
  get fd() {
    return this[m];
  }
  get path() {
    return this[U];
  }
  [Ut](t) {
    this[H](), this[gt] = true, this.emit("error", t);
  }
  [at]() {
    I.open(this[U], this[tt], this[ie], (t, e) => this[Ht](t, e));
  }
  [Ht](t, e) {
    this[Me] && this[tt] === "r+" && t && t.code === "ENOENT" ? (this[tt] = "w", this[at]()) : t ? this[Ut](t) : (this[m] = e, this.emit("open", e), this[gt] || this[Ai]());
  }
  end(t, e) {
    return t && this.write(t, e), this[te] = true, !this[gt] && !this[Y].length && typeof this[m] == "number" && this[Pt](null, 0), this;
  }
  write(t, e) {
    return typeof t == "string" && (t = Buffer.from(t, e)), this[te] ? (this.emit("error", new Error("write() after end()")), false) : this[m] === void 0 || this[gt] || this[Y].length ? (this[Y].push(t), this[ke] = true, false) : (this[gt] = true, this[ve](t), true);
  }
  [ve](t) {
    I.write(this[m], t, 0, t.length, this[ot], (e, i) => this[Pt](e, i));
  }
  [Pt](t, e) {
    t ? this[Ut](t) : (this[ot] !== void 0 && typeof e == "number" && (this[ot] += e), this[Y].length ? this[Ai]() : (this[gt] = false, this[te] && !this[Ni] ? (this[Ni] = true, this[H](), this.emit("finish")) : this[ke] && (this[ke] = false, this.emit("drain"))));
  }
  [Ai]() {
    if (this[Y].length === 0) this[te] && this[Pt](null, 0);
    else if (this[Y].length === 1) this[ve](this[Y].pop());
    else {
      let t = this[Y];
      this[Y] = [], Jr(this[m], t, this[ot], (e, i) => this[Pt](e, i));
    }
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = void 0, I.close(t, (e) => e ? this.emit("error", e) : this.emit("close"));
    }
  }
};
var Wt = class extends et {
  [at]() {
    let t;
    if (this[Me] && this[tt] === "r+") try {
      t = I.openSync(this[U], this[tt], this[ie]);
    } catch (e) {
      if (e?.code === "ENOENT") return this[tt] = "w", this[at]();
      throw e;
    }
    else t = I.openSync(this[U], this[tt], this[ie]);
    this[Ht](null, t);
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = void 0, I.closeSync(t), this.emit("close");
    }
  }
  [ve](t) {
    let e = true;
    try {
      this[Pt](null, I.writeSync(this[m], t, 0, t.length, this[ot])), e = false;
    } finally {
      if (e) try {
        this[H]();
      } catch {
      }
    }
  }
};
var jr = /* @__PURE__ */ new Map([["C", "cwd"], ["f", "file"], ["z", "gzip"], ["P", "preservePaths"], ["U", "unlink"], ["strip-components", "strip"], ["stripComponents", "strip"], ["keep-newer", "newer"], ["keepNewer", "newer"], ["keep-newer-files", "newer"], ["keepNewerFiles", "newer"], ["k", "keep"], ["keep-existing", "keep"], ["keepExisting", "keep"], ["m", "noMtime"], ["no-mtime", "noMtime"], ["p", "preserveOwner"], ["L", "follow"], ["h", "follow"], ["onentry", "onReadEntry"]]);
var Fs = (s3) => !!s3.sync && !!s3.file;
var ks = (s3) => !s3.sync && !!s3.file;
var vs = (s3) => !!s3.sync && !s3.file;
var Ms = (s3) => !s3.sync && !s3.file;
var Bs = (s3) => !!s3.file;
var tn = (s3) => {
  let t = jr.get(s3);
  return t || s3;
};
var se = (s3 = {}) => {
  if (!s3) return {};
  let t = {};
  for (let [e, i] of Object.entries(s3)) {
    let r = tn(e);
    t[r] = i;
  }
  return t.chmod === void 0 && t.noChmod === false && (t.chmod = true), delete t.noChmod, t;
};
var K = (s3, t, e, i, r) => Object.assign((n = [], o, h) => {
  Array.isArray(n) && (o = n, n = {}), typeof o == "function" && (h = o, o = void 0), o = o ? Array.from(o) : [];
  let a = se(n);
  if (r?.(a, o), Fs(a)) {
    if (typeof h == "function") throw new TypeError("callback not supported for sync tar functions");
    return s3(a, o);
  } else if (ks(a)) {
    let l = t(a, o);
    return h ? l.then(() => h(), h) : l;
  } else if (vs(a)) {
    if (typeof h == "function") throw new TypeError("callback not supported for sync tar functions");
    return e(a, o);
  } else if (Ms(a)) {
    if (typeof h == "function") throw new TypeError("callback only supported with file option");
    return i(a, o);
  }
  throw new Error("impossible options??");
}, { syncFile: s3, asyncFile: t, syncNoFile: e, asyncNoFile: i, validate: r });
var sn = en.constants || { ZLIB_VERNUM: 4736 };
var M = Object.freeze(Object.assign(/* @__PURE__ */ Object.create(null), { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: 1 / 0, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1, BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30, BROTLI_DEFAULT_WINDOW: 22, BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24, BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_LGWIN: 2, BROTLI_PARAM_LGBLOCK: 3, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1, BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1, BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5, BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6, BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7, BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10, BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11, BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12, BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13, BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14, BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15, BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16, BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19, BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21, BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27, BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30, BROTLI_DECODER_ERROR_UNREACHABLE: -31 }, sn));
var rn = Ot.concat;
var zs = Object.getOwnPropertyDescriptor(Ot, "concat");
var nn = (s3) => s3;
var Bi = zs?.writable === true || zs?.set !== void 0 ? (s3) => {
  Ot.concat = s3 ? nn : rn;
} : (s3) => {
};
var Tt = /* @__PURE__ */ Symbol("_superWrite");
var Gt = class extends Error {
  code;
  errno;
  constructor(t, e) {
    super("zlib: " + t.message, { cause: t }), this.code = t.code, this.errno = t.errno, this.code || (this.code = "ZLIB_ERROR"), this.message = "zlib: " + t.message, Error.captureStackTrace(this, e ?? this.constructor);
  }
  get name() {
    return "ZlibError";
  }
};
var Pi = /* @__PURE__ */ Symbol("flushFlag");
var re = class extends A {
  #t = false;
  #i = false;
  #s;
  #n;
  #r;
  #e;
  #o;
  get sawError() {
    return this.#t;
  }
  get handle() {
    return this.#e;
  }
  get flushFlag() {
    return this.#s;
  }
  constructor(t, e) {
    if (!t || typeof t != "object") throw new TypeError("invalid options for ZlibBase constructor");
    if (super(t), this.#s = t.flush ?? 0, this.#n = t.finishFlush ?? 0, this.#r = t.fullFlushFlag ?? 0, typeof Ps[e] != "function") throw new TypeError("Compression method not supported: " + e);
    try {
      this.#e = new Ps[e](t);
    } catch (i) {
      throw new Gt(i, this.constructor);
    }
    this.#o = (i) => {
      this.#t || (this.#t = true, this.close(), this.emit("error", i));
    }, this.#e?.on("error", (i) => this.#o(new Gt(i))), this.once("end", () => this.close);
  }
  close() {
    this.#e && (this.#e.close(), this.#e = void 0, this.emit("close"));
  }
  reset() {
    if (!this.#t) return zi(this.#e, "zlib binding closed"), this.#e.reset?.();
  }
  flush(t) {
    this.ended || (typeof t != "number" && (t = this.#r), this.write(Object.assign(Ot.alloc(0), { [Pi]: t })));
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, e = void 0, t = void 0), typeof e == "function" && (i = e, e = void 0), t && (e ? this.write(t, e) : this.write(t)), this.flush(this.#n), this.#i = true, super.end(i);
  }
  get ended() {
    return this.#i;
  }
  [Tt](t) {
    return super.write(t);
  }
  write(t, e, i) {
    if (typeof e == "function" && (i = e, e = "utf8"), typeof t == "string" && (t = Ot.from(t, e)), this.#t) return;
    zi(this.#e, "zlib binding closed");
    let r = this.#e._handle, n = r.close;
    r.close = () => {
    };
    let o = this.#e.close;
    this.#e.close = () => {
    }, Bi(true);
    let h;
    try {
      let l = typeof t[Pi] == "number" ? t[Pi] : this.#s;
      h = this.#e._processChunk(t, l), Bi(false);
    } catch (l) {
      Bi(false), this.#o(new Gt(l, this.write));
    } finally {
      this.#e && (this.#e._handle = r, r.close = n, this.#e.close = o, this.#e.removeAllListeners("error"));
    }
    this.#e && this.#e.on("error", (l) => this.#o(new Gt(l, this.write)));
    let a;
    if (h) if (Array.isArray(h) && h.length > 0) {
      let l = h[0];
      a = this[Tt](Ot.from(l));
      for (let c = 1; c < h.length; c++) a = this[Tt](h[c]);
    } else a = this[Tt](Ot.from(h));
    return i && i(), a;
  }
};
var Pe = class extends re {
  #t;
  #i;
  constructor(t, e) {
    t = t || {}, t.flush = t.flush || M.Z_NO_FLUSH, t.finishFlush = t.finishFlush || M.Z_FINISH, t.fullFlushFlag = M.Z_FULL_FLUSH, super(t, e), this.#t = t.level, this.#i = t.strategy;
  }
  params(t, e) {
    if (!this.sawError) {
      if (!this.handle) throw new Error("cannot switch params when binding is closed");
      if (!this.handle.params) throw new Error("not supported in this implementation");
      if (this.#t !== t || this.#i !== e) {
        this.flush(M.Z_SYNC_FLUSH), zi(this.handle, "zlib binding closed");
        let i = this.handle.flush;
        this.handle.flush = (r, n) => {
          typeof r == "function" && (n = r, r = this.flushFlag), this.flush(r), n?.();
        };
        try {
          this.handle.params(t, e);
        } finally {
          this.handle.flush = i;
        }
        this.handle && (this.#t = t, this.#i = e);
      }
    }
  }
};
var ze = class extends Pe {
  #t;
  constructor(t) {
    super(t, "Gzip"), this.#t = t && !!t.portable;
  }
  [Tt](t) {
    return this.#t ? (this.#t = false, t[9] = 255, super[Tt](t)) : super[Tt](t);
  }
};
var Ue = class extends Pe {
  constructor(t) {
    super(t, "Unzip");
  }
};
var He = class extends re {
  constructor(t, e) {
    t = t || {}, t.flush = t.flush || M.BROTLI_OPERATION_PROCESS, t.finishFlush = t.finishFlush || M.BROTLI_OPERATION_FINISH, t.fullFlushFlag = M.BROTLI_OPERATION_FLUSH, super(t, e);
  }
};
var We = class extends He {
  constructor(t) {
    super(t, "BrotliCompress");
  }
};
var Ge = class extends He {
  constructor(t) {
    super(t, "BrotliDecompress");
  }
};
var Ze = class extends re {
  constructor(t, e) {
    t = t || {}, t.flush = t.flush || M.ZSTD_e_continue, t.finishFlush = t.finishFlush || M.ZSTD_e_end, t.fullFlushFlag = M.ZSTD_e_flush, super(t, e);
  }
};
var Ye = class extends Ze {
  constructor(t) {
    super(t, "ZstdCompress");
  }
};
var Ke = class extends Ze {
  constructor(t) {
    super(t, "ZstdDecompress");
  }
};
var Us = (s3, t) => {
  if (Number.isSafeInteger(s3)) s3 < 0 ? an(s3, t) : hn(s3, t);
  else throw Error("cannot encode number outside of javascript safe integer range");
  return t;
};
var hn = (s3, t) => {
  t[0] = 128;
  for (var e = t.length; e > 1; e--) t[e - 1] = s3 & 255, s3 = Math.floor(s3 / 256);
};
var an = (s3, t) => {
  t[0] = 255;
  var e = false;
  s3 = s3 * -1;
  for (var i = t.length; i > 1; i--) {
    var r = s3 & 255;
    s3 = Math.floor(s3 / 256), e ? t[i - 1] = Ws(r) : r === 0 ? t[i - 1] = 0 : (e = true, t[i - 1] = Gs(r));
  }
};
var Hs = (s3) => {
  let t = s3[0], e = t === 128 ? cn(s3.subarray(1, s3.length)) : t === 255 ? ln(s3) : null;
  if (e === null) throw Error("invalid base256 encoding");
  if (!Number.isSafeInteger(e)) throw Error("parsed number outside of javascript safe integer range");
  return e;
};
var ln = (s3) => {
  for (var t = s3.length, e = 0, i = false, r = t - 1; r > -1; r--) {
    var n = Number(s3[r]), o;
    i ? o = Ws(n) : n === 0 ? o = n : (i = true, o = Gs(n)), o !== 0 && (e -= o * Math.pow(256, t - r - 1));
  }
  return e;
};
var cn = (s3) => {
  for (var t = s3.length, e = 0, i = t - 1; i > -1; i--) {
    var r = Number(s3[i]);
    r !== 0 && (e += r * Math.pow(256, t - i - 1));
  }
  return e;
};
var Ws = (s3) => (255 ^ s3) & 255;
var Gs = (s3) => (255 ^ s3) + 1 & 255;
var Hi = {};
Ur(Hi, { code: () => Ve, isCode: () => ne, isName: () => dn, name: () => oe, normalFsTypes: () => Ui });
var ne = (s3) => oe.has(s3);
var dn = (s3) => Ve.has(s3);
var Ui = /* @__PURE__ */ new Set(["0", "", "1", "2", "3", "4", "5", "6", "7", "D"]);
var oe = /* @__PURE__ */ new Map([["0", "File"], ["", "OldFile"], ["1", "Link"], ["2", "SymbolicLink"], ["3", "CharacterDevice"], ["4", "BlockDevice"], ["5", "Directory"], ["6", "FIFO"], ["7", "ContiguousFile"], ["g", "GlobalExtendedHeader"], ["x", "ExtendedHeader"], ["A", "SolarisACL"], ["D", "GNUDumpDir"], ["I", "Inode"], ["K", "NextFileHasLongLinkpath"], ["L", "NextFileHasLongPath"], ["M", "ContinuationFile"], ["N", "OldGnuLongPath"], ["S", "SparseFile"], ["V", "TapeVolumeHeader"], ["X", "OldExtendedHeader"]]);
var Ve = new Map(Array.from(oe).map((s3) => [s3[1], s3[0]]));
var un = (s3) => s3 === void 0 || s3 < 0 ? void 0 : s3;
var F = class {
  cksumValid = false;
  needPax = false;
  nullBlock = false;
  block;
  path;
  mode;
  uid;
  gid;
  size;
  cksum;
  #t = "Unsupported";
  linkpath;
  uname;
  gname;
  devmaj = 0;
  devmin = 0;
  atime;
  ctime;
  mtime;
  charset;
  comment;
  constructor(t, e = 0, i, r) {
    Buffer.isBuffer(t) ? this.decode(t, e || 0, i, r) : t && this.#i(t);
  }
  decode(t, e, i, r) {
    if (e || (e = 0), !t || !(t.length >= e + 512)) throw new Error("need 512 bytes for header");
    let n = xt(t, e + 156, 1), o = Ui.has(n), h = o ? i : void 0, a = o ? r : void 0;
    if (this.path = h?.path ?? xt(t, e, 100), this.mode = h?.mode ?? a?.mode ?? lt(t, e + 100, 8), this.uid = h?.uid ?? a?.uid ?? lt(t, e + 108, 8), this.gid = h?.gid ?? a?.gid ?? lt(t, e + 116, 8), this.size = un(h?.size ?? a?.size ?? lt(t, e + 124, 12)), this.mtime = h?.mtime ?? a?.mtime ?? Wi(t, e + 136, 12), this.cksum = lt(t, e + 148, 12), a && this.#i(a, true), h && this.#i(h), ne(n) && (this.#t = n || "0"), this.#t === "0" && this.path.slice(-1) === "/" && (this.#t = "5"), this.#t === "5" && (this.size = 0), this.linkpath = xt(t, e + 157, 100), t.subarray(e + 257, e + 265).toString() === "ustar\x0000") if (this.uname = h?.uname ?? a?.uname ?? xt(t, e + 265, 32), this.gname = h?.gname ?? a?.gname ?? xt(t, e + 297, 32), this.devmaj = h?.devmaj ?? a?.devmaj ?? lt(t, e + 329, 8) ?? 0, this.devmin = h?.devmin ?? a?.devmin ?? lt(t, e + 337, 8) ?? 0, t[e + 475] !== 0) {
      let c = xt(t, e + 345, 155);
      this.path = c + "/" + this.path;
    } else {
      let c = xt(t, e + 345, 130);
      c && (this.path = c + "/" + this.path), this.atime = i?.atime ?? r?.atime ?? Wi(t, e + 476, 12), this.ctime = i?.ctime ?? r?.ctime ?? Wi(t, e + 488, 12);
    }
    let l = 256;
    for (let c = e; c < e + 148; c++) l += t[c];
    for (let c = e + 156; c < e + 512; c++) l += t[c];
    this.cksumValid = l === this.cksum, this.cksum === void 0 && l === 256 && (this.nullBlock = true);
  }
  #i(t, e = false) {
    Object.assign(this, Object.fromEntries(Object.entries(t).filter(([i, r]) => !(r == null || i === "size" && Number(r) < 0 || i === "path" && e || i === "linkpath" && e || i === "global"))));
  }
  encode(t, e = 0) {
    if (t || (t = this.block = Buffer.alloc(512)), this.#t === "Unsupported" && (this.#t = "0"), !(t.length >= e + 512)) throw new Error("need 512 bytes for header");
    let i = this.ctime || this.atime ? 130 : 155, r = mn(this.path || "", i), n = r[0], o = r[1];
    this.needPax = !!r[2], this.needPax = Lt(t, e, 100, n) || this.needPax, this.needPax = ct(t, e + 100, 8, this.mode) || this.needPax, this.needPax = ct(t, e + 108, 8, this.uid) || this.needPax, this.needPax = ct(t, e + 116, 8, this.gid) || this.needPax, this.needPax = ct(t, e + 124, 12, this.size) || this.needPax, this.needPax = Gi(t, e + 136, 12, this.mtime) || this.needPax, t[e + 156] = Number(this.#t.codePointAt(0)), this.needPax = Lt(t, e + 157, 100, this.linkpath) || this.needPax, t.write("ustar\x0000", e + 257, 8), this.needPax = Lt(t, e + 265, 32, this.uname) || this.needPax, this.needPax = Lt(t, e + 297, 32, this.gname) || this.needPax, this.needPax = ct(t, e + 329, 8, this.devmaj) || this.needPax, this.needPax = ct(t, e + 337, 8, this.devmin) || this.needPax, this.needPax = Lt(t, e + 345, i, o) || this.needPax, t[e + 475] !== 0 ? this.needPax = Lt(t, e + 345, 155, o) || this.needPax : (this.needPax = Lt(t, e + 345, 130, o) || this.needPax, this.needPax = Gi(t, e + 476, 12, this.atime) || this.needPax, this.needPax = Gi(t, e + 488, 12, this.ctime) || this.needPax);
    let h = 256;
    for (let a = e; a < e + 148; a++) h += t[a];
    for (let a = e + 156; a < e + 512; a++) h += t[a];
    return this.cksum = h, ct(t, e + 148, 8, this.cksum), this.cksumValid = true, this.needPax;
  }
  get type() {
    return this.#t === "Unsupported" ? this.#t : oe.get(this.#t);
  }
  get typeKey() {
    return this.#t;
  }
  set type(t) {
    let e = String(Ve.get(t));
    if (ne(e) || e === "Unsupported") this.#t = e;
    else if (ne(t)) this.#t = t;
    else throw new TypeError("invalid entry type: " + t);
  }
};
var mn = (s3, t) => {
  let i = s3, r = "", n, o = Zt.parse(s3).root || ".";
  if (Buffer.byteLength(i) < 100) n = [i, r, false];
  else {
    r = Zt.dirname(i), i = Zt.basename(i);
    do
      Buffer.byteLength(i) <= 100 && Buffer.byteLength(r) <= t ? n = [i, r, false] : Buffer.byteLength(i) > 100 && Buffer.byteLength(r) <= t ? n = [i.slice(0, 99), r, true] : (i = Zt.join(Zt.basename(r), i), r = Zt.dirname(r));
    while (r !== o && n === void 0);
    n || (n = [s3.slice(0, 99), "", true]);
  }
  return n;
};
var xt = (s3, t, e) => s3.subarray(t, t + e).toString("utf8").replace(/\0.*/, "");
var Wi = (s3, t, e) => pn(lt(s3, t, e));
var pn = (s3) => s3 === void 0 ? void 0 : new Date(s3 * 1e3);
var lt = (s3, t, e) => Number(s3[t]) & 128 ? Hs(s3.subarray(t, t + e)) : wn(s3, t, e);
var En = (s3) => isNaN(s3) ? void 0 : s3;
var wn = (s3, t, e) => En(parseInt(s3.subarray(t, t + e).toString("utf8").replace(/\0.*$/, "").trim(), 8));
var Sn = { 12: 8589934591, 8: 2097151 };
var ct = (s3, t, e, i) => i === void 0 ? false : i > Sn[e] || i < 0 ? (Us(i, s3.subarray(t, t + e)), true) : (yn(s3, t, e, i), false);
var yn = (s3, t, e, i) => s3.write(Rn(i, e), t, e, "ascii");
var Rn = (s3, t) => gn(Math.floor(s3).toString(8), t);
var gn = (s3, t) => (s3.length === t - 1 ? s3 : new Array(t - s3.length - 1).join("0") + s3 + " ") + "\0";
var Gi = (s3, t, e, i) => i === void 0 ? false : ct(s3, t, e, i.getTime() / 1e3);
var bn = new Array(156).join("\0");
var Lt = (s3, t, e, i) => i === void 0 ? false : (s3.write(i + bn, t, e, "utf8"), i.length !== Buffer.byteLength(i) || i.length > e);
var ft = class s {
  atime;
  mtime;
  ctime;
  charset;
  comment;
  gid;
  uid;
  gname;
  uname;
  linkpath;
  dev;
  ino;
  nlink;
  path;
  size;
  mode;
  global;
  constructor(t, e = false) {
    this.atime = t.atime, this.charset = t.charset, this.comment = t.comment, this.ctime = t.ctime, this.dev = t.dev, this.gid = t.gid, this.global = e, this.gname = t.gname, this.ino = t.ino, this.linkpath = t.linkpath, this.mtime = t.mtime, this.nlink = t.nlink, this.path = t.path, this.size = t.size, this.uid = t.uid, this.uname = t.uname;
  }
  encode() {
    let t = this.encodeBody();
    if (t === "") return Buffer.allocUnsafe(0);
    let e = Buffer.byteLength(t), i = 512 * Math.ceil(1 + e / 512), r = Buffer.allocUnsafe(i);
    for (let n = 0; n < 512; n++) r[n] = 0;
    new F({ path: ("PaxHeader/" + _n(this.path ?? "")).slice(0, 99), mode: this.mode || 420, uid: this.uid, gid: this.gid, size: e, mtime: this.mtime, type: this.global ? "GlobalExtendedHeader" : "ExtendedHeader", linkpath: "", uname: this.uname || "", gname: this.gname || "", devmaj: 0, devmin: 0, atime: this.atime, ctime: this.ctime }).encode(r), r.write(t, 512, e, "utf8");
    for (let n = e + 512; n < r.length; n++) r[n] = 0;
    return r;
  }
  encodeBody() {
    return this.encodeField("path") + this.encodeField("ctime") + this.encodeField("atime") + this.encodeField("dev") + this.encodeField("ino") + this.encodeField("nlink") + this.encodeField("charset") + this.encodeField("comment") + this.encodeField("gid") + this.encodeField("gname") + this.encodeField("linkpath") + this.encodeField("mtime") + this.encodeField("size") + this.encodeField("uid") + this.encodeField("uname");
  }
  encodeField(t) {
    if (this[t] === void 0) return "";
    let e = this[t], i = e instanceof Date ? e.getTime() / 1e3 : e, r = " " + (t === "dev" || t === "ino" || t === "nlink" ? "SCHILY." : "") + t + "=" + i + `
`, n = Buffer.byteLength(r), o = Math.floor(Math.log(n) / Math.log(10)) + 1;
    return n + o >= Math.pow(10, o) && (o += 1), o + n + r;
  }
  static parse(t, e, i = false) {
    return new s(On(Tn(t), e), i);
  }
};
var On = (s3, t) => t ? Object.assign({}, t, s3) : s3;
var Tn = (s3) => s3.replace(/\n$/, "").split(`
`).reduce(xn, /* @__PURE__ */ Object.create(null));
var xn = (s3, t) => {
  let e = parseInt(t, 10);
  if (e !== Buffer.byteLength(t) + 1) return s3;
  t = t.slice((e + " ").length);
  let i = t.split("="), r = i.shift();
  if (!r) return s3;
  let n = r.replace(/^SCHILY\.(dev|ino|nlink)/, "$1"), o = i.join("=").replace(/\0.*/, "");
  switch (n) {
    case "path":
    case "linkpath":
    case "type":
    case "charset":
    case "comment":
    case "gname":
    case "uname":
      s3[n] = o;
      break;
    case "ctime":
    case "atime":
    case "mtime":
      s3[n] = new Date(Number(o) * 1e3);
      break;
    case "size":
      let h = +o;
      h >= 0 && (s3[n] = h);
      break;
    case "gid":
    case "uid":
    case "dev":
    case "ino":
    case "nlink":
    case "mode":
      s3[n] = +o;
      break;
  }
  return s3;
};
var Ln = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
var f = Ln !== "win32" ? (s3) => String(s3) : (s3) => String(s3).replaceAll(/\\/g, "/");
var $e = class extends A {
  extended;
  globalExtended;
  header;
  startBlockSize;
  blockRemain;
  remain;
  type;
  meta = false;
  ignore = false;
  path;
  mode;
  uid;
  gid;
  uname;
  gname;
  size = 0;
  mtime;
  atime;
  ctime;
  linkpath;
  dev;
  ino;
  nlink;
  invalid = false;
  absolute;
  unsupported = false;
  constructor(t, e, i) {
    switch (super({}), this.pause(), this.extended = e, this.globalExtended = i, this.header = t, this.remain = t.size ?? 0, this.startBlockSize = 512 * Math.ceil(this.remain / 512), this.blockRemain = this.startBlockSize, this.type = t.type, this.type) {
      case "File":
      case "OldFile":
      case "Link":
      case "SymbolicLink":
      case "CharacterDevice":
      case "BlockDevice":
      case "Directory":
      case "FIFO":
      case "ContiguousFile":
      case "GNUDumpDir":
        break;
      case "NextFileHasLongLinkpath":
      case "NextFileHasLongPath":
      case "OldGnuLongPath":
      case "GlobalExtendedHeader":
      case "ExtendedHeader":
      case "OldExtendedHeader":
        this.meta = true;
        break;
      default:
        this.ignore = true;
    }
    if (!t.path) throw new Error("no path provided for tar.ReadEntry");
    this.path = f(t.path), this.mode = t.mode, this.mode && (this.mode = this.mode & 4095), this.uid = t.uid, this.gid = t.gid, this.uname = t.uname, this.gname = t.gname, this.size = this.remain, this.mtime = t.mtime, this.atime = t.atime, this.ctime = t.ctime, this.linkpath = t.linkpath ? f(t.linkpath) : void 0, this.uname = t.uname, this.gname = t.gname, e && this.#t(e), i && this.#t(i, true);
  }
  write(t) {
    let e = t.length;
    if (e > this.blockRemain) throw new Error("writing more to entry than is appropriate");
    let i = this.remain, r = this.blockRemain;
    return this.remain = Math.max(0, i - e), this.blockRemain = Math.max(0, r - e), this.ignore ? true : i >= e ? super.write(t) : super.write(t.subarray(0, i));
  }
  #t(t, e = false) {
    t.path && (t.path = f(t.path)), t.linkpath && (t.linkpath = f(t.linkpath)), Object.assign(this, Object.fromEntries(Object.entries(t).filter(([i, r]) => !(r == null || i === "path" && e))));
  }
};
var Dt = (s3, t, e, i = {}) => {
  s3.file && (i.file = s3.file), s3.cwd && (i.cwd = s3.cwd), i.code = e instanceof Error && e.code || t, i.tarCode = t, !s3.strict && i.recoverable !== false ? (e instanceof Error && (i = Object.assign(e, i), e = e.message), s3.emit("warn", t, e, i)) : e instanceof Error ? s3.emit("error", Object.assign(e, i)) : s3.emit("error", Object.assign(new Error(`${t}: ${e}`), i));
};
var Nn = 1024 * 1024;
var Xi = Buffer.from([31, 139]);
var qi = Buffer.from([40, 181, 47, 253]);
var An = Math.max(Xi.length, qi.length);
var B = /* @__PURE__ */ Symbol("state");
var Nt = /* @__PURE__ */ Symbol("writeEntry");
var it = /* @__PURE__ */ Symbol("readEntry");
var Zi = /* @__PURE__ */ Symbol("nextEntry");
var Zs = /* @__PURE__ */ Symbol("processEntry");
var V = /* @__PURE__ */ Symbol("extendedHeader");
var he = /* @__PURE__ */ Symbol("globalExtendedHeader");
var dt = /* @__PURE__ */ Symbol("meta");
var Ys = /* @__PURE__ */ Symbol("emitMeta");
var p = /* @__PURE__ */ Symbol("buffer");
var st = /* @__PURE__ */ Symbol("queue");
var ut = /* @__PURE__ */ Symbol("ended");
var Yi = /* @__PURE__ */ Symbol("emittedEnd");
var At = /* @__PURE__ */ Symbol("emit");
var w = /* @__PURE__ */ Symbol("unzip");
var Xe = /* @__PURE__ */ Symbol("consumeChunk");
var qe = /* @__PURE__ */ Symbol("consumeChunkSub");
var Ki = /* @__PURE__ */ Symbol("consumeBody");
var Ks = /* @__PURE__ */ Symbol("consumeMeta");
var Vs = /* @__PURE__ */ Symbol("consumeHeader");
var ae = /* @__PURE__ */ Symbol("consuming");
var Vi = /* @__PURE__ */ Symbol("bufferConcat");
var Qe = /* @__PURE__ */ Symbol("maybeEnd");
var Yt = /* @__PURE__ */ Symbol("writing");
var $ = /* @__PURE__ */ Symbol("aborted");
var Je = /* @__PURE__ */ Symbol("onDone");
var It = /* @__PURE__ */ Symbol("sawValidEntry");
var je = /* @__PURE__ */ Symbol("sawNullBlock");
var ti = /* @__PURE__ */ Symbol("sawEOF");
var $s = /* @__PURE__ */ Symbol("closeStream");
var In = 1e3;
var le = /* @__PURE__ */ Symbol("compressedBytesRead");
var $i = /* @__PURE__ */ Symbol("decompressedBytesRead");
var Xs = /* @__PURE__ */ Symbol("checkDecompressionRatio");
var Cn = () => true;
var rt = class extends Dn {
  file;
  strict;
  maxMetaEntrySize;
  filter;
  brotli;
  zstd;
  maxDecompressionRatio;
  writable = true;
  readable = false;
  [st] = [];
  [p];
  [it];
  [Nt];
  [B] = "begin";
  [dt] = "";
  [V];
  [he];
  [ut] = false;
  [w];
  [$] = false;
  [It];
  [je] = false;
  [ti] = false;
  [Yt] = false;
  [ae] = false;
  [Yi] = false;
  [le] = 0;
  [$i] = 0;
  constructor(t = {}) {
    super(), this.file = t.file || "", this.on(Je, () => {
      (this[B] === "begin" || this[It] === false) && this.warn("TAR_BAD_ARCHIVE", "Unrecognized archive format");
    }), t.ondone ? this.on(Je, t.ondone) : this.on(Je, () => {
      this.emit("prefinish"), this.emit("finish"), this.emit("end");
    }), this.strict = !!t.strict, this.maxDecompressionRatio = typeof t.maxDecompressionRatio == "number" ? t.maxDecompressionRatio : In, this.maxMetaEntrySize = t.maxMetaEntrySize || Nn, this.filter = typeof t.filter == "function" ? t.filter : Cn;
    let e = t.file && (t.file.endsWith(".tar.br") || t.file.endsWith(".tbr"));
    this.brotli = !(t.gzip || t.zstd) && t.brotli !== void 0 ? t.brotli : e ? void 0 : false;
    let i = t.file && (t.file.endsWith(".tar.zst") || t.file.endsWith(".tzst"));
    this.zstd = !(t.gzip || t.brotli) && t.zstd !== void 0 ? t.zstd : i ? true : void 0, this.on("end", () => this[$s]()), typeof t.onwarn == "function" && this.on("warn", t.onwarn), typeof t.onReadEntry == "function" && this.on("entry", t.onReadEntry);
  }
  warn(t, e, i = {}) {
    Dt(this, t, e, i);
  }
  [Vs](t, e) {
    this[It] === void 0 && (this[It] = false);
    let i;
    try {
      i = new F(t, e, this[V], this[he]);
    } catch (r) {
      return this.warn("TAR_ENTRY_INVALID", r);
    }
    if (i.nullBlock) this[je] ? (this[ti] = true, this[B] === "begin" && (this[B] = "header"), this[At]("eof")) : (this[je] = true, this[At]("nullBlock"));
    else if (this[je] = false, !i.cksumValid) this.warn("TAR_ENTRY_INVALID", "checksum failure", { header: i });
    else if (!i.path) this.warn("TAR_ENTRY_INVALID", "path is required", { header: i });
    else {
      let r = i.type;
      if (/^(Symbolic)?Link$/.test(r) && !i.linkpath) this.warn("TAR_ENTRY_INVALID", "linkpath required", { header: i });
      else if (!/^(Symbolic)?Link$/.test(r) && !/^(Global)?ExtendedHeader$/.test(r) && i.linkpath) this.warn("TAR_ENTRY_INVALID", "linkpath forbidden", { header: i });
      else {
        let n = this[Nt] = new $e(i, this[V], this[he]);
        if (!this[It]) if (n.remain) {
          let o = () => {
            n.invalid || (this[It] = true);
          };
          n.on("end", o);
        } else this[It] = true;
        n.meta ? n.size > this.maxMetaEntrySize ? (n.ignore = true, this[At]("ignoredEntry", n), this[B] = "ignore", n.resume()) : n.size > 0 && (this[dt] = "", n.on("data", (o) => this[dt] += o), this[B] = "meta") : (this[V] = void 0, n.ignore = n.ignore || !this.filter(n.path, n), n.ignore ? (this[At]("ignoredEntry", n), this[B] = n.remain ? "ignore" : "header", n.resume()) : (n.remain ? this[B] = "body" : (this[B] = "header", n.end()), this[it] ? this[st].push(n) : (this[st].push(n), this[Zi]())));
      }
    }
  }
  [$s]() {
    queueMicrotask(() => this.emit("close"));
  }
  [Zs](t) {
    let e = true;
    if (!t) this[it] = void 0, e = false;
    else if (Array.isArray(t)) {
      let [i, ...r] = t;
      this.emit(i, ...r);
    } else this[it] = t, this.emit("entry", t), t.emittedEnd || (t.on("end", () => this[Zi]()), e = false);
    return e;
  }
  [Zi]() {
    do
      ;
    while (this[Zs](this[st].shift()));
    if (this[st].length === 0) {
      let t = this[it];
      !t || t.flowing || t.size === t.remain ? this[Yt] || this.emit("drain") : t.once("drain", () => this.emit("drain"));
    }
  }
  [Ki](t, e) {
    let i = this[Nt];
    if (!i) throw new Error("attempt to consume body without entry??");
    let r = i.blockRemain ?? 0, n = r >= t.length && e === 0 ? t : t.subarray(e, e + r);
    return i.write(n), i.blockRemain || (this[B] = "header", this[Nt] = void 0, i.end()), n.length;
  }
  [Ks](t, e) {
    let i = this[Nt], r = this[Ki](t, e);
    return !this[Nt] && i && this[Ys](i), r;
  }
  [At](t, e, i) {
    this[st].length === 0 && !this[it] ? this.emit(t, e, i) : this[st].push([t, e, i]);
  }
  [Ys](t) {
    switch (this[At]("meta", this[dt]), t.type) {
      case "ExtendedHeader":
      case "OldExtendedHeader":
        this[V] = ft.parse(this[dt], this[V], false);
        break;
      case "GlobalExtendedHeader":
        this[he] = ft.parse(this[dt], this[he], true);
        break;
      case "NextFileHasLongPath":
      case "OldGnuLongPath": {
        let e = this[V] ?? /* @__PURE__ */ Object.create(null);
        this[V] = e, e.path = this[dt].replace(/\0.*/, "");
        break;
      }
      case "NextFileHasLongLinkpath": {
        let e = this[V] || /* @__PURE__ */ Object.create(null);
        this[V] = e, e.linkpath = this[dt].replace(/\0.*/, "");
        break;
      }
      default:
        throw new Error("unknown meta: " + t.type);
    }
  }
  abort(t) {
    if (!this[$]) {
      if (this[w]) {
        let e = this[w];
        e.write = () => true, e.end = () => e, e.emit = () => false, e.destroy?.();
      }
      this[$] = true, this.emit("abort", t), this.warn("TAR_ABORT", t, { recoverable: false });
    }
  }
  [Xs](t) {
    this[$i] += t.length;
    let e = this[$i] / this[le];
    return e > this.maxDecompressionRatio ? (this.abort(new Error(`max decompression ratio exceeded: ${e.toFixed(2)} > ${this.maxDecompressionRatio}`)), false) : true;
  }
  write(t, e, i) {
    if (typeof e == "function" && (i = e, e = void 0), typeof t == "string" && (t = Buffer.from(t, typeof e == "string" ? e : "utf8")), this[$]) return i?.(), false;
    if ((this[w] === void 0 || this.brotli === void 0 && this[w] === false) && t) {
      if (this[p] && (t = Buffer.concat([this[p], t]), this[p] = void 0), t.length < An) return this[p] = t, i?.(), true;
      for (let a = 0; this[w] === void 0 && a < Xi.length; a++) t[a] !== Xi[a] && (this[w] = false);
      let o = false;
      if (this[w] === false && this.zstd !== false) {
        o = true;
        for (let a = 0; a < qi.length; a++) if (t[a] !== qi[a]) {
          o = false;
          break;
        }
      }
      let h = this.brotli === void 0 && !o;
      if (this[w] === false && h) if (t.length < 512) if (this[ut]) this.brotli = true;
      else return this[p] = t, i?.(), true;
      else try {
        new F(t.subarray(0, 512)), this.brotli = false;
      } catch {
        this.brotli = true;
      }
      if (this[w] === void 0 || this[w] === false && (this.brotli || o)) {
        let a = this[ut];
        this[ut] = false, this[w] = this[w] === void 0 ? new Ue({}) : o ? new Ke({}) : new Ge({}), this[w].on("data", (c) => {
          this[Xs](c) && this[Xe](c);
        }), this[w].on("error", (c) => {
          this[$] || this.abort(c);
        }), this[w].on("end", () => {
          this[ut] = true, this[Xe]();
        }), this[Yt] = true, this[le] += t.length;
        let l = !!this[w][a ? "end" : "write"](t);
        return this[Yt] = false, i?.(), l;
      }
    }
    this[Yt] = true, this[w] ? (this[le] += t.length, this[w].write(t)) : this[Xe](t), this[Yt] = false;
    let n = this[st].length > 0 ? false : this[it] ? this[it].flowing : true;
    return !n && this[st].length === 0 && this[it]?.once("drain", () => this.emit("drain")), i?.(), n;
  }
  [Vi](t) {
    t && !this[$] && (this[p] = this[p] ? Buffer.concat([this[p], t]) : t);
  }
  [Qe]() {
    if (this[ut] && !this[Yi] && !this[$] && !this[ae]) {
      this[Yi] = true;
      let t = this[Nt];
      if (t?.blockRemain) {
        let e = this[p] ? this[p].length : 0;
        this.warn("TAR_BAD_ARCHIVE", `Truncated input (needed ${t.blockRemain} more bytes, only ${e} available)`, { entry: t }), this[p] && t.write(this[p]), t.end();
      }
      this[At](Je);
    }
  }
  [Xe](t) {
    if (this[ae] && t) this[Vi](t);
    else if (!t && !this[p]) this[Qe]();
    else if (t) {
      if (this[ae] = true, this[p]) {
        this[Vi](t);
        let e = this[p];
        this[p] = void 0, this[qe](e);
      } else this[qe](t);
      for (; this[p] && this[p]?.length >= 512 && !this[$] && !this[ti]; ) {
        let e = this[p];
        this[p] = void 0, this[qe](e);
      }
      this[ae] = false;
    }
    (!this[p] || this[ut]) && this[Qe]();
  }
  [qe](t) {
    let e = 0, i = t.length;
    for (; e + 512 <= i && !this[$] && !this[ti]; ) switch (this[B]) {
      case "begin":
      case "header":
        this[Vs](t, e), e += 512;
        break;
      case "ignore":
      case "body":
        e += this[Ki](t, e);
        break;
      case "meta":
        e += this[Ks](t, e);
        break;
      default:
        throw new Error("invalid state: " + this[B]);
    }
    e < i && (this[p] = this[p] ? Buffer.concat([t.subarray(e), this[p]]) : t.subarray(e));
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, e = void 0, t = void 0), typeof e == "function" && (i = e, e = void 0), typeof t == "string" && (t = Buffer.from(t, e)), i && this.once("finish", i), this[$] || (this[w] ? (t && (this[le] += t.length, this[w].write(t)), this[w].end()) : (this[ut] = true, (this.brotli === void 0 || this.zstd === void 0) && (t = t || Buffer.alloc(0)), t && this.write(t), this[Qe]())), this;
  }
};
var mt = (s3) => {
  let t = s3.length - 1, e = -1;
  for (; t > -1 && s3.charAt(t) === "/"; ) e = t, t--;
  return e === -1 ? s3 : s3.slice(0, e);
};
var vn = (s3) => {
  let t = s3.onReadEntry;
  s3.onReadEntry = t ? (e) => {
    t(e), e.resume();
  } : (e) => e.resume();
};
var Qi = (s3, t) => {
  let e = new Map(t.map((o) => [mt(o), true])), i = s3.filter, r = 100, n = (o, h = "", a = 0) => {
    if (a >= r) return e.set(o, false), false;
    let l = h || kn(o).root || ".", c;
    if (o === l) c = false;
    else {
      let d = e.get(o);
      c = d !== void 0 ? d : n(Fn(o), l, a + 1);
    }
    return e.set(o, c), c;
  };
  s3.filter = i ? (o, h) => i(o, h) && n(mt(o)) : (o) => n(mt(o));
};
var Mn = (s3) => {
  let t = new rt(s3), e = s3.file, i;
  try {
    i = Kt.openSync(e, "r");
    let r = Kt.fstatSync(i), n = s3.maxReadSize || 16 * 1024 * 1024;
    if (r.size < n) {
      let o = Buffer.allocUnsafe(r.size), h = Kt.readSync(i, o, 0, r.size, 0);
      t.end(h === o.byteLength ? o : o.subarray(0, h));
    } else {
      let o = 0, h = Buffer.allocUnsafe(n);
      for (; o < r.size; ) {
        let a = Kt.readSync(i, h, 0, n, o);
        if (a === 0) break;
        o += a, t.write(h.subarray(0, a));
      }
      t.end();
    }
  } finally {
    if (typeof i == "number") try {
      Kt.closeSync(i);
    } catch {
    }
  }
};
var Bn = (s3, t) => {
  let e = new rt(s3), i = s3.maxReadSize || 16 * 1024 * 1024, r = s3.file;
  return new Promise((o, h) => {
    e.on("error", h), e.on("end", o), Kt.stat(r, (a, l) => {
      if (a) h(a);
      else {
        let c = new _t(r, { readSize: i, size: l.size });
        c.on("error", h), c.pipe(e);
      }
    });
  });
};
var Ct = K(Mn, Bn, (s3) => new rt(s3), (s3) => new rt(s3), (s3, t) => {
  t?.length && Qi(s3, t), s3.noResume || vn(s3);
});
var Ji = (s3, t, e) => (s3 &= 4095, e && (s3 = (s3 | 384) & -19), t && (s3 & 256 && (s3 |= 64), s3 & 32 && (s3 |= 8), s3 & 4 && (s3 |= 1)), s3);
var { isAbsolute: zn, parse: qs } = Pn;
var ce = (s3) => {
  let t = "", e = qs(s3);
  for (; zn(s3) || e.root; ) {
    let i = s3.charAt(0) === "/" && s3.slice(0, 4) !== "//?/" ? "/" : e.root;
    s3 = s3.slice(i.length), t += i, e = qs(s3);
  }
  return [t, s3];
};
var ei = ["|", "<", ">", "?", ":"];
var ji = ei.map((s3) => String.fromCodePoint(61440 + Number(s3.codePointAt(0))));
var Un = new Map(ei.map((s3, t) => [s3, ji[t]]));
var Hn = new Map(ji.map((s3, t) => [s3, ei[t]]));
var ts = (s3) => ei.reduce((t, e) => t.split(e).join(Un.get(e)), s3);
var Qs = (s3) => ji.reduce((t, e) => t.split(e).join(Hn.get(e)), s3);
var rr = (s3, t) => t ? (s3 = f(s3).replace(/^\.(\/|$)/, ""), mt(t) + "/" + s3) : f(s3);
var Wn = 16 * 1024 * 1024;
var tr = /* @__PURE__ */ Symbol("process");
var er = /* @__PURE__ */ Symbol("file");
var ir = /* @__PURE__ */ Symbol("directory");
var is = /* @__PURE__ */ Symbol("symlink");
var sr = /* @__PURE__ */ Symbol("hardlink");
var fe = /* @__PURE__ */ Symbol("header");
var ii = /* @__PURE__ */ Symbol("read");
var ss = /* @__PURE__ */ Symbol("lstat");
var si = /* @__PURE__ */ Symbol("onlstat");
var rs = /* @__PURE__ */ Symbol("onread");
var ns = /* @__PURE__ */ Symbol("onreadlink");
var os4 = /* @__PURE__ */ Symbol("openfile");
var hs = /* @__PURE__ */ Symbol("onopenfile");
var pt = /* @__PURE__ */ Symbol("close");
var ri = /* @__PURE__ */ Symbol("mode");
var as = /* @__PURE__ */ Symbol("awaitDrain");
var es = /* @__PURE__ */ Symbol("ondrain");
var q = /* @__PURE__ */ Symbol("prefix");
var de = class extends A {
  path;
  portable;
  myuid = process.getuid && process.getuid() || 0;
  myuser = process.env.USER || "";
  maxReadSize;
  linkCache;
  statCache;
  preservePaths;
  cwd;
  strict;
  mtime;
  noPax;
  noMtime;
  prefix;
  fd;
  blockLen = 0;
  blockRemain = 0;
  buf;
  pos = 0;
  remain = 0;
  length = 0;
  offset = 0;
  win32;
  absolute;
  header;
  type;
  linkpath;
  stat;
  onWriteEntry;
  #t = false;
  constructor(t, e = {}) {
    let i = se(e);
    super(), this.path = f(t), this.portable = !!i.portable, this.maxReadSize = i.maxReadSize || Wn, this.linkCache = i.linkCache || /* @__PURE__ */ new Map(), this.statCache = i.statCache || /* @__PURE__ */ new Map(), this.preservePaths = !!i.preservePaths, this.cwd = f(i.cwd || process.cwd()), this.strict = !!i.strict, this.noPax = !!i.noPax, this.noMtime = !!i.noMtime, this.mtime = i.mtime, this.prefix = i.prefix ? f(i.prefix) : void 0, this.onWriteEntry = i.onWriteEntry, typeof i.onwarn == "function" && this.on("warn", i.onwarn);
    let r = false;
    if (!this.preservePaths) {
      let [o, h] = ce(this.path);
      o && typeof h == "string" && (this.path = h, r = o);
    }
    this.win32 = !!i.win32 || process.platform === "win32", this.win32 && (this.path = Qs(this.path.replaceAll(/\\/g, "/")), t = t.replaceAll(/\\/g, "/")), this.absolute = f(i.absolute || js.resolve(this.cwd, t)), this.path === "" && (this.path = "./"), r && this.warn("TAR_ENTRY_INFO", `stripping ${r} from absolute path`, { entry: this, path: r + this.path });
    let n = this.statCache.get(this.absolute);
    n ? this[si](n) : this[ss]();
  }
  warn(t, e, i = {}) {
    return Dt(this, t, e, i);
  }
  emit(t, ...e) {
    return t === "error" && (this.#t = true), super.emit(t, ...e);
  }
  [ss]() {
    X.lstat(this.absolute, (t, e) => {
      if (t) return this.emit("error", t);
      this[si](e);
    });
  }
  [si](t) {
    this.statCache.set(this.absolute, t), this.stat = t, t.isFile() || (t.size = 0), this.type = Gn(t), this.emit("stat", t), this[tr]();
  }
  [tr]() {
    switch (this.type) {
      case "File":
        return this[er]();
      case "Directory":
        return this[ir]();
      case "SymbolicLink":
        return this[is]();
      default:
        return this.end();
    }
  }
  [ri](t) {
    return Ji(t, this.type === "Directory", this.portable);
  }
  [q](t) {
    return rr(t, this.prefix);
  }
  [fe]() {
    if (!this.stat) throw new Error("cannot write header before stat");
    this.type === "Directory" && this.portable && (this.noMtime = true), this.onWriteEntry?.(this), this.header = new F({ path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[q](this.linkpath) : this.linkpath, mode: this[ri](this.stat.mode), uid: this.portable ? void 0 : this.stat.uid, gid: this.portable ? void 0 : this.stat.gid, size: this.stat.size, mtime: this.noMtime ? void 0 : this.mtime || this.stat.mtime, type: this.type === "Unsupported" ? void 0 : this.type, uname: this.portable ? void 0 : this.stat.uid === this.myuid ? this.myuser : "", atime: this.portable ? void 0 : this.stat.atime, ctime: this.portable ? void 0 : this.stat.ctime }), this.header.encode() && !this.noPax && super.write(new ft({ atime: this.portable ? void 0 : this.header.atime, ctime: this.portable ? void 0 : this.header.ctime, gid: this.portable ? void 0 : this.header.gid, mtime: this.noMtime ? void 0 : this.mtime || this.header.mtime, path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[q](this.linkpath) : this.linkpath, size: this.header.size, uid: this.portable ? void 0 : this.header.uid, uname: this.portable ? void 0 : this.header.uname, dev: this.portable ? void 0 : this.stat.dev, ino: this.portable ? void 0 : this.stat.ino, nlink: this.portable ? void 0 : this.stat.nlink }).encode());
    let t = this.header?.block;
    if (!t) throw new Error("failed to encode header");
    super.write(t);
  }
  [ir]() {
    if (!this.stat) throw new Error("cannot create directory entry without stat");
    this.path.slice(-1) !== "/" && (this.path += "/"), this.stat.size = 0, this[fe](), this.end();
  }
  [is]() {
    X.readlink(this.absolute, (t, e) => {
      if (t) return this.emit("error", t);
      this[ns](e);
    });
  }
  [ns](t) {
    this.linkpath = f(t), this[fe](), this.end();
  }
  [sr](t) {
    if (!this.stat) throw new Error("cannot create link entry without stat");
    this.type = "Link", this.linkpath = f(js.relative(this.cwd, t)), this.stat.size = 0, this[fe](), this.end();
  }
  [er]() {
    if (!this.stat) throw new Error("cannot create file entry without stat");
    if (this.stat.nlink > 1) {
      let t = `${this.stat.dev}:${this.stat.ino}`, e = this.linkCache.get(t);
      if (e?.indexOf(this.cwd) === 0) return this[sr](e);
      this.linkCache.set(t, this.absolute);
    }
    if (this[fe](), this.stat.size === 0) return this.end();
    this[os4]();
  }
  [os4]() {
    X.open(this.absolute, "r", (t, e) => {
      if (t) return this.emit("error", t);
      this[hs](e);
    });
  }
  [hs](t) {
    if (this.fd = t, this.#t) return this[pt]();
    if (!this.stat) throw new Error("should stat before calling onopenfile");
    this.blockLen = 512 * Math.ceil(this.stat.size / 512), this.blockRemain = this.blockLen;
    let e = Math.min(this.blockLen, this.maxReadSize);
    this.buf = Buffer.allocUnsafe(e), this.offset = 0, this.pos = 0, this.remain = this.stat.size, this.length = this.buf.length, this[ii]();
  }
  [ii]() {
    let { fd: t, buf: e, offset: i, length: r, pos: n } = this;
    if (t === void 0 || e === void 0) throw new Error("cannot read file without first opening");
    X.read(t, e, i, r, n, (o, h) => {
      if (o) return this[pt](() => this.emit("error", o));
      this[rs](h);
    });
  }
  [pt](t = () => {
  }) {
    this.fd !== void 0 && X.close(this.fd, t);
  }
  [rs](t) {
    if (t <= 0 && this.remain > 0) {
      let r = Object.assign(new Error("encountered unexpected EOF"), { path: this.absolute, syscall: "read", code: "EOF" });
      return this[pt](() => this.emit("error", r));
    }
    if (t > this.remain) {
      let r = Object.assign(new Error("did not encounter expected EOF"), { path: this.absolute, syscall: "read", code: "EOF" });
      return this[pt](() => this.emit("error", r));
    }
    if (!this.buf) throw new Error("should have created buffer prior to reading");
    if (t === this.remain) for (let r = t; r < this.length && t < this.blockRemain; r++) this.buf[r + this.offset] = 0, t++, this.remain++;
    let e = this.offset === 0 && t === this.buf.length ? this.buf : this.buf.subarray(this.offset, this.offset + t);
    this.write(e) ? this[es]() : this[as](() => this[es]());
  }
  [as](t) {
    this.once("drain", t);
  }
  write(t, e, i) {
    if (typeof e == "function" && (i = e, e = void 0), typeof t == "string" && (t = Buffer.from(t, typeof e == "string" ? e : "utf8")), this.blockRemain < t.length) {
      let r = Object.assign(new Error("writing more data than expected"), { path: this.absolute });
      return this.emit("error", r);
    }
    return this.remain -= t.length, this.blockRemain -= t.length, this.pos += t.length, this.offset += t.length, super.write(t, null, i);
  }
  [es]() {
    if (!this.remain) return this.blockRemain && super.write(Buffer.alloc(this.blockRemain)), this[pt]((t) => t ? this.emit("error", t) : this.end());
    if (!this.buf) throw new Error("buffer lost somehow in ONDRAIN");
    this.offset >= this.length && (this.buf = Buffer.allocUnsafe(Math.min(this.blockRemain, this.buf.length)), this.offset = 0), this.length = this.buf.length - this.offset, this[ii]();
  }
};
var ni = class extends de {
  sync = true;
  [ss]() {
    this[si](X.lstatSync(this.absolute));
  }
  [is]() {
    this[ns](X.readlinkSync(this.absolute));
  }
  [os4]() {
    this[hs](X.openSync(this.absolute, "r"));
  }
  [ii]() {
    let t = true;
    try {
      let { fd: e, buf: i, offset: r, length: n, pos: o } = this;
      if (e === void 0 || i === void 0) throw new Error("fd and buf must be set in READ method");
      let h = X.readSync(e, i, r, n, o);
      this[rs](h), t = false;
    } finally {
      if (t) try {
        this[pt](() => {
        });
      } catch {
      }
    }
  }
  [as](t) {
    t();
  }
  [pt](t = () => {
  }) {
    this.fd !== void 0 && X.closeSync(this.fd), t();
  }
};
var oi = class extends A {
  blockLen = 0;
  blockRemain = 0;
  buf = 0;
  pos = 0;
  remain = 0;
  length = 0;
  preservePaths;
  portable;
  strict;
  noPax;
  noMtime;
  readEntry;
  type;
  prefix;
  path;
  mode;
  uid;
  gid;
  uname;
  gname;
  header;
  mtime;
  atime;
  ctime;
  linkpath;
  size;
  onWriteEntry;
  warn(t, e, i = {}) {
    return Dt(this, t, e, i);
  }
  constructor(t, e = {}) {
    let i = se(e);
    super(), this.preservePaths = !!i.preservePaths, this.portable = !!i.portable, this.strict = !!i.strict, this.noPax = !!i.noPax, this.noMtime = !!i.noMtime, this.onWriteEntry = i.onWriteEntry, this.readEntry = t;
    let { type: r } = t;
    if (r === "Unsupported") throw new Error("writing entry that should be ignored");
    this.type = r, this.type === "Directory" && this.portable && (this.noMtime = true), this.prefix = i.prefix, this.path = f(t.path), this.mode = t.mode !== void 0 ? this[ri](t.mode) : void 0, this.uid = this.portable ? void 0 : t.uid, this.gid = this.portable ? void 0 : t.gid, this.uname = this.portable ? void 0 : t.uname, this.gname = this.portable ? void 0 : t.gname, this.size = t.size, this.mtime = this.noMtime ? void 0 : i.mtime || t.mtime, this.atime = this.portable ? void 0 : t.atime, this.ctime = this.portable ? void 0 : t.ctime, this.linkpath = t.linkpath !== void 0 ? f(t.linkpath) : void 0, typeof i.onwarn == "function" && this.on("warn", i.onwarn);
    let n = false;
    if (!this.preservePaths) {
      let [h, a] = ce(this.path);
      h && typeof a == "string" && (this.path = a, n = h);
    }
    this.remain = t.size, this.blockRemain = t.startBlockSize, this.onWriteEntry?.(this), this.header = new F({ path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[q](this.linkpath) : this.linkpath, mode: this.mode, uid: this.portable ? void 0 : this.uid, gid: this.portable ? void 0 : this.gid, size: this.size, mtime: this.noMtime ? void 0 : this.mtime, type: this.type, uname: this.portable ? void 0 : this.uname, atime: this.portable ? void 0 : this.atime, ctime: this.portable ? void 0 : this.ctime }), n && this.warn("TAR_ENTRY_INFO", `stripping ${n} from absolute path`, { entry: this, path: n + this.path }), this.header.encode() && !this.noPax && super.write(new ft({ atime: this.portable ? void 0 : this.atime, ctime: this.portable ? void 0 : this.ctime, gid: this.portable ? void 0 : this.gid, mtime: this.noMtime ? void 0 : this.mtime, path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[q](this.linkpath) : this.linkpath, size: this.size, uid: this.portable ? void 0 : this.uid, uname: this.portable ? void 0 : this.uname, dev: this.portable ? void 0 : this.readEntry.dev, ino: this.portable ? void 0 : this.readEntry.ino, nlink: this.portable ? void 0 : this.readEntry.nlink }).encode());
    let o = this.header?.block;
    if (!o) throw new Error("failed to encode header");
    super.write(o), t.pipe(this);
  }
  [q](t) {
    return rr(t, this.prefix);
  }
  [ri](t) {
    return Ji(t, this.type === "Directory", this.portable);
  }
  write(t, e, i) {
    typeof e == "function" && (i = e, e = void 0), typeof t == "string" && (t = Buffer.from(t, typeof e == "string" ? e : "utf8"));
    let r = t.length;
    if (r > this.blockRemain) throw new Error("writing more to entry than is appropriate");
    return this.blockRemain -= r, super.write(t, i);
  }
  end(t, e, i) {
    return this.blockRemain && super.write(Buffer.alloc(this.blockRemain)), typeof t == "function" && (i = t, e = void 0, t = void 0), typeof e == "function" && (i = e, e = void 0), typeof t == "string" && (t = Buffer.from(t, e ?? "utf8")), i && this.once("finish", i), t ? super.end(t, i) : super.end(i), this;
  }
};
var Gn = (s3) => s3.isFile() ? "File" : s3.isDirectory() ? "Directory" : s3.isSymbolicLink() ? "SymbolicLink" : "Unsupported";
var hi = class s2 {
  tail;
  head;
  length = 0;
  static create(t = []) {
    return new s2(t);
  }
  constructor(t = []) {
    for (let e of t) this.push(e);
  }
  *[Symbol.iterator]() {
    for (let t = this.head; t; t = t.next) yield t.value;
  }
  removeNode(t) {
    if (t.list !== this) throw new Error("removing node which does not belong to this list");
    let e = t.next, i = t.prev;
    return e && (e.prev = i), i && (i.next = e), t === this.head && (this.head = e), t === this.tail && (this.tail = i), this.length--, t.next = void 0, t.prev = void 0, t.list = void 0, e;
  }
  unshiftNode(t) {
    if (t === this.head) return;
    t.list && t.list.removeNode(t);
    let e = this.head;
    t.list = this, t.next = e, e && (e.prev = t), this.head = t, this.tail || (this.tail = t), this.length++;
  }
  pushNode(t) {
    if (t === this.tail) return;
    t.list && t.list.removeNode(t);
    let e = this.tail;
    t.list = this, t.prev = e, e && (e.next = t), this.tail = t, this.head || (this.head = t), this.length++;
  }
  push(...t) {
    for (let e = 0, i = t.length; e < i; e++) Yn(this, t[e]);
    return this.length;
  }
  unshift(...t) {
    for (var e = 0, i = t.length; e < i; e++) Kn(this, t[e]);
    return this.length;
  }
  pop() {
    if (!this.tail) return;
    let t = this.tail.value, e = this.tail;
    return this.tail = this.tail.prev, this.tail ? this.tail.next = void 0 : this.head = void 0, e.list = void 0, this.length--, t;
  }
  shift() {
    if (!this.head) return;
    let t = this.head.value, e = this.head;
    return this.head = this.head.next, this.head ? this.head.prev = void 0 : this.tail = void 0, e.list = void 0, this.length--, t;
  }
  forEach(t, e) {
    e = e || this;
    for (let i = this.head, r = 0; i; r++) t.call(e, i.value, r, this), i = i.next;
  }
  forEachReverse(t, e) {
    e = e || this;
    for (let i = this.tail, r = this.length - 1; i; r--) t.call(e, i.value, r, this), i = i.prev;
  }
  get(t) {
    let e = 0, i = this.head;
    for (; i && e < t; e++) i = i.next;
    if (e === t && i) return i.value;
  }
  getReverse(t) {
    let e = 0, i = this.tail;
    for (; i && e < t; e++) i = i.prev;
    if (e === t && i) return i.value;
  }
  map(t, e) {
    e = e || this;
    let i = new s2();
    for (let r = this.head; r; ) i.push(t.call(e, r.value, this)), r = r.next;
    return i;
  }
  mapReverse(t, e) {
    e = e || this;
    var i = new s2();
    for (let r = this.tail; r; ) i.push(t.call(e, r.value, this)), r = r.prev;
    return i;
  }
  reduce(t, e) {
    let i, r = this.head;
    if (arguments.length > 1) i = e;
    else if (this.head) r = this.head.next, i = this.head.value;
    else throw new TypeError("Reduce of empty list with no initial value");
    for (var n = 0; r; n++) i = t(i, r.value, n), r = r.next;
    return i;
  }
  reduceReverse(t, e) {
    let i, r = this.tail;
    if (arguments.length > 1) i = e;
    else if (this.tail) r = this.tail.prev, i = this.tail.value;
    else throw new TypeError("Reduce of empty list with no initial value");
    for (let n = this.length - 1; r; n--) i = t(i, r.value, n), r = r.prev;
    return i;
  }
  toArray() {
    let t = new Array(this.length);
    for (let e = 0, i = this.head; i; e++) t[e] = i.value, i = i.next;
    return t;
  }
  toArrayReverse() {
    let t = new Array(this.length);
    for (let e = 0, i = this.tail; i; e++) t[e] = i.value, i = i.prev;
    return t;
  }
  slice(t = 0, e = this.length) {
    e < 0 && (e += this.length), t < 0 && (t += this.length);
    let i = new s2();
    if (e < t || e < 0) return i;
    t < 0 && (t = 0), e > this.length && (e = this.length);
    let r = this.head, n = 0;
    for (n = 0; r && n < t; n++) r = r.next;
    for (; r && n < e; n++, r = r.next) i.push(r.value);
    return i;
  }
  sliceReverse(t = 0, e = this.length) {
    e < 0 && (e += this.length), t < 0 && (t += this.length);
    let i = new s2();
    if (e < t || e < 0) return i;
    t < 0 && (t = 0), e > this.length && (e = this.length);
    let r = this.length, n = this.tail;
    for (; n && r > e; r--) n = n.prev;
    for (; n && r > t; r--, n = n.prev) i.push(n.value);
    return i;
  }
  splice(t, e = 0, ...i) {
    t > this.length && (t = this.length - 1), t < 0 && (t = this.length + t);
    let r = this.head;
    for (let o = 0; r && o < t; o++) r = r.next;
    let n = [];
    for (let o = 0; r && o < e; o++) n.push(r.value), r = this.removeNode(r);
    r ? r !== this.tail && (r = r.prev) : r = this.tail;
    for (let o of i) r = Zn(this, r, o);
    return n;
  }
  reverse() {
    let t = this.head, e = this.tail;
    for (let i = t; i; i = i.prev) {
      let r = i.prev;
      i.prev = i.next, i.next = r;
    }
    return this.head = e, this.tail = t, this;
  }
};
function Zn(s3, t, e) {
  let i = t, r = t ? t.next : s3.head, n = new ue(e, i, r, s3);
  return n.next === void 0 && (s3.tail = n), n.prev === void 0 && (s3.head = n), s3.length++, n;
}
function Yn(s3, t) {
  s3.tail = new ue(t, s3.tail, void 0, s3), s3.head || (s3.head = s3.tail), s3.length++;
}
function Kn(s3, t) {
  s3.head = new ue(t, void 0, s3.head, s3), s3.tail || (s3.tail = s3.head), s3.length++;
}
var ue = class {
  list;
  next;
  prev;
  value;
  constructor(t, e, i, r) {
    this.list = r, this.value = t, e ? (e.next = this, this.prev = e) : this.prev = void 0, i ? (i.prev = this, this.next = i) : this.next = void 0;
  }
};
var pi = class {
  path;
  absolute;
  entry;
  stat;
  readdir;
  pending = false;
  pendingLink = false;
  ignore = false;
  piped = false;
  constructor(t, e) {
    this.path = t || "./", this.absolute = e;
  }
};
var nr = Buffer.alloc(1024);
var li = /* @__PURE__ */ Symbol("onStat");
var me = /* @__PURE__ */ Symbol("ended");
var W = /* @__PURE__ */ Symbol("queue");
var pe = /* @__PURE__ */ Symbol("pendingLinks");
var Et = /* @__PURE__ */ Symbol("current");
var Ft = /* @__PURE__ */ Symbol("process");
var Ee = /* @__PURE__ */ Symbol("processing");
var ai = /* @__PURE__ */ Symbol("processJob");
var G = /* @__PURE__ */ Symbol("jobs");
var ls = /* @__PURE__ */ Symbol("jobDone");
var ci = /* @__PURE__ */ Symbol("addFSEntry");
var or = /* @__PURE__ */ Symbol("addTarEntry");
var ds = /* @__PURE__ */ Symbol("stat");
var us = /* @__PURE__ */ Symbol("readdir");
var fi = /* @__PURE__ */ Symbol("onreaddir");
var di = /* @__PURE__ */ Symbol("pipe");
var hr = /* @__PURE__ */ Symbol("entry");
var cs = /* @__PURE__ */ Symbol("entryOpt");
var ui = /* @__PURE__ */ Symbol("writeEntryClass");
var lr = /* @__PURE__ */ Symbol("write");
var fs8 = /* @__PURE__ */ Symbol("ondrain");
var wt = class extends A {
  sync = false;
  opt;
  cwd;
  maxReadSize;
  preservePaths;
  strict;
  noPax;
  prefix;
  linkCache;
  statCache;
  file;
  portable;
  zip;
  readdirCache;
  noDirRecurse;
  follow;
  noMtime;
  mtime;
  filter;
  jobs;
  [ui];
  onWriteEntry;
  [W];
  [pe] = /* @__PURE__ */ new Map();
  [G] = 0;
  [Ee] = false;
  [me] = false;
  constructor(t = {}) {
    if (super(), this.opt = t, this.file = t.file || "", this.cwd = t.cwd || process.cwd(), this.maxReadSize = t.maxReadSize, this.preservePaths = !!t.preservePaths, this.strict = !!t.strict, this.noPax = !!t.noPax, this.prefix = f(t.prefix || ""), this.linkCache = t.linkCache || /* @__PURE__ */ new Map(), this.statCache = t.statCache || /* @__PURE__ */ new Map(), this.readdirCache = t.readdirCache || /* @__PURE__ */ new Map(), this.onWriteEntry = t.onWriteEntry, this[ui] = de, typeof t.onwarn == "function" && this.on("warn", t.onwarn), this.portable = !!t.portable, t.gzip || t.brotli || t.zstd) {
      if ((t.gzip ? 1 : 0) + (t.brotli ? 1 : 0) + (t.zstd ? 1 : 0) > 1) throw new TypeError("gzip, brotli, zstd are mutually exclusive");
      if (t.gzip && (typeof t.gzip != "object" && (t.gzip = {}), this.portable && (t.gzip.portable = true), this.zip = new ze(t.gzip)), t.brotli && (typeof t.brotli != "object" && (t.brotli = {}), this.zip = new We(t.brotli)), t.zstd && (typeof t.zstd != "object" && (t.zstd = {}), this.zip = new Ye(t.zstd)), !this.zip) throw new Error("impossible");
      let e = this.zip;
      e.on("data", (i) => super.write(i)), e.on("end", () => super.end()), e.on("drain", () => this[fs8]()), this.on("resume", () => e.resume());
    } else this.on("drain", this[fs8]);
    this.noDirRecurse = !!t.noDirRecurse, this.follow = !!t.follow, this.noMtime = !!t.noMtime, t.mtime && (this.mtime = t.mtime), this.filter = typeof t.filter == "function" ? t.filter : () => true, this[W] = new hi(), this[G] = 0, this.jobs = Number(t.jobs) || 4, this[Ee] = false, this[me] = false;
  }
  [lr](t) {
    return super.write(t);
  }
  add(t) {
    return this.write(t), this;
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, t = void 0), typeof e == "function" && (i = e, e = void 0), t && this.add(t), this[me] = true, this[Ft](), i && i(), this;
  }
  write(t) {
    if (this[me]) throw new Error("write after end");
    return typeof t == "string" ? this[ci](t) : this[or](t), this.flowing;
  }
  [or](t) {
    let e = f(ar.resolve(this.cwd, t.path));
    if (!this.filter(t.path, t)) t.resume();
    else {
      let i = new pi(t.path, e);
      i.entry = new oi(t, this[cs](i)), i.entry.on("end", () => this[ls](i)), this[G] += 1, this[W].push(i);
    }
    this[Ft]();
  }
  [ci](t) {
    let e = f(ar.resolve(this.cwd, t));
    this[W].push(new pi(t, e)), this[Ft]();
  }
  [ds](t) {
    t.pending = true, this[G] += 1;
    let e = this.follow ? "stat" : "lstat";
    mi[e](t.absolute, (i, r) => {
      t.pending = false, this[G] -= 1, i ? this.emit("error", i) : this[li](t, r);
    });
  }
  [li](t, e) {
    if (this.statCache.set(t.absolute, e), t.stat = e, !this.filter(t.path, e)) t.ignore = true;
    else if (e.isFile() && e.nlink > 1 && !this.linkCache.get(`${e.dev}:${e.ino}`) && !this.sync) if (t === this[Et]) this[ai](t);
    else {
      let i = `${e.dev}:${e.ino}`, r = this[pe].get(i);
      r ? r.push(t) : this[pe].set(i, [t]), t.pendingLink = true, t.pending = true;
    }
    this[Ft]();
  }
  [us](t) {
    t.pending = true, this[G] += 1, mi.readdir(t.absolute, (e, i) => {
      if (t.pending = false, this[G] -= 1, e) return this.emit("error", e);
      this[fi](t, i);
    });
  }
  [fi](t, e) {
    this.readdirCache.set(t.absolute, e), t.readdir = e, this[Ft]();
  }
  [Ft]() {
    if (!this[Ee]) {
      this[Ee] = true;
      for (let t = this[W].head; t && this[G] < this.jobs; t = t.next) if (this[ai](t.value), t.value.ignore) {
        let e = t.next;
        this[W].removeNode(t), t.next = e;
      }
      this[Ee] = false, this[me] && this[W].length === 0 && this[G] === 0 && (this.zip ? this.zip.end(nr) : (super.write(nr), super.end()));
    }
  }
  get [Et]() {
    return this[W] && this[W].head && this[W].head.value;
  }
  [ls](t) {
    this[W].shift(), this[G] -= 1;
    let { stat: e } = t;
    if (e && e.isFile() && e.nlink > 1) {
      let i = `${e.dev}:${e.ino}`, r = this[pe].get(i);
      if (r) {
        this[pe].delete(i);
        for (let n of r) n.pending = false, this[ai](n);
      }
    }
    this[Ft]();
  }
  [ai](t) {
    if (t.pending && t.pendingLink && t === this[Et] && (t.pending = false, t.pendingLink = false), !t.pending) {
      if (t.entry) {
        t === this[Et] && !t.piped && this[di](t);
        return;
      }
      if (!t.stat) {
        let e = this.statCache.get(t.absolute);
        e ? this[li](t, e) : this[ds](t);
      }
      if (t.stat && !t.ignore) {
        if (!this.noDirRecurse && t.stat.isDirectory() && !t.readdir) {
          let e = this.readdirCache.get(t.absolute);
          if (e ? this[fi](t, e) : this[us](t), !t.readdir) return;
        }
        if (t.entry = this[hr](t), !t.entry) {
          t.ignore = true;
          return;
        }
        t === this[Et] && !t.piped && this[di](t);
      }
    }
  }
  [cs](t) {
    return { onwarn: (e, i, r) => this.warn(e, i, r), noPax: this.noPax, cwd: this.cwd, absolute: t.absolute, preservePaths: this.preservePaths, maxReadSize: this.maxReadSize, strict: this.strict, portable: this.portable, linkCache: this.linkCache, statCache: this.statCache, noMtime: this.noMtime, mtime: this.mtime, prefix: this.prefix, onWriteEntry: this.onWriteEntry };
  }
  [hr](t) {
    this[G] += 1;
    try {
      return new this[ui](t.path, this[cs](t)).on("end", () => this[ls](t)).on("error", (i) => this.emit("error", i));
    } catch (e) {
      this.emit("error", e);
    }
  }
  [fs8]() {
    this[Et] && this[Et].entry && this[Et].entry.resume();
  }
  [di](t) {
    t.piped = true, t.readdir && t.readdir.forEach((r) => {
      let n = t.path, o = n === "./" ? "" : n.replace(/\/*$/, "/");
      this[ci](o + r);
    });
    let e = t.entry, i = this.zip;
    if (!e) throw new Error("cannot pipe without source");
    i ? e.on("data", (r) => {
      i.write(r) || e.pause();
    }) : e.on("data", (r) => {
      super.write(r) || e.pause();
    });
  }
  pause() {
    return this.zip && this.zip.pause(), super.pause();
  }
  warn(t, e, i = {}) {
    Dt(this, t, e, i);
  }
};
var kt = class extends wt {
  sync = true;
  constructor(t) {
    super(t), this[ui] = ni;
  }
  pause() {
  }
  resume() {
  }
  [ds](t) {
    let e = this.follow ? "statSync" : "lstatSync";
    this[li](t, mi[e](t.absolute));
  }
  [us](t) {
    this[fi](t, mi.readdirSync(t.absolute));
  }
  [di](t) {
    let e = t.entry, i = this.zip;
    if (t.readdir && t.readdir.forEach((r) => {
      let n = t.path, o = n === "./" ? "" : n.replace(/\/*$/, "/");
      this[ci](o + r);
    }), !e) throw new Error("Cannot pipe without source");
    i ? e.on("data", (r) => {
      i.write(r);
    }) : e.on("data", (r) => {
      super[lr](r);
    });
  }
};
var Vn = (s3, t) => {
  let e = new kt(s3), i = new Wt(s3.file, { mode: s3.mode || 438 });
  e.pipe(i), fr(e, t);
};
var $n = (s3, t) => {
  let e = new wt(s3), i = new et(s3.file, { mode: s3.mode || 438 });
  e.pipe(i);
  let r = new Promise((n, o) => {
    i.on("error", o), i.on("close", n), e.on("error", o);
  });
  return dr(e, t).catch((n) => e.emit("error", n)), r;
};
var fr = (s3, t) => {
  t.forEach((e) => {
    e.charAt(0) === "@" ? Ct({ file: cr.resolve(s3.cwd, e.slice(1)), sync: true, noResume: true, onReadEntry: (i) => s3.add(i) }) : s3.add(e);
  }), s3.end();
};
var dr = async (s3, t) => {
  for (let e of t) e.charAt(0) === "@" ? await Ct({ file: cr.resolve(String(s3.cwd), e.slice(1)), noResume: true, onReadEntry: (i) => {
    s3.add(i);
  } }) : s3.add(e);
  s3.end();
};
var Xn = (s3, t) => {
  let e = new kt(s3);
  return fr(e, t), e;
};
var qn = (s3, t) => {
  let e = new wt(s3);
  return dr(e, t).catch((i) => e.emit("error", i)), e;
};
var Qn = K(Vn, $n, Xn, qn, (s3, t) => {
  if (!t?.length) throw new TypeError("no paths specified to add to archive");
});
var Jn = process.env.__FAKE_PLATFORM__ || process.platform;
var Er = Jn === "win32";
var { O_CREAT: wr, O_NOFOLLOW: ur, O_TRUNC: Sr, O_WRONLY: yr } = pr.constants;
var Rr = Number(process.env.__FAKE_FS_O_FILENAME__) || pr.constants.UV_FS_O_FILEMAP || 0;
var jn = Er && !!Rr;
var to = 512 * 1024;
var eo = Rr | Sr | wr | yr;
var mr = !Er && typeof ur == "number" ? ur | Sr | wr | yr : null;
var ms = mr !== null ? () => mr : jn ? (s3) => s3 < to ? eo : "w" : () => "w";
var ps = (s3, t, e) => {
  try {
    return wi.lchownSync(s3, t, e);
  } catch (i) {
    if (i?.code !== "ENOENT") throw i;
  }
};
var Ei = (s3, t, e, i) => {
  wi.lchown(s3, t, e, (r) => {
    i(r && r?.code !== "ENOENT" ? r : null);
  });
};
var io = (s3, t, e, i, r) => {
  if (t.isDirectory()) Es(we.resolve(s3, t.name), e, i, (n) => {
    if (n) return r(n);
    let o = we.resolve(s3, t.name);
    Ei(o, e, i, r);
  });
  else {
    let n = we.resolve(s3, t.name);
    Ei(n, e, i, r);
  }
};
var Es = (s3, t, e, i) => {
  wi.readdir(s3, { withFileTypes: true }, (r, n) => {
    if (r) {
      if (r.code === "ENOENT") return i();
      if (r.code !== "ENOTDIR" && r.code !== "ENOTSUP") return i(r);
    }
    if (r || !n.length) return Ei(s3, t, e, i);
    let o = n.length, h = null, a = (l) => {
      if (!h) {
        if (l) return i(h = l);
        if (--o === 0) return Ei(s3, t, e, i);
      }
    };
    for (let l of n) io(s3, l, t, e, a);
  });
};
var so = (s3, t, e, i) => {
  t.isDirectory() && ws(we.resolve(s3, t.name), e, i), ps(we.resolve(s3, t.name), e, i);
};
var ws = (s3, t, e) => {
  let i;
  try {
    i = wi.readdirSync(s3, { withFileTypes: true });
  } catch (r) {
    let n = r;
    if (n?.code === "ENOENT") return;
    if (n?.code === "ENOTDIR" || n?.code === "ENOTSUP") return ps(s3, t, e);
    throw n;
  }
  for (let r of i) so(s3, r, t, e);
  return ps(s3, t, e);
};
var Se = class extends Error {
  path;
  code;
  syscall = "chdir";
  constructor(t, e) {
    super(`${e}: Cannot cd into '${t}'`), this.path = t, this.code = e;
  }
  get name() {
    return "CwdError";
  }
};
var St = class extends Error {
  path;
  symlink;
  syscall = "symlink";
  code = "TAR_SYMLINK_ERROR";
  constructor(t, e) {
    super("TAR_SYMLINK_ERROR: Cannot extract through symbolic link"), this.symlink = t, this.path = e;
  }
  get name() {
    return "SymlinkError";
  }
};
var no = (s3, t) => {
  k.stat(s3, (e, i) => {
    (e || !i.isDirectory()) && (e = new Se(s3, e?.code || "ENOTDIR")), t(e);
  });
};
var gr = (s3, t, e) => {
  s3 = f(s3);
  let i = t.umask ?? 18, r = t.mode | 448, n = (r & i) !== 0, o = t.uid, h = t.gid, a = typeof o == "number" && typeof h == "number" && (o !== t.processUid || h !== t.processGid), l = t.preserve, c = t.unlink, d = f(t.cwd), y = (E, x) => {
    E ? e(E) : x && a ? Es(x, o, h, (Le) => y(Le)) : n ? k.chmod(s3, r, e) : e();
  };
  if (s3 === d) return no(s3, y);
  if (l) return ro.mkdir(s3, { mode: r, recursive: true }).then((E) => y(null, E ?? void 0), y);
  let D = f(Si.relative(d, s3)).split("/");
  Ss(d, D, r, c, d, void 0, y);
};
var Ss = (s3, t, e, i, r, n, o) => {
  if (t.length === 0) return o(null, n);
  let h = t.shift(), a = f(Si.resolve(s3 + "/" + h));
  k.mkdir(a, e, br(a, t, e, i, r, n, o));
};
var br = (s3, t, e, i, r, n, o) => (h) => {
  h ? k.lstat(s3, (a, l) => {
    if (a) a.path = a.path && f(a.path), o(a);
    else if (l.isDirectory()) Ss(s3, t, e, i, r, n, o);
    else if (i) k.unlink(s3, (c) => {
      if (c) return o(c);
      k.mkdir(s3, e, br(s3, t, e, i, r, n, o));
    });
    else {
      if (l.isSymbolicLink()) return o(new St(s3, s3 + "/" + t.join("/")));
      o(h);
    }
  }) : (n = n || s3, Ss(s3, t, e, i, r, n, o));
};
var oo = (s3) => {
  let t = false, e;
  try {
    t = k.statSync(s3).isDirectory();
  } catch (i) {
    e = i?.code;
  } finally {
    if (!t) throw new Se(s3, e ?? "ENOTDIR");
  }
};
var _r = (s3, t) => {
  s3 = f(s3);
  let e = t.umask ?? 18, i = t.mode | 448, r = (i & e) !== 0, n = t.uid, o = t.gid, h = typeof n == "number" && typeof o == "number" && (n !== t.processUid || o !== t.processGid), a = t.preserve, l = t.unlink, c = f(t.cwd), d = (E) => {
    E && h && ws(E, n, o), r && k.chmodSync(s3, i);
  };
  if (s3 === c) return oo(c), d();
  if (a) return d(k.mkdirSync(s3, { mode: i, recursive: true }) ?? void 0);
  let T = f(Si.relative(c, s3)).split("/"), D;
  for (let E = T.shift(), x = c; E && (x += "/" + E); E = T.shift()) {
    x = f(Si.resolve(x));
    try {
      k.mkdirSync(x, i), D = D || x;
    } catch {
      let Le = k.lstatSync(x);
      if (Le.isDirectory()) continue;
      if (l) {
        k.unlinkSync(x), k.mkdirSync(x, i), D = D || x;
        continue;
      } else if (Le.isSymbolicLink()) return new St(x, x + "/" + T.join("/"));
    }
  }
  return d(D);
};
var ys = /* @__PURE__ */ Object.create(null);
var Or = 1e4;
var Vt = /* @__PURE__ */ new Set();
var Tr = (s3) => {
  Vt.has(s3) ? Vt.delete(s3) : ys[s3] = s3.normalize("NFD").toLocaleLowerCase("en").toLocaleUpperCase("en"), Vt.add(s3);
  let t = ys[s3], e = Vt.size - Or;
  if (e > Or / 10) {
    for (let i of Vt) if (Vt.delete(i), delete ys[i], --e <= 0) break;
  }
  return t;
};
var ho = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
var ao = ho === "win32";
var lo = (s3) => s3.split("/").slice(0, -1).reduce((e, i) => {
  let r = e.at(-1);
  return r !== void 0 && (i = xr(r, i)), e.push(i || "/"), e;
}, []);
var yi = class {
  #t = /* @__PURE__ */ new Map();
  #i = /* @__PURE__ */ new Map();
  #s = /* @__PURE__ */ new Set();
  reserve(t, e) {
    t = ao ? ["win32 parallelization disabled"] : t.map((r) => mt(xr(Tr(r))));
    let i = new Set(t.map((r) => lo(r)).reduce((r, n) => r.concat(n)));
    this.#i.set(e, { dirs: i, paths: t });
    for (let r of t) {
      let n = this.#t.get(r);
      n ? n.push(e) : this.#t.set(r, [e]);
    }
    for (let r of i) {
      let n = this.#t.get(r);
      if (!n) this.#t.set(r, [/* @__PURE__ */ new Set([e])]);
      else {
        let o = n.at(-1);
        o instanceof Set ? o.add(e) : n.push(/* @__PURE__ */ new Set([e]));
      }
    }
    return this.#r(e);
  }
  #n(t) {
    let e = this.#i.get(t);
    if (!e) throw new Error("function does not have any path reservations");
    return { paths: e.paths.map((i) => this.#t.get(i)), dirs: [...e.dirs].map((i) => this.#t.get(i)) };
  }
  check(t) {
    let { paths: e, dirs: i } = this.#n(t);
    return e.every((r) => r && r[0] === t) && i.every((r) => r && r[0] instanceof Set && r[0].has(t));
  }
  #r(t) {
    return this.#s.has(t) || !this.check(t) ? false : (this.#s.add(t), t(() => this.#e(t)), true);
  }
  #e(t) {
    if (!this.#s.has(t)) return false;
    let e = this.#i.get(t);
    if (!e) throw new Error("invalid reservation");
    let { paths: i, dirs: r } = e, n = /* @__PURE__ */ new Set();
    for (let o of i) {
      let h = this.#t.get(o);
      if (!h || h?.[0] !== t) continue;
      let a = h[1];
      if (!a) {
        this.#t.delete(o);
        continue;
      }
      if (h.shift(), typeof a == "function") n.add(a);
      else for (let l of a) n.add(l);
    }
    for (let o of r) {
      let h = this.#t.get(o), a = h?.[0];
      if (!(!h || !(a instanceof Set))) if (a.size === 1 && h.length === 1) {
        this.#t.delete(o);
        continue;
      } else if (a.size === 1) {
        h.shift();
        let l = h[0];
        typeof l == "function" && n.add(l);
      } else a.delete(t);
    }
    return this.#s.delete(t), n.forEach((o) => this.#r(o)), true;
  }
};
var Lr = () => process.umask();
var Dr = /* @__PURE__ */ Symbol("onEntry");
var _s = /* @__PURE__ */ Symbol("checkFs");
var Nr = /* @__PURE__ */ Symbol("checkFs2");
var Os = /* @__PURE__ */ Symbol("isReusable");
var P = /* @__PURE__ */ Symbol("makeFs");
var Ts = /* @__PURE__ */ Symbol("file");
var xs = /* @__PURE__ */ Symbol("directory");
var gi = /* @__PURE__ */ Symbol("link");
var Ar = /* @__PURE__ */ Symbol("symlink");
var Ir = /* @__PURE__ */ Symbol("hardlink");
var Re = /* @__PURE__ */ Symbol("ensureNoSymlink");
var Cr = /* @__PURE__ */ Symbol("unsupported");
var Fr = /* @__PURE__ */ Symbol("checkPath");
var Rs = /* @__PURE__ */ Symbol("stripAbsolutePath");
var yt = /* @__PURE__ */ Symbol("mkdir");
var O = /* @__PURE__ */ Symbol("onError");
var Ri = /* @__PURE__ */ Symbol("pending");
var kr = /* @__PURE__ */ Symbol("pend");
var $t = /* @__PURE__ */ Symbol("unpend");
var gs = /* @__PURE__ */ Symbol("ended");
var bs = /* @__PURE__ */ Symbol("maybeClose");
var Ls = /* @__PURE__ */ Symbol("skip");
var ge = /* @__PURE__ */ Symbol("doChown");
var be = /* @__PURE__ */ Symbol("uid");
var _e = /* @__PURE__ */ Symbol("gid");
var Oe = /* @__PURE__ */ Symbol("checkedCwd");
var fo = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
var Te = fo === "win32";
var uo = 1024;
var mo = (s3, t) => {
  if (!Te) return u.unlink(s3, t);
  let e = s3 + ".DELETE." + Mr(16).toString("hex");
  u.rename(s3, e, (i) => {
    if (i) return t(i);
    u.unlink(e, t);
  });
};
var po = (s3) => {
  if (!Te) return u.unlinkSync(s3);
  let t = s3 + ".DELETE." + Mr(16).toString("hex");
  u.renameSync(s3, t), u.unlinkSync(t);
};
var vr = (s3, t, e) => s3 !== void 0 && s3 === s3 >>> 0 ? s3 : t !== void 0 && t === t >>> 0 ? t : e;
var Xt = class extends rt {
  [gs] = false;
  [Oe] = false;
  [Ri] = 0;
  reservations = new yi();
  transform;
  writable = true;
  readable = false;
  uid;
  gid;
  setOwner;
  preserveOwner;
  processGid;
  processUid;
  maxDepth;
  forceChown;
  win32;
  newer;
  keep;
  noMtime;
  preservePaths;
  unlink;
  cwd;
  strip;
  processUmask;
  umask;
  dmode;
  fmode;
  chmod;
  constructor(t = {}) {
    if (t.ondone = () => {
      this[gs] = true, this[bs]();
    }, super(t), this.transform = t.transform, this.chmod = !!t.chmod, typeof t.uid == "number" || typeof t.gid == "number") {
      if (typeof t.uid != "number" || typeof t.gid != "number") throw new TypeError("cannot set owner without number uid and gid");
      if (t.preserveOwner) throw new TypeError("cannot preserve owner in archive and also set owner explicitly");
      this.uid = t.uid, this.gid = t.gid, this.setOwner = true;
    } else this.uid = void 0, this.gid = void 0, this.setOwner = false;
    this.preserveOwner = t.preserveOwner === void 0 && typeof t.uid != "number" ? process.getuid?.() === 0 : !!t.preserveOwner, this.processUid = (this.preserveOwner || this.setOwner) && process.getuid ? process.getuid() : void 0, this.processGid = (this.preserveOwner || this.setOwner) && process.getgid ? process.getgid() : void 0, this.maxDepth = typeof t.maxDepth == "number" ? t.maxDepth : uo, this.forceChown = t.forceChown === true, this.win32 = !!t.win32 || Te, this.newer = !!t.newer, this.keep = !!t.keep, this.noMtime = !!t.noMtime, this.preservePaths = !!t.preservePaths, this.unlink = !!t.unlink, this.cwd = f(R.resolve(t.cwd || process.cwd())), this.strip = Number(t.strip) || 0, this.processUmask = this.chmod ? typeof t.processUmask == "number" ? t.processUmask : Lr() : 0, this.umask = typeof t.umask == "number" ? t.umask : this.processUmask, this.dmode = t.dmode || 511 & ~this.umask, this.fmode = t.fmode || 438 & ~this.umask, this.on("entry", (e) => this[Dr](e));
  }
  warn(t, e, i = {}) {
    return (t === "TAR_BAD_ARCHIVE" || t === "TAR_ABORT") && (i.recoverable = false), super.warn(t, e, i);
  }
  [bs]() {
    this[gs] && this[Ri] === 0 && (this.emit("prefinish"), this.emit("finish"), this.emit("end"));
  }
  [Rs](t, e) {
    let i = t[e], { type: r } = t;
    if (!i || this.preservePaths) return true;
    let [n, o] = ce(i), h = o.replaceAll(/\\/g, "/").split("/");
    if (h.includes("..") || Te && /^[a-z]:\.\.$/i.test(h[0] ?? "")) {
      if (e === "path" || r === "Link") return this.warn("TAR_ENTRY_ERROR", `${e} contains '..'`, { entry: t, [e]: i }), false;
      let a = R.posix.dirname(t.path), l = R.posix.normalize(R.posix.join(a, h.join("/")));
      if (l.startsWith("../") || l === "..") return this.warn("TAR_ENTRY_ERROR", `${e} escapes extraction directory`, { entry: t, [e]: i }), false;
    }
    return n && (t[e] = String(o), this.warn("TAR_ENTRY_INFO", `stripping ${n} from absolute ${e}`, { entry: t, [e]: i })), true;
  }
  [Fr](t) {
    let e = f(t.path), i = e.split("/");
    if (this.strip) {
      if (i.length < this.strip) return false;
      if (t.type === "Link") {
        let r = f(String(t.linkpath)).split("/");
        if (r.length >= this.strip) t.linkpath = r.slice(this.strip).join("/");
        else return false;
      }
      i.splice(0, this.strip), t.path = i.join("/");
    }
    if (isFinite(this.maxDepth) && i.length > this.maxDepth) return this.warn("TAR_ENTRY_ERROR", "path excessively deep", { entry: t, path: e, depth: i.length, maxDepth: this.maxDepth }), false;
    if (!this[Rs](t, "path") || !this[Rs](t, "linkpath")) return false;
    if (t.absolute = R.isAbsolute(t.path) ? f(R.resolve(t.path)) : f(R.resolve(this.cwd, t.path)), !this.preservePaths && typeof t.absolute == "string" && t.absolute.indexOf(this.cwd + "/") !== 0 && t.absolute !== this.cwd) return this.warn("TAR_ENTRY_ERROR", "path escaped extraction target", { entry: t, path: f(t.path), resolvedPath: t.absolute, cwd: this.cwd }), false;
    if (t.absolute === this.cwd && t.type !== "Directory" && t.type !== "GNUDumpDir") return false;
    if (this.win32) {
      let { root: r } = R.win32.parse(String(t.absolute));
      t.absolute = r + ts(String(t.absolute).slice(r.length));
      let { root: n } = R.win32.parse(t.path);
      t.path = n + ts(t.path.slice(n.length));
    }
    return true;
  }
  [Dr](t) {
    if (!this[Fr](t)) return t.resume();
    switch (co.equal(typeof t.absolute, "string"), t.type) {
      case "Directory":
      case "GNUDumpDir":
        t.mode && (t.mode = t.mode | 448);
      case "File":
      case "OldFile":
      case "ContiguousFile":
      case "Link":
      case "SymbolicLink":
        return this[_s](t);
      default:
        return this[Cr](t);
    }
  }
  [O](t, e) {
    t.name === "CwdError" ? this.emit("error", t) : (this.warn("TAR_ENTRY_ERROR", t, { entry: e }), this[$t](), e.resume());
  }
  [yt](t, e, i) {
    gr(f(t), { uid: this.uid, gid: this.gid, processUid: this.processUid, processGid: this.processGid, umask: this.processUmask, preserve: this.preservePaths, unlink: this.unlink, cwd: this.cwd, mode: e }, i);
  }
  [ge](t) {
    return this.forceChown || this.preserveOwner && (typeof t.uid == "number" && t.uid !== this.processUid || typeof t.gid == "number" && t.gid !== this.processGid) || typeof this.uid == "number" && this.uid !== this.processUid || typeof this.gid == "number" && this.gid !== this.processGid;
  }
  [be](t) {
    return vr(this.uid, t.uid, this.processUid);
  }
  [_e](t) {
    return vr(this.gid, t.gid, this.processGid);
  }
  [Ts](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.fmode, r = new et(String(t.absolute), { flags: ms(t.size), mode: i, autoClose: false });
    r.on("error", (a) => {
      r.fd && u.close(r.fd, () => {
      }), r.write = () => true, this[O](a, t), e();
    });
    let n = 1, o = (a) => {
      if (a) {
        r.fd && u.close(r.fd, () => {
        }), this[O](a, t), e();
        return;
      }
      --n === 0 && r.fd !== void 0 && u.close(r.fd, (l) => {
        l ? this[O](l, t) : this[$t](), e();
      });
    };
    r.on("finish", () => {
      let a = String(t.absolute), l = r.fd;
      if (typeof l == "number" && t.mtime && !this.noMtime) {
        n++;
        let c = t.atime || /* @__PURE__ */ new Date(), d = t.mtime;
        u.futimes(l, c, d, (y) => y ? u.utimes(a, c, d, (T) => o(T && y)) : o());
      }
      if (typeof l == "number" && this[ge](t)) {
        n++;
        let c = this[be](t), d = this[_e](t);
        typeof c == "number" && typeof d == "number" && u.fchown(l, c, d, (y) => y ? u.chown(a, c, d, (T) => o(T && y)) : o());
      }
      o();
    });
    let h = this.transform && this.transform(t) || t;
    h !== t && (h.on("error", (a) => {
      this[O](a, t), e();
    }), t.pipe(h)), h.pipe(r);
  }
  [xs](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.dmode;
    this[yt](String(t.absolute), i, (r) => {
      if (r) {
        this[O](r, t), e();
        return;
      }
      let n = 1, o = () => {
        --n === 0 && (e(), this[$t](), t.resume());
      };
      t.mtime && !this.noMtime && (n++, u.utimes(String(t.absolute), t.atime || /* @__PURE__ */ new Date(), t.mtime, o)), this[ge](t) && (n++, u.chown(String(t.absolute), Number(this[be](t)), Number(this[_e](t)), o)), o();
    });
  }
  [Cr](t) {
    t.unsupported = true, this.warn("TAR_ENTRY_UNSUPPORTED", `unsupported entry type: ${t.type}`, { entry: t }), t.resume();
  }
  [Ar](t, e) {
    let i = f(R.relative(this.cwd, R.resolve(R.dirname(String(t.absolute)), String(t.linkpath)))).split("/");
    this[Re](t, this.cwd, i, () => this[gi](t, String(t.linkpath), "symlink", e), (r) => {
      this[O](r, t), e();
    });
  }
  [Ir](t, e) {
    let i = f(R.resolve(this.cwd, String(t.linkpath))), r = f(String(t.linkpath)).split("/");
    this[Re](t, this.cwd, r, () => this[gi](t, i, "link", e), (n) => {
      this[O](n, t), e();
    });
  }
  [Re](t, e, i, r, n) {
    let o = i.shift();
    if (this.preservePaths || o === void 0) return r();
    let h = R.resolve(e, o);
    u.lstat(h, (a, l) => {
      if (a) return r();
      if (l?.isSymbolicLink()) return n(new St(h, R.resolve(h, i.join("/"))));
      this[Re](t, h, i, r, n);
    });
  }
  [kr]() {
    this[Ri]++;
  }
  [$t]() {
    this[Ri]--, this[bs]();
  }
  [Ls](t) {
    this[$t](), t.resume();
  }
  [Os](t, e) {
    return t.type === "File" && !this.unlink && e.isFile() && e.nlink <= 1 && !Te;
  }
  [_s](t) {
    this[kr]();
    let e = [t.path];
    t.linkpath && e.push(t.linkpath), this.reservations.reserve(e, (i) => this[Nr](t, i));
  }
  [Nr](t, e) {
    let i = (h) => {
      e(h);
    }, r = () => {
      this[yt](this.cwd, this.dmode, (h) => {
        if (h) {
          this[O](h, t), i();
          return;
        }
        this[Oe] = true, n();
      });
    }, n = () => {
      if (t.absolute !== this.cwd) {
        let h = f(R.dirname(String(t.absolute)));
        if (h !== this.cwd) return this[yt](h, this.dmode, (a) => {
          if (a) {
            this[O](a, t), i();
            return;
          }
          o();
        });
      }
      o();
    }, o = () => {
      u.lstat(String(t.absolute), (h, a) => {
        if (a && (this.keep || this.newer && a.mtime > (t.mtime ?? a.mtime))) {
          this[Ls](t), i();
          return;
        }
        if (h || this[Os](t, a)) return this[P](null, t, i);
        if (a.isDirectory()) {
          if (t.type === "Directory") {
            let l = this.chmod && t.mode && (a.mode & 4095) !== t.mode, c = (d) => this[P](d ?? null, t, i);
            return l ? u.chmod(String(t.absolute), Number(t.mode), c) : c();
          }
          if (t.absolute !== this.cwd) return u.rmdir(String(t.absolute), (l) => this[P](l ?? null, t, i));
        }
        if (t.absolute === this.cwd) return this[P](null, t, i);
        mo(String(t.absolute), (l) => this[P](l ?? null, t, i));
      });
    };
    this[Oe] ? n() : r();
  }
  [P](t, e, i) {
    if (t) {
      this[O](t, e), i();
      return;
    }
    switch (e.type) {
      case "File":
      case "OldFile":
      case "ContiguousFile":
        return this[Ts](e, i);
      case "Link":
        return this[Ir](e, i);
      case "SymbolicLink":
        return this[Ar](e, i);
      case "Directory":
      case "GNUDumpDir":
        return this[xs](e, i);
    }
  }
  [gi](t, e, i, r) {
    u[i](e, String(t.absolute), (n) => {
      n ? this[O](n, t) : (this[$t](), t.resume()), r();
    });
  }
};
var ye = (s3) => {
  try {
    return [null, s3()];
  } catch (t) {
    return [t, null];
  }
};
var xe = class extends Xt {
  sync = true;
  [P](t, e) {
    return super[P](t, e, () => {
    });
  }
  [_s](t) {
    if (!this[Oe]) {
      let n = this[yt](this.cwd, this.dmode);
      if (n) return this[O](n, t);
      this[Oe] = true;
    }
    if (t.absolute !== this.cwd) {
      let n = f(R.dirname(String(t.absolute)));
      if (n !== this.cwd) {
        let o = this[yt](n, this.dmode);
        if (o) return this[O](o, t);
      }
    }
    let [e, i] = ye(() => u.lstatSync(String(t.absolute)));
    if (i && (this.keep || this.newer && i.mtime > (t.mtime ?? i.mtime))) return this[Ls](t);
    if (e || this[Os](t, i)) return this[P](null, t);
    if (i.isDirectory()) {
      if (t.type === "Directory") {
        let o = this.chmod && t.mode && (i.mode & 4095) !== t.mode, [h] = o ? ye(() => {
          u.chmodSync(String(t.absolute), Number(t.mode));
        }) : [];
        return this[P](h, t);
      }
      let [n] = ye(() => u.rmdirSync(String(t.absolute)));
      this[P](n, t);
    }
    let [r] = t.absolute === this.cwd ? [] : ye(() => po(String(t.absolute)));
    this[P](r, t);
  }
  [Ts](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.fmode, r = (h) => {
      let a;
      try {
        u.closeSync(n);
      } catch (l) {
        a = l;
      }
      (h || a) && this[O](h || a, t), e();
    }, n;
    try {
      n = u.openSync(String(t.absolute), ms(t.size), i);
    } catch (h) {
      return r(h);
    }
    let o = this.transform && this.transform(t) || t;
    o !== t && (o.on("error", (h) => this[O](h, t)), t.pipe(o)), o.on("data", (h) => {
      try {
        u.writeSync(n, h, 0, h.length);
      } catch (a) {
        r(a);
      }
    }), o.on("end", () => {
      let h = null;
      if (t.mtime && !this.noMtime) {
        let a = t.atime || /* @__PURE__ */ new Date(), l = t.mtime;
        try {
          u.futimesSync(n, a, l);
        } catch (c) {
          try {
            u.utimesSync(String(t.absolute), a, l);
          } catch {
            h = c;
          }
        }
      }
      if (this[ge](t)) {
        let a = this[be](t), l = this[_e](t);
        try {
          u.fchownSync(n, Number(a), Number(l));
        } catch (c) {
          try {
            u.chownSync(String(t.absolute), Number(a), Number(l));
          } catch {
            h = h || c;
          }
        }
      }
      r(h);
    });
  }
  [xs](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.dmode, r = this[yt](String(t.absolute), i);
    if (r) {
      this[O](r, t), e();
      return;
    }
    if (t.mtime && !this.noMtime) try {
      u.utimesSync(String(t.absolute), t.atime || /* @__PURE__ */ new Date(), t.mtime);
    } catch {
    }
    if (this[ge](t)) try {
      u.chownSync(String(t.absolute), Number(this[be](t)), Number(this[_e](t)));
    } catch {
    }
    e(), t.resume();
  }
  [yt](t, e) {
    try {
      return _r(f(t), { uid: this.uid, gid: this.gid, processUid: this.processUid, processGid: this.processGid, umask: this.processUmask, preserve: this.preservePaths, unlink: this.unlink, cwd: this.cwd, mode: e });
    } catch (i) {
      return i;
    }
  }
  [Re](t, e, i, r, n) {
    if (this.preservePaths || i.length === 0) return r();
    let o = e;
    for (let h of i) {
      o = R.resolve(o, h);
      let [a, l] = ye(() => u.lstatSync(o));
      if (a) return r();
      if (l.isSymbolicLink()) return n(new St(o, R.resolve(e, i.join("/"))));
    }
    r();
  }
  [gi](t, e, i, r) {
    let n = `${i}Sync`;
    try {
      u[n](e, String(t.absolute)), r(), t.resume();
    } catch (o) {
      return this[O](o, t);
    }
  }
};
var Eo = (s3) => {
  let t = new xe(s3), e = s3.file, i = Br.statSync(e), r = s3.maxReadSize || 16 * 1024 * 1024;
  new Be(e, { readSize: r, size: i.size }).pipe(t);
};
var wo = (s3, t) => {
  let e = new Xt(s3), i = s3.maxReadSize || 16 * 1024 * 1024, r = s3.file;
  return new Promise((o, h) => {
    e.on("error", h), e.on("close", o), Br.stat(r, (a, l) => {
      if (a) h(a);
      else {
        let c = new _t(r, { readSize: i, size: l.size });
        c.on("error", h), c.pipe(e);
      }
    });
  });
};
var So = K(Eo, wo, (s3) => new xe(s3), (s3) => new Xt(s3), (s3, t) => {
  t?.length && Qi(s3, t);
});
var yo = (s3, t) => {
  let e = new kt(s3), i = true, r, n;
  try {
    try {
      r = v.openSync(s3.file, "r+");
    } catch (a) {
      if (a?.code === "ENOENT") r = v.openSync(s3.file, "w+");
      else throw a;
    }
    let o = v.fstatSync(r), h = Buffer.alloc(512);
    t: for (n = 0; n < o.size; n += 512) {
      for (let c = 0, d = 0; c < 512; c += d) {
        if (d = v.readSync(r, h, c, h.length - c, n + c), n === 0 && h[0] === 31 && h[1] === 139) throw new Error("cannot append to compressed archives");
        if (!d) break t;
      }
      let a = new F(h);
      if (!a.cksumValid) break;
      let l = 512 * Math.ceil((a.size || 0) / 512);
      if (n + l + 512 > o.size) break;
      n += l, s3.mtimeCache && a.mtime && s3.mtimeCache.set(String(a.path), a.mtime);
    }
    i = false, Ro(s3, e, n, r, t);
  } finally {
    if (i) try {
      v.closeSync(r);
    } catch {
    }
  }
};
var Ro = (s3, t, e, i, r) => {
  let n = new Wt(s3.file, { fd: i, start: e });
  t.pipe(n), bo(t, r);
};
var go = (s3, t) => {
  t = Array.from(t);
  let e = new wt(s3), i = (n, o, h) => {
    let a = (T, D) => {
      T ? v.close(n, (E) => h(T)) : h(null, D);
    }, l = 0;
    if (o === 0) return a(null, 0);
    let c = 0, d = Buffer.alloc(512), y = (T, D) => {
      if (T || D === void 0) return a(T);
      if (c += D, c < 512 && D) return v.read(n, d, c, d.length - c, l + c, y);
      if (l === 0 && d[0] === 31 && d[1] === 139) return a(new Error("cannot append to compressed archives"));
      if (c < 512) return a(null, l);
      let E = new F(d);
      if (!E.cksumValid) return a(null, l);
      let x = 512 * Math.ceil((E.size ?? 0) / 512);
      if (l + x + 512 > o || (l += x + 512, l >= o)) return a(null, l);
      s3.mtimeCache && E.mtime && s3.mtimeCache.set(String(E.path), E.mtime), c = 0, v.read(n, d, 0, 512, l, y);
    };
    v.read(n, d, 0, 512, l, y);
  };
  return new Promise((n, o) => {
    e.on("error", o);
    let h = "r+", a = (l, c) => {
      if (l && l.code === "ENOENT" && h === "r+") return h = "w+", v.open(s3.file, h, a);
      if (l || !c) return o(l);
      v.fstat(c, (d, y) => {
        if (d) return v.close(c, () => o(d));
        i(c, y.size, (T, D) => {
          if (T) return o(T);
          let E = new et(s3.file, { fd: c, start: D });
          e.pipe(E), E.on("error", o), E.on("close", n), _o(e, t);
        });
      });
    };
    v.open(s3.file, h, a);
  });
};
var bo = (s3, t) => {
  t.forEach((e) => {
    e.charAt(0) === "@" ? Ct({ file: Pr.resolve(s3.cwd, e.slice(1)), sync: true, noResume: true, onReadEntry: (i) => s3.add(i) }) : s3.add(e);
  }), s3.end();
};
var _o = async (s3, t) => {
  for (let e of t) e.charAt(0) === "@" ? await Ct({ file: Pr.resolve(String(s3.cwd), e.slice(1)), noResume: true, onReadEntry: (i) => s3.add(i) }) : s3.add(e);
  s3.end();
};
var vt = K(yo, go, () => {
  throw new TypeError("file is required");
}, () => {
  throw new TypeError("file is required");
}, (s3, t) => {
  if (!Bs(s3)) throw new TypeError("file is required");
  if (s3.gzip || s3.brotli || s3.zstd || s3.file.endsWith(".br") || s3.file.endsWith(".tbr")) throw new TypeError("cannot append to compressed archives");
  if (!t?.length) throw new TypeError("no paths specified to add/replace");
});
var Oo = K(vt.syncFile, vt.asyncFile, vt.syncNoFile, vt.asyncNoFile, (s3, t = []) => {
  vt.validate?.(s3, t), To(s3);
});
var To = (s3) => {
  let t = s3.filter;
  s3.mtimeCache || (s3.mtimeCache = /* @__PURE__ */ new Map()), s3.filter = t ? (e, i) => t(e, i) && !((s3.mtimeCache?.get(e) ?? i.mtime ?? 0) > (i.mtime ?? 0)) : (e, i) => !((s3.mtimeCache?.get(e) ?? i.mtime ?? 0) > (i.mtime ?? 0));
};

// src/adapters/hashing.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp7 from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline as pipeline2 } from "node:stream/promises";
async function sha256File(file, signal) {
  const hash = createHash("sha256");
  const options = signal === void 0 ? {} : { signal };
  await pipeline2(createReadStream(file), hash, options);
  return hash.digest("hex");
}
function createHashTee(algorithms = ["sha256", "md5"]) {
  const hashes = /* @__PURE__ */ new Map();
  for (const algorithm of algorithms) hashes.set(algorithm, createHash(algorithm));
  const digests = /* @__PURE__ */ new Map();
  let seen = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      for (const hash of hashes.values()) hash.update(chunk);
      seen += chunk.length;
      callback(null, chunk);
    }
  });
  return {
    stream,
    digest: (algorithm = "sha256") => {
      const cached2 = digests.get(algorithm);
      if (cached2 !== void 0) return cached2;
      const hash = hashes.get(algorithm);
      if (hash === void 0) throw new BugError(`hash tee was not built for ${algorithm}`);
      const value = hash.digest("hex");
      digests.set(algorithm, value);
      return value;
    },
    bytes: () => seen
  };
}
async function sha256Prefix(file, bytes, signal) {
  if (bytes <= 0) return null;
  const handle = await fsp7.open(file, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(bytes, 1024 * 1024));
    let read = 0;
    while (read < bytes) {
      signal?.throwIfAborted();
      const want = Math.min(buffer.length, bytes - read);
      const { bytesRead } = await handle.read(buffer, 0, want, read);
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

// src/adapters/bundle.ts
var DEFAULT_ZSTD_LEVEL = 19;
var TAR_READ_OPTIONS = { maxDecompressionRatio: Infinity };
async function createBundle(input) {
  const level = input.compressionLevel ?? DEFAULT_ZSTD_LEVEL;
  await fsp8.mkdir(path13.dirname(input.outputPath), { recursive: true });
  const temp = siblingTempPath(input.outputPath);
  const tee = createHashTee();
  try {
    const pack = Qn(
      {
        cwd: input.cwd,
        // Portable mode drops uid/gid/atime, so the same session bundles to the
        // same bytes on macOS, Windows and Linux.
        portable: true,
        follow: false,
        // node-tar dedupes files that share an inode: the second one becomes a
        // zero-byte Link entry pointing at the first. The manifest lstats each
        // file independently and records its real size, so the bundle could
        // never agree with it and the session was blocked for ever. Storing
        // both copies in full costs bytes and always agrees.
        linkCache: new NoLinkCache(),
        noDirRecurse: false
      },
      input.entries
    );
    const compress = zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: level }
    });
    const sink = fs9.createWriteStream(temp, { flags: "wx", mode: 384 });
    const options = input.signal === void 0 ? {} : { signal: input.signal };
    await pipeline3(pack, compress, tee.stream, sink, options);
    await fsyncPath(temp);
    await renameWithRetry(temp, input.outputPath);
    return {
      path: input.outputPath,
      bytes: tee.bytes(),
      sha256: tee.digest("sha256"),
      md5: tee.digest("md5"),
      compressionLevel: level
    };
  } catch (err) {
    await fsp8.rm(temp, { force: true }).catch(() => void 0);
    throw err;
  }
}
async function fsyncPath(file) {
  const handle = await fsp8.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function describeSessionFiles(args) {
  const described = [];
  for (const entry of args.entries) {
    await describeInto(described, args.cwd, entry, args.signal, true);
  }
  described.sort((a, b2) => a.path < b2.path ? -1 : a.path > b2.path ? 1 : 0);
  return described;
}
async function describeInto(out, cwd, relative, signal, optional = false) {
  const absolute = path13.join(cwd, relative);
  let stat;
  try {
    stat = await fsp8.lstat(absolute);
  } catch (err) {
    if (optional && err.code === "ENOENT") return;
    throw err;
  }
  if (stat.isFile()) {
    out.push({
      path: toPosix(relative),
      bytes: stat.size,
      sha256: await sha256File(absolute, signal)
    });
    return;
  }
  if (!stat.isDirectory()) return;
  const children = await fsp8.readdir(absolute);
  for (const child of children) {
    await describeInto(out, cwd, path13.join(relative, child), signal);
  }
}
var NoLinkCache = class extends Map {
  set() {
    return this;
  }
};
function toPosix(relative) {
  return relative.split(path13.sep).join("/");
}
async function verifyBundleContents(bundlePath, expected) {
  const wanted = new Map(expected.map((file) => [file.path, file]));
  const seen = /* @__PURE__ */ new Set();
  const problems = [];
  await Ct({
    ...TAR_READ_OPTIONS,
    file: bundlePath,
    onReadEntry: (entry) => {
      const entryPath = toPosix(entry.path).replace(/\/$/, "");
      const want = wanted.get(entryPath);
      if (want === void 0) {
        entry.resume();
        return;
      }
      seen.add(entryPath);
      const hash = createHash2("sha256");
      let bytes = 0;
      entry.on("data", (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      entry.on("end", () => {
        if (bytes !== want.bytes) {
          problems.push(`${entryPath}: ${String(bytes)} bytes, expected ${String(want.bytes)}`);
        } else if (hash.digest("hex") !== want.sha256) {
          problems.push(`${entryPath}: content does not match its hash`);
        }
      });
    }
  });
  for (const file of expected) {
    if (!seen.has(file.path)) problems.push(`${file.path}: missing from the bundle`);
  }
  return problems.length === 0 ? null : problems.slice(0, 5).join("; ");
}

// src/adapters/transcript-file.ts
import { createReadStream as createReadStream2 } from "node:fs";
import readline from "node:readline";

// src/core/transcript.ts
var MAX_PROMPT_CHARS = 8e3;
var MAX_PROMPTS = 1e3;
var KEEP_FIRST_PROMPTS = 200;
var MAX_FILES = 500;
function createExtractor() {
  let sessionId = null;
  let title = null;
  let lastPrompt = null;
  let projectCwd = null;
  let gitBranch = null;
  let startedAt = null;
  let endedAt = null;
  let messageCount = 0;
  let malformedLines = 0;
  const prompts = [];
  let nextPromptSeq = 0;
  const files = /* @__PURE__ */ new Set();
  const noteTimestamp = (record) => {
    const ts2 = parseTimestamp(record["timestamp"]);
    if (ts2 === null) return;
    if (startedAt === null || ts2 < startedAt) startedAt = ts2;
    if (endedAt === null || ts2 > endedAt) endedAt = ts2;
  };
  return {
    pushLine(line) {
      const trimmed2 = line.trim();
      if (trimmed2.length === 0) return;
      let record;
      try {
        const parsed = JSON.parse(trimmed2);
        if (typeof parsed !== "object" || parsed === null) {
          malformedLines++;
          return;
        }
        record = parsed;
      } catch {
        malformedLines++;
        return;
      }
      sessionId ??= asString3(record["sessionId"]);
      const type = asString3(record["type"]);
      if (type === "ai-title") {
        title = asString3(record["aiTitle"]) ?? title;
        return;
      }
      if (type === "summary") {
        title ??= asString3(record["summary"]);
        return;
      }
      if (type === "last-prompt") {
        lastPrompt = asString3(record["lastPrompt"]) ?? lastPrompt;
        return;
      }
      if (type !== "user" && type !== "assistant") return;
      noteTimestamp(record);
      projectCwd ??= asString3(record["cwd"]);
      const branch = asString3(record["gitBranch"]);
      if (branch !== null && branch.length > 0) gitBranch = branch;
      if (record["isSidechain"] === true) return;
      messageCount++;
      if (type === "assistant") {
        collectToolPaths(record, files);
        return;
      }
      if (record["isMeta"] === true) return;
      if (record["toolUseResult"] !== void 0) return;
      const text = userPromptText(record);
      if (text === null) return;
      if (prompts.length >= MAX_PROMPTS) prompts.splice(KEEP_FIRST_PROMPTS, 1);
      prompts.push({
        seq: nextPromptSeq++,
        ts: parseTimestamp(record["timestamp"]),
        text: text.slice(0, MAX_PROMPT_CHARS)
      });
    },
    finish() {
      return {
        sessionId,
        title,
        lastPrompt: lastPrompt ?? prompts.at(-1)?.text ?? null,
        projectCwd,
        gitBranch,
        startedAt,
        endedAt,
        messageCount,
        prompts,
        files: [...files].slice(0, MAX_FILES),
        malformedLines
      };
    }
  };
}
function userPromptText(record) {
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = message["content"];
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts2 = [];
    for (const block2 of content) {
      if (typeof block2 !== "object" || block2 === null) continue;
      const blockRecord = block2;
      if (blockRecord["type"] === "tool_result") return null;
      if (blockRecord["type"] === "text") {
        const value = asString3(blockRecord["text"]);
        if (value !== null) parts2.push(value);
      }
    }
    if (parts2.length === 0) return null;
    text = parts2.join("\n");
  } else {
    return null;
  }
  return cleanPromptText(text);
}
var SYNTHETIC_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<user-memory-input>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>"
];
function cleanPromptText(raw) {
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (text.length === 0) return null;
  for (const prefix of SYNTHETIC_PREFIXES) {
    if (text.startsWith(prefix)) return null;
  }
  const commandName = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (commandName !== null) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    const name = (commandName[1] ?? "").trim();
    const argText = (args?.[1] ?? "").trim();
    const joined = argText.length > 0 ? `${name} ${argText}` : name;
    return joined.length > 0 ? joined : null;
  }
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "").trim();
  return text.length > 0 ? text : null;
}
function collectToolPaths(record, into) {
  if (into.size >= MAX_FILES) return;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return;
  const content = message["content"];
  if (!Array.isArray(content)) return;
  for (const block2 of content) {
    if (typeof block2 !== "object" || block2 === null) continue;
    const blockRecord = block2;
    if (blockRecord["type"] !== "tool_use") continue;
    const input = blockRecord["input"];
    if (typeof input !== "object" || input === null) continue;
    const inputRecord = input;
    for (const key of ["file_path", "notebook_path", "path"]) {
      const value = asString3(inputRecord[key]);
      if (value !== null && value.length > 0 && into.size < MAX_FILES) into.add(value);
    }
  }
}
function asString3(value) {
  return typeof value === "string" ? value : null;
}
var MAX_EPOCH_MS = 864e13;
function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return Math.abs(truncated) <= MAX_EPOCH_MS ? truncated : null;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.trunc(parsed);
}

// src/adapters/transcript-file.ts
async function extractFromFile(file, signal) {
  const extractor = createExtractor();
  const stream = createReadStream2(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      extractor.pushLine(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return extractor.finish();
}

// src/core/manifest.ts
var MANIFEST_VERSION = 1;
function buildManifest(args) {
  return {
    manifestVersion: MANIFEST_VERSION,
    archiverVersion: args.archiverVersion,
    sessionId: args.sessionId,
    projectCwd: args.projectCwd,
    encodedDir: args.encodedDir,
    title: args.title,
    startedAt: toIso(args.startedAt),
    endedAt: toIso(args.endedAt),
    createdAt: new Date(args.createdAt).toISOString(),
    bundle: {
      name: args.bundleName,
      sha256: args.bundleSha256,
      bytes: args.bundleBytes,
      compression: "zstd",
      compressionLevel: args.compressionLevel
    },
    files: args.files,
    uncompressedBytes: args.files.reduce((total, file) => total + file.bytes, 0)
  };
}
function toIso(epochMs) {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

// src/core/slug.ts
var WINDOWS_ILLEGAL = /[<>:"/\\|?*]/g;
var CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
var COMBINING_MARKS = /[\u0300-\u036f]/g;
var WINDOWS_RESERVED = /* @__PURE__ */ new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);
var MAX_FILENAME_BYTES = 200;
function isWindowsReservedName(name) {
  const stem = name.split(".")[0] ?? "";
  return WINDOWS_RESERVED.has(stem.toLowerCase());
}
function sanitizeFileName(input, fallback = "untitled") {
  let name = input.normalize("NFC").replace(CONTROL_CHARS, "").replace(WINDOWS_ILLEGAL, "-");
  name = name.replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  name = truncateUtf8(name, MAX_FILENAME_BYTES).replace(/[. ]+$/, "");
  if (name.length === 0 || /^[-_. ]+$/.test(name)) return fallback;
  if (isWindowsReservedName(name)) return `_${name}`;
  return name;
}
function slugifyTitle(title, maxBytes = 60) {
  const slug = title.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "session";
  return truncateUtf8(slug, maxBytes).replace(/-+$/, "") || "session";
}
function shortSessionId(sessionId) {
  const compact = sessionId.replace(/[^a-zA-Z0-9]/g, "");
  return compact.slice(0, 8) || "nosessid";
}
function bundleBaseName(args) {
  const slug = slugifyTitle(args.title ?? "");
  const short = shortSessionId(args.sessionId);
  const digest = contentTag(args.contentHash);
  const base = `${args.date}_${slug}_${short}${digest}`;
  return sanitizeFileName(base, `${args.date}_session_${short}${digest}`);
}
function contentTag(hash) {
  if (typeof hash !== "string") return "";
  const hex = hash.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase();
  return hex.length === 8 ? `_${hex}` : "";
}
function nameableEpoch(epochMs) {
  if (!Number.isFinite(epochMs)) return 0;
  return Math.min(Math.max(Math.trunc(epochMs), 0), MAX_NAMEABLE_EPOCH_MS);
}
var MAX_NAMEABLE_EPOCH_MS = 253402300799999;
function isoDate(epochMs) {
  return new Date(nameableEpoch(epochMs)).toISOString().slice(0, 10);
}
function isoYear(epochMs) {
  return new Date(nameableEpoch(epochMs)).toISOString().slice(0, 4);
}
function truncateUtf8(input, maxBytes) {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let bytes = 0;
  let out = "";
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

// src/worker/upload.ts
import fsp9 from "node:fs/promises";
var UNKNOWN_CHECKSUM_LIMIT = 8;
async function uploadWithResume(ctx, args) {
  const log = ctx.logger.child({ session_id: args.job.sessionId ?? "", name: args.name });
  const chunkSize = alignChunkSize(args.chunkSize ?? CHUNK_SIZE);
  const stored = parseUploadUri(args.job.uploadUri);
  let uploadUri = stored !== null && stored.sha256 === args.sha256 && stored.parentId === args.parentId ? stored.uri : null;
  if (stored !== null && uploadUri === null) {
    log.info("upload.uri_belongs_to_another_bundle");
    setUploadUri(ctx.db, args.job, null, ctx.clock.now());
  }
  let confirmed = 0;
  if (uploadUri !== null) {
    const progress = await ctx.drive.probeUpload(
      { uploadUri, totalBytes: args.totalBytes },
      ctx.signal
    );
    if (progress === null) {
      log.info("upload.session_expired");
      uploadUri = null;
      setUploadUri(ctx.db, args.job, null, ctx.clock.now());
    } else if (progress.done && progress.file !== null) {
      if (matchesLocal(progress.file, args) !== "mismatch") {
        log.info("upload.already_complete");
        setUploadUri(ctx.db, args.job, null, ctx.clock.now());
        return progress.file;
      }
      log.warn("upload.complete_but_mismatched", { file_id: progress.file.id });
      uploadUri = null;
      setUploadUri(ctx.db, args.job, null, ctx.clock.now());
    } else {
      confirmed = progress.confirmedBytes;
      log.info("upload.resuming", { confirmed_bytes: confirmed });
    }
  }
  if (uploadUri === null) {
    const existing = await ctx.drive.findFile(
      { name: args.name, parentId: args.parentId },
      ctx.signal
    );
    const verdict = existing === null ? "mismatch" : matchesLocal(existing, args);
    if (existing !== null && verdict === "match") {
      log.info("upload.found_existing", { file_id: existing.id });
      return existing;
    }
    if (existing !== null && verdict === "unknown") {
      if (args.job.attempts >= UNKNOWN_CHECKSUM_LIMIT) {
        throw new FatalError(
          `Drive has never reported a checksum for the existing ${args.name}`,
          "Check that file in Drive: if it is not this session's bundle, move it to the wastebasket and run /archive:now."
        );
      }
      throw new RetryableError(
        `Drive has not reported a checksum for the existing ${args.name}; leaving it alone`
      );
    }
    if (existing !== null) {
      log.warn("upload.trashing_mismatched_remote", { file_id: existing.id });
      await ctx.drive.trashFile(existing.id, ctx.signal);
    }
    uploadUri = await ctx.drive.startResumableUpload(
      {
        name: args.name,
        parentId: args.parentId,
        mimeType: args.mimeType,
        totalBytes: args.totalBytes,
        // Stamped on the file so an audit can verify it without local state.
        appProperties: { sha256: args.sha256, ...args.appProperties }
      },
      ctx.signal
    );
    setUploadUri(
      ctx.db,
      args.job,
      tagUploadUri(uploadUri, args.sha256, args.parentId),
      ctx.clock.now()
    );
    confirmed = 0;
  }
  const handle = await fsp9.open(args.filePath, "r");
  try {
    while (confirmed < args.totalBytes) {
      ctx.signal?.throwIfAborted();
      const length = Math.min(chunkSize, args.totalBytes - confirmed);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, confirmed);
      if (bytesRead !== length) {
        throw new RetryableError(
          `the bundle shrank while uploading: wanted ${String(length)} bytes at ${String(confirmed)}`
        );
      }
      let progress;
      try {
        progress = await ctx.drive.uploadChunk(
          { uploadUri, body: buffer, offset: confirmed, totalBytes: args.totalBytes },
          ctx.signal
        );
      } catch (err) {
        if (err instanceof UploadSessionExpired) {
          setUploadUri(ctx.db, args.job, null, ctx.clock.now());
          throw new RetryableError("the upload session expired mid-transfer", { cause: err });
        }
        throw err;
      }
      heartbeatClaim(ctx.db, args.job, ctx.clock.now(), ctx.config.jobVisibilityMs);
      if (progress.done && progress.file !== null) {
        setUploadUri(ctx.db, args.job, null, ctx.clock.now());
        return progress.file;
      }
      if (progress.confirmedBytes <= confirmed) {
        throw new RetryableError(
          `Drive confirmed no progress past ${String(confirmed)} of ${String(args.totalBytes)} bytes`
        );
      }
      confirmed = progress.confirmedBytes;
      log.debug("upload.progress", { confirmed_bytes: confirmed, total_bytes: args.totalBytes });
    }
  } finally {
    await handle.close();
  }
  throw new RetryableError("the upload finished without Drive returning the file");
}
function tagUploadUri(uri, sha256, parentId = "") {
  return `${sha256}:${parentId}|${uri}`;
}
function parseUploadUri(stored) {
  if (stored === null) return null;
  const separator = stored.indexOf("|");
  if (separator <= 0) return null;
  const tag = stored.slice(0, separator);
  const colon = tag.indexOf(":");
  return colon < 0 ? { sha256: tag, parentId: "", uri: stored.slice(separator + 1) } : {
    sha256: tag.slice(0, colon),
    parentId: tag.slice(colon + 1),
    uri: stored.slice(separator + 1)
  };
}
function matchesLocal(remote, args) {
  if (remote.sha256 !== null) {
    return remote.sha256.toLowerCase() === args.sha256.toLowerCase() ? "match" : "mismatch";
  }
  if (remote.md5 !== null && args.md5 !== void 0) {
    return remote.md5.toLowerCase() === args.md5.toLowerCase() ? "match" : "mismatch";
  }
  if (remote.size !== null && remote.size !== args.totalBytes) return "mismatch";
  return "unknown";
}

// src/worker/backup.ts
async function backupSession(ctx, job, args) {
  const log = ctx.logger.child({ session_id: args.sessionId });
  const session = await statSession(ctx.paths, args.encodedDir, args.sessionId);
  if (session === null) {
    log.info("backup.transcript_missing");
    return { status: "missing" };
  }
  if (session.sidecarUnreadable) {
    throw new FatalError(
      `the sidecar directory for ${args.sessionId} cannot be read as a plain directory`,
      `Check the session directory beside its transcript: a permission problem or a symbolic link both land here, and a link cannot be archived consistently. Fix it and run /archive:now. Nothing has been archived or deleted for this session.`
    );
  }
  const now = ctx.clock.now();
  const previous = getSession(ctx.db, session.sessionId);
  const summary = await indexSession(ctx, session, previous, now);
  const bundle = await buildBundle(ctx, session, summary, now);
  try {
    const remote = await publish(ctx, job, session, bundle, summary, previous, now);
    log.info("backup.verified", { bytes: bundle.bytes, file_id: remote.id });
    return { status: "verified", bundleBytes: bundle.bytes, remoteFileId: remote.id };
  } finally {
    await fsp10.rm(bundle.path, { force: true }).catch(() => void 0);
  }
}
async function indexSession(ctx, session, previous, now) {
  const log = ctx.logger.child({ session_id: session.sessionId });
  let summary = null;
  try {
    summary = await extractFromFile(session.transcriptPath, ctx.signal);
  } catch (err) {
    log.warn("catalog.extract_failed", {}, err);
  }
  const transcriptSha256 = await sha256File(session.transcriptPath, ctx.signal);
  upsertSession(
    ctx.db,
    {
      sessionId: session.sessionId,
      encodedDir: session.encodedDir,
      projectCwd: summary?.projectCwd ?? null,
      title: summary?.title ?? null,
      summary: summary?.lastPrompt ?? null,
      gitBranch: summary?.gitBranch ?? null,
      startedAt: summary?.startedAt ?? null,
      endedAt: summary?.endedAt ?? null,
      messageCount: summary?.messageCount ?? null,
      transcriptBytes: session.transcriptBytes,
      transcriptSha256,
      sidecarBytes: session.sidecarBytes,
      lastLocalMtime: Math.trunc(session.mtimeMs)
    },
    now
  );
  const shrunk = previous?.verifiedTranscriptBytes != null && session.transcriptBytes < previous.verifiedTranscriptBytes;
  if (shrunk) {
    log.warn("catalog.index_kept", {
      transcript_bytes: session.transcriptBytes,
      archived_bytes: previous.verifiedTranscriptBytes
    });
  }
  if (summary !== null && !shrunk) {
    try {
      const existingPrompts = countPrompts(ctx.db, session.sessionId);
      const collapsed = existingPrompts > 8 && summary.prompts.length < existingPrompts;
      if (collapsed) {
        log.warn("catalog.index_collapse_ignored", {
          found: summary.prompts.length,
          kept: existingPrompts
        });
      }
      if (!collapsed && (summary.prompts.length > 0 || existingPrompts === 0)) {
        replacePrompts(ctx.db, session.sessionId, summary.prompts);
      }
    } catch (err) {
      log.warn("catalog.prompts_failed", {}, err);
    }
    try {
      if (summary.files.length > 0 || countSessionFiles(ctx.db, session.sessionId) === 0) {
        replaceFiles(ctx.db, session.sessionId, summary.files);
      }
    } catch (err) {
      log.warn("catalog.files_failed", {}, err);
    }
    if (summary.malformedLines > 0) {
      log.warn("catalog.malformed_lines", { count: summary.malformedLines });
    }
  }
  return {
    title: summary?.title ?? null,
    projectCwd: summary?.projectCwd ?? null,
    startedAt: summary?.startedAt ?? null,
    endedAt: summary?.endedAt ?? null
  };
}
async function buildBundle(ctx, session, index, now) {
  const stamp = (index.endedAt ?? index.startedAt ?? Math.trunc(session.mtimeMs)) || now;
  const title = index.title;
  const date = isoDate(stamp);
  const outputPath = path14.join(ctx.paths.stagingDir, `${session.sessionId}.building.tar.zst`);
  const result = await createBundle({
    cwd: path14.dirname(session.transcriptPath),
    entries: bundleEntries(session),
    outputPath,
    compressionLevel: ctx.config.zstdLevel,
    ...ctx.signal === void 0 ? {} : { signal: ctx.signal }
  });
  const name = `${bundleBaseName({
    date,
    title,
    sessionId: session.sessionId,
    contentHash: result.sha256
  })}.tar.zst`;
  markBundled(
    ctx.db,
    session.sessionId,
    {
      bundleName: name,
      bundleBytes: result.bytes,
      bundleSha256: result.sha256,
      archiverVersion: ctx.version
    },
    ctx.clock.now()
  );
  return {
    path: result.path,
    name,
    bytes: result.bytes,
    sha256: result.sha256,
    md5: result.md5,
    date,
    year: isoYear(stamp)
  };
}
async function publish(ctx, job, session, bundle, index, previous, now) {
  const folderPath = [ctx.config.driveRootFolder, session.encodedDir, bundle.year];
  const parentId = await ctx.drive.ensureFolder(folderPath, ctx.signal);
  const before = await statSession(ctx.paths, session.encodedDir, session.sessionId);
  const files = await describeSessionFiles({
    cwd: path14.dirname(session.transcriptPath),
    entries: bundleEntries(session),
    ...ctx.signal === void 0 ? {} : { signal: ctx.signal }
  });
  const contentProblem = await verifyBundleContents(bundle.path, files);
  if (contentProblem !== null) {
    throw new RetryableError(`the bundle does not match the session on disk: ${contentProblem}`);
  }
  const archivedBytes = files.reduce((total, file) => total + file.bytes, 0);
  const confirmed = await statSession(ctx.paths, session.encodedDir, session.sessionId);
  if (confirmed === null || confirmed.transcriptBytes + confirmed.sidecarBytes !== archivedBytes) {
    throw new RetryableError("the session changed while it was being archived");
  }
  if (before === null || Math.trunc(confirmed.mtimeMs) !== Math.trunc(before.mtimeMs)) {
    throw new RetryableError("the session was written to while it was being archived");
  }
  const archivedTranscript = files.find((file) => file.path === `${session.sessionId}.jsonl`)?.bytes ?? 0;
  const archivedSidecar = archivedBytes - archivedTranscript;
  const shrank = describeShrink(previous, {
    transcript: archivedTranscript,
    sidecar: archivedSidecar,
    total: archivedBytes
  });
  if (shrank !== null) {
    throw new FatalError(
      `${session.sessionId} has less on disk than the copy on Drive: ${shrank}`,
      "Archiving now would replace the fuller copy with the smaller one. Run /archive:resume to recover the archived copy beside the local files, then remove whichever you do not want. Nothing has been changed."
    );
  }
  const contains = await describeContainment(ctx, session, previous, files);
  const remote = await uploadWithResume(ctx, {
    job,
    filePath: bundle.path,
    name: bundle.name,
    parentId,
    mimeType: "application/zstd",
    totalBytes: bundle.bytes,
    sha256: bundle.sha256,
    md5: bundle.md5,
    appProperties: { sessionId: session.sessionId, archiver: ctx.version }
  });
  await verifyRemote(ctx, session.sessionId, remote, bundle);
  const manifest = buildManifest({
    archiverVersion: ctx.version,
    sessionId: session.sessionId,
    projectCwd: index.projectCwd,
    encodedDir: session.encodedDir,
    title: index.title,
    startedAt: index.startedAt,
    endedAt: index.endedAt,
    createdAt: now,
    bundleName: bundle.name,
    bundleSha256: bundle.sha256,
    bundleBytes: bundle.bytes,
    compressionLevel: ctx.config.zstdLevel,
    files
  });
  const manifestName = `${bundle.name.replace(/\.tar\.zst$/, "")}.manifest.json`;
  const existingManifest = await ctx.drive.findFile({ name: manifestName, parentId }, ctx.signal);
  await ctx.drive.uploadSmallFile(
    {
      name: manifestName,
      parentId,
      mimeType: "application/json",
      body: Buffer.from(`${JSON.stringify(manifest, null, 2)}
`, "utf8"),
      appProperties: { sessionId: session.sessionId },
      ...existingManifest === null ? {} : { replaceFileId: existingManifest.id }
    },
    ctx.signal
  );
  const supersededId = previous?.remoteFileId ?? null;
  markVerified(
    ctx.db,
    session.sessionId,
    {
      fileId: remote.id,
      path: `${folderPath.join("/")}/${bundle.name}`,
      localMtime: Math.trunc(confirmed.mtimeMs),
      localBytes: archivedBytes,
      transcriptBytes: archivedTranscript,
      sidecarBytes: archivedSidecar,
      bundleBytes: bundle.bytes,
      bundleSha256: bundle.sha256,
      bundleMd5: bundle.md5,
      manifest: encodeManifest(files),
      // From the same hashing pass that verifyBundleContents checked the
      // bundle against, so it describes the archived bytes. Hashing the file
      // separately opens a window in which a live session appends between the
      // hash and the read, leaving a row that verifies but cannot be restored.
      transcriptSha256: files.find((file) => file.path === `${session.sessionId}.jsonl`)?.sha256 ?? null
    },
    ctx.clock.now()
  );
  const sameProject = previous?.encodedDir === session.encodedDir;
  const retiring = supersededId !== null && supersededId !== remote.id && sameProject;
  if (supersededId !== null && supersededId !== remote.id && (contains !== null || !sameProject)) {
    const reason = contains ?? "the session moved to another project directory";
    ctx.logger.warn("backup.superseded_kept", {
      session_id: session.sessionId,
      file_id: supersededId,
      reason
    });
    recordRetainedBundle(
      ctx.db,
      {
        sessionId: session.sessionId,
        fileId: supersededId,
        remotePath: previous?.remotePath ?? null,
        bundleSha256: previous?.verifiedBundleSha256 ?? null,
        bundleBytes: previous?.verifiedBundleBytes ?? null,
        bundleMd5: previous?.verifiedBundleMd5 ?? null,
        manifest: previous?.verifiedManifest ?? null,
        reason
      },
      ctx.clock.now()
    );
  }
  if (retiring && contains === null) {
    try {
      await ctx.drive.trashFile(supersededId, ctx.signal);
    } catch (err) {
      ctx.logger.warn("backup.superseded_cleanup_failed", { file_id: supersededId }, err);
    }
  }
  return remote;
}
async function verifyRemote(ctx, sessionId, uploaded, bundle) {
  let meta = await ctx.drive.getFile(uploaded.id, ctx.signal);
  let problem = compareChecksums(meta, bundle);
  if (problem === null) return;
  if (meta.sha256 === null && meta.md5 === null) {
    await ctx.clock.sleep(2e3);
    meta = await ctx.drive.getFile(uploaded.id, ctx.signal);
    problem = compareChecksums(meta, bundle);
    if (problem === null) return;
  }
  ctx.logger.error("backup.verification_failed", { session_id: sessionId, reason: problem });
  clearVerification(ctx.db, sessionId, ctx.clock.now());
  if (meta.sha256 === null && meta.md5 === null) {
    throw new RetryableError(`Drive has not reported a checksum for ${uploaded.id} yet`);
  }
  await ctx.drive.trashFile(uploaded.id, ctx.signal).catch(() => void 0);
  throw new RetryableError(`Drive copy did not match the local bundle: ${problem}`);
}
function encodeManifest(files) {
  return JSON.stringify(files.map((file) => [file.path, file.sha256]));
}
function decodeManifest(encoded) {
  const out = /* @__PURE__ */ new Map();
  if (encoded === null) return out;
  try {
    const parsed = JSON.parse(encoded);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        out.set(entry[0], entry[1]);
      }
    }
  } catch {
  }
  return out;
}
async function describeContainment(ctx, session, previous, files) {
  if (!hasAllFloors(previous) || previous === null)
    return "the archived copy is not fully described";
  const archived = decodeManifest(previous.verifiedManifest);
  if (archived.size === 0) return "the archived file list is not recorded";
  const current = new Map(files.map((file) => [file.path, file.sha256]));
  const transcript = `${session.sessionId}.jsonl`;
  for (const [entryPath, hash] of archived) {
    if (entryPath === transcript) continue;
    const now = current.get(entryPath);
    if (now === void 0) return `${entryPath} is no longer present`;
    if (now !== hash) return `${entryPath} has different content`;
  }
  const floor = previous.verifiedTranscriptBytes;
  const expected = previous.verifiedTranscriptSha256;
  if (floor === null || expected === null) return "the archived transcript is not described";
  const prefix = await sha256Prefix(session.transcriptPath, floor, ctx.signal);
  if (prefix === null) return "the transcript is shorter than the archived one";
  if (prefix !== expected) return "the transcript no longer begins with the archived content";
  return null;
}
function hasAllFloors(previous) {
  return previous?.verifiedTranscriptBytes != null && previous.verifiedSidecarBytes !== null && previous.verifiedLocalBytes !== null && previous.verifiedTranscriptSha256 !== null;
}
function describeShrink(previous, now) {
  if (previous?.remoteFileId == null) return null;
  const complaints = [];
  const check = (label, floor, current) => {
    if (floor !== null && current < floor) {
      complaints.push(`${label} ${String(current)} bytes, archived ${String(floor)}`);
    }
  };
  check("transcript", previous.verifiedTranscriptBytes, now.transcript);
  check("sidecar", previous.verifiedSidecarBytes, now.sidecar);
  check("total", previous.verifiedLocalBytes, now.total);
  return complaints.length === 0 ? null : complaints.join("; ");
}
function compareChecksums(remote, bundle) {
  if (remote.trashed === true) return "the remote copy is in the wastebasket";
  const sizeProblem = remote.size !== null && remote.size !== bundle.bytes ? `size ${String(remote.size)} != ${String(bundle.bytes)}` : null;
  if (sizeProblem !== null && remote.sha256 === null && remote.md5 === null) return sizeProblem;
  if (sizeProblem !== null) {
    const hashAgrees = remote.sha256 !== null && remote.sha256.toLowerCase() === bundle.sha256.toLowerCase() || remote.md5 !== null && remote.md5.toLowerCase() === bundle.md5.toLowerCase();
    if (!hashAgrees) return sizeProblem;
    return null;
  }
  if (remote.sha256 !== null) {
    return remote.sha256.toLowerCase() === bundle.sha256.toLowerCase() ? null : "sha256 mismatch";
  }
  if (remote.md5 !== null) {
    return remote.md5.toLowerCase() === bundle.md5.toLowerCase() ? null : "md5 mismatch";
  }
  return "Drive returned no checksum";
}

// src/worker/reap.ts
import fsp11 from "node:fs/promises";
import path15 from "node:path";
var SKIP_COOLDOWN_MS = 24 * 60 * 6e4;
async function reapLocalCopies(ctx, now, limit) {
  let projectDirsCache = null;
  const projectDirs = async () => {
    projectDirsCache ??= await fsp11.readdir(ctx.paths.projectsDir).catch(() => []);
    return projectDirsCache;
  };
  const report = {
    deleted: 0,
    bytesFreed: 0,
    requeued: 0,
    skipped: 0,
    unverified: 0,
    unconfirmable: 0,
    orphanSidecars: 0,
    blockedReason: null
  };
  if (!ctx.config.enabled || ctx.config.keepLocalForever) return report;
  const cutoff = reapCutoff(now, ctx.config.retentionDays);
  for (const record of listReapable(ctx.db, cutoff, now, limit)) {
    ctx.signal?.throwIfAborted();
    const log = ctx.logger.child({ session_id: record.sessionId });
    const target = safeTarget(ctx, record);
    if (target === null) {
      log.error("reap.unsafe_identifiers", {
        encoded_dir: record.encodedDir,
        reason: "identifier or path failed validation"
      });
      report.skipped++;
      continue;
    }
    if (!hasVerifiedState(record)) {
      report.skipped++;
      continue;
    }
    let onDisk;
    try {
      onDisk = await statSession(ctx.paths, record.encodedDir, record.sessionId);
    } catch (err) {
      log.warn("reap.stat_failed", {}, err);
      markReapSkipped(ctx.db, record.sessionId, "stat-failed", now + SKIP_COOLDOWN_MS, now);
      report.skipped++;
      continue;
    }
    if (onDisk === null) {
      const sidecar = path15.join(ctx.paths.projectsDir, record.encodedDir, record.sessionId);
      if (await isDirectory(sidecar)) {
        log.warn("reap.orphan_sidecar", { encoded_dir: record.encodedDir });
        markReapSkipped(ctx.db, record.sessionId, "orphan-sidecar", now + SKIP_COOLDOWN_MS, now);
        report.orphanSidecars++;
        report.skipped++;
        continue;
      }
      const elsewhere = await findSessionElsewhere(ctx, record, await projectDirs());
      if (elsewhere !== null) {
        log.info("reap.session_moved", { encoded_dir: elsewhere });
        report.skipped++;
        continue;
      }
      markLocalDeleted(ctx.db, record.sessionId, now);
      continue;
    }
    if (onDisk.sidecarUnreadable) {
      markReapSkipped(ctx.db, record.sessionId, "sidecar-unreadable", now + SKIP_COOLDOWN_MS, now);
      report.skipped++;
      continue;
    }
    if (changedSinceVerification(record, onDisk)) {
      markLocalPresent(ctx.db, record.sessionId, Math.trunc(onDisk.mtimeMs), now);
      enqueue(
        ctx.db,
        { kind: "backup", sessionId: record.sessionId, payload: { encodedDir: record.encodedDir } },
        now
      );
      log.info("reap.changed_since_backup");
      report.requeued++;
      continue;
    }
    if (Math.trunc(onDisk.mtimeMs) >= cutoff) {
      report.skipped++;
      continue;
    }
    if (record.verifiedAt !== null && now - record.verifiedAt < ctx.config.archiveGraceDays * DAY_MS) {
      report.skipped++;
      continue;
    }
    if (isSessionActive(ctx, record.sessionId, now)) {
      log.info("reap.session_active");
      markReapSkipped(ctx.db, record.sessionId, "session-active", now + SKIP_COOLDOWN_MS, now);
      report.skipped++;
      continue;
    }
    const remote = await confirmRemote(ctx, record, report);
    if (remote === "gone") {
      log.warn("reap.remote_no_longer_valid");
      clearVerification(ctx.db, record.sessionId, now);
      enqueue(
        ctx.db,
        { kind: "backup", sessionId: record.sessionId, payload: { encodedDir: record.encodedDir } },
        now
      );
      report.unverified++;
      continue;
    }
    if (remote === "blocked") {
      report.skipped++;
      break;
    }
    if (remote === "unavailable") {
      report.skipped++;
      report.unconfirmable++;
      continue;
    }
    const settled = await statSession(ctx.paths, record.encodedDir, record.sessionId);
    if (settled === null || changedSinceVerification(record, settled) || isSessionActive(ctx, record.sessionId, ctx.clock.now())) {
      report.skipped++;
      continue;
    }
    const divergence = await describeDivergence(ctx, record, settled);
    if (divergence !== null) {
      log.warn("reap.content_differs", { reason: divergence });
      clearVerification(ctx.db, record.sessionId, now);
      enqueue(
        ctx.db,
        { kind: "backup", sessionId: record.sessionId, payload: { encodedDir: record.encodedDir } },
        now
      );
      report.unverified++;
      continue;
    }
    if (!await removeLocalCopy(ctx, settled, target)) {
      report.skipped++;
      continue;
    }
    markLocalDeleted(ctx.db, record.sessionId, now);
    report.deleted++;
    report.bytesFreed += onDisk.transcriptBytes + onDisk.sidecarBytes;
    log.info("reap.deleted", { bytes: onDisk.transcriptBytes + onDisk.sidecarBytes });
  }
  return report;
}
async function describeDivergence(ctx, record, onDisk) {
  const archived = decodeManifest(record.verifiedManifest);
  if (archived.size === 0) return "the archived file list is not recorded";
  let current;
  try {
    current = await describeSessionFiles({
      cwd: path15.dirname(onDisk.transcriptPath),
      entries: bundleEntries(onDisk),
      ...ctx.signal === void 0 ? {} : { signal: ctx.signal }
    });
  } catch (err) {
    return `the session could not be read: ${err instanceof Error ? err.message : "unknown"}`;
  }
  const byPath = new Map(current.map((file) => [file.path, file.sha256]));
  for (const [entryPath, hash] of archived) {
    const now = byPath.get(entryPath);
    if (now === void 0) return `${entryPath} is no longer on disk`;
    if (now !== hash) return `${entryPath} is not the file that was archived`;
  }
  for (const file of current) {
    if (!archived.has(file.path)) return `${file.path} was added after the archive was made`;
  }
  return null;
}
function isSessionActive(ctx, sessionId, now) {
  const seen = kvGetNumber(ctx.db, activeSessionKey(sessionId));
  if (seen === void 0) return false;
  const ttl = Math.max(ACTIVE_SESSION_TTL_MS, (ctx.config.retentionDays + 7) * DAY_MS);
  return now - seen < ttl;
}
function safeTarget(ctx, record) {
  if (!isSafeSessionId(record.sessionId) || !isSafeEncodedDir(record.encodedDir)) return null;
  const projectDir = path15.join(ctx.paths.projectsDir, record.encodedDir);
  const target = {
    transcriptPath: path15.join(projectDir, `${record.sessionId}.jsonl`),
    sidecarDir: path15.join(projectDir, record.sessionId)
  };
  try {
    assertInside(ctx.paths.projectsDir, projectDir, "project directory");
    assertInside(projectDir, target.transcriptPath, "transcript");
    assertInside(projectDir, target.sidecarDir, "sidecar directory");
  } catch {
    return null;
  }
  return target;
}
function hasVerifiedState(record) {
  return record.verifiedAt !== null && record.bundleSha256 !== null && record.remoteFileId !== null && record.verifiedLocalMtime !== null && record.verifiedBundleSha256 !== null;
}
function changedSinceVerification(record, onDisk) {
  if (Math.trunc(onDisk.mtimeMs) !== record.verifiedLocalMtime) return true;
  const bytes = onDisk.transcriptBytes + onDisk.sidecarBytes;
  return record.verifiedLocalBytes !== null && bytes !== record.verifiedLocalBytes;
}
async function confirmRemote(ctx, record, report) {
  if (record.remoteFileId === null) return "gone";
  try {
    const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
    if (remote.trashed === true) return "gone";
    if (remote.trashed === null) return "unavailable";
    const expectedBytes = record.verifiedBundleBytes;
    if (remote.size !== null && expectedBytes !== null && remote.size !== expectedBytes) {
      return "gone";
    }
    if (remote.sha256 !== null) {
      return remote.sha256.toLowerCase() === record.verifiedBundleSha256?.toLowerCase() ? "ok" : "gone";
    }
    if (remote.md5 !== null && record.verifiedBundleMd5 !== null) {
      return remote.md5.toLowerCase() === record.verifiedBundleMd5.toLowerCase() ? "ok" : "gone";
    }
    return "unavailable";
  } catch (err) {
    if (err instanceof FatalError) {
      if (err.status === 404) return "gone";
      ctx.logger.error("reap.remote_check_blocked", { session_id: record.sessionId }, err);
      report.blockedReason = `${err.message} \u2014 ${err.remediation}`;
      return "blocked";
    }
    ctx.logger.warn("reap.remote_check_failed", { session_id: record.sessionId }, err);
    return "unavailable";
  }
}
async function isDirectory(candidate) {
  try {
    return (await fsp11.lstat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
async function findSessionElsewhere(ctx, record, dirs) {
  for (const dir of dirs) {
    if (dir === record.encodedDir || !isSafeEncodedDir(dir)) continue;
    try {
      const stat = await fsp11.lstat(
        path15.join(ctx.paths.projectsDir, dir, `${record.sessionId}.jsonl`)
      );
      if (stat.isFile()) return dir;
    } catch {
    }
  }
  return null;
}
async function removeLocalCopy(ctx, onDisk, target) {
  const log = ctx.logger.child({ session_id: onDisk.sessionId });
  if (onDisk.hasSidecar) {
    try {
      await fsp11.rm(target.sidecarDir, { recursive: true, force: true });
    } catch (err) {
      log.warn("reap.sidecar_delete_failed", {}, err);
      return false;
    }
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp11.rm(target.transcriptPath, { force: true });
      return true;
    } catch (err) {
      const code = err.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" || attempt === 3) {
        log.warn("reap.delete_failed", {}, err);
        return false;
      }
      await ctx.clock.sleep(renameRetryDelay(attempt));
    }
  }
  return false;
}

// src/worker/restore.ts
async function verifyArchive(ctx, records) {
  const report = {
    checked: 0,
    ok: 0,
    okIds: [],
    mismatched: [],
    missing: [],
    unchecked: []
  };
  for (const record of records) {
    ctx.signal?.throwIfAborted();
    if (record.remoteFileId === null) {
      report.missing.push(record.sessionId);
      continue;
    }
    report.checked++;
    try {
      const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
      const canCheck = remote.sha256 !== null || remote.md5 !== null && record.verifiedBundleMd5 !== null;
      if (remote.trashed !== true && !canCheck) {
        report.checked--;
        report.unchecked.push({
          sessionId: record.sessionId,
          reason: "Drive returned no checksum"
        });
        continue;
      }
      const reason = remote.trashed === true ? "the bundle is in the Drive wastebasket and will be purged" : describeMismatch(record, remote.size, remote.sha256, remote.md5);
      if (reason === null) {
        report.ok++;
        report.okIds.push(record.sessionId);
      } else {
        clearVerification(ctx.db, record.sessionId, ctx.clock.now());
        report.mismatched.push({
          sessionId: record.sessionId,
          reason,
          // No local copy means "run /archive:now" cannot be the advice: there
          // is nothing left on this machine to upload.
          localDeleted: !record.localPresent
        });
      }
    } catch (err) {
      report.checked--;
      report.unchecked.push({
        sessionId: record.sessionId,
        reason: err instanceof Error ? err.message : "unreadable"
      });
    }
  }
  return report;
}
function describeMismatch(record, remoteSize, remoteSha256, remoteMd5) {
  const expectedBytes = record.verifiedBundleBytes;
  if (expectedBytes !== null && remoteSize !== null && remoteSize !== expectedBytes) {
    return `size ${String(remoteSize)} != ${String(expectedBytes)}`;
  }
  if (remoteSha256 !== null && record.verifiedBundleSha256 !== null) {
    return remoteSha256.toLowerCase() === record.verifiedBundleSha256.toLowerCase() ? null : "sha256 mismatch";
  }
  if (remoteMd5 !== null && record.verifiedBundleMd5 !== null) {
    return remoteMd5.toLowerCase() === record.verifiedBundleMd5.toLowerCase() ? null : "md5 mismatch";
  }
  if (record.verifiedBundleSha256 === null) {
    return "the catalog has no verified hash for this bundle";
  }
  return "Drive returned no checksum";
}

// src/worker/sweep.ts
async function runSweep(ctx, options = {}) {
  const startedAt = ctx.clock.now();
  const report = {
    ranAt: startedAt,
    durationMs: 0,
    discovered: 0,
    enqueued: 0,
    processed: 0,
    verified: 0,
    failed: 0,
    blocked: 0,
    reap: {
      deleted: 0,
      bytesFreed: 0,
      requeued: 0,
      skipped: 0,
      unverified: 0,
      unconfirmable: 0,
      orphanSidecars: 0,
      blockedReason: null
    },
    catalogUploaded: false,
    audited: 0,
    cooledDown: false,
    budgetExhausted: false,
    lastError: null
  };
  if (!ctx.config.enabled) {
    ctx.logger.info("sweep.disabled");
    report.durationMs = ctx.clock.now() - startedAt;
    return report;
  }
  const cooldownUntil = kvGetNumber(ctx.db, KV.circuitUntil) ?? 0;
  if (options.force !== true && cooldownUntil > startedAt) {
    ctx.logger.info("sweep.cooling_down", { until: cooldownUntil });
    report.cooledDown = true;
    report.durationMs = ctx.clock.now() - startedAt;
    return report;
  }
  const removed = [
    ...await removePartials(ctx.paths.stagingDir, ctx.clock.now()),
    // A restore downloads into its own directory; a killed one left the
    // partial file there with nothing to clean it up.
    ...await removePartials(ctx.paths.restoreDir, ctx.clock.now())
  ];
  if (removed.length > 0) ctx.logger.info("sweep.removed_partials", { count: removed.length });
  const revived = unblockStale(ctx.db, startedAt, BLOCK_RETRY_MS);
  if (revived > 0) ctx.logger.info("sweep.unblocked_stale", { count: revived });
  const discovery = await discover(ctx, startedAt, {
    unblock: options.unblock === true,
    runNow: options.runNow === true
  });
  report.discovered = discovery.discovered;
  report.enqueued = discovery.enqueued;
  const deadline = startedAt + ctx.config.workerBudgetMs;
  const drained = await drain(ctx, deadline, report);
  report.budgetExhausted = drained.budgetExhausted;
  if (!drained.budgetExhausted && clockLooksSane(ctx, startedAt)) {
    report.reap = await reapLocalCopies(ctx, ctx.clock.now());
    const at2 = ctx.clock.now();
    kvSetNumber(ctx.db, KV.unconfirmableCount, report.reap.unconfirmable, at2);
    kvSetNumber(ctx.db, KV.reapUnverified, report.reap.unverified, at2);
    kvSetNumber(ctx.db, KV.orphanSidecars, report.reap.orphanSidecars, at2);
    kvSetNumber(ctx.db, KV.reapRanAt, at2, at2);
    kvSet(ctx.db, KV.reapBlockedReason, report.reap.blockedReason ?? "", at2);
  }
  if (!drained.budgetExhausted) report.audited = await auditReaped(ctx);
  if (report.verified > 0 || report.reap.deleted > 0 || catalogCopyIsStale(ctx)) {
    report.catalogUploaded = await uploadCatalogCopy(ctx);
  }
  const now = ctx.clock.now();
  kvSetNumber(ctx.db, KV.lastSweepAt, now, now);
  report.durationMs = now - startedAt;
  ctx.logger.info("sweep.done", {
    processed: report.processed,
    verified: report.verified,
    failed: report.failed,
    reaped: report.reap.deleted,
    duration_ms: report.durationMs
  });
  return report;
}
async function discover(ctx, now, flags) {
  let discovered = 0;
  let enqueued = 0;
  const skipped = [];
  const seen = /* @__PURE__ */ new Set();
  for await (const session of scanSessions(ctx.paths, skipped)) {
    ctx.signal?.throwIfAborted();
    discovered++;
    if (seen.has(session.sessionId)) {
      skipped.push({ kind: "session", name: session.sessionId, reason: "duplicate" });
      ctx.logger.warn("sweep.duplicate_session", {
        session_id: session.sessionId,
        encoded_dir: session.encodedDir
      });
      continue;
    }
    seen.add(session.sessionId);
    const mtime = Math.trunc(session.mtimeMs);
    const known = getSession(ctx.db, session.sessionId);
    if (known === null) {
      upsertSession(
        ctx.db,
        {
          sessionId: session.sessionId,
          encodedDir: session.encodedDir,
          transcriptBytes: session.transcriptBytes,
          sidecarBytes: session.sidecarBytes,
          lastLocalMtime: mtime
        },
        now
      );
    } else if (!known.localPresent || (known.lastLocalMtime ?? 0) !== mtime) {
      markLocalPresent(ctx.db, session.sessionId, mtime, now);
    }
    const bytes = session.transcriptBytes + session.sidecarBytes;
    const needsBackup = known?.verifiedAt == null || known.verifiedLocalMtime !== mtime || known.verifiedLocalBytes !== null && known.verifiedLocalBytes !== bytes || // A moved project directory changes neither the transcript's mtime nor
    // its size, and markLocalPresent does not write encoded_dir — so the
    // catalog kept pointing at the old directory, the reaper looked there,
    // found nothing, and recorded a live session as locally deleted.
    known.encodedDir !== session.encodedDir;
    if (needsBackup) {
      enqueue(
        ctx.db,
        {
          kind: "backup",
          sessionId: session.sessionId,
          payload: { encodedDir: session.encodedDir },
          ...flags.unblock ? { unblock: true } : {},
          ...flags.runNow ? { runNow: true } : {}
        },
        now
      );
      enqueued++;
    }
  }
  kvSetNumber(ctx.db, KV.lastScanAt, now, now);
  if (skipped.length > 0) {
    const unreadable = skipped.filter((entry) => entry.reason === "unreadable");
    ctx.logger.error("sweep.skipped_unarchivable", {
      count: skipped.length,
      unreadable: unreadable.length,
      first: skipped[0]?.name ?? ""
    });
    kvSetNumber(ctx.db, KV.skippedCount, skipped.length, now);
    kvSetNumber(ctx.db, KV.unreadableCount, unreadable.length, now);
  } else {
    kvSetNumber(ctx.db, KV.skippedCount, 0, now);
    kvSetNumber(ctx.db, KV.unreadableCount, 0, now);
  }
  return { discovered, enqueued };
}
async function drain(ctx, deadline, report) {
  for (; ; ) {
    const now = ctx.clock.now();
    if (now >= deadline) return { budgetExhausted: true };
    ctx.signal?.throwIfAborted();
    const job = claim(ctx.db, now, ctx.config.jobVisibilityMs);
    if (job === null) {
      const soonest = nextRunnableAt(ctx.db, now);
      if (soonest !== null && soonest - now <= DEBOUNCE_WAIT_MS && soonest < deadline) {
        await ctx.clock.sleep(Math.max(0, soonest - now));
        continue;
      }
      return { budgetExhausted: false };
    }
    report.processed++;
    try {
      await runJob(ctx, job, report);
      complete(ctx.db, job);
      noteSuccess(ctx);
    } catch (err) {
      report.failed++;
      report.lastError = describe(err);
      handleJobFailure(ctx, job, err, report);
    }
  }
}
async function runJob(ctx, job, report) {
  const sessionId = job.sessionId;
  if (sessionId === null) return;
  const payload = parsePayload(job);
  const known = getSession(ctx.db, sessionId);
  const encodedDir = typeof payload?.encodedDir === "string" ? payload.encodedDir : known?.encodedDir;
  if (encodedDir === void 0) {
    ctx.logger.warn("sweep.job_without_project", { session_id: sessionId });
    return;
  }
  const outcome = await backupSession(ctx, job, { sessionId, encodedDir });
  if (outcome.status === "verified") report.verified++;
}
function handleJobFailure(ctx, job, err, report) {
  const now = ctx.clock.now();
  const message = describe(err);
  if (err instanceof FatalError) {
    ctx.logger.error(
      "sweep.job_blocked",
      { session_id: job.sessionId, remediation: err.remediation },
      err
    );
    block(ctx.db, job, { error: `${message} \u2014 ${err.remediation}`, now });
    report.blocked++;
    if (isRetryableNetworkError(err)) noteFailure(ctx);
    return;
  }
  if (!isRetryableNetworkError(err) && job.attempts >= LOCAL_FAILURE_LIMIT) {
    ctx.logger.error(
      "sweep.job_blocked_after_local_failures",
      { session_id: job.sessionId, attempts: job.attempts },
      err
    );
    block(ctx.db, job, {
      error: `${message} (gave up after ${String(job.attempts)} local attempts)`,
      now
    });
    report.blocked++;
    return;
  }
  const at2 = nextAttemptAt({
    now,
    attempt: job.attempts,
    random: () => ctx.clock.random(),
    // The server told us when to come back. ARCHITECTURE §6: Retry-After always
    // wins. Only the HTTP client's own retries were honouring it.
    ...err instanceof RetryableError && err.retryAfterSeconds !== void 0 ? { retryAfterSeconds: err.retryAfterSeconds } : {}
  });
  ctx.logger.warn("sweep.job_retry", { session_id: job.sessionId, attempt: job.attempts, at: at2 }, err);
  retryLater(ctx.db, job, { at: at2, error: message });
  if (isRetryableNetworkError(err)) noteFailure(ctx);
}
function noteFailure(ctx) {
  const now = ctx.clock.now();
  const failures = (kvGetNumber(ctx.db, KV.circuitFailures) ?? 0) + 1;
  kvSetNumber(ctx.db, KV.circuitFailures, failures, now);
  if (failures >= 3) {
    kvSetNumber(ctx.db, KV.circuitUntil, now + circuitBackoffMs(failures - 2), now);
  }
}
function noteSuccess(ctx) {
  const now = ctx.clock.now();
  if ((kvGetNumber(ctx.db, KV.circuitFailures) ?? 0) === 0) return;
  kvSetNumber(ctx.db, KV.circuitFailures, 0, now);
  kvSetNumber(ctx.db, KV.circuitUntil, 0, now);
}
var IMPLAUSIBLE_CLOCK_JUMP_MS = 180 * 24 * 36e5;
function clockLooksSane(ctx, now) {
  const last = kvGetNumber(ctx.db, KV.lastSweepAt) ?? 0;
  if (last === 0) return true;
  if (now < last) {
    ctx.logger.warn("sweep.clock_went_backwards", { last_sweep_at: last, now });
    return false;
  }
  if (now - last > IMPLAUSIBLE_CLOCK_JUMP_MS) {
    ctx.logger.warn("sweep.clock_jumped_forward", { last_sweep_at: last, now });
    return false;
  }
  return true;
}
var BLOCK_RETRY_MS = 24 * 60 * 6e4;
var DEBOUNCE_WAIT_MS = 6e4;
var LOCAL_FAILURE_LIMIT = 5;
var CATALOG_REFRESH_MS = 24 * 36e5;
var AUDIT_BATCH = 10;
async function auditReaped(ctx) {
  const records = listReapedForAudit(ctx.db, AUDIT_BATCH);
  if (records.length === 0) return 0;
  const report = await verifyArchive(ctx, records);
  const at2 = ctx.clock.now();
  markAudited(
    ctx.db,
    records.map((record) => record.sessionId),
    at2
  );
  for (const sessionId of report.okIds) restoreVerification(ctx.db, sessionId, at2);
  if (report.mismatched.length > 0) {
    ctx.logger.error("sweep.archive_damaged", {
      count: report.mismatched.length,
      first: report.mismatched[0]?.reason ?? ""
    });
  }
  kvSetNumber(ctx.db, KV.auditMismatched, report.mismatched.length, at2);
  return report.checked;
}
function catalogCopyIsStale(ctx) {
  const last = kvGetNumber(ctx.db, KV.catalogUploadedAt) ?? 0;
  return ctx.clock.now() - last > CATALOG_REFRESH_MS;
}
function catalogFileName(machineId2) {
  return `catalog-${machineId2}.sqlite`;
}
function machineId(ctx) {
  const existing = kvGet(ctx.db, KV.machineId);
  if (existing !== void 0 && existing !== "") return existing;
  const minted = createHash3("sha256").update(`${os5.hostname()}:${randomBytes3(8).toString("hex")}`).digest("hex").slice(0, 8);
  kvSet(ctx.db, KV.machineId, minted, ctx.clock.now());
  return minted;
}
async function uploadCatalogCopy(ctx) {
  const destination = path16.join(
    ctx.paths.stagingDir,
    `catalog-${String(process.pid)}-${String(ctx.clock.now())}.sqlite.partial`
  );
  try {
    await fsp12.mkdir(ctx.paths.stagingDir, { recursive: true });
    await fsp12.rm(destination, { force: true });
    await getSqlite().backup(ctx.db, destination);
    const parentId = await ctx.drive.ensureFolder([ctx.config.driveRootFolder], ctx.signal);
    const cached2 = kvGet(ctx.db, KV.catalogFileId);
    const existingId = cached2 === void 0 || cached2 === "" ? void 0 : cached2;
    const existing = existingId ?? (await ctx.drive.findFile({ name: catalogFileName(machineId(ctx)), parentId }, ctx.signal))?.id;
    const uploaded = await ctx.drive.uploadSmallFile(
      {
        name: catalogFileName(machineId(ctx)),
        parentId,
        mimeType: "application/vnd.sqlite3",
        body: await fsp12.readFile(destination),
        ...existing === void 0 ? {} : { replaceFileId: existing }
      },
      ctx.signal
    );
    let stored = uploaded;
    if (stored.trashed === true) {
      ctx.logger.warn("catalog.copy_trashed", { file_id: stored.id });
      kvSet(ctx.db, KV.catalogFileId, "", ctx.clock.now());
      stored = await ctx.drive.uploadSmallFile(
        {
          name: catalogFileName(machineId(ctx)),
          parentId,
          mimeType: "application/vnd.sqlite3",
          body: await fsp12.readFile(destination)
        },
        ctx.signal
      );
      if (stored.trashed === true) return false;
    }
    const now = ctx.clock.now();
    kvSet(ctx.db, KV.catalogFileId, stored.id, now);
    kvSetNumber(ctx.db, KV.catalogUploadedAt, now, now);
    ctx.logger.info("catalog.uploaded", { file_id: stored.id });
    return true;
  } catch (err) {
    kvSet(ctx.db, KV.catalogFileId, "", ctx.clock.now());
    ctx.logger.warn("catalog.upload_failed", {}, err);
    return false;
  } finally {
    await fsp12.rm(destination, { force: true }).catch(() => void 0);
  }
}
function describe(err) {
  const info = toErrorInfo(err);
  return `${info.name}: ${info.message}`;
}

// src/worker/status.ts
function buildStatus(ctx, report) {
  const now = ctx.clock.now();
  return {
    version: ctx.version,
    writtenAt: now,
    lastSweepAt: kvGetNumber(ctx.db, KV.lastSweepAt) ?? null,
    lastSweep: report,
    catalog: catalogStats(ctx.db),
    queue: countJobs(ctx.db, now),
    blockedJobs: listJobs(ctx.db).filter((job) => job.blocked).slice(0, 20).map((job) => ({ sessionId: job.sessionId, error: job.lastError, attempts: job.attempts })),
    circuit: {
      openUntil: kvGetNumber(ctx.db, KV.circuitUntil) ?? null,
      consecutiveFailures: kvGetNumber(ctx.db, KV.circuitFailures) ?? 0
    },
    retentionDays: ctx.config.retentionDays,
    keepLocalForever: ctx.config.keepLocalForever,
    catalogUploadedAt: kvGetNumber(ctx.db, KV.catalogUploadedAt) ?? null
  };
}
async function writeStatusFile(ctx, report) {
  try {
    const snapshot = buildStatus(ctx, report);
    await writeFileAtomic(ctx.paths.statusFile, `${JSON.stringify(snapshot, null, 2)}
`, {
      mode: 384
    });
  } catch (err) {
    ctx.logger.warn("status.write_failed", {}, err);
  }
}

// src/worker/main.ts
function parseArgs(argv) {
  return {
    force: argv.includes("--force")
  };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const problem = nodeVersionProblem();
  if (problem !== null) {
    if (!alreadyReexeced(process.env)) {
      const better = findCompatibleNode({ cacheFile: runtime.paths.runtimeCacheFile });
      if (better !== null) {
        runtime.logger.info("worker.reexec", { node: better.version });
        runtime.close();
        reexec(better.path);
        return;
      }
    }
    runtime.logger.error("worker.unsupported_node", { remediation: NODE_REMEDIATION, problem });
    runtime.close();
    return;
  }
  kvSetNumber(runtime.db(), KV.workerRanAt, runtime.clock.now(), runtime.clock.now());
  const lock = acquireLock(runtime.paths.lockDir, { logger: runtime.logger, clock: runtime.clock });
  if (lock === null) {
    runtime.logger.debug("worker.already_running");
    runtime.close();
    return;
  }
  const controller = AbortSignal.timeout(runtime.config.workerBudgetMs + 6e4);
  let report = null;
  let ctx = null;
  try {
    ctx = {
      db: runtime.db(),
      paths: runtime.paths,
      config: runtime.config,
      drive: await runtime.drive(),
      logger: runtime.logger,
      clock: runtime.clock,
      version: runtime.version,
      signal: controller
    };
    report = await runSweep(ctx, { force: args.force });
  } catch (err) {
    const info = toErrorInfo(err);
    if (err instanceof FatalError) {
      runtime.logger.error("worker.blocked", { remediation: err.remediation }, err);
    } else {
      runtime.logger.error("worker.failed", {}, err);
    }
    ctx ??= {
      db: runtime.db(),
      paths: runtime.paths,
      config: runtime.config,
      drive: unavailableDrive(info.message),
      logger: runtime.logger,
      clock: runtime.clock,
      version: runtime.version,
      signal: controller
    };
  } finally {
    if (ctx !== null) await writeStatusFile(ctx, report);
    runtime.close();
    lock.release();
  }
}
function unavailableDrive(reason) {
  const fail = () => {
    throw new FatalError(reason, "Run /archive:setup to connect Google Drive.");
  };
  return {
    ensureFolder: fail,
    findFile: fail,
    listFiles: fail,
    startResumableUpload: fail,
    uploadChunk: fail,
    probeUpload: fail,
    uploadSmallFile: fail,
    getFile: fail,
    deleteFile: fail,
    trashFile: fail,
    downloadToFile: fail,
    storageQuota: fail
  };
}
try {
  await main();
  clearLastResort("worker.failed_to_start");
} catch (err) {
  logLastResort("worker.failed_to_start", err);
}
process.exit(0);
