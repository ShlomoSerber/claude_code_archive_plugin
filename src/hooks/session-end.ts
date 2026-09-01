// Must come first: it silences the node:sqlite warning before SQLite loads.
import '../core/quiet.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../composition.ts';
import { enqueue } from '../core/queue.ts';
import { encodedDirOfTranscript, sessionIdOfTranscript } from '../core/paths.ts';
import { isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
import { kvDelete, kvSetNumber } from '../adapters/db.ts';
import { KV, activeSessionKey } from '../core/state-keys.ts';
import { spawnWorker } from '../adapters/spawn-worker.ts';
import { emitSystemMessage, readHookInput } from './hook-input.ts';
import { logLastResort } from './last-resort.ts';
import { NODE_REMEDIATION, nodeVersionProblem } from '../core/runtime-check.ts';
import { alreadyReexeced, findCompatibleNode, reexec } from '../adapters/node-locator.ts';
import { resolvePaths } from '../core/paths.ts';

/**
 * The `SessionEnd` hook (SPEC §1).
 *
 * It records the session as a backup candidate, starts a detached worker, and
 * returns. No network, no compression, no waiting: the session is closing, and
 * nothing here may delay that.
 *
 * It exits 0 whatever happens. A hook that fails loudly turns a background
 * inconvenience into a visible break in the user's session.
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

    const transcriptPath = input?.transcript_path;
    if (transcriptPath === undefined) {
      runtime.logger.debug('hook.session_end.no_transcript');
      return;
    }
    const sessionId = input?.session_id ?? sessionIdOfTranscript(transcriptPath);
    const encodedDir = encodedDirOfTranscript(transcriptPath);

    // These become filesystem paths later. The reaper validates them again as
    // its last line of defence, but keeping malformed rows out of the catalog
    // in the first place is better than relying on that.
    if (!isSafeSessionId(sessionId) || !isSafeEncodedDir(encodedDir)) {
      runtime.logger.warn('hook.session_end.unsafe_identifiers', { session_id: sessionId });
      return;
    }

    // The session is closing, so it stops being off limits to the reaper.
    kvDelete(runtime.db(), activeSessionKey(sessionId));

    const now = runtime.clock.now();
    enqueue(
      runtime.db(),
      {
        kind: 'backup',
        sessionId,
        payload: { encodedDir },
        // The debounce coalesces the burst of fires a resumed session produces
        // into a single backup of its final state.
        notBefore: now + runtime.config.debounceMs,
        // A person closed this session, so a previous block is worth retrying.
        unblock: true,
      },
      now,
    );
    runtime.logger.info('hook.session_end.enqueued', {
      session_id: sessionId,
      reason: input?.reason ?? null,
    });

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

function workerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
}

try {
  await main();
} catch (err) {
  // Swallowed on purpose — the session must not care — but never silently:
  // this writes with node:fs alone, so it still works when the catalog is
  // corrupt or the data directory is not writable by this user.
  logLastResort('hook.session_end_failed', err);
}
process.exit(0);
