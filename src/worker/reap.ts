import fsp from 'node:fs/promises';
import { listReapable, markLocalDeleted, markLocalPresent } from '../core/catalog.ts';
import { reapCutoff } from '../core/config.ts';
import { enqueue } from '../core/queue.ts';
import { statSession } from '../adapters/session-scan.ts';
import type { WorkerContext } from './context.ts';

/**
 * Deleting local copies (SPEC §2).
 *
 * This is the only code in the plugin that removes user data, so it re-checks
 * every precondition itself rather than trusting the query that selected the
 * row. The query is an optimisation; these checks are the guarantee.
 */

export type ReapReport = {
  deleted: number;
  bytesFreed: number;
  requeued: number;
  skipped: number;
};

export async function reapLocalCopies(ctx: WorkerContext, now: number): Promise<ReapReport> {
  const report: ReapReport = { deleted: 0, bytesFreed: 0, requeued: 0, skipped: 0 };
  if (ctx.config.keepLocalForever) return report;

  const cutoff = reapCutoff(now, ctx.config.retentionDays);
  for (const record of listReapable(ctx.db, cutoff)) {
    ctx.signal?.throwIfAborted();
    const log = ctx.logger.child({ session_id: record.sessionId });

    // SPEC invariant 1, restated in code: no verified Drive copy, no deletion.
    if (
      record.verifiedAt === null ||
      record.bundleSha256 === null ||
      record.remoteFileId === null
    ) {
      report.skipped++;
      continue;
    }

    const onDisk = await statSession(ctx.paths, record.encodedDir, record.sessionId);
    if (onDisk === null) {
      // Already gone; make the catalog agree with the disk.
      markLocalDeleted(ctx.db, record.sessionId, now);
      continue;
    }

    // A session touched since we archived it is a different session now.
    if (Math.trunc(onDisk.mtimeMs) > (record.lastLocalMtime ?? 0)) {
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

    if (onDisk.mtimeMs >= cutoff) {
      report.skipped++;
      continue;
    }

    try {
      await fsp.rm(onDisk.transcriptPath, { force: true });
      if (onDisk.hasSidecar) {
        await fsp.rm(onDisk.sidecarDir, { recursive: true, force: true });
      }
    } catch (err) {
      log.warn('reap.delete_failed', {}, err);
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
