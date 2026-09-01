import { listUnverified } from '../core/catalog.ts';
import { verifyArchive } from '../worker/restore.ts';
import type { SessionRecord } from '../core/catalog.ts';
import { SESSION_COLUMNS, toRecord, type SessionRow } from '../core/catalog.ts';
import type { Runtime } from '../composition.ts';
import { commandContext } from './context.ts';
import { print, printJson } from './output.ts';

/**
 * `/archive:verify` — spot-check what Drive holds against the stored hashes.
 *
 * A sample by default, because verifying a whole multi-year archive is a lot of
 * API calls to make someone wait for. `--all` is there when it matters.
 */
export async function runVerify(
  runtime: Runtime,
  options: { limit?: number; all?: boolean; json?: boolean } = {},
): Promise<number> {
  const records =
    options.all === true ? allArchived(runtime) : sampleArchived(runtime, options.limit ?? 20);

  const ctx = commandContext(runtime);
  const report = await verifyArchive(ctx, records);
  const pending = listUnverified(runtime.db(), 1).length;

  if (options.json === true) {
    printJson({ ...report, pendingBackup: pending });
    return report.mismatched.length > 0 ? 1 : 0;
  }

  print(`Checked ${String(report.checked)} archived sessions: ${String(report.ok)} verified.`);
  if (report.unchecked.length > 0) {
    // Not a verdict: Drive could not be asked. Saying so plainly keeps a rate
    // limit from reading as an archive failure.
    print(
      `${String(report.unchecked.length)} could not be checked right now (network or rate limit).`,
    );
  }
  if (report.missing.length > 0) {
    print(`${String(report.missing.length)} have no remote copy recorded.`);
  }
  if (report.mismatched.length > 0) {
    print(`${String(report.mismatched.length)} did not match:`);
    for (const item of report.mismatched.slice(0, 10)) {
      print(`  ${item.sessionId}: ${item.reason}`);
    }
    const gone = report.mismatched.filter((item) => item.localDeleted);
    if (gone.length > 0) {
      print(`${String(gone.length)} of those have no local copy left to re-upload.`);
      print('For those, /archive:status lists any older bundle that was kept:');
      print('  /archive:resume --bundle <file id>');
    }
    if (gone.length < report.mismatched.length) {
      print('Run /archive:now to re-upload the sessions that still have a local copy.');
    }
    return 1;
  }
  if (pending > 0) print('Some sessions are still waiting to be archived — run /archive:now.');
  return 0;
}

/** A recent-weighted sample, so a spot check looks at what changed lately. */
function sampleArchived(runtime: Runtime, limit: number): SessionRecord[] {
  const rows = runtime
    .db()
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE remote_file_id IS NOT NULL
          AND (verified_at IS NOT NULL OR local_deleted_at IS NOT NULL)
        ORDER BY COALESCE(verified_at, local_deleted_at) DESC LIMIT ?`,
    )
    .all(limit) as SessionRow[];
  return rows.map(toRecord);
}

function allArchived(runtime: Runtime): SessionRecord[] {
  const rows = runtime
    .db()
    // Rows whose verification was withdrawn are included when the local copy
    // is already gone. Excluding them meant a damaged bundle was reported once
    // and then never again — and that session has no local copy to re-archive,
    // so nothing else would ever notice.
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE remote_file_id IS NOT NULL
          AND (verified_at IS NOT NULL OR local_deleted_at IS NOT NULL)
        ORDER BY COALESCE(verified_at, local_deleted_at) ASC`,
    )
    .all() as SessionRow[];
  return rows.map(toRecord);
}
