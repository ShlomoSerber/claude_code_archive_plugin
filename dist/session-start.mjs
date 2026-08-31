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

// src/hooks/session-start.ts
import path9 from "node:path";
import { fileURLToPath } from "node:url";

// src/composition.ts
import fsp5 from "node:fs/promises";
import path7 from "node:path";

// src/adapters/db.ts
import fs from "node:fs";
import path from "node:path";

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
  constructor(message, remediation, options) {
    super(message, options);
    this.remediation = remediation;
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
  if (compareVersions(version, MIN_NODE_VERSION) >= 0) return null;
  return `the archive plugin needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${version}`;
}
function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
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
  `
];
var SCHEMA_VERSION = MIGRATIONS.length;

// src/adapters/db.ts
function openDatabase(file, options = {}) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new (getSqlite()).DatabaseSync(file, { readOnly: options.readOnly ?? false });
  applyPragmas(db, options);
  if (options.skipMigrations !== true && options.readOnly !== true) {
    migrate(db);
  }
  return db;
}
function applyPragmas(db, options) {
  const busyTimeout = options.busyTimeoutMs ?? 5e3;
  if (options.readOnly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(`PRAGMA busy_timeout = ${String(Math.trunc(busyTimeout))}`);
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

// src/adapters/ndjson-logger.ts
import fs2 from "node:fs";
import path2 from "node:path";
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
      fs2.mkdirSync(path2.dirname(state.file), { recursive: true });
      state.ready = true;
    }
    if (state.bytesSinceCheck > 64 * 1024) {
      rotateIfLarge(state);
      state.bytesSinceCheck = 0;
    }
    fs2.appendFileSync(state.file, line, { encoding: "utf8", mode: 384 });
    state.bytesSinceCheck += line.length;
  } catch {
  }
}
function rotateIfLarge(state) {
  let size;
  try {
    size = fs2.statSync(state.file).size;
  } catch {
    return;
  }
  if (size <= state.maxBytes) return;
  try {
    fs2.rmSync(`${state.file}.1`, { force: true });
    fs2.renameSync(state.file, `${state.file}.1`);
  } catch {
  }
}

// src/adapters/token-file.ts
import fs3 from "node:fs";
import fsp2 from "node:fs/promises";

// src/adapters/atomic.ts
import fsp from "node:fs/promises";
import path3 from "node:path";
import { randomBytes } from "node:crypto";
var RENAME_ATTEMPTS = 6;
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function renameRetryDelay(attempt) {
  return Math.min(1e3, 10 * 3 ** attempt);
}
function isTransientRenameError(err) {
  const code = err?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}
async function renameWithRetry(from, to, options = {}) {
  const attempts = options.attempts ?? RENAME_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts - 1 || !isTransientRenameError(err)) throw err;
      await sleep(renameRetryDelay(attempt));
    }
  }
}
function siblingTempPath(finalPath, suffix = ".partial") {
  const dir = path3.dirname(finalPath);
  const base = path3.basename(finalPath);
  return path3.join(dir, `${base}.${randomBytes(6).toString("hex")}${suffix}`);
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
  await fsp.mkdir(path3.dirname(finalPath), { recursive: true });
  const temp = siblingTempPath(finalPath);
  let handle;
  try {
    handle = await fsp.open(temp, "wx", options.mode ?? 384);
    await handle.writeFile(data);
    await fsyncFile(handle);
    await handle.close();
    handle = void 0;
    await renameWithRetry(temp, finalPath);
    await fsyncDir(path3.dirname(finalPath));
  } catch (err) {
    await handle?.close().catch(() => void 0);
    await fsp.rm(temp, { force: true }).catch(() => void 0);
    throw err;
  }
}
var PARTIAL_GRACE_MS = 5 * 6e4;

// src/ports/logger.ts
var nullLogger = {
  debug: () => void 0,
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
  child: () => nullLogger,
  close: () => void 0
};

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
    const mode = fs3.statSync(file).mode & 511;
    if ((mode & 63) !== 0) {
      logger.warn("tokens.permissions_too_open", { file, mode: mode.toString(8) });
      fs3.chmodSync(file, 384);
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
function parseRetryAfter(header, now) {
  if (header === null) return void 0;
  const trimmed2 = header.trim();
  if (trimmed2.length === 0) return void 0;
  if (/^\d+$/.test(trimmed2)) return Number(trimmed2);
  const date = Date.parse(trimmed2);
  if (Number.isNaN(date)) return void 0;
  return Math.max(0, Math.ceil((date - now) / 1e3));
}

// src/ports/clock.ts
var systemClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  })
};

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
        const waited = await waitBeforeRetry({
          attempt,
          clock,
          remainingBudgetMs,
          logger,
          url,
          retryAfterSeconds: retryAfter,
          status: response.status
        });
        if (!waited) return response;
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
import path4 from "node:path";

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
  const fromFile = await readClientFile(path4.join(dataDir, "oauth-client.json"));
  if (fromFile !== null) return fromFile;
  if (BUNDLED_CLIENT.clientId.length > 0) return BUNDLED_CLIENT;
  throw new FatalError(
    "no Google OAuth client is configured",
    `Create a Desktop-app OAuth client in Google Cloud Console, then save it as ${path4.join(dataDir, "oauth-client.json")} with {"clientId":"...","clientSecret":"..."}, or set ARCHIVE_GOOGLE_CLIENT_ID and ARCHIVE_GOOGLE_CLIENT_SECRET.`
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
import fs4 from "node:fs";
import fsp4 from "node:fs/promises";
import path5 from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
var API = "https://www.googleapis.com/drive/v3";
var UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
var FOLDER_MIME = "application/vnd.google-apps.folder";
var FILE_FIELDS = "id,name,size,sha256Checksum,md5Checksum,trashed";
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
      throw new FatalError("Google rejected the access token", REAUTH_REMEDIATION);
    }
    return second;
  };
  const failIfNotOk = async (response, what) => {
    const body = await readJson(response);
    if (response.ok) return body;
    const message = `${what}: ${describeApiError(response.status, body)}`;
    if (response.status === 403 && isQuotaExhausted(body)) {
      throw new FatalError(message, "Free space in Google Drive, then run /archive:now.");
    }
    if (response.status === 403 && isRateLimited(body)) {
      throw new RetryableError(message, { status: response.status });
    }
    if (response.status >= 400 && response.status < 500) {
      throw new FatalError(message, "Run /archive:status for details.");
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
      await fsp4.mkdir(path5.dirname(args.destination), { recursive: true });
      const temp = siblingTempPath(args.destination);
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          fs4.createWriteStream(temp, { flags: "wx", mode: 384 })
        );
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
  if (response.status >= 400 && response.status < 500) {
    throw new FatalError(
      `Drive refused the upload: ${message}`,
      "Run /archive:status for details."
    );
  }
  throw new RetryableError(`Drive upload failed: ${message}`, { status: response.status });
}
function confirmedFromRange(header) {
  if (header === null) return 0;
  const match = /bytes=(\d+)-(\d+)/.exec(header.trim());
  if (match === null) return 0;
  return Number(match[2]) + 1;
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
    trashed: record["trashed"] === true
  };
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function isRateLimited(body) {
  const text = JSON.stringify(body ?? "");
  return text.includes("rateLimitExceeded") || text.includes("userRateLimitExceeded") || text.includes("sharingRateLimitExceeded");
}
function isQuotaExhausted(body) {
  const text = JSON.stringify(body ?? "");
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
  applySource(config, file ?? {});
  applySource(config, envSource(env));
  if (file !== null && unreadableSafetyValues(file).length > 0) {
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

// src/core/paths.ts
import path6 from "node:path";
import os from "node:os";
function resolveClaudeDir(env, homedir = os.homedir) {
  const configured = trimmed(env["CLAUDE_CONFIG_DIR"]);
  if (configured !== void 0) return path6.resolve(configured);
  return path6.join(homedir(), ".claude");
}
function resolveDataDir(env, claudeDir) {
  const override = trimmed(env["ARCHIVE_DATA_DIR"]);
  if (override !== void 0) return path6.resolve(override);
  const provided = trimmed(env["CLAUDE_PLUGIN_DATA"]);
  if (provided !== void 0) return path6.resolve(provided);
  return path6.join(claudeDir, "plugins", "data", DEFAULT_PLUGIN_SLUG);
}
var DEFAULT_PLUGIN_SLUG = "claude-code-archive-plugin";
function resolvePaths(env, homedir = os.homedir) {
  const claudeDir = resolveClaudeDir(env, homedir);
  const dataDir = resolveDataDir(env, claudeDir);
  return {
    claudeDir,
    projectsDir: path6.join(claudeDir, "projects"),
    settingsFile: path6.join(claudeDir, "settings.json"),
    dataDir,
    dbFile: path6.join(dataDir, "archive.sqlite"),
    logFile: path6.join(dataDir, "archive.log"),
    tokenFile: path6.join(dataDir, "tokens.json"),
    statusFile: path6.join(dataDir, "status.json"),
    lockDir: path6.join(dataDir, "worker.lock"),
    runtimeCacheFile: path6.join(dataDir, "runtime.json"),
    stagingDir: path6.join(dataDir, "staging")
  };
}
function trimmed(value) {
  if (value === void 0) return void 0;
  const out = value.trim();
  return out.length > 0 ? out : void 0;
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
    raw = await fsp5.readFile(path7.join(dataDir, "config.json"), "utf8");
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

// src/core/identifiers.ts
var SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,253}$/;
function isSafePathSegment(value) {
  if (!SAFE_SEGMENT.test(value)) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  return true;
}
var isSafeSessionId = isSafePathSegment;

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
  /** Set once the initial backfill has enqueued every existing session. */
  backfillDoneAt: "backfill.done_at"
};
function activeSessionKey(sessionId) {
  return `active.${sessionId}`;
}
var ACTIVE_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1e3;

// src/adapters/spawn-worker.ts
import { spawn } from "node:child_process";

// src/core/spawn.ts
function workerSpawnSpec(args) {
  return {
    command: args.execPath,
    args: [args.workerPath, ...args.extraArgs ?? []],
    options: {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: args.env,
      cwd: args.cwd
    }
  };
}
function detachDisabled(env) {
  const value = env["ARCHIVE_NO_DETACH"];
  return value !== void 0 && value !== "" && value !== "0";
}

// src/adapters/spawn-worker.ts
function spawnWorker(args) {
  const logger = args.logger ?? nullLogger;
  if (detachDisabled(args.env)) {
    logger.debug("worker.spawn_skipped", { reason: "ARCHIVE_NO_DETACH" });
    return false;
  }
  const spec = workerSpawnSpec({
    execPath: process.execPath,
    workerPath: args.workerPath,
    env: args.env,
    cwd: args.cwd,
    ...args.extraArgs === void 0 ? {} : { extraArgs: args.extraArgs }
  });
  try {
    const child = spawn(spec.command, spec.args, spec.options);
    child.on("error", (err) => {
      logger.warn("worker.spawn_failed", {}, err);
    });
    child.unref();
    logger.debug("worker.spawned", { pid: child.pid ?? null });
    return true;
  } catch (err) {
    logger.warn("worker.spawn_failed", {}, err);
    return false;
  }
}

// src/hooks/hook-input.ts
async function readHookInput(timeoutMs = 2e3) {
  const text = await readStdin(timeoutMs);
  if (text === null || text.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
function readStdin(timeoutMs) {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null);
    }, timeoutMs);
    timer.unref();
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      finish(null);
    });
  });
}
function emitSystemMessage(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}
`);
}

// src/adapters/node-locator.ts
import fs5 from "node:fs";
import os2 from "node:os";
import path8 from "node:path";
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
  known.sort((a, b) => compareVersions(b.version ?? "0", a.version ?? "0"));
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
  const homedir = (options.homedir ?? os2.homedir)();
  const verify = options.verify ?? probeVersion;
  const minVersion = options.minVersion ?? MIN_NODE_VERSION;
  const cached2 = readCache(options.cacheFile);
  if (cached2 !== null && fs5.existsSync(cached2.path) && satisfiesFloor(cached2.version, minVersion)) {
    return cached2;
  }
  for (const candidate of rankCandidates(collectCandidates(env, homedir), minVersion)) {
    const version = verify(candidate.path);
    if (version === null || !satisfiesFloor(version, minVersion)) continue;
    const found = { path: candidate.path, version };
    writeCache(options.cacheFile, found);
    return found;
  }
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
      entries = fs5.readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path8.join(root, entry, ...tail, exe);
      if (fs5.existsSync(full)) add(full);
    }
  };
  if (process.platform === "win32") {
    const appData = env["APPDATA"];
    const localAppData = env["LOCALAPPDATA"];
    const programFiles = env["ProgramFiles"];
    if (appData !== void 0) addVersioned(path8.join(appData, "nvm"));
    if (localAppData !== void 0) {
      addVersioned(path8.join(localAppData, "fnm", "node-versions"), "installation");
      addVersioned(path8.join(localAppData, "Volta", "tools", "image", "node"));
      addIfPresent(path8.join(localAppData, "Programs", "nodejs", exe), add);
    }
    if (programFiles !== void 0) addIfPresent(path8.join(programFiles, "nodejs", exe), add);
  } else {
    const nvm = env["NVM_DIR"] ?? path8.join(homedir, ".nvm");
    addVersioned(path8.join(nvm, "versions", "node"), "bin");
    for (const fnm of [
      env["FNM_DIR"],
      path8.join(homedir, ".fnm"),
      path8.join(homedir, ".local", "share", "fnm")
    ]) {
      if (fnm !== void 0) addVersioned(path8.join(fnm, "node-versions"), "installation", "bin");
    }
    addVersioned(path8.join(homedir, ".volta", "tools", "image", "node"), "bin");
    addVersioned(path8.join(homedir, ".local", "share", "mise", "installs", "node"), "bin");
    addVersioned(path8.join(homedir, ".asdf", "installs", "nodejs"), "bin");
    for (const fixed of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
      addIfPresent(fixed, add);
    }
  }
  return candidates;
}
function addIfPresent(candidatePath, add) {
  if (fs5.existsSync(candidatePath)) add(candidatePath);
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
    const parsed = JSON.parse(fs5.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { path: cachedPath, version } = parsed;
    if (typeof cachedPath !== "string" || typeof version !== "string") return null;
    return { path: cachedPath, version };
  } catch {
    return null;
  }
}
function writeCache(file, found) {
  if (file === void 0) return;
  try {
    fs5.mkdirSync(path8.dirname(file), { recursive: true });
    fs5.writeFileSync(file, `${JSON.stringify(found)}
`, { mode: 384 });
  } catch {
  }
}

// src/hooks/session-start.ts
async function main() {
  const problem = nodeVersionProblem();
  if (problem !== null) {
    if (!alreadyReexeced(process.env)) {
      const better = findCompatibleNode({ cacheFile: resolvePaths(process.env).runtimeCacheFile });
      if (better !== null) {
        reexec(better.path);
        return;
      }
    }
    emitSystemMessage(`Claude Code Archive is not running: ${problem}. ${NODE_REMEDIATION}`);
    return;
  }
  const input = await readHookInput();
  const runtime = await createRuntime();
  try {
    if (!runtime.config.enabled) return;
    const now = runtime.clock.now();
    const sessionId = input?.session_id;
    if (sessionId !== void 0 && isSafeSessionId(sessionId)) {
      kvSetNumber(runtime.db(), activeSessionKey(sessionId), now, now);
    }
    const lastSweep = kvGetNumber(runtime.db(), KV.lastSweepAt) ?? 0;
    if (now - lastSweep < runtime.config.sweepMinIntervalMs) {
      runtime.logger.debug("hook.session_start.too_soon", { last_sweep_at: lastSweep });
      return;
    }
    runtime.logger.info("hook.session_start.sweeping", { source: input?.source ?? null });
    spawnWorker({
      workerPath: workerPath(),
      env: process.env,
      cwd: runtime.paths.dataDir,
      logger: runtime.logger
    });
  } finally {
    runtime.close();
  }
}
function workerPath() {
  return path9.join(path9.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
}
try {
  await main();
} catch {
}
process.exit(0);
