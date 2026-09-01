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
import { renameRetryDelay } from '../adapters/atomic.ts';
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
  /** Why the run stopped asking Drive at all, when it did. */
  blockedReason: string | null;
  /**
   * Rows Drive would not answer for, so nothing could be reclaimed.
   *
   * Counted separately from `skipped` because it is the shape of a plugin that
   * has quietly stopped doing the one thing it exists for: everything reports
   * verified, nothing is ever freed, and no message says why.
   */
  unconfirmable: number;
};

export async function reapLocalCopies(ctx: WorkerContext, now: number): Promise<ReapReport> {
  const report: ReapReport = {
    deleted: 0,
    bytesFreed: 0,
    requeued: 0,
    skipped: 0,
    unverified: 0,
    unconfirmable: 0,
    blockedReason: null,
  };
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

    let onDisk;
    try {
      onDisk = await statSession(ctx.paths, record.encodedDir, record.sessionId);
    } catch (err) {
      // "I could not look" is not "it is not there". Recording the latter made
      // /archive:status report space reclaimed from files still on disk.
      log.warn('reap.stat_failed', {}, err);
      report.skipped++;
      continue;
    }
    if (onDisk === null) {
      // Only if it is not simply somewhere else. A project directory renamed
      // by hand leaves the transcript on disk under a name the catalog has not
      // caught up with, and recording that as deleted made /archive:status
      // claim space it had never reclaimed and /archive:resume unpack a second
      // copy into the directory the user had moved away from.
      const elsewhere = await findSessionElsewhere(ctx, record);
      if (elsewhere !== null) {
        log.info('reap.session_moved', { encoded_dir: elsewhere });
        report.skipped++;
        continue;
      }
      markLocalDeleted(ctx.db, record.sessionId, now);
      continue;
    }

    if (onDisk.sidecarUnreadable) {
      // We cannot tell what is in there, so we cannot know it is archived.
      report.skipped++;
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

    const remote = await confirmRemote(ctx, record, report);
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
    if (remote === 'blocked') {
      // Whatever is wrong is wrong for every session, so asking again for each
      // of the other two hundred just burns quota against a Drive that is
      // already refusing us.
      // Not counted as one unconfirmable session: the fault is not this
      // session's, and reporting "1 could not be confirmed" when it is all of
      // them understates it. blockedReason carries the real signal.
      report.skipped++;
      break;
    }
    if (remote === 'unavailable') {
      report.skipped++;
      report.unconfirmable++;
      continue;
    }

    // Everything above this line was decided before a network round trip.
    // A session resumed in the meantime would otherwise be unlinked under a
    // live writer, losing whatever it had written since.
    const settled = await statSession(ctx.paths, record.encodedDir, record.sessionId);
    if (
      settled === null ||
      changedSinceVerification(record, settled) ||
      isSessionActive(ctx, record.sessionId, ctx.clock.now())
    ) {
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
  // A crashed Claude Code never fires SessionEnd, so the mark has to expire —
  // but it is written once at SessionStart and never refreshed, so a TTL below
  // the retention window can never protect anything: by the time a session is
  // old enough to reap, its mark has always expired.
  const ttl = Math.max(ACTIVE_SESSION_TTL_MS, (ctx.config.retentionDays + 7) * DAY_MS);
  return now - seen < ttl;
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
  report: ReapReport,
): Promise<'ok' | 'gone' | 'unavailable' | 'blocked'> {
  if (record.remoteFileId === null) return 'gone';
  try {
    const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
    // A file in the wastebasket still answers with its checksum, and Drive
    // purges the wastebasket after thirty days. Treating that as "stored" is
    // how the last copy of a conversation quietly becomes the only copy, and
    // then no copy at all.
    if (remote.trashed === true) return 'gone';
    // Drive did not say. That is not permission to delete the local copy.
    if (remote.trashed === null) return 'unavailable';
    // Against the size verification recorded, not bundle_bytes, which
    // describes the last bundle *built* — a failed re-upload leaves that
    // pointing at bytes Drive never received while the pointer still names the
    // good copy, and comparing it calls a healthy archive corrupt.
    const expectedBytes = record.verifiedBundleBytes;
    if (remote.size !== null && expectedBytes !== null && remote.size !== expectedBytes) {
      return 'gone';
    }
    // Compared against the hash verification actually passed on, not against
    // bundle_sha256, which a later failed rebuild overwrites with bytes Drive
    // never received.
    if (remote.sha256 !== null) {
      return remote.sha256.toLowerCase() === record.verifiedBundleSha256?.toLowerCase()
        ? 'ok'
        : 'gone';
    }
    // Drive returns sha256Checksum only "if available". Requiring it meant a
    // Drive that answers with md5 alone never let a single session be reaped —
    // the plugin's entire purpose, silently never happening while /archive:status
    // reported everything verified. md5 is weaker, but it is answering the only
    // question left here: is this still the file we uploaded? What the bundle
    // contains was settled earlier, by sha256 against the disk.
    if (remote.md5 !== null && record.verifiedBundleMd5 !== null) {
      return remote.md5.toLowerCase() === record.verifiedBundleMd5.toLowerCase() ? 'ok' : 'gone';
    }
    // No checksum at all means Drive could not answer the question, not that
    // the answer was bad. Skip this session for now rather than withdrawing a
    // good verification and scheduling a re-archive.
    return 'unavailable';
  } catch (err) {
    // Only 404 is Drive saying the file is not there. Every other FatalError —
    // a rejected token, a full Drive, a 403 — is Drive refusing to talk to us,
    // and reading that as "the archive is gone" withdrew the verification of
    // every session and queued a re-upload of the lot, while the remediation
    // that would have fixed it was swallowed here.
    if (err instanceof FatalError) {
      if (err.status === 404) return 'gone';
      ctx.logger.error('reap.remote_check_blocked', { session_id: record.sessionId }, err);
      report.blockedReason = `${err.message} — ${err.remediation}`;
      return 'blocked';
    }
    ctx.logger.warn('reap.remote_check_failed', { session_id: record.sessionId }, err);
    return 'unavailable';
  }
}

/**
 * Is this session's transcript under some other project directory?
 *
 * Returns the directory it was found in, or null. Used only to keep the
 * reaper from calling a moved session a deleted one; the scan corrects the
 * catalog on its next pass.
 */
async function findSessionElsewhere(
  ctx: WorkerContext,
  record: SessionRecord,
): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await fsp.readdir(ctx.paths.projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (dir === record.encodedDir || !isSafeEncodedDir(dir)) continue;
    try {
      const stat = await fsp.lstat(
        path.join(ctx.paths.projectsDir, dir, `${record.sessionId}.jsonl`),
      );
      if (stat.isFile()) return dir;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
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
  // Retried the way renames are: on Windows an antivirus or indexer handle
  // gives a transient EPERM, and giving up here leaves the sidecar deleted and
  // the transcript in place — the half-reaped state that later let a growing
  // session overwrite the archive of what was already lost.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp.rm(target.transcriptPath, { force: true });
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 3) {
        log.warn('reap.delete_failed', {}, err);
        return false;
      }
      await ctx.clock.sleep(renameRetryDelay(attempt));
    }
  }
  return false;
}
