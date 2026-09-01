// Must come first: it silences the node:sqlite warning before SQLite loads.
import '../core/quiet.ts';
import { acquireLock } from '../adapters/lock.ts';
import { logLastResort } from '../hooks/last-resort.ts';
import { kvSetNumber } from '../adapters/db.ts';
import { KV } from '../core/state-keys.ts';
import { createRuntime } from '../composition.ts';
import { FatalError, toErrorInfo } from '../core/errors.ts';
import { NODE_REMEDIATION, nodeVersionProblem } from '../core/runtime-check.ts';
import { alreadyReexeced, findCompatibleNode, reexec } from '../adapters/node-locator.ts';
import { runSweep, type SweepReport } from './sweep.ts';
import { writeStatusFile } from './status.ts';
import type { WorkerContext } from './context.ts';

/**
 * The detached background worker (SPEC §3).
 *
 * One run does one sweep and exits. It holds a lock so two hooks firing at once
 * produce one worker, and it always exits 0 — a background process that fails
 * loudly is a background process the user has to think about.
 */

type Args = { force: boolean };

function parseArgs(argv: string[]): Args {
  return {
    force: argv.includes('--force'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();

  // Nothing below here works on an unsupported runtime, and the log is the only
  // channel a detached worker has.
  const problem = nodeVersionProblem();
  if (problem !== null) {
    if (!alreadyReexeced(process.env)) {
      const better = findCompatibleNode({ cacheFile: runtime.paths.runtimeCacheFile });
      if (better !== null) {
        runtime.logger.info('worker.reexec', { node: better.version });
        runtime.close();
        reexec(better.path);
        return;
      }
    }
    runtime.logger.error('worker.unsupported_node', { remediation: NODE_REMEDIATION, problem });
    runtime.close();
    return;
  }

  // Proof of life, compared against the hooks' spawn timestamp by
  // /archive:status: spawn() succeeds even when the worker bundle is missing
  // or dies on its first line, and nothing else would ever notice.
  kvSetNumber(runtime.db(), KV.workerRanAt, runtime.clock.now(), runtime.clock.now());

  const lock = acquireLock(runtime.paths.lockDir, { logger: runtime.logger, clock: runtime.clock });
  if (lock === null) {
    // Another worker is already doing this. That is a normal outcome.
    runtime.logger.debug('worker.already_running');
    runtime.close();
    return;
  }

  // A hard ceiling above the sweep's own budget, so a wedged socket cannot
  // leave this process alive forever.
  const controller = AbortSignal.timeout(runtime.config.workerBudgetMs + 60_000);
  let report: SweepReport | null = null;
  let ctx: WorkerContext | null = null;

  try {
    ctx = {
      db: runtime.db(),
      paths: runtime.paths,
      config: runtime.config,
      drive: await runtime.drive(),
      logger: runtime.logger,
      clock: runtime.clock,
      version: runtime.version,
      signal: controller,
    };
    report = await runSweep(ctx, { force: args.force });
  } catch (err) {
    const info = toErrorInfo(err);
    if (err instanceof FatalError) {
      runtime.logger.error('worker.blocked', { remediation: err.remediation }, err);
    } else {
      runtime.logger.error('worker.failed', {}, err);
    }
    // Drive could not even be constructed, usually because nobody has signed
    // in yet. Record that so /archive:status can say so.
    ctx ??= {
      db: runtime.db(),
      paths: runtime.paths,
      config: runtime.config,
      drive: unavailableDrive(info.message),
      logger: runtime.logger,
      clock: runtime.clock,
      version: runtime.version,
      signal: controller,
    };
  } finally {
    if (ctx !== null) await writeStatusFile(ctx, report);
    runtime.close();
    lock.release();
  }
}

/** A transport that fails every call, used only to build a status snapshot. */
function unavailableDrive(reason: string): WorkerContext['drive'] {
  const fail = (): never => {
    throw new FatalError(reason, 'Run /archive:setup to connect Google Drive.');
  };
  return {
    ensureFolder: fail,
    findFile: fail,
    listFiles: fail,
    startResumableUpload: fail,
    uploadChunk: fail,
    probeUpload: fail,
    uploadSmallFile: fail,
    getFile: fail,
    deleteFile: fail,
    trashFile: fail,
    downloadToFile: fail,
    storageQuota: fail,
  };
}

try {
  await main();
} catch (err) {
  // Not "already logged": createRuntime, the database open and the lock
  // directory all run before the worker's own error handling, and a failure in
  // any of them — a corrupt catalog, ENOSPC, a root-owned data directory —
  // reached this catch having written nothing anywhere. This path uses node:fs
  // alone, so it works when the catalog does not.
  logLastResort('worker.failed_to_start', err);
}
process.exit(0);
