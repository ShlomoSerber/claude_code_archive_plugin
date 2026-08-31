import fsp from 'node:fs/promises';
import { writeFileAtomic } from '../adapters/atomic.ts';
import { kvGetNumber } from '../adapters/db.ts';
import { catalogStats, type CatalogStats } from '../core/catalog.ts';
import { countJobs, listJobs, type QueueCounts } from '../core/queue.ts';
import { KV } from '../core/state-keys.ts';
import type { WorkerContext } from './context.ts';
import type { SweepReport } from './sweep.ts';

/**
 * The status snapshot rendered by `/archive:status` (ARCHITECTURE §11).
 *
 * One of the three surfaces a background process has for telling a user
 * something: the NDJSON log for forensics, this file for state, and the hook
 * `systemMessage` channel for the rare thing that needs eyes now.
 */

export type StatusSnapshot = {
  version: string;
  writtenAt: number;
  lastSweepAt: number | null;
  lastSweep: SweepReport | null;
  catalog: CatalogStats;
  queue: QueueCounts;
  /** Jobs parked until the user does something, with what to do. */
  blockedJobs: { sessionId: string | null; error: string | null; attempts: number }[];
  circuit: { openUntil: number | null; consecutiveFailures: number };
  retentionDays: number;
  keepLocalForever: boolean;
  catalogUploadedAt: number | null;
};

export function buildStatus(ctx: WorkerContext, report: SweepReport | null): StatusSnapshot {
  const now = ctx.clock.now();
  return {
    version: ctx.version,
    writtenAt: now,
    lastSweepAt: kvGetNumber(ctx.db, KV.lastSweepAt) ?? null,
    lastSweep: report,
    catalog: catalogStats(ctx.db),
    queue: countJobs(ctx.db, now),
    blockedJobs: listJobs(ctx.db)
      .filter((job) => job.blocked)
      .slice(0, 20)
      .map((job) => ({ sessionId: job.sessionId, error: job.lastError, attempts: job.attempts })),
    circuit: {
      openUntil: kvGetNumber(ctx.db, KV.circuitUntil) ?? null,
      consecutiveFailures: kvGetNumber(ctx.db, KV.circuitFailures) ?? 0,
    },
    retentionDays: ctx.config.retentionDays,
    keepLocalForever: ctx.config.keepLocalForever,
    catalogUploadedAt: kvGetNumber(ctx.db, KV.catalogUploadedAt) ?? null,
  };
}

export async function writeStatusFile(
  ctx: WorkerContext,
  report: SweepReport | null,
): Promise<void> {
  try {
    const snapshot = buildStatus(ctx, report);
    await writeFileAtomic(ctx.paths.statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    ctx.logger.warn('status.write_failed', {}, err);
  }
}

export async function readStatusFile(file: string): Promise<StatusSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as StatusSnapshot) : null;
  } catch {
    return null;
  }
}
