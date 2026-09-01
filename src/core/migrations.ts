/**
 * Schema migrations (ARCHITECTURE §8).
 *
 * An ordered, append-only list. `PRAGMA user_version` records how many have
 * run. Never edit an entry that has shipped; add a new one.
 */
export const MIGRATIONS: readonly string[] = [
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
];

export const SCHEMA_VERSION = MIGRATIONS.length;
