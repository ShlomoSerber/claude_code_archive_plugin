import fsp from 'node:fs/promises';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { getSqlite } from '../adapters/sqlite.ts';
import { removePartials } from '../adapters/atomic.ts';
import { kvGetNumber, kvGet, kvSet, kvSetNumber } from '../adapters/db.ts';
import { scanSessions, type ScanSkip } from '../adapters/session-scan.ts';
import { getSession, markLocalPresent, upsertSession } from '../core/catalog.ts';
import { circuitBackoffMs, nextAttemptAt } from '../core/backoff.ts';
import { FatalError, isRetryableNetworkError, toErrorInfo } from '../core/errors.ts';
import {
  claim,
  complete,
  countJobs,
  enqueue,
  block,
  nextRunnableAt,
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
  /**
   * Retry jobs that were parked for a person to look at.
   *
   * Set by `/archive:now`, which is what every remediation message tells the
   * user to run. A background sweep never sets it, so a fault nobody has fixed
   * is not retried every ten minutes for ever.
   */
  unblock?: boolean;
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
    reap: { deleted: 0, bytesFreed: 0, requeued: 0, skipped: 0, unverified: 0, unconfirmable: 0 },
    catalogUploaded: false,
    cooledDown: false,
    budgetExhausted: false,
    lastError: null,
  };

  if (!ctx.config.enabled) {
    ctx.logger.info('sweep.disabled');
    report.durationMs = ctx.clock.now() - startedAt;
    return report;
  }

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

  const discovery = await discover(ctx, startedAt, options.unblock === true);
  report.discovered = discovery.discovered;
  report.enqueued = discovery.enqueued;

  const deadline = startedAt + ctx.config.workerBudgetMs;
  const drained = await drain(ctx, deadline, report);
  report.budgetExhausted = drained.budgetExhausted;

  if (!drained.budgetExhausted && clockLooksSane(ctx, startedAt)) {
    report.reap = await reapLocalCopies(ctx, ctx.clock.now());
    const at = ctx.clock.now();
    kvSetNumber(ctx.db, KV.unconfirmableCount, report.reap.unconfirmable, at);
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
  unblock: boolean,
): Promise<{ discovered: number; enqueued: number }> {
  let discovered = 0;
  let enqueued = 0;
  const skipped: ScanSkip[] = [];

  for await (const session of scanSessions(ctx.paths, skipped)) {
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

    // Any difference counts, not only a later mtime: restores, rsync and
    // clock corrections all move a timestamp backwards, and a coarse
    // filesystem can leave it identical across a real edit — hence the size.
    const bytes = session.transcriptBytes + session.sidecarBytes;
    const needsBackup =
      known?.verifiedAt == null ||
      known.verifiedLocalMtime !== mtime ||
      (known.verifiedLocalBytes !== null && known.verifiedLocalBytes !== bytes);
    if (needsBackup) {
      enqueue(
        ctx.db,
        {
          kind: 'backup',
          sessionId: session.sessionId,
          payload: { encodedDir: session.encodedDir },
          ...(unblock ? { unblock: true } : {}),
        },
        now,
      );
      enqueued++;
    }
  }

  kvSetNumber(ctx.db, KV.lastScanAt, now, now);
  if (skipped.length > 0) {
    const unreadable = skipped.filter((entry) => entry.reason === 'unreadable');
    ctx.logger.error('sweep.skipped_unarchivable', {
      count: skipped.length,
      unreadable: unreadable.length,
      first: skipped[0]?.name ?? '',
    });
    kvSetNumber(ctx.db, KV.skippedCount, skipped.length, now);
    kvSetNumber(ctx.db, KV.unreadableCount, unreadable.length, now);
  } else {
    kvSetNumber(ctx.db, KV.skippedCount, 0, now);
    kvSetNumber(ctx.db, KV.unreadableCount, 0, now);
  }
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
    if (job === null) {
      // The hook enqueues with a short debounce and spawns this worker
      // immediately, so the worker always lost the race with its own delay and
      // exited — leaving the session that just closed unarchived until the next
      // time Claude Code ran. For the last session before a laptop is lost,
      // that is for ever, which is the case the product exists for.
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
    // Deliberately conditional: an unreadable sidecar or a shrunken session is
    // a local fault, and letting a handful of those open the shared circuit
    // breaker stops every healthy session archiving for hours.
    if (isRetryableNetworkError(err)) noteFailure(ctx);
    return;
  }

  // A local fault does not fix itself. Retrying it a thousand times a day in
  // silence is how a session stays unarchived for months with nothing reported:
  // no blocked job, no error, no warning in /archive:status.
  if (!isRetryableNetworkError(err) && job.attempts >= LOCAL_FAILURE_LIMIT) {
    ctx.logger.error(
      'sweep.job_blocked_after_local_failures',
      { session_id: job.sessionId, attempts: job.attempts },
      err,
    );
    block(ctx.db, job, {
      error: `${message} (gave up after ${String(job.attempts)} local attempts)`,
      now,
    });
    report.blocked++;
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

/** A gap larger than this between sweeps means the clock moved, not the calendar. */
const IMPLAUSIBLE_CLOCK_JUMP_MS = 180 * 24 * 3_600_000;

/**
 * Every idle test in the reaper is arithmetic on the system clock, so a clock
 * that jumps forward makes the entire archive look ancient at once — including
 * sessions open right now, whose heartbeat is measured against the same clock.
 * A dead battery, a VM snapshot restore or a dual boot is enough.
 *
 * Skipping one sweep's reaping costs disk space. Not skipping it costs history.
 */
function clockLooksSane(ctx: WorkerContext, now: number): boolean {
  const last = kvGetNumber(ctx.db, KV.lastSweepAt) ?? 0;
  if (last === 0) return true;
  if (now < last) {
    ctx.logger.warn('sweep.clock_went_backwards', { last_sweep_at: last, now });
    return false;
  }
  if (now - last > IMPLAUSIBLE_CLOCK_JUMP_MS) {
    // The next sweep, with lastSweepAt refreshed, will reap normally.
    ctx.logger.warn('sweep.clock_jumped_forward', { last_sweep_at: last, now });
    return false;
  }
  return true;
}

/** How long a worker will wait for a job whose debounce has not elapsed. */
const DEBOUNCE_WAIT_MS = 60_000;

/** Consecutive local failures before a job is parked where a person sees it. */
const LOCAL_FAILURE_LIMIT = 5;

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
/**
 * One catalog copy per machine.
 *
 * A single shared name meant a laptop and a desktop on one Google account
 * overwrote each other every sweep, so the disaster-recovery index described
 * only whichever swept last. The bundles were all still there; the promise that
 * a dead laptop loses nothing was not.
 */
export function catalogFileName(machineId: string): string {
  return `catalog-${machineId}.sqlite`;
}

/**
 * A stable id for this installation, minted once and kept in the catalog.
 *
 * Derived from the hostname plus randomness, because two machines with the
 * same name — a corporate image, two default macOS installs — would otherwise
 * share a catalog file and overwrite each other every sweep.
 */
export function machineId(ctx: WorkerContext): string {
  const existing = kvGet(ctx.db, KV.machineId);
  if (existing !== undefined && existing !== '') return existing;
  const minted = createHash('sha256')
    .update(`${os.hostname()}:${randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 8);
  kvSet(ctx.db, KV.machineId, minted, ctx.clock.now());
  return minted;
}

export async function uploadCatalogCopy(ctx: WorkerContext): Promise<boolean> {
  const destination = path.join(ctx.paths.stagingDir, 'catalog.sqlite');
  try {
    await fsp.mkdir(ctx.paths.stagingDir, { recursive: true });
    await fsp.rm(destination, { force: true });
    await getSqlite().backup(ctx.db, destination);

    const parentId = await ctx.drive.ensureFolder([ctx.config.driveRootFolder], ctx.signal);
    const cached = kvGet(ctx.db, KV.catalogFileId);
    const existingId = cached === undefined || cached === '' ? undefined : cached;
    const existing =
      existingId ??
      (await ctx.drive.findFile({ name: catalogFileName(machineId(ctx)), parentId }, ctx.signal))
        ?.id;

    const uploaded = await ctx.drive.uploadSmallFile(
      {
        name: catalogFileName(machineId(ctx)),
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
    // Most often a stale file id: the copy was removed on Drive and every
    // later attempt targets an id that no longer exists. Forget it so the next
    // sweep creates a fresh one instead of failing forever.
    kvSet(ctx.db, KV.catalogFileId, '', ctx.clock.now());
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
