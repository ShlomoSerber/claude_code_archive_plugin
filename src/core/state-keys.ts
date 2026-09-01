/**
 * Keys in the `kv` table.
 *
 * The circuit breaker lives here rather than in memory because every process
 * that could hold it dies within minutes (ARCHITECTURE §6).
 */
export const KV = {
  /** No network work before this timestamp. */
  circuitUntil: 'circuit.until',
  /** Consecutive failed runs, which set the length of the next cool-down. */
  circuitFailures: 'circuit.failures',
  /** Last completed sweep, for the minimum-interval check. */
  lastSweepAt: 'sweep.last_at',
  /** Last time the catalog copy reached Drive. */
  catalogUploadedAt: 'catalog.uploaded_at',
  /** Drive file id of the catalog copy, so it is replaced and not duplicated. */
  catalogFileId: 'catalog.file_id',
  /** Sessions counted at the last full scan, shown by /archive:status. */
  lastScanAt: 'scan.last_at',
  /** Sessions or projects the last scan could not archive, for /archive:status. */
  skippedCount: 'scan.skipped_count',
  /** How many of those were unreadable rather than badly named. */
  unreadableCount: 'scan.unreadable_count',
  /** Stable id for this installation, so two machines never share a catalog file. */
  machineId: 'machine.id',
  /** Why the last reap stopped asking Drive, if it did. */
  reapBlockedReason: 'reap.blocked_reason',
  /** Archived sessions the last reap found missing or changed on Drive. */
  reapUnverified: 'reap.unverified_count',
  /** Sessions the last reap could not confirm on Drive, so nothing was freed. */
  unconfirmableCount: 'reap.unconfirmable_count',
} as const;

/**
 * Marks a session as open right now. Written by SessionStart, cleared by
 * SessionEnd, and expired on a timer because a crash never sends SessionEnd.
 */
export function activeSessionKey(sessionId: string): string {
  return `active.${sessionId}`;
}

/**
 * How long an open-session mark is honoured without being refreshed.
 *
 * Deliberately generous. The mark is only written at SessionStart, so a session
 * left open for days still holds one; and the two failure directions are not
 * symmetric. A mark that lingers too long delays a deletion, which costs disk.
 * A mark that expires too early unlinks a file under a live writer.
 */
export const ACTIVE_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
