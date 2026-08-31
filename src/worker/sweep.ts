import fsp from 'node:fs/promises';
import path from 'node:path';
import { getSqlite } from '../adapters/sqlite.ts';
import { removePartials } from '../adapters/atomic.ts';
import { kvGetNumber, kvGet, kvSet, kvSetNumber } from '../adapters/db.ts';
import { scanSessions } from '../adapters/session-scan.ts';
import { getSession, markLocalPresent, upsertSession } from '../core/catalog.ts';
import { circuitBackoffMs, nextAttemptAt } from '../core/backoff.ts';
import { FatalError, isRetryableNetworkError, toErrorInfo } from '../core/errors.ts';
import {
  claim,
  complete,
  countJobs,
  enqueue,
  block,
  retryLater,
  parsePayload,
  type Job,
} from '../core/queue.ts';
import { KV } from '../core/state-keys.ts';
import { backupSession } from './backup.ts';
import { reapLocalCopies, type ReapReport } from './reap.ts';
import type { WorkerContext } from './context.ts';

/**
 * The sweep (SPEC §3).
 *
 * There is no daemon and no OS scheduler. Session start and session end wake a
 * worker, and this is what it does: notice sessions nobody backed up, drain the
 * queue, delete what is safely archived, and refresh the catalog on Drive.
 *
 * The design rests on one observation: when the user is not running Claude
 * Code, nothing new accumulates, so nothing here is time-critical. Deferred
 * work waits for the next session and loses nothing by waiting.
 */

export type SweepReport = {
  ranAt: number;
  durationMs: number;
  discovered: number;
  enqueued: number;
  processed: number;
  verified: number;
  failed: number;
  blocked: number;
  reap: ReapReport;
  catalogUploaded: boolean;
  /** True when the circuit breaker was open and the sweep did nothing. */
  cooledDown: boolean;
  /** True when the sweep stopped early because it ran out of time. */
  budgetExhausted: boolean;
  lastError: string | null;
};

export type SweepOptions = {
  /** Ignore the minimum interval and the circuit breaker. */
  force?: boolean;
  /** Enqueue every unarchived session, not just the ones seen since last time. */
  backfill?: boolean;
};

export async function runSweep(
  ctx: WorkerContext,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const startedAt = ctx.clock.now();
  const report: SweepReport = {
    ranAt: startedAt,
    durationMs: 0,
    discovered: 0,
    enqueued: 0,
    processed: 0,
    verified: 0,
    failed: 0,
    blocked: 0,
    reap: { deleted: 0, bytesFreed: 0, requeued: 0, skipped: 0 },
    catalogUploaded: false,
    cooledDown: false,
    budgetExhausted: false,
    lastError: null,
  };

  const cooldownUntil = kvGetNumber(ctx.db, KV.circuitUntil) ?? 0;
  if (options.force !== true && cooldownUntil > startedAt) {
    ctx.logger.info('sweep.cooling_down', { until: cooldownUntil });
    report.cooledDown = true;
    report.durationMs = ctx.clock.now() - startedAt;
    return report;
  }

  // An interrupted bundle is never resumed, only rebuilt.
  const removed = await removePartials(ctx.paths.stagingDir);
  if (removed.length > 0) ctx.logger.info('sweep.removed_partials', { count: removed.length });

  const discovery = await discover(ctx, startedAt);
  report.discovered = discovery.discovered;
  report.enqueued = discovery.enqueued;

  const deadline = startedAt + ctx.config.workerBudgetMs;
  const drained = await drain(ctx, deadline, report);
  report.budgetExhausted = drained.budgetExhausted;

  if (!drained.budgetExhausted) {
    report.reap = await reapLocalCopies(ctx, ctx.clock.now());
  }

  if (report.verified > 0 || report.reap.deleted > 0 || catalogCopyIsStale(ctx)) {
    report.catalogUploaded = await uploadCatalogCopy(ctx);
  }

  const now = ctx.clock.now();
  kvSetNumber(ctx.db, KV.lastSweepAt, now, now);
  report.durationMs = now - startedAt;
  ctx.logger.info('sweep.done', {
    processed: report.processed,
    verified: report.verified,
    failed: report.failed,
    reaped: report.reap.deleted,
    duration_ms: report.durationMs,
  });
  return report;
}

/**
 * Bring the catalog in line with the disk.
 *
 * This is what covers the cases the close hook cannot: a crash, a machine that
 * was off for a month, sessions that existed before the plugin was installed.
 */
async function discover(
  ctx: WorkerContext,
  now: number,
): Promise<{ discovered: number; enqueued: number }> {
  let discovered = 0;
  let enqueued = 0;

  for await (const session of scanSessions(ctx.paths)) {
    ctx.signal?.throwIfAborted();
    discovered++;
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
          lastLocalMtime: mtime,
        },
        now,
      );
    } else if (!known.localPresent || (known.lastLocalMtime ?? 0) !== mtime) {
      markLocalPresent(ctx.db, session.sessionId, mtime, now);
    }

    const needsBackup = known?.verifiedAt == null || (known.lastLocalMtime ?? 0) < mtime;
    if (needsBackup) {
      enqueue(
        ctx.db,
        {
          kind: 'backup',
          sessionId: session.sessionId,
          payload: { encodedDir: session.encodedDir },
        },
        now,
      );
      enqueued++;
    }
  }

  kvSetNumber(ctx.db, KV.lastScanAt, now, now);
  return { discovered, enqueued };
}

/** Run queued jobs until the queue empties or the run runs out of time. */
async function drain(
  ctx: WorkerContext,
  deadline: number,
  report: SweepReport,
): Promise<{ budgetExhausted: boolean }> {
  for (;;) {
    const now = ctx.clock.now();
    if (now >= deadline) return { budgetExhausted: true };
    ctx.signal?.throwIfAborted();

    const job = claim(ctx.db, now, ctx.config.jobVisibilityMs);
    if (job === null) return { budgetExhausted: false };

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

async function runJob(ctx: WorkerContext, job: Job, report: SweepReport): Promise<void> {
  if (job.kind === 'catalog_upload') {
    await uploadCatalogCopy(ctx);
    return;
  }
  const sessionId = job.sessionId;
  if (sessionId === null) return;
  const payload = parsePayload(job) as { encodedDir?: unknown } | null;
  const known = getSession(ctx.db, sessionId);
  const encodedDir =
    typeof payload?.encodedDir === 'string' ? payload.encodedDir : known?.encodedDir;
  if (encodedDir === undefined) {
    ctx.logger.warn('sweep.job_without_project', { session_id: sessionId });
    return;
  }
  const outcome = await backupSession(ctx, job, { sessionId, encodedDir });
  if (outcome.status === 'verified') report.verified++;
}

/**
 * Decide what a failure means for the job and for the whole remote.
 *
 * A fatal error blocks one job and tells the user how to fix it. A run of
 * transient failures pushes a shared cool-down forward, so a plugin whose token
 * expired overnight does not spend the morning hammering Google.
 */
function handleJobFailure(ctx: WorkerContext, job: Job, err: unknown, report: SweepReport): void {
  const now = ctx.clock.now();
  const message = describe(err);

  if (err instanceof FatalError) {
    ctx.logger.error(
      'sweep.job_blocked',
      { session_id: job.sessionId, remediation: err.remediation },
      err,
    );
    block(ctx.db, job, { error: `${message} — ${err.remediation}`, now });
    report.blocked++;
    noteFailure(ctx);
    return;
  }

  const at = nextAttemptAt({
    now,
    attempt: job.attempts,
    random: () => ctx.clock.random(),
  });
  ctx.logger.warn('sweep.job_retry', { session_id: job.sessionId, attempt: job.attempts, at }, err);
  retryLater(ctx.db, job, { at, error: message });
  if (isRetryableNetworkError(err)) noteFailure(ctx);
}

function noteFailure(ctx: WorkerContext): void {
  const now = ctx.clock.now();
  const failures = (kvGetNumber(ctx.db, KV.circuitFailures) ?? 0) + 1;
  kvSetNumber(ctx.db, KV.circuitFailures, failures, now);
  // Only a sustained run of failures opens the breaker; one blip should not
  // silence the archive for half an hour.
  if (failures >= 3) {
    kvSetNumber(ctx.db, KV.circuitUntil, now + circuitBackoffMs(failures - 2), now);
  }
}

function noteSuccess(ctx: WorkerContext): void {
  const now = ctx.clock.now();
  if ((kvGetNumber(ctx.db, KV.circuitFailures) ?? 0) === 0) return;
  kvSetNumber(ctx.db, KV.circuitFailures, 0, now);
  kvSetNumber(ctx.db, KV.circuitUntil, 0, now);
}

const CATALOG_REFRESH_MS = 24 * 3_600_000;

function catalogCopyIsStale(ctx: WorkerContext): boolean {
  const last = kvGetNumber(ctx.db, KV.catalogUploadedAt) ?? 0;
  return ctx.clock.now() - last > CATALOG_REFRESH_MS;
}

/**
 * Put a copy of the catalog on Drive (SPEC §4, disaster recovery).
 *
 * `sqlite.backup()`, never `fs.copyFile`: copying a live WAL database is a
 * documented way to produce a file that opens and is quietly wrong.
 */
export async function uploadCatalogCopy(ctx: WorkerContext): Promise<boolean> {
  const destination = path.join(ctx.paths.stagingDir, 'catalog.sqlite');
  try {
    await fsp.mkdir(ctx.paths.stagingDir, { recursive: true });
    await fsp.rm(destination, { force: true });
    await getSqlite().backup(ctx.db, destination);

    const parentId = await ctx.drive.ensureFolder([ctx.config.driveRootFolder], ctx.signal);
    const existingId = kvGet(ctx.db, KV.catalogFileId);
    const existing =
      existingId ??
      (await ctx.drive.findFile({ name: 'catalog.sqlite', parentId }, ctx.signal))?.id;

    const uploaded = await ctx.drive.uploadSmallFile(
      {
        name: 'catalog.sqlite',
        parentId,
        mimeType: 'application/vnd.sqlite3',
        body: await fsp.readFile(destination),
        ...(existing === undefined ? {} : { replaceFileId: existing }),
      },
      ctx.signal,
    );

    const now = ctx.clock.now();
    kvSet(ctx.db, KV.catalogFileId, uploaded.id, now);
    kvSetNumber(ctx.db, KV.catalogUploadedAt, now, now);
    ctx.logger.info('catalog.uploaded', { file_id: uploaded.id });
    return true;
  } catch (err) {
    // The catalog copy is a convenience for a lost laptop; failing to refresh
    // it must never fail the sweep that archived real sessions.
    ctx.logger.warn('catalog.upload_failed', {}, err);
    return false;
  } finally {
    await fsp.rm(destination, { force: true }).catch(() => undefined);
  }
}

/** How many jobs are waiting, for the status file and `/archive:status`. */
export function queueSnapshot(ctx: WorkerContext): ReturnType<typeof countJobs> {
  return countJobs(ctx.db, ctx.clock.now());
}

function describe(err: unknown): string {
  const info = toErrorInfo(err);
  return `${info.name}: ${info.message}`;
}
