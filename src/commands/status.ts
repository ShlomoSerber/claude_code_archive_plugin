import { catalogStats, listRetainedBundles } from '../core/catalog.ts';
import { countJobs, listJobs } from '../core/queue.ts';
import { kvGet, kvGetNumber } from '../adapters/db.ts';
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
  const unreadable = kvGetNumber(db, KV.unreadableCount) ?? 0;
  const unconfirmable = kvGetNumber(db, KV.unconfirmableCount) ?? 0;
  const reapUnverified = kvGetNumber(db, KV.reapUnverified) ?? 0;
  const reapBlocked = kvGet(db, KV.reapBlockedReason) ?? '';
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
      unarchivable: skipped,
      unreadable,
      unconfirmable,
      reapUnverified,
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
      `                      ${String(unreadable)} could not be read; the rest have unusable names. See the log.`,
    );
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
    print(
      `  Retrying:           ${String(queue.failing)} job(s) are in backoff after a failure`,
    );
  }
  if (reapBlocked !== '') {
    // The remediation Drive's refusal came with. It used to be swallowed here,
    // so a revoked token showed up only as an archive that had stopped being
    // verified, with nothing saying why.
    print(`  WARNING:            Drive would not answer the last check:`);
    print(`                      ${reapBlocked}`);
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
      print(`      ${entry.remotePath ?? entry.fileId}`);
    }
    print(`  They hold data the newer bundle does not. Nothing deletes them.`);
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
