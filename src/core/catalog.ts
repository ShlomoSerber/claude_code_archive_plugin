import type { Db } from '../adapters/db.ts';
import { inTransaction } from '../adapters/db.ts';
import type { ExtractedPrompt } from './transcript.ts';

/**
 * The catalog (SPEC §4): everything needed to find and restore a session,
 * held locally forever so search never touches the network.
 */

export type SessionRecord = {
  sessionId: string;
  encodedDir: string;
  projectCwd: string | null;
  title: string | null;
  summary: string | null;
  gitBranch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  messageCount: number | null;
  transcriptBytes: number | null;
  transcriptSha256: string | null;
  sidecarBytes: number | null;
  bundleName: string | null;
  bundleBytes: number | null;
  bundleSha256: string | null;
  remoteFileId: string | null;
  remotePath: string | null;
  backedUpAt: number | null;
  verifiedAt: number | null;
  archiverVersion: string | null;
  localPresent: boolean;
  localDeletedAt: number | null;
  lastLocalMtime: number | null;
  /**
   * The mtime and total byte count of the local files at the moment the Drive
   * copy was verified. Written only by {@link markVerified}. Change detection
   * must compare against these, never against `lastLocalMtime`, which is
   * advanced by scans and by indexing passes that never completed a backup.
   */
  verifiedLocalMtime: number | null;
  verifiedLocalBytes: number | null;
  /** Hash of the bundle Drive was confirmed to hold. Written only by markVerified. */
  verifiedBundleSha256: string | null;
  /** Transcript hash belonging to the archived copy, not to whatever is on disk. */
  verifiedTranscriptSha256: string | null;
  /** Transcript size of the archived copy. Written only by markVerified. */
  verifiedTranscriptBytes: number | null;
  /** Sidecar size of the archived copy. Written only by markVerified. */
  verifiedSidecarBytes: number | null;
  /** Bundle size Drive was confirmed to hold. Written only by markVerified. */
  verifiedBundleBytes: number | null;
  /** JSON `[[path, sha256], …]` of the archived bundle. Only markVerified writes it. */
  verifiedManifest: string | null;
  /** Weaker hash of the same bundle, for a Drive that reports no sha256. */
  verifiedBundleMd5: string | null;
  createdAt: number;
  updatedAt: number;
};

type SessionRow = {
  session_id: string;
  encoded_dir: string;
  project_cwd: string | null;
  title: string | null;
  summary: string | null;
  git_branch: string | null;
  started_at: number | null;
  ended_at: number | null;
  message_count: number | null;
  transcript_bytes: number | null;
  transcript_sha256: string | null;
  sidecar_bytes: number | null;
  bundle_name: string | null;
  bundle_bytes: number | null;
  bundle_sha256: string | null;
  remote_file_id: string | null;
  remote_path: string | null;
  backed_up_at: number | null;
  verified_at: number | null;
  archiver_version: string | null;
  local_present: number;
  local_deleted_at: number | null;
  last_local_mtime: number | null;
  verified_local_mtime: number | null;
  verified_local_bytes: number | null;
  verified_bundle_sha256: string | null;
  verified_transcript_sha256: string | null;
  verified_transcript_bytes: number | null;
  verified_sidecar_bytes: number | null;
  verified_bundle_bytes: number | null;
  verified_manifest: string | null;
  verified_bundle_md5: string | null;
  created_at: number;
  updated_at: number;
};

const SESSION_COLUMNS = `session_id, encoded_dir, project_cwd, title, summary, git_branch,
  started_at, ended_at, message_count, transcript_bytes, transcript_sha256, sidecar_bytes,
  bundle_name, bundle_bytes, bundle_sha256, remote_file_id, remote_path, backed_up_at,
  verified_at, archiver_version, local_present, local_deleted_at, last_local_mtime,
  verified_local_mtime, verified_local_bytes, verified_bundle_sha256,
  verified_transcript_sha256, verified_transcript_bytes, verified_sidecar_bytes,
  verified_bundle_bytes, verified_manifest, verified_bundle_md5, created_at, updated_at`;

/** The fields extraction knows about. Backup and verification fill the rest. */
export type SessionUpsert = {
  sessionId: string;
  encodedDir: string;
  projectCwd?: string | null;
  title?: string | null;
  summary?: string | null;
  gitBranch?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  messageCount?: number | null;
  transcriptBytes?: number | null;
  transcriptSha256?: string | null;
  sidecarBytes?: number | null;
  lastLocalMtime?: number | null;
};

/**
 * Insert or refresh a session's catalog entry.
 *
 * `COALESCE(excluded.x, sessions.x)` on every optional column: a later pass
 * that knows less must never erase what an earlier pass knew.
 */
export function upsertSession(db: Db, session: SessionUpsert, now: number): void {
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
       updated_at        = excluded.updated_at`,
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
    now,
  );
}

/** Replace the indexed prompts wholesale; a resumed session gains new ones. */
export function replacePrompts(db: Db, sessionId: string, prompts: ExtractedPrompt[]): void {
  inTransaction(db, () => {
    db.prepare('DELETE FROM prompts WHERE session_id = ?').run(sessionId);
    const insert = db.prepare(
      'INSERT INTO prompts (session_id, seq, ts, text) VALUES (?, ?, ?, ?)',
    );
    for (const prompt of prompts) {
      insert.run(sessionId, prompt.seq, prompt.ts, prompt.text);
    }
  });
}

export function replaceFiles(db: Db, sessionId: string, files: string[]): void {
  inTransaction(db, () => {
    db.prepare('DELETE FROM session_files WHERE session_id = ?').run(sessionId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO session_files (session_id, path) VALUES (?, ?)',
    );
    for (const file of files) insert.run(sessionId, file);
  });
}

export type BackupRecord = {
  bundleName: string;
  bundleBytes: number;
  bundleSha256: string;
  archiverVersion: string;
};

/**
 * The bundle exists locally and is hashed, but is not yet on Drive.
 *
 * This withdraws `verified_at` — the authority to delete the local copy — and
 * deliberately leaves the `verified_*` description of the copy Drive already
 * holds. Clearing those made the "this session has shrunk" guard a one-shot: it
 * fired on the first attempt, erased the evidence it depended on, and waved the
 * second attempt through. They are overwritten by markVerified on success.
 */
export function markBundled(db: Db, sessionId: string, backup: BackupRecord, now: number): void {
  db.prepare(
    `UPDATE sessions
        SET bundle_name = ?, bundle_bytes = ?, bundle_sha256 = ?, archiver_version = ?,
            verified_at = NULL, updated_at = ?
      WHERE session_id = ?`,
  ).run(
    backup.bundleName,
    backup.bundleBytes,
    backup.bundleSha256,
    backup.archiverVersion,
    now,
    sessionId,
  );
}

export type RetainedBundle = {
  id: number;
  sessionId: string;
  fileId: string;
  remotePath: string | null;
  bundleSha256: string | null;
  manifest: string | null;
  reason: string;
  createdAt: number;
};

/**
 * Remember a superseded bundle that was deliberately not retired.
 *
 * When the replacement does not provably contain the old bundle, the old one
 * stays on Drive — but `remote_file_id` has already moved on, so nothing
 * pointed at it and its unique contents were reachable only by browsing Drive
 * by hand. This row is that pointer.
 */
export function recordRetainedBundle(
  db: Db,
  entry: {
    sessionId: string;
    fileId: string;
    remotePath: string | null;
    bundleSha256: string | null;
    manifest: string | null;
    reason: string;
  },
  now: number,
): void {
  db.prepare(
    `INSERT INTO retained_bundles
       (session_id, file_id, remote_path, bundle_sha256, manifest, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id) DO UPDATE SET reason = excluded.reason`,
  ).run(
    entry.sessionId,
    entry.fileId,
    entry.remotePath,
    entry.bundleSha256,
    entry.manifest,
    entry.reason,
    now,
  );
}

export function listRetainedBundles(db: Db, sessionId?: string): RetainedBundle[] {
  const rows = (
    sessionId === undefined
      ? db.prepare('SELECT * FROM retained_bundles ORDER BY id').all()
      : db.prepare('SELECT * FROM retained_bundles WHERE session_id = ? ORDER BY id').all(sessionId)
  ) as {
    id: number;
    session_id: string;
    file_id: string;
    remote_path: string | null;
    bundle_sha256: string | null;
    manifest: string | null;
    reason: string;
    created_at: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    fileId: row.file_id,
    remotePath: row.remote_path,
    bundleSha256: row.bundle_sha256,
    manifest: row.manifest,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

/**
 * The remote copy exists and its hash matched ours.
 *
 * This is the only thing that makes a session eligible for local deletion, and
 * so the enforcement point for SPEC invariant 1.
 */
export function markVerified(
  db: Db,
  sessionId: string,
  remote: {
    fileId: string;
    path: string;
    /** State of the local files that this Drive copy was made from. */
    localMtime: number | null;
    localBytes: number | null;
    /** Hash of the bundle Drive was just confirmed to hold. */
    bundleSha256: string;
    /** Hash of the transcript *inside* that bundle. */
    transcriptSha256: string | null;
    /** Sizes of the archived copy, component by component. */
    transcriptBytes: number | null;
    sidecarBytes: number | null;
    bundleBytes: number | null;
    /** Compact file list of the archived bundle. */
    manifest: string | null;
    /** md5 of the same bundle. Used only when Drive reports no sha256. */
    bundleMd5: string | null;
  },
  now: number,
): void {
  db.prepare(
    `UPDATE sessions
        SET remote_file_id = ?, remote_path = ?, backed_up_at = ?, verified_at = ?,
            verified_local_mtime = ?, verified_local_bytes = ?, verified_bundle_sha256 = ?,
            verified_transcript_sha256 = ?, verified_transcript_bytes = ?,
            verified_sidecar_bytes = ?, verified_bundle_bytes = ?, verified_manifest = ?,
            verified_bundle_md5 = ?, updated_at = ?
      WHERE session_id = ?`,
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
    sessionId,
  );
}

/**
 * Withdraw the authority to delete this session's local copy.
 *
 * It clears exactly one thing: `verified_at`. Everything else on the row
 * describes the copy Drive holds, and this function is called for *transient*
 * reasons — a checksum that arrived late, one failed verification, a bulk
 * `/archive:verify` run. Erasing the description each time blinded the guard
 * that refuses to archive a session smaller than its archive, which is the
 * check standing between a locally damaged session and a destroyed archive.
 *
 * `remote_file_id` stays for the same reason. For a session already reaped, it
 * is the only pointer to bytes that exist nowhere else, and nothing rebuilds
 * it: discovery only enqueues sessions found on disk.
 */
export function clearVerification(db: Db, sessionId: string, now: number): void {
  db.prepare(`UPDATE sessions SET verified_at = NULL, updated_at = ? WHERE session_id = ?`).run(
    now,
    sessionId,
  );
}

export function markLocalDeleted(db: Db, sessionId: string, now: number): void {
  db.prepare(
    `UPDATE sessions SET local_present = 0, local_deleted_at = ?, updated_at = ? WHERE session_id = ?`,
  ).run(now, now, sessionId);
}

export function markLocalPresent(db: Db, sessionId: string, mtime: number, now: number): void {
  db.prepare(
    `UPDATE sessions
        SET local_present = 1, local_deleted_at = NULL, last_local_mtime = ?, updated_at = ?
      WHERE session_id = ?`,
  ).run(mtime, now, sessionId);
}

export function getSession(db: Db, sessionId: string): SessionRecord | null {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
    .get(sessionId) as SessionRow | undefined;
  return row === undefined ? null : toRecord(row);
}

export function getPrompts(db: Db, sessionId: string, limit = 20): string[] {
  const rows = db
    .prepare('SELECT text FROM prompts WHERE session_id = ? ORDER BY seq ASC LIMIT ?')
    .all(sessionId, limit) as { text: string }[];
  return rows.map((row) => row.text);
}

export function getFiles(db: Db, sessionId: string, limit = 50): string[] {
  const rows = db
    .prepare('SELECT path FROM session_files WHERE session_id = ? ORDER BY path ASC LIMIT ?')
    .all(sessionId, limit) as { path: string }[];
  return rows.map((row) => row.path);
}

/**
 * Sessions whose local copy may be deleted: verified on Drive, still on disk,
 * and untouched for longer than the retention window.
 */
export function listReapable(db: Db, idleBefore: number, limit = 500): SessionRecord[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE local_present = 1
          AND verified_at IS NOT NULL
          AND bundle_sha256 IS NOT NULL
          AND remote_file_id IS NOT NULL
          AND verified_local_mtime IS NOT NULL
          AND verified_local_mtime < ?
        ORDER BY verified_local_mtime ASC
        LIMIT ?`,
    )
    .all(idleBefore, limit) as SessionRow[];
  return rows.map(toRecord);
}

/** Sessions that still need a verified copy on Drive. */
export function listUnverified(db: Db, limit = 500): SessionRecord[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE verified_at IS NULL
        ORDER BY COALESCE(ended_at, created_at) DESC
        LIMIT ?`,
    )
    .all(limit) as SessionRow[];
  return rows.map(toRecord);
}

export type CatalogStats = {
  sessions: number;
  verified: number;
  localPresent: number;
  pendingBackup: number;
  localBytes: number;
  archivedBytes: number;
  reclaimedBytes: number;
  oldestSession: number | null;
  newestSession: number | null;
};

export function catalogStats(db: Db): CatalogStats {
  const row = db
    .prepare(
      `SELECT
         count(*) AS sessions,
         sum(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
         sum(CASE WHEN local_present = 1 THEN 1 ELSE 0 END) AS local_present,
         sum(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END) AS pending_backup,
         sum(CASE WHEN local_present = 1
                  THEN COALESCE(transcript_bytes, 0) + COALESCE(sidecar_bytes, 0)
                  ELSE 0 END) AS local_bytes,
         -- verified_bundle_bytes, not bundle_bytes: the latter describes a
         -- bundle that was *built*, so a session that never uploaded still
         -- counted towards "On Drive".
         sum(COALESCE(verified_bundle_bytes, 0)) AS archived_bytes,
         sum(CASE WHEN local_present = 0
                  THEN COALESCE(transcript_bytes, 0) + COALESCE(sidecar_bytes, 0)
                  ELSE 0 END) AS reclaimed_bytes,
         min(COALESCE(started_at, ended_at)) AS oldest,
         max(COALESCE(ended_at, started_at)) AS newest
       FROM sessions`,
    )
    .get() as Record<string, number | null> | undefined;
  return {
    sessions: row?.['sessions'] ?? 0,
    verified: row?.['verified'] ?? 0,
    localPresent: row?.['local_present'] ?? 0,
    pendingBackup: row?.['pending_backup'] ?? 0,
    localBytes: row?.['local_bytes'] ?? 0,
    archivedBytes: row?.['archived_bytes'] ?? 0,
    reclaimedBytes: row?.['reclaimed_bytes'] ?? 0,
    oldestSession: row?.['oldest'] ?? null,
    newestSession: row?.['newest'] ?? null,
  };
}

export function toRecord(row: SessionRow): SessionRecord {
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
    updatedAt: row.updated_at,
  };
}

export { type SessionRow, SESSION_COLUMNS };
