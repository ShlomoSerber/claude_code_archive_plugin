import fsp from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../adapters/db.ts';
import { competingCleanupSettings, setCleanupPeriodDays } from '../adapters/claude-settings.ts';
import {
  loginWithDeviceCode,
  loginWithLoopback,
  resolveOAuthClient,
} from '../adapters/google-auth.ts';
import { catalogStats, SESSION_COLUMNS, toRecord, type SessionRow } from '../core/catalog.ts';
import { CLEANUP_PERIOD_DAYS } from '../core/config.ts';
import { FatalError } from '../core/errors.ts';
import { isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
import { KV } from '../core/state-keys.ts';
import { kvGetNumber, kvSetNumber } from '../adapters/db.ts';
import type { Runtime } from '../composition.ts';
import { commandContext } from './context.ts';
import { runNow } from './now.ts';
import { formatBytes, print, printJson, warn } from './output.ts';

/**
 * `/archive:setup` — the one-time step (SPEC §7).
 *
 * Sign in, take ownership of transcript deletion, and get the existing history
 * on its way to Drive. On a machine that has lost its disk, it also pulls the
 * catalog back down so the whole history is searchable again immediately.
 */

export type SetupOptions = {
  device?: boolean;
  json?: boolean;
  /** Sign in again even if a token is already stored. */
  reauth?: boolean;
  /** Skip the first backup pass; useful when the archive is already current. */
  skipBackfill?: boolean;
};

export async function runSetup(runtime: Runtime, options: SetupOptions = {}): Promise<number> {
  const steps: Record<string, unknown> = {};

  const client = await resolveOAuthClient(runtime.env, runtime.paths.dataDir);
  steps['clientId'] = `${client.clientId.slice(0, 12)}…`;

  const auth = await runtime.auth();
  const alreadySignedIn = await auth.hasCredentials();
  if (!alreadySignedIn || options.reauth === true) {
    const deps = {
      client,
      tokenStore: runtime.tokenStore,
      http: runtime.http(),
      clock: runtime.clock,
      logger: runtime.logger,
    };
    if (options.device === true) {
      const result = await loginWithDeviceCode(deps, {
        onPrompt: (prompt) => {
          print(`Open ${prompt.verificationUrl} and enter the code: ${prompt.userCode}`);
          print(`The code expires in ${String(Math.round(prompt.expiresInSeconds / 60))} minutes.`);
        },
      });
      steps['signIn'] = result.method;
    } else {
      const result = await loginWithLoopback(deps, { onMessage: print });
      steps['signIn'] = result.method;
    }
  } else {
    steps['signIn'] = 'already signed in';
  }

  // From here on the plugin is meant to be the only thing that deletes a
  // transcript. If something outranks the file we write, that is not true, and
  // the plugin would archive on the assumption of a safety it does not have.
  const competing = await competingCleanupSettings(runtime.paths.claudeDir);
  if (competing.length > 0) {
    const list = competing.map((entry) => `${entry.file} (${String(entry.value)})`).join(', ');
    throw new FatalError(
      `another settings file also sets cleanupPeriodDays: ${list}`,
      'That file takes precedence over the one this plugin writes, so Claude Code ' +
        'would keep deleting transcripts on its own schedule. Remove ' +
        'cleanupPeriodDays from it, then run /archive:setup again.',
    );
  }

  const settings = await setCleanupPeriodDays(runtime.paths.settingsFile, CLEANUP_PERIOD_DAYS);
  steps['cleanupPeriodDays'] = settings;
  if (settings.changed) {
    print(
      `Set cleanupPeriodDays to ${String(settings.current)} so Claude Code stops deleting transcripts.`,
    );
  }

  const imported = await importCatalogIfEmpty(runtime);
  if (imported > 0) {
    steps['catalogImported'] = imported;
    print(`Recovered ${String(imported)} sessions from the catalog on Drive.`);
  }

  if (options.skipBackfill !== true) {
    print('Backing up existing sessions. This continues in the background if it takes a while.');
    await runNow(runtime, { backfill: true });
    const now = runtime.clock.now();
    kvSetNumber(runtime.db(), KV.backfillDoneAt, now, now);
  }

  const stats = catalogStats(runtime.db());
  steps['catalog'] = stats;

  if (options.json === true) {
    printJson({ ok: true, steps });
    return 0;
  }
  print();
  print(
    `Archive ready: ${String(stats.verified)} of ${String(stats.sessions)} sessions verified on Drive.`,
  );
  print(
    `Local sessions still on disk: ${String(stats.localPresent)} (${formatBytes(stats.localBytes)}).`,
  );
  print(
    `Local copies are deleted after ${String(runtime.config.retentionDays)} idle days, never before Drive is verified.`,
  );
  return 0;
}

/**
 * Fresh-machine recovery (SPEC, "The model").
 *
 * Only ever runs into an empty catalog, and only ever inserts rows that are not
 * already there: a local catalog is always more current than the Drive copy.
 */
export async function importCatalogIfEmpty(runtime: Runtime): Promise<number> {
  const db = runtime.db();
  if (catalogStats(db).sessions > 0) return 0;
  if ((kvGetNumber(db, KV.catalogUploadedAt) ?? 0) > 0) return 0;

  const staged = path.join(runtime.paths.stagingDir, 'catalog-recovered.sqlite');
  try {
    const ctx = commandContext(runtime);
    const parentId = await ctx.drive.ensureFolder([runtime.config.driveRootFolder], ctx.signal);
    const remote = await ctx.drive.findFile({ name: 'catalog.sqlite', parentId }, ctx.signal);
    if (remote === null) return 0;

    await ctx.drive.downloadToFile({ fileId: remote.id, destination: staged }, ctx.signal);
    return importCatalogFile(runtime, staged);
  } catch (err) {
    warn(
      `Could not recover the catalog from Drive: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return 0;
  } finally {
    await fsp.rm(staged, { force: true }).catch(() => undefined);
  }
}

/**
 * Copy rows out of a downloaded catalog.
 *
 * A second connection rather than `ATTACH`: the downloaded file is untrusted
 * input, and reading it read-only with no migrations keeps it that way.
 */
export function importCatalogFile(runtime: Runtime, file: string): number {
  const source = openDatabase(file, { readOnly: true, skipMigrations: true });
  const db = runtime.db();
  let imported = 0;
  try {
    const rows = source.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions`).all() as SessionRow[];
    // Read the values by column name rather than by object key order, so the
    // insert cannot silently shift if the column list is ever reordered.
    const columnNames = SESSION_COLUMNS.split(',').map((name) => name.trim());
    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO sessions (${columnNames.join(', ')})
       VALUES (${columnNames.map(() => '?').join(', ')})`,
    );
    const insertPrompt = db.prepare(
      'INSERT OR IGNORE INTO prompts (session_id, seq, ts, text) VALUES (?, ?, ?, ?)',
    );
    const insertFile = db.prepare(
      'INSERT OR IGNORE INTO session_files (session_id, path) VALUES (?, ?)',
    );
    const selectPrompts = source.prepare('SELECT seq, ts, text FROM prompts WHERE session_id = ?');
    const selectFiles = source.prepare('SELECT path FROM session_files WHERE session_id = ?');

    for (const row of rows) {
      const record = toRecord(row);
      // These strings become filesystem paths for the reaper and for restore.
      // They arrived over the network, so they get the same scrutiny as a
      // filename found on disk.
      if (!isSafeSessionId(record.sessionId) || !isSafeEncodedDir(record.encodedDir)) {
        warn(`Skipped a recovered catalog row with an unusable id: ${record.sessionId}`);
        continue;
      }
      const values = row as unknown as Record<string, string | number | null | undefined>;
      insertSession.run(...columnNames.map((name) => values[name] ?? null));
      // The bytes live on Drive, not here: a recovered session is not local.
      // The verification fingerprint is dropped as well. It was measured on
      // another machine against files this one has never seen, and it is the
      // value that authorises deleting local data. Restore still works, since
      // that needs only the remote id and the bundle hash.
      db.prepare(
        `UPDATE sessions
            SET local_present = 0, verified_local_mtime = NULL, verified_local_bytes = NULL
          WHERE session_id = ?`,
      ).run(record.sessionId);
      for (const prompt of selectPrompts.all(record.sessionId) as {
        seq: number;
        ts: number | null;
        text: string;
      }[]) {
        insertPrompt.run(record.sessionId, prompt.seq, prompt.ts, prompt.text);
      }
      for (const item of selectFiles.all(record.sessionId) as { path: string }[]) {
        insertFile.run(record.sessionId, item.path);
      }
      imported++;
    }
  } catch (err) {
    throw new FatalError(
      `the catalog downloaded from Drive could not be read: ${err instanceof Error ? err.message : 'unknown'}`,
      'Delete it from Drive and run /archive:now to rebuild the catalog from local sessions.',
    );
  } finally {
    source.close();
  }
  return imported;
}
