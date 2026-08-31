import { createLazyDrive } from '../adapters/lazy-drive.ts';
import type { Runtime } from '../composition.ts';
import type { WorkerContext } from '../worker/context.ts';

/**
 * Build the same context the worker uses, for commands that do real work.
 *
 * The transport is lazy on purpose: a command that never reaches Drive must not
 * fail because Drive is not set up. Restoring a session that is still on disk,
 * and searching the catalog, both work with no credentials at all.
 *
 * Commands run in the foreground, so they get a shorter abort budget than the
 * background worker: a user waiting at a prompt should not wait twenty minutes.
 */
export function commandContext(
  runtime: Runtime,
  options: { timeoutMs?: number } = {},
): WorkerContext {
  return {
    db: runtime.db(),
    paths: runtime.paths,
    config: runtime.config,
    drive: createLazyDrive(() => runtime.drive()),
    logger: runtime.logger,
    clock: runtime.clock,
    version: runtime.version,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
  };
}
