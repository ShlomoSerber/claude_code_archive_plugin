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
  /** Set once the initial backfill has enqueued every existing session. */
  backfillDoneAt: 'backfill.done_at',
} as const;
