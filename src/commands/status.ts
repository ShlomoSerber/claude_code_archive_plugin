import { catalogStats, countReapSkipped, listRetainedBundles } from '../core/catalog.ts';
import { countJobs, listJobs } from '../core/queue.ts';
import { kvGet, kvGetNumber } from '../adapters/db.ts';
import { KV } from '../core/state-keys.ts';
import {
  competingCleanupSettings,
  projectCleanupSettings,
  readCleanupPeriodDays,
} from '../adapters/claude-settings.ts';
import { CLEANUP_PERIOD_DAYS, DAY_MS } from '../core/config.ts';
import { readStatusFile } from '../worker/status.ts';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from '../composition.ts';
import { formatBytes, formatDate, formatRelative, print, printJson } from './output.ts';

/**
 * `/archive:status` — what is local, what is archived, and what is stuck.
 *
 * It reads state rather than doing work, so it stays instant and never needs
 * the network unless the user asks for the Drive quota.
 */
/** The line a hook wrote when it could not even open the catalog. */
async function readHookError(dataDir: string, file: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(dataDir, file), 'utf8');
    const parsed = JSON.parse(raw) as { message?: unknown; at?: unknown } | null;
    const message = parsed?.message;
    if (typeof message !== 'string') return null;
    const at = typeof parsed?.at === 'number' ? new Date(parsed.at).toISOString() : 'unknown time';
    return `${at}: ${message.slice(0, 300)}`;
  } catch {
    return null;
  }
}

/** Every project the catalog knows, newest first, capped so status stays fast. */
function knownProjectDirs(db: ReturnType<Runtime['db']>): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT project_cwd FROM sessions
        WHERE project_cwd IS NOT NULL ORDER BY updated_at DESC LIMIT 100`,
    )
    .all() as { project_cwd: string }[];
  return rows.map((row) => row.project_cwd);
}

export async function runStatus(
  runtime: Runtime,
  options: { json?: boolean; quota?: boolean; projects?: boolean },
): Promise<number> {
  const db = runtime.db();
  const now = runtime.clock.now();
  const stats = catalogStats(db);
  const queue = countJobs(db, now);
  const blocked = listJobs(db).filter((job) => job.blocked);
  const lastSweepAt = kvGetNumber(db, KV.lastSweepAt) ?? null;
  const catalogUploadedAt = kvGetNumber(db, KV.catalogUploadedAt) ?? null;
  const circuitUntil = kvGetNumber(db, KV.circuitUntil) ?? null;
  const cleanupPeriodDays = await readCleanupPeriodDays(runtime.paths.settingsFile);
  const competing = await competingCleanupSettings(runtime.paths.claudeDir);
  // Off by default. A project_cwd is whatever directory a session was run
  // from, which routinely includes network shares and removable volumes, and
  // an open() on a dead NFS mount blocks uninterruptibly — so reading every
  // one of them to print a status page could hang the command outright.
  const competingProjects =
    options.projects === true ? await projectCleanupSettings(knownProjectDirs(db)) : [];
  const skipped = kvGetNumber(db, KV.skippedCount) ?? 0;
  const unreadable = kvGetNumber(db, KV.unreadableCount) ?? 0;
  const unconfirmable = kvGetNumber(db, KV.unconfirmableCount) ?? 0;
  const reapUnverified = kvGetNumber(db, KV.reapUnverified) ?? 0;
  // Counted from the catalog, not from the last run: the reaper looks at a
  // capped window, so 505 orphans were reported as 500.
  const orphanSidecars = countReapSkipped(db, 'orphan-sidecar');
  const unreadableSidecars = countReapSkipped(db, 'sidecar-unreadable');
  const reapBlocked = kvGet(db, KV.reapBlockedReason) ?? '';
  // The reap does not run on a sweep that exhausted its budget or saw a wild
  // clock, so these numbers can describe an earlier run. Saying when keeps a
  // fault that was fixed hours ago from reading as current.
  const reapRanAt = kvGetNumber(db, KV.reapRanAt) ?? null;
  const reapAge =
    reapRanAt === null
      ? ''
      : lastSweepAt !== null && lastSweepAt - reapRanAt > 60_000
        ? ` (as of ${formatRelative(reapRanAt, now)})`
        : '';
  const workerSpawnedAt = kvGetNumber(db, KV.workerSpawnedAt) ?? 0;
  const workerRanAt = kvGetNumber(db, KV.workerRanAt) ?? 0;
  // A worker that dies on its first line looks exactly like a healthy one:
  // spawn() succeeds because the interpreter exists, and stdio is discarded.
  const workerNeverRan = workerSpawnedAt > 0 && workerSpawnedAt - workerRanAt > 30 * 60_000;
  const hookError = (
    await Promise.all([
      readHookError(runtime.paths.dataDir, 'hook-error-end.json'),
      readHookError(runtime.paths.dataDir, 'hook-error-start.json'),
    ])
  )
    .filter((entry): entry is string => entry !== null)
    .join('; ');
  // A sweep that throws leaves lastSweepAt unwritten. Without this the page is
  // clean while nothing has ever been archived.
  // pendingBackup, not sessions: /archive:setup --skip-backfill imports rows
  // from Drive without sweeping, and there is nothing wrong with that.
  const sweepNeverRan = stats.pendingBackup > 0 && lastSweepAt === null;
  const sweepStale =
    lastSweepAt !== null && stats.pendingBackup > 0 && now - lastSweepAt > 3 * DAY_MS;
  const retained = listRetainedBundles(db);
  const signedIn = await runtime.tokenStore
    .read()
    .then((tokens) => tokens !== null)
    .catch(() => false);
  const persisted = await readStatusFile(runtime.paths.statusFile);

  let quota: Awaited<ReturnType<Awaited<ReturnType<Runtime['drive']>>['storageQuota']>> | null =
    null;
  let quotaError: string | null = null;
  if (options.quota === true) {
    try {
      quota = await (await runtime.drive()).storageQuota();
    } catch (err) {
      quotaError = err instanceof Error ? err.message : 'unavailable';
    }
  }

  if (options.json === true) {
    printJson({
      version: runtime.version,
      signedIn,
      config: runtime.config,
      cleanupPeriodDays,
      competingCleanupSettings: competing,
      competingProjectSettings: competingProjects,
      unarchivable: skipped,
      unreadable,
      unconfirmable,
      reapUnverified,
      reapRanAt,
      orphanSidecars,
      unreadableSidecars,
      workerSpawnedAt,
      workerRanAt,
      workerNeverRan,
      hookError: hookError === '' ? null : hookError,
      sweepNeverRan,
      sweepStale,
      reapBlocked: reapBlocked === '' ? null : reapBlocked,
      retainedBundles: retained.map((entry) => ({
        sessionId: entry.sessionId,
        fileId: entry.fileId,
        remotePath: entry.remotePath,
        reason: entry.reason,
      })),
      catalog: stats,
      queue,
      blocked: blocked.map((job) => ({ sessionId: job.sessionId, error: job.lastError })),
      lastSweepAt,
      catalogUploadedAt,
      circuitUntil,
      quota,
      quotaError,
      paths: {
        dataDir: runtime.paths.dataDir,
        logFile: runtime.paths.logFile,
        tokenFile: runtime.tokenStore.location,
        projectsDir: runtime.paths.projectsDir,
      },
      lastSweep: persisted?.lastSweep ?? null,
    });
    return 0;
  }

  print(`Claude Code Archive ${runtime.version}`);
  print(`  Google account:     ${signedIn ? 'connected' : 'not connected — run /archive:setup'}`);
  print(`  Sessions known:     ${String(stats.sessions)}`);
  print(`  Archived & verified:${String(stats.verified).padStart(7)}`);
  print(`  Still local:        ${String(stats.localPresent)} (${formatBytes(stats.localBytes)})`);
  print(`  Reclaimed locally:  ${formatBytes(stats.reclaimedBytes)}`);
  print(`  On Drive:           ${formatBytes(stats.archivedBytes)}`);
  print(
    `  History spans:      ${formatDate(stats.oldestSession)} → ${formatDate(stats.newestSession)}`,
  );
  print();
  print(
    `  Retention:          ${String(runtime.config.retentionDays)} idle days${runtime.config.keepLocalForever ? ' (deletion disabled)' : ''}`,
  );
  print(
    `  cleanupPeriodDays:  ${cleanupPeriodDays === null ? 'unset' : String(cleanupPeriodDays)}${cleanupPeriodDays === CLEANUP_PERIOD_DAYS ? ' (plugin owns deletion)' : ' — run /archive:setup'}`,
  );
  print(`  Last sweep:         ${formatRelative(lastSweepAt, now)}`);
  print(`  Queue:              ${String(queue.runnable)} runnable, ${String(queue.total)} total`);
  print();
  // Printed unconditionally: this is the directory a bring-your-own
  // oauth-client.json goes in, and the first thing to look at when the log
  // needs reading. Making the user hit an error to learn the path is unkind.
  print(`  Data directory:     ${runtime.paths.dataDir}`);
  print(`  Log:                ${runtime.paths.logFile}`);

  if (skipped > 0) {
    print(`  WARNING:            ${String(skipped)} project(s) or session(s) cannot be archived`);
    print(
      `                      ${String(unreadable)} could not be read; the rest have unusable names ` +
        `or share a session id with another project directory. See the log.`,
    );
  }
  if (options.projects !== true) {
    print(`  Project settings:   not checked (pass --projects to read every project's`);
    print(`                      .claude/settings.json; a dead network mount can hang it)`);
  }
  for (const other of competingProjects) {
    print(`  WARNING:            ${other.file} sets cleanupPeriodDays=${String(other.value)}`);
    print(`                      Claude Code still deletes that project's transcripts.`);
  }
  for (const other of competing) {
    print(`  WARNING:            ${other.file} also sets cleanupPeriodDays=${String(other.value)}`);
    print(`                      That file outranks the one this plugin wrote.`);
  }
  if (!runtime.config.enabled) {
    print(`  WARNING:            archiving is switched off (enabled: false).`);
    print(`                      Nothing is being backed up or deleted.`);
  }
  if (queue.failing > 0) {
    print(`  Retrying:           ${String(queue.failing)} job(s) are in backoff after a failure`);
  }
  if (workerNeverRan) {
    print(`  WARNING:            the background worker was started but never ran.`);
    print(`                      Nothing is being archived. Run /archive:now and check the log.`);
  }
  if (hookError !== '') {
    print(`  WARNING:            a hook failed: ${hookError}`);
  }
  if (sweepNeverRan) {
    print(`  WARNING:            no sweep has ever finished, though sessions are known.`);
    print(`                      Nothing is being archived. Run /archive:now.`);
  } else if (sweepStale) {
    print(`  WARNING:            sessions are waiting and the last finished sweep was`);
    print(`                      ${formatRelative(lastSweepAt, now)}. Run /archive:now.`);
  }
  if (reapBlocked !== '') {
    // The remediation Drive's refusal came with. It used to be swallowed here,
    // so a revoked token showed up only as an archive that had stopped being
    // verified, with nothing saying why.
    print(`  WARNING:            Drive would not answer the last check${reapAge}:`);
    print(`                      ${reapBlocked}`);
  }
  if (orphanSidecars > 0) {
    print(`  ${String(orphanSidecars)} session(s) have a sidecar directory but no transcript.`);
    print(`  Nothing removes those, and their bytes are not counted as reclaimed.`);
  }
  // Without the catalog copy, a replacement machine can still read every
  // bundle by hand but cannot search or restore anything archived since.
  if (catalogUploadedAt === null && stats.verified > 0) {
    print(`  WARNING:            the catalog has never been copied to Drive.`);
    print(`                      A new machine could not find these sessions. Run /archive:now.`);
  } else if (catalogUploadedAt !== null && now - catalogUploadedAt > 7 * DAY_MS) {
    print(
      `  WARNING:            the catalog copy on Drive is from ${formatRelative(catalogUploadedAt, now)}.`,
    );
    print(`                      Sessions archived since then would not be findable on a new machine.`);
  }
  if (unreadableSidecars > 0) {
    print(`  WARNING:            ${String(unreadableSidecars)} session(s) have a sidecar this`);
    print(`                      plugin cannot read, so they are not being archived.`);
  }
  if (reapUnverified > 0) {
    print(
      `  WARNING:            ${String(reapUnverified)} archived session(s) were missing or changed`,
    );
    print(`                      on Drive and have been queued to upload again.`);
  }
  if (unconfirmable > 0) {
    // Everything says verified and nothing is ever reclaimed: without this line
    // the plugin looks healthy while its whole purpose has quietly stopped.
    print(`  WARNING:            ${String(unconfirmable)} archived session(s) could not be`);
    print(`                      re-confirmed on Drive, so no space was reclaimed. See the log.`);
  }
  if (retained.length > 0) {
    print();
    print(
      `  ${String(retained.length)} older bundle(s) kept on Drive alongside their replacement:`,
    );
    for (const entry of retained.slice(0, 5)) {
      print(`    ${entry.sessionId}: ${entry.reason}`);
      print(`      ${entry.remotePath ?? '(path unknown)'}  id: ${entry.fileId}`);
    }
    print(`  They hold data the newer bundle does not. Nothing deletes them.`);
    print(`  Unpack one beside its session with: /archive:resume --bundle <file id>`);
  }
  if (circuitUntil !== null && circuitUntil > now) {
    print(`  Backing off until:  ${formatDate(circuitUntil)} after repeated failures`);
  }
  if (blocked.length > 0) {
    print();
    print(`  ${String(blocked.length)} job(s) need attention:`);
    for (const job of blocked.slice(0, 5)) {
      print(`    ${job.sessionId ?? '(catalog)'}: ${job.lastError ?? 'unknown error'}`);
    }
  }
  if (quota !== null) {
    print();
    print(
      `  Drive used:         ${formatBytes(quota.usageBytes)} of ${formatBytes(quota.limitBytes)}`,
    );
  } else if (quotaError !== null) {
    print(`  Drive quota:        unavailable (${quotaError})`);
  }
  return 0;
}
