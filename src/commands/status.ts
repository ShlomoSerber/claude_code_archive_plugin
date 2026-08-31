import { catalogStats } from '../core/catalog.ts';
import { countJobs, listJobs } from '../core/queue.ts';
import { kvGetNumber } from '../adapters/db.ts';
import { KV } from '../core/state-keys.ts';
import { competingCleanupSettings, readCleanupPeriodDays } from '../adapters/claude-settings.ts';
import { CLEANUP_PERIOD_DAYS } from '../core/config.ts';
import { readStatusFile } from '../worker/status.ts';
import type { Runtime } from '../composition.ts';
import { formatBytes, formatDate, formatRelative, print, printJson } from './output.ts';

/**
 * `/archive:status` — what is local, what is archived, and what is stuck.
 *
 * It reads state rather than doing work, so it stays instant and never needs
 * the network unless the user asks for the Drive quota.
 */
export async function runStatus(
  runtime: Runtime,
  options: { json?: boolean; quota?: boolean },
): Promise<number> {
  const db = runtime.db();
  const now = runtime.clock.now();
  const stats = catalogStats(db);
  const queue = countJobs(db, now);
  const blocked = listJobs(db).filter((job) => job.blocked);
  const lastSweepAt = kvGetNumber(db, KV.lastSweepAt) ?? null;
  const circuitUntil = kvGetNumber(db, KV.circuitUntil) ?? null;
  const cleanupPeriodDays = await readCleanupPeriodDays(runtime.paths.settingsFile);
  const competing = await competingCleanupSettings(runtime.paths.claudeDir);
  const skipped = kvGetNumber(db, KV.skippedCount) ?? 0;
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
      unarchivable: skipped,
      catalog: stats,
      queue,
      blocked: blocked.map((job) => ({ sessionId: job.sessionId, error: job.lastError })),
      lastSweepAt,
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
    print(`                      Their names are unusable as paths; see the log.`);
  }
  for (const other of competing) {
    print(`  WARNING:            ${other.file} also sets cleanupPeriodDays=${String(other.value)}`);
    print(`                      That file outranks the one this plugin wrote.`);
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
