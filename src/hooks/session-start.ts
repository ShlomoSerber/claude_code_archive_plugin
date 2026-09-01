// Must come first: it silences the node:sqlite warning before SQLite loads.
import '../core/quiet.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../composition.ts';
import { kvGetNumber, kvSetNumber } from '../adapters/db.ts';
import { isSafeSessionId } from '../core/identifiers.ts';
import { KV, activeSessionKey } from '../core/state-keys.ts';
import { readCleanupPeriodDays } from '../adapters/claude-settings.ts';
import { CLEANUP_PERIOD_DAYS, DAY_MS } from '../core/config.ts';
import type { Runtime } from '../composition.ts';
import { spawnWorker } from '../adapters/spawn-worker.ts';
import { emitSystemMessage, readHookInput } from './hook-input.ts';
import { clearLastResort, logLastResort } from './last-resort.ts';
import { NODE_REMEDIATION, nodeVersionProblem } from '../core/runtime-check.ts';
import { alreadyReexeced, findCompatibleNode, reexec } from '../adapters/node-locator.ts';
import { resolvePaths } from '../core/paths.ts';

/**
 * The `SessionStart` hook (SPEC §3).
 *
 * It exists to wake the sweep. The session that just started is still running,
 * so it is not a backup candidate; everything else that was missed — a crash, a
 * fortnight away from the machine — is what the sweep is for.
 *
 * The minimum interval keeps a burst of new sessions from starting a burst of
 * workers, none of which would find anything to do.
 */
async function main(): Promise<void> {
  // Checked before anything opens the database. Claude Code runs hooks with
  // whatever `node` is on PATH, which is regularly older than the one the user
  // installed for development.
  const problem = nodeVersionProblem();
  if (problem !== null) {
    // Before giving up, look for a Node that does qualify. Most machines that
    // land here have one installed under a version manager and simply are not
    // pointing PATH at it. Re-exec happens before stdin is read, so the child
    // still receives the hook payload.
    if (!alreadyReexeced(process.env)) {
      const better = findCompatibleNode({ cacheFile: resolvePaths(process.env).runtimeCacheFile });
      if (better !== null) {
        reexec(better.path);
        return;
      }
    }
    emitSystemMessage(`Claude Code Archive is not running: ${problem}. ${NODE_REMEDIATION}`);
    return;
  }
  const input = await readHookInput();
  const runtime = await createRuntime();
  try {
    if (!runtime.config.enabled) return;

    const now = runtime.clock.now();
    // Mark the session open so the reaper leaves it alone. A transcript being
    // appended to is not idle, however old its last write happens to be.
    const sessionId = input?.session_id;
    if (sessionId !== undefined && isSafeSessionId(sessionId)) {
      kvSetNumber(runtime.db(), activeSessionKey(sessionId), now, now);
    }

    await warnIfUnconfigured(runtime, now);

    const lastSweep = kvGetNumber(runtime.db(), KV.lastSweepAt) ?? 0;
    if (now - lastSweep < runtime.config.sweepMinIntervalMs) {
      runtime.logger.debug('hook.session_start.too_soon', { last_sweep_at: lastSweep });
      return;
    }

    runtime.logger.info('hook.session_start.sweeping', { source: input?.source ?? null });
    kvSetNumber(runtime.db(), KV.workerSpawnedAt, now, now);
    spawnWorker({
      workerPath: workerPath(),
      env: process.env,
      cwd: runtime.paths.dataDir,
      logger: runtime.logger,
    });
  } finally {
    runtime.close();
  }
}

/**
 * Tell the user, in the session, when the plugin is installed but not set up.
 *
 * Until /archive:setup runs, cleanupPeriodDays is whatever Claude Code's
 * default is and every upload blocks on "not signed in" — so the hooks are
 * running, the plugin looks installed, and Claude Code is still deleting
 * transcripts on its own schedule. /archive:status would say so, but nobody
 * runs a status command for a problem they do not know they have. Once a day
 * at most, and never in a way that can delay the session.
 */
async function warnIfUnconfigured(runtime: Runtime, now: number): Promise<void> {
  const lastWarned = kvGetNumber(runtime.db(), KV.setupWarnedAt) ?? 0;
  if (now - lastWarned < DAY_MS) return;

  // A token file that cannot be read is a token file that cannot be used, and
  // /archive:status says "not connected" for exactly this. The two readers
  // disagreeing meant a chmod-000 tokens.json produced no warning anywhere.
  const signedIn = await runtime.tokenStore
    .read()
    .then((tokens) => tokens !== null)
    .catch(() => false);
  // Unreadable settings, on the other hand, is not evidence that Claude Code
  // is still deleting transcripts — and saying so would be a false alarm.
  const cleanup = await readCleanupPeriodDays(runtime.paths.settingsFile).catch(() => undefined);
  const owned = cleanup === undefined || cleanup === CLEANUP_PERIOD_DAYS;
  if (signedIn && owned) return;

  kvSetNumber(runtime.db(), KV.setupWarnedAt, now, now);
  emitSystemMessage(
    !signedIn
      ? 'Claude Code Archive is installed but not signed in, so nothing is being ' +
          'backed up. Run /archive:setup.'
      : 'Claude Code Archive is installed but Claude Code is still deleting ' +
          `transcripts on its own schedule (cleanupPeriodDays: ${String(cleanup ?? 'unset')}). ` +
          'Run /archive:setup.',
  );
}

function workerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
}

try {
  await main();
  // A run that finished means the last failure is history, not the state.
  clearLastResort('hook.session_start_failed');
} catch (err) {
  // Never let a hook disturb a session that is just starting — but never
  // silently: see last-resort.ts.
  logLastResort('hook.session_start_failed', err);
}
process.exit(0);
