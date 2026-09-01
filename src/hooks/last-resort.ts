import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../core/paths.ts';

/**
 * Write one line to the log with nothing but `node:fs`.
 *
 * Both hooks swallow every exception, which is right — a hook must never
 * disturb a session. But the comment claiming "the log has it" was false: the
 * logger is created lazily through the same composition root that had just
 * failed, so a corrupt catalog, a full disk or a root-owned data directory
 * produced a hook that did nothing, said nothing, and left no log file at all.
 * This path depends on no database, no config and no runtime object.
 */
/** Clear the marker after a run that worked, so the warning is never stale. */
export function clearLastResort(event: string): void {
  try {
    fs.rmSync(path.join(resolvePaths(process.env).dataDir, markerName(event)), { force: true });
  } catch {
    // Nothing to do; the marker carries its own timestamp.
  }
}

/**
 * One marker per hook.
 *
 * A single shared file meant a SessionStart that worked deleted the record of
 * a SessionEnd that had failed, so a hook that fails every time could leave a
 * completely clean status page.
 */
function markerName(event: string): string {
  return event.startsWith('hook.session_start') ? 'hook-error-start.json' : 'hook-error-end.json';
}

export function logLastResort(event: string, err: unknown): void {
  try {
    const paths = resolvePaths(process.env);
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event,
      err: {
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    fs.appendFileSync(paths.logFile, `${line}\n`, { mode: 0o600 });
    // A second copy where /archive:status looks, so the failure has a reader.
    fs.writeFileSync(
      path.join(paths.dataDir, markerName(event)),
      `${JSON.stringify({ at: Date.now(), event, message: line })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // There is nothing below this. Exiting 0 is still the right answer.
  }
}
