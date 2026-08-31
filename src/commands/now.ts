import { runSweep } from '../worker/sweep.ts';
import { writeStatusFile } from '../worker/status.ts';
import { acquireLock } from '../adapters/lock.ts';
import type { Runtime } from '../composition.ts';
import { commandContext } from './context.ts';
import { formatBytes, print, printJson, warn } from './output.ts';

/**
 * `/archive:now` — run a sweep in the foreground and report what happened.
 *
 * It takes the same lock the background worker does, so an explicit sweep and a
 * hook-triggered one can never run at once.
 */
export async function runNow(
  runtime: Runtime,
  options: { json?: boolean; backfill?: boolean } = {},
): Promise<number> {
  const lock = acquireLock(runtime.paths.lockDir, { logger: runtime.logger, clock: runtime.clock });
  if (lock === null) {
    const message = 'A background sweep is already running. Try again in a moment.';
    if (options.json === true) printJson({ status: 'busy', message });
    else warn(message);
    return 0;
  }

  try {
    const ctx = commandContext(runtime, { timeoutMs: runtime.config.workerBudgetMs });
    const report = await runSweep(ctx, { force: true, backfill: options.backfill === true });
    await writeStatusFile(ctx, report);

    if (options.json === true) {
      printJson(report);
      return 0;
    }
    print(`Scanned ${String(report.discovered)} sessions, queued ${String(report.enqueued)}.`);
    print(
      `Backed up and verified ${String(report.verified)} of ${String(report.processed)} processed.`,
    );
    if (report.reap.deleted > 0) {
      print(
        `Deleted ${String(report.reap.deleted)} local copies, freeing ${formatBytes(report.reap.bytesFreed)}.`,
      );
    }
    if (report.failed > 0) print(`${String(report.failed)} job(s) failed and will retry.`);
    if (report.blocked > 0)
      print(`${String(report.blocked)} job(s) need attention — run /archive:status.`);
    if (report.budgetExhausted)
      print('Stopped on the time budget; the rest is queued for the next sweep.');
    return 0;
  } finally {
    lock.release();
  }
}
