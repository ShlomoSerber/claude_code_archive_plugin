import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { detachDisabled, workerSpawnSpec } from '../core/spawn.ts';
import { nullLogger, type Logger } from '../ports/logger.ts';

/**
 * Start the background worker and forget about it.
 *
 * Windows job objects can still take the child down with its parent no matter
 * what we pass here, so the worker is built to be resumable rather than assumed
 * immortal: its state is in the queue, and the next hook starts it again.
 */
export function spawnWorker(args: {
  workerPath: string;
  env: Record<string, string | undefined>;
  cwd: string;
  extraArgs?: string[];
  logger?: Logger;
}): boolean {
  const logger = args.logger ?? nullLogger;
  // spawn() reports success as long as `process.execPath` exists — the worker
  // file is only an argument, so a missing or quarantined bundle produced a
  // "worker.spawned" log line, a job queued for ever, and no other signal.
  if (!existsSync(args.workerPath)) {
    logger.error('worker.missing', { path: args.workerPath });
    return false;
  }
  const attached = detachDisabled(args.env);
  const spec = workerSpawnSpec({
    execPath: process.execPath,
    workerPath: args.workerPath,
    env: args.env,
    cwd: args.cwd,
    ...(args.extraArgs === undefined ? {} : { extraArgs: args.extraArgs }),
    ...(attached ? { attached: true } : {}),
  });
  try {
    const child = spawn(spec.command, spec.args, spec.options);
    child.on('error', (err) => {
      logger.warn('worker.spawn_failed', {}, err);
    });
    // An attached child is still unref'd: the hook must never wait on it.
    child.unref();
    logger.debug('worker.spawned', { pid: child.pid ?? null });
    return true;
  } catch (err) {
    logger.warn('worker.spawn_failed', {}, err);
    return false;
  }
}
