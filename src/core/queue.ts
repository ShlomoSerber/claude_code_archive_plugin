import { randomBytes } from 'node:crypto';
import type { Db } from '../adapters/db.ts';

/**
 * Work queue (ARCHITECTURE §2): at-least-once, with a visibility timeout.
 *
 * The at-least-once guarantee comes from claiming: a claim pushes `visible_at`
 * into the future, so a worker that dies mid-job leaves a row that becomes
 * claimable again on its own. Nothing needs to notice the crash.
 *
 * Coalescing comes from `dedupe_key`. Ten `SessionEnd` fires for one session
 * are one row, because the tenth backup subsumes the first nine.
 */

export const JOB_KINDS = ['backup', 'catalog_upload'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type Job = {
  id: number;
  dedupeKey: string;
  kind: JobKind;
  sessionId: string | null;
  attempts: number;
  notBefore: number;
  visibleAt: number;
  blocked: boolean;
  claimToken: string | null;
  payload: string | null;
  uploadUri: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

type JobRow = {
  id: number;
  dedupe_key: string;
  kind: string;
  session_id: string | null;
  attempts: number;
  not_before: number;
  visible_at: number;
  blocked: number;
  claim_token: string | null;
  payload: string | null;
  upload_uri: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

const JOB_COLUMNS = `id, dedupe_key, kind, session_id, attempts, not_before, visible_at,
  blocked, claim_token, payload, upload_uri, last_error, created_at, updated_at`;

export function dedupeKey(kind: JobKind, sessionId: string | null): string {
  return `${kind}:${sessionId ?? ''}`;
}

export type EnqueueArgs = {
  /**
   * Clear a block. True for a hook, which means a person really used the
   * session again; false for the sweep, whose rescan would otherwise unblock
   * every parked job on every pass and retry a fault nobody has fixed.
   */
  unblock?: boolean;
  /**
   * Also run it now, discarding any wait it is serving.
   *
   * Only /archive:now sets this. A hook must not: a session closing again is
   * an ordinary event, and letting it cancel a server's Retry-After turns the
   * normal "resume a session, close it" workflow into quota burn.
   */
  runNow?: boolean;
  kind: JobKind;
  sessionId?: string | null;
  payload?: unknown;
  /** Earliest time the job may run. Used as the hook debounce. */
  notBefore?: number;
};

/**
 * Add or refresh a job.
 *
 * `not_before` takes the later of the two values so a fresh hook fire cannot
 * cancel an active backoff, and clearing `claim_token` invalidates any claim in
 * flight — the running worker's completion will not delete this new work.
 */
export function enqueue(db: Db, args: EnqueueArgs, now: number): number {
  const sessionId = args.sessionId ?? null;
  const key = dedupeKey(args.kind, sessionId);
  const notBefore = args.notBefore ?? now;
  const payload = args.payload === undefined ? null : JSON.stringify(args.payload);

  const row = db
    .prepare(
      `INSERT INTO jobs (dedupe_key, kind, session_id, payload, not_before, visible_at,
                         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         payload     = excluded.payload,
         -- max(), so neither an ordinary hook fire nor a session closing can
         -- pull a backing-off job forward: a server that answered Retry-After
         -- gets the wait it asked for. runNow is the one exception, and only
         -- /archive:now sets it — that is a person saying "try again, now".
         not_before  = CASE WHEN ? THEN excluded.not_before
                            ELSE max(jobs.not_before, excluded.not_before) END,
         blocked     = CASE WHEN ? THEN 0 ELSE jobs.blocked END,
         blocked_at  = CASE WHEN ? THEN NULL ELSE jobs.blocked_at END,
         -- A block leaves the claim's visibility timeout in place, so without this
         -- an unblocked job stayed invisible for up to fifteen minutes and
         -- /archive:now appeared to have done nothing.
         visible_at  = CASE WHEN ? THEN 0 ELSE jobs.visible_at END,
         claim_token = NULL,
         -- New work means a new bundle. A URI opened for the previous one would
         -- otherwise be resumed against different bytes, and the "already
         -- complete" answer would hand back the wrong file.
         upload_uri  = NULL,
         updated_at  = excluded.updated_at
       RETURNING id`,
    )
    .get(
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
      args.unblock === true ? 1 : 0,
    ) as { id: number } | undefined;
  return row?.id ?? 0;
}

/**
 * Take the oldest runnable job, if any.
 *
 * SQLite serializes writers, so this single statement is the whole mutual
 * exclusion; no `SKIP LOCKED` equivalent is needed.
 */
export function claim(db: Db, now: number, visibilityMs: number): Job | null {
  const token = randomBytes(8).toString('hex');
  const row = db
    .prepare(
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
       RETURNING ${JOB_COLUMNS}`,
    )
    .get(now + visibilityMs, token, now, now, now) as JobRow | undefined;
  return row === undefined ? null : toJob(row);
}

/** Extend a claim on a job that is legitimately taking a long time. */
export function heartbeatClaim(db: Db, job: Job, now: number, visibilityMs: number): void {
  db.prepare(`UPDATE jobs SET visible_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?`).run(
    now + visibilityMs,
    now,
    job.id,
    job.claimToken,
  );
}

export type CompleteResult = 'deleted' | 'superseded';

/**
 * Retire a finished job — but only if it is still the job we claimed.
 *
 * If a hook re-enqueued the session while we worked, `claim_token` is now NULL
 * and the delete matches nothing. That newer work must not then sit invisible
 * until our claim expires, so we clear the visibility timeout and let the next
 * worker take it immediately.
 *
 * The release is conditional on `claim_token IS NULL`: if some other worker
 * has since claimed the row, only that worker may make it visible again.
 */
export function complete(db: Db, job: Job): CompleteResult {
  const deleted = db
    .prepare('DELETE FROM jobs WHERE id = ? AND claim_token = ?')
    .run(job.id, job.claimToken);
  if (deleted.changes > 0) return 'deleted';
  db.prepare('UPDATE jobs SET visible_at = 0 WHERE id = ? AND claim_token IS NULL').run(job.id);
  return 'superseded';
}

/** Return a job to the queue after a retryable failure. */
export function retryLater(db: Db, job: Job, args: { at: number; error: string }): void {
  db.prepare(
    `UPDATE jobs
        SET not_before  = ?,
            visible_at  = 0,
            claim_token = NULL,
            last_error  = ?,
            updated_at  = ?
      WHERE id = ?`,
  ).run(args.at, args.error, args.at, job.id);
}

/**
 * Park a job that cannot succeed without the user. It stays in the table so
 * `/archive:status` can report it, and a re-enqueue unblocks it.
 */
export function block(db: Db, job: Job, args: { error: string; now: number }): void {
  db.prepare(
    `UPDATE jobs
        SET blocked = 1, blocked_at = ?, claim_token = NULL, last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(args.now, args.error, args.now, job.id);
}

/**
 * Retry jobs that were parked long enough ago that the cause may have passed.
 *
 * A block is meant for a fault a person has to fix, and /archive:now is what
 * clears it. But a rate limit or a full disk parks a job the same way, and a
 * session that is never opened again is never archived again — the plugin
 * silently gives up on one conversation for ever. Once a day is rare enough
 * not to hammer a Drive that is genuinely refusing us.
 */
export function unblockStale(db: Db, now: number, olderThanMs: number): number {
  const result = db
    .prepare(
      `UPDATE jobs SET blocked = 0, blocked_at = NULL, visible_at = 0,
              not_before = ?, updated_at = ?
        WHERE blocked = 1 AND COALESCE(blocked_at, updated_at) <= ?`,
    )
    .run(now, now, now - olderThanMs);
  return Number(result.changes);
}

/** Record the resumable-upload session URI: it is the upload's idempotency key. */
export function setUploadUri(db: Db, job: Job, uri: string | null, now: number): void {
  // Scoped to the claim, like complete() and heartbeatClaim(). A worker whose
  // claim has been superseded could otherwise null the new claimant's URI and
  // make it restart an upload that was nearly done.
  db.prepare(
    'UPDATE jobs SET upload_uri = ?, updated_at = ? WHERE id = ? AND claim_token IS ?',
  ).run(uri, now, job.id, job.claimToken);
}

/**
 * When the next job becomes claimable, or null if none ever will.
 *
 * Only jobs that have never been attempted count. A worker should wait out the
 * debounce on work a hook just enqueued, and must never wait out the backoff on
 * a job that is failing — that delay exists to space attempts apart.
 */
export function nextRunnableAt(db: Db, now: number): number | null {
  const row = db
    .prepare(
      `SELECT min(not_before) AS at FROM jobs
        WHERE blocked = 0 AND attempts = 0 AND visible_at <= ?`,
    )
    .get(now) as { at: number | null } | undefined;
  return row?.at ?? null;
}

export function getJob(db: Db, id: number): Job | null {
  const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as
    JobRow | undefined;
  return row === undefined ? null : toJob(row);
}

export function listJobs(db: Db): Job[] {
  const rows = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY not_before ASC, id ASC`)
    .all() as JobRow[];
  return rows.map(toJob);
}

export type QueueCounts = { total: number; runnable: number; blocked: number; failing: number };

export function countJobs(db: Db, now: number): QueueCounts {
  const row = db
    .prepare(
      `SELECT
         count(*) AS total,
         sum(CASE WHEN blocked = 0 AND not_before <= ? AND visible_at <= ? THEN 1 ELSE 0 END)
           AS runnable,
         sum(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked,
         -- attempts >= 1: a job that has failed once has attempts = 1, and
         -- counting from 2 made every first failure invisible to the status
         -- report — including one parked for hours by a Retry-After.
         sum(CASE WHEN blocked = 0 AND attempts >= 1 AND not_before > ?
                  THEN 1 ELSE 0 END) AS failing
       FROM jobs`,
    )
    .get(now, now, now) as
    | { total: number; runnable: number | null; blocked: number | null; failing: number | null }
    | undefined;
  return {
    total: row?.total ?? 0,
    runnable: row?.runnable ?? 0,
    blocked: row?.blocked ?? 0,
    failing: row?.failing ?? 0,
  };
}

/** Decode a job payload. Callers narrow the result; a corrupt payload is null. */
export function parsePayload(job: Job): unknown {
  if (job.payload === null) return null;
  try {
    return JSON.parse(job.payload);
  } catch {
    return null;
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    kind: row.kind as JobKind,
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
    updatedAt: row.updated_at,
  };
}
