// Must come first: it silences the node:sqlite warning before SQLite loads.
import '../core/quiet.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../composition.ts';
import { enqueue } from '../core/queue.ts';
import { encodedDirOfTranscript, sessionIdOfTranscript } from '../core/paths.ts';
import { spawnWorker } from '../adapters/spawn-worker.ts';
import { emitSystemMessage, readHookInput } from './hook-input.ts';
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

    const now = runtime.clock.now();
    enqueue(
      runtime.db(),
      {
        kind: 'backup',
        sessionId,
        payload: { encodedDir: encodedDirOfTranscript(transcriptPath) },
        // The debounce coalesces the burst of fires a resumed session produces
        // into a single backup of its final state.
        notBefore: now + runtime.config.debounceMs,
      },
      now,
    );
    runtime.logger.info('hook.session_end.enqueued', {
      session_id: sessionId,
      reason: input?.reason ?? null,
    });

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
} catch {
  // Swallowed on purpose: the log has it, and the session must not care.
}
process.exit(0);
