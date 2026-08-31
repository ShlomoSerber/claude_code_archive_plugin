import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  clearVerification,
  listReapable,
  markLocalDeleted,
  markLocalPresent,
} from '../core/catalog.ts';
import type { SessionRecord } from '../core/catalog.ts';
import { DAY_MS, reapCutoff } from '../core/config.ts';
import { FatalError } from '../core/errors.ts';
import { assertInside, isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
import { enqueue } from '../core/queue.ts';
import { statSession, type LocalSession } from '../adapters/session-scan.ts';
import { kvGetNumber } from '../adapters/db.ts';
import { ACTIVE_SESSION_TTL_MS, activeSessionKey } from '../core/state-keys.ts';
import type { WorkerContext } from './context.ts';

/**
 * Deleting local copies (SPEC §2).
 *
 * This is the only code in the plugin that removes the user's data, and it is
 * written on the assumption that everything upstream of it is wrong. The query
 * that selects a row is an optimisation; the checks in this loop are the
 * guarantee.
 *
 * Four things must hold before a single byte is deleted:
 *
 *  1. The identifiers are well formed and the resolved paths sit inside the
 *     projects directory. An unchecked session id of `..` turns a per-session
 *     delete into a delete of every project.
 *  2. The files on disk are byte-for-byte the ones that were archived, judged
 *     by the mtime and size recorded *at verification time* — never by
 *     `last_local_mtime`, which scans and indexing passes also advance.
 *  3. Drive still holds that copy, confirmed by asking Drive now rather than
 *     by trusting a timestamp that may be months old.
 *  4. The remote checksum still matches the bundle we made.
 */

export type ReapReport = {
  deleted: number;
  bytesFreed: number;
  requeued: number;
  skipped: number;
  /** Rows whose Drive copy has gone missing or changed since it was verified. */
  unverified: number;
};

export async function reapLocalCopies(ctx: WorkerContext, now: number): Promise<ReapReport> {
  const report: ReapReport = { deleted: 0, bytesFreed: 0, requeued: 0, skipped: 0, unverified: 0 };
  // `enabled: false` has to stop deletion, not merely stop the hooks, or
  // "turn it off" is a promise the plugin does not keep.
  if (!ctx.config.enabled || ctx.config.keepLocalForever) return report;

  const cutoff = reapCutoff(now, ctx.config.retentionDays);
  for (const record of listReapable(ctx.db, cutoff)) {
    ctx.signal?.throwIfAborted();
    const log = ctx.logger.child({ session_id: record.sessionId });

    const target = safeTarget(ctx, record);
    if (target === null) {
      log.error('reap.unsafe_identifiers', {
        encoded_dir: record.encodedDir,
        reason: 'identifier or path failed validation',
      });
      report.skipped++;
      continue;
    }

    if (!hasVerifiedState(record)) {
      report.skipped++;
      continue;
    }

    const onDisk = await statSession(ctx.paths, record.encodedDir, record.sessionId);
    if (onDisk === null) {
      markLocalDeleted(ctx.db, record.sessionId, now);
      continue;
    }

    if (changedSinceVerification(record, onDisk)) {
      markLocalPresent(ctx.db, record.sessionId, Math.trunc(onDisk.mtimeMs), now);
      enqueue(
        ctx.db,
        { kind: 'backup', sessionId: record.sessionId, payload: { encodedDir: record.encodedDir } },
        now,
      );
      log.info('reap.changed_since_backup');
      report.requeued++;
      continue;
    }

    if (Math.trunc(onDisk.mtimeMs) >= cutoff) {
      report.skipped++;
      continue;
    }

    // The archive itself has to have survived a while. Without this, a first
    // install uploads a months-old session and deletes it in the same sweep,
    // before anyone has evidence that restoring from this archive works.
    if (
      record.verifiedAt !== null &&
      now - record.verifiedAt < ctx.config.archiveGraceDays * DAY_MS
    ) {
      report.skipped++;
      continue;
    }

    // A session Claude Code is using right now is not idle, whatever its mtime
    // says. Deleting it unlinks the file under a live writer: everything after
    // the last flush is lost and the session cannot be resumed.
    if (isSessionActive(ctx, record.sessionId, now)) {
      log.info('reap.session_active');
      report.skipped++;
      continue;
    }

    const remote = await confirmRemote(ctx, record);
    if (remote === 'gone') {
      log.warn('reap.remote_no_longer_valid');
      clearVerification(ctx.db, record.sessionId, now);
      enqueue(
        ctx.db,
        { kind: 'backup', sessionId: record.sessionId, payload: { encodedDir: record.encodedDir } },
        now,
      );
      report.unverified++;
      continue;
    }
    if (remote === 'unavailable') {
      report.skipped++;
      continue;
    }

    if (!(await removeLocalCopy(ctx, onDisk, target))) {
      report.skipped++;
      continue;
    }

    markLocalDeleted(ctx.db, record.sessionId, now);
    report.deleted++;
    report.bytesFreed += onDisk.transcriptBytes + onDisk.sidecarBytes;
    log.info('reap.deleted', { bytes: onDisk.transcriptBytes + onDisk.sidecarBytes });
  }

  return report;
}

/** Hooks record a heartbeat while a session is open; this reads it back. */
function isSessionActive(ctx: WorkerContext, sessionId: string, now: number): boolean {
  const seen = kvGetNumber(ctx.db, activeSessionKey(sessionId));
  if (seen === undefined) return false;
  // A crashed Claude Code never fires SessionEnd, so the mark has to expire.
  return now - seen < ACTIVE_SESSION_TTL_MS;
}

type Target = { transcriptPath: string; sidecarDir: string };

/**
 * Validate the identifiers, then prove the paths they build land inside the
 * projects directory. Returns null when anything is off.
 */
function safeTarget(ctx: WorkerContext, record: SessionRecord): Target | null {
  if (!isSafeSessionId(record.sessionId) || !isSafeEncodedDir(record.encodedDir)) return null;
  const projectDir = path.join(ctx.paths.projectsDir, record.encodedDir);
  const target: Target = {
    transcriptPath: path.join(projectDir, `${record.sessionId}.jsonl`),
    sidecarDir: path.join(projectDir, record.sessionId),
  };
  try {
    assertInside(ctx.paths.projectsDir, projectDir, 'project directory');
    assertInside(projectDir, target.transcriptPath, 'transcript');
    assertInside(projectDir, target.sidecarDir, 'sidecar directory');
  } catch {
    return null;
  }
  return target;
}

/** A row with no recorded verification state cannot be reasoned about. */
function hasVerifiedState(record: SessionRecord): boolean {
  return (
    record.verifiedAt !== null &&
    record.bundleSha256 !== null &&
    record.remoteFileId !== null &&
    record.verifiedLocalMtime !== null &&
    record.verifiedBundleSha256 !== null
  );
}

/**
 * Has the session changed since the archived copy was made?
 *
 * Compared against the state recorded at verification, and by size as well as
 * mtime: an edit that leaves mtime unchanged is invisible otherwise, and coarse
 * filesystem timestamps make that a real case rather than a theoretical one.
 */
export function changedSinceVerification(record: SessionRecord, onDisk: LocalSession): boolean {
  if (Math.trunc(onDisk.mtimeMs) !== record.verifiedLocalMtime) return true;
  const bytes = onDisk.transcriptBytes + onDisk.sidecarBytes;
  return record.verifiedLocalBytes !== null && bytes !== record.verifiedLocalBytes;
}

/**
 * Ask Drive whether it still holds the bundle, now.
 *
 * A `verified_at` timestamp records that a check passed once. It says nothing
 * about whether the file survived: it can be trashed, purged for quota, or
 * removed by someone with access. Deleting the last local copy on the strength
 * of a months-old timestamp is exactly the failure this plugin exists to avoid.
 */
async function confirmRemote(
  ctx: WorkerContext,
  record: SessionRecord,
): Promise<'ok' | 'gone' | 'unavailable'> {
  if (record.remoteFileId === null) return 'gone';
  try {
    const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
    // A file in the wastebasket still answers with its checksum, and Drive
    // purges the wastebasket after thirty days. Treating that as "stored" is
    // how the last copy of a conversation quietly becomes the only copy, and
    // then no copy at all.
    if (remote.trashed) return 'gone';
    if (remote.size !== null && record.bundleBytes !== null && remote.size !== record.bundleBytes) {
      return 'gone';
    }
    // Deletion is irreversible, so the strong hash is required here even though
    // the upload path is willing to fall back to md5.
    // No checksum means Drive could not answer the question, not that the
    // answer was bad. Skip this session for now rather than withdrawing a good
    // verification and scheduling a re-archive that could overwrite the archive.
    if (remote.sha256 === null) return 'unavailable';
    // Compared against the hash verification actually passed on, not against
    // bundle_sha256, which a later failed rebuild overwrites with bytes Drive
    // never received.
    return remote.sha256.toLowerCase() === record.verifiedBundleSha256?.toLowerCase()
      ? 'ok'
      : 'gone';
  } catch (err) {
    // A 4xx is Drive saying the file is not there. Anything else is this run's
    // problem, not the archive's, so leave the row alone and try next time.
    if (err instanceof FatalError) return 'gone';
    ctx.logger.warn('reap.remote_check_failed', { session_id: record.sessionId }, err);
    return 'unavailable';
  }
}

/**
 * Remove the sidecar first, then the transcript.
 *
 * That order means a failure part-way through leaves the transcript in place,
 * so the catalog is never left claiming a session is archived-and-gone when
 * part of it is still on disk.
 */
async function removeLocalCopy(
  ctx: WorkerContext,
  onDisk: LocalSession,
  target: Target,
): Promise<boolean> {
  const log = ctx.logger.child({ session_id: onDisk.sessionId });
  if (onDisk.hasSidecar) {
    try {
      await fsp.rm(target.sidecarDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('reap.sidecar_delete_failed', {}, err);
      return false;
    }
  }
  try {
    await fsp.rm(target.transcriptPath, { force: true });
    return true;
  } catch (err) {
    log.warn('reap.delete_failed', {}, err);
    return false;
  }
}
