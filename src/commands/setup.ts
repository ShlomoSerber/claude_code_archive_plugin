import fsp from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../adapters/db.ts';
import { competingCleanupSettings, setCleanupPeriodDays } from '../adapters/claude-settings.ts';
import {
  loginWithDeviceCode,
  loginWithLoopback,
  resolveOAuthClient,
} from '../adapters/google-auth.ts';
import {
  catalogStats,
  recordRetainedBundle,
  SESSION_COLUMNS,
  toRecord,
  type SessionRow,
} from '../core/catalog.ts';
import { CLEANUP_PERIOD_DAYS } from '../core/config.ts';
import { FatalError } from '../core/errors.ts';
import { isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
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

  // Before the sign-in, deliberately. Claude Code's own reaper deletes
  // transcripts after 30 days, and the plugin looks installed from the moment
  // the hooks land — so every minute between installing it and finishing a
  // login was a minute where nothing was archived and the reaper was still
  // running. Writing the setting first costs nothing and stops that clock.
  const settings = await setCleanupPeriodDays(runtime.paths.settingsFile, CLEANUP_PERIOD_DAYS);
  steps['cleanupPeriodDays'] = settings;
  if (settings.changed) {
    print(
      `Set cleanupPeriodDays to ${String(settings.current)} so Claude Code stops deleting transcripts.`,
    );
  }

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

  const imported = await importCatalogIfEmpty(runtime);
  if (imported > 0) {
    steps['catalogImported'] = imported;
    print(`Recovered ${String(imported)} sessions from the catalog on Drive.`);
  }

  if (options.skipBackfill !== true) {
    print('Backing up existing sessions. This continues in the background if it takes a while.');
    await runNow(runtime, {});
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
  // Deliberately unconditional. This used to return early once the local
  // catalog had any rows at all — and the plugin's own hooks put rows there on
  // the first Claude Code session after install. Anyone who opened Claude Code
  // before running /archive:setup lost access to their entire archived history,
  // silently and permanently, which is the one promise the whole design exists
  // to keep. Every insert below is INSERT OR IGNORE, so re-running is cheap and
  // cannot overwrite anything this machine knows.

  const staged = path.join(runtime.paths.stagingDir, 'catalog-recovered.sqlite');
  try {
    const ctx = commandContext(runtime);
    const parentId = await ctx.drive.ensureFolder([runtime.config.driveRootFolder], ctx.signal);
    // Every machine's copy, not only this one's. A replacement laptop has a
    // different hostname and so a different catalog name, and searching for its
    // own would find nothing at all — which is precisely the case the whole
    // disaster-recovery promise is about.
    const remotes = await ctx.drive.listFiles({ parentId, namePrefix: 'catalog' }, ctx.signal);
    const wanted = remotes.filter(
      (file) => file.name === 'catalog.sqlite' || /^catalog-[0-9a-f]{8}\.sqlite$/.test(file.name),
    );
    let imported = 0;
    for (const remote of wanted) {
      // Per file, not per run. One unreadable catalog used to abort the whole
      // loop, discarding every other machine's history along with it.
      try {
        await ctx.drive.downloadToFile({ fileId: remote.id, destination: staged }, ctx.signal);
        imported += importCatalogFile(runtime, staged);
      } catch (err) {
        warn(
          `Could not read ${remote.name}: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      } finally {
        await fsp.rm(staged, { force: true }).catch(() => undefined);
      }
    }
    return imported;
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
/** A statement an older catalog may not support. Absence is not an error. */
function tryPrepare(db: ReturnType<typeof openDatabase>, sql: string) {
  try {
    return db.prepare(sql);
  } catch {
    return null;
  }
}

export function importCatalogFile(runtime: Runtime, file: string): number {
  const source = openDatabase(file, { readOnly: true, skipMigrations: true });
  const db = runtime.db();
  let imported = 0;
  try {
    // Only the columns this catalog actually has.
    //
    // The download is opened read-only with no migrations, so a catalog written
    // by an older version of the plugin never gains the columns added since —
    // and selecting the current list from it threw `no such column`. That is
    // the disaster-recovery path: a dead laptop's catalog, written by whatever
    // version was installed then, read by whatever version you install now. It
    // recovered nothing and said so in a single warning line.
    const available = new Set(
      (source.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    const columnNames = SESSION_COLUMNS.split(',')
      .map((name) => name.trim())
      .filter((name) => available.has(name));
    if (!columnNames.includes('session_id') || !columnNames.includes('encoded_dir')) {
      throw new Error('it has no sessions table this version can read');
    }
    const rows = source
      .prepare(`SELECT ${columnNames.join(', ')} FROM sessions`)
      .all() as SessionRow[];
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
    // A retained bundle is, by definition, one whose contents the newer bundle
    // could not be proved to contain — so it holds data nothing else holds.
    // The table travels inside the catalog copy; only this import ignored it,
    // which left a replacement machine with no way to name or fetch them.
    const selectRetained = tryPrepare(
      source,
      `SELECT * FROM retained_bundles WHERE session_id = ?`,
    );

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
      const inserted = insertSession.run(...columnNames.map((name) => values[name] ?? null));
      // An older catalog may predate verified_bundle_sha256, and restore needs
      // a hash or it refuses for ever — on the machine whose disk is gone,
      // which is the only machine that ever runs this. bundle_sha256 described
      // the same bundle in the schema that had only that column.
      if (Number(inserted.changes) > 0) {
        db.prepare(
          `UPDATE sessions
              SET verified_bundle_sha256 = bundle_sha256
            WHERE session_id = ? AND verified_bundle_sha256 IS NULL
              AND bundle_sha256 IS NOT NULL AND verified_at IS NOT NULL`,
        ).run(record.sessionId);
      }
      // The prompts and the file list are what search runs on, and both inserts
      // ignore conflicts, so they are worth doing for a row we already had.
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
      for (const kept of (selectRetained?.all(record.sessionId) ?? []) as {
        session_id: string;
        file_id: string;
        remote_path: string | null;
        bundle_sha256: string | null;
        bundle_bytes?: number | null;
        bundle_md5?: string | null;
        manifest: string | null;
        reason: string;
        created_at: number;
      }[]) {
        recordRetainedBundle(
          db,
          {
            sessionId: kept.session_id,
            fileId: kept.file_id,
            remotePath: kept.remote_path,
            bundleSha256: kept.bundle_sha256,
            // An older catalog has neither column; null reads as "unknown",
            // which verifyRetained reports as unchecked rather than intact.
            bundleBytes: kept.bundle_bytes ?? null,
            bundleMd5: kept.bundle_md5 ?? null,
            manifest: kept.manifest,
            reason: kept.reason,
          },
          kept.created_at,
        );
      }
      // Only for a row this machine did not already have. The import runs on
      // every /archive:setup and downloads this machine's own catalog copy too,
      // so resetting unconditionally told the plugin that sessions sitting on
      // its own disk were not there: /archive:status counted them as reclaimed,
      // and the next sweep re-bundled and re-uploaded every one of them.
      if (Number(inserted.changes) === 0) continue;
      // The bytes live on Drive, not here: a recovered session is not local.
      // The verification fingerprint is dropped as well. It was measured on
      // another machine against files this one has never seen, and it is the
      // value that authorises deleting local data. Restore still works, since
      // that needs only the remote id and the bundle hash. The recorded sizes
      // stay: they are facts about the archive itself, and the guard that
      // refuses to replace a larger archive with a smaller session needs them.
      db.prepare(
        `UPDATE sessions
            SET local_present = 0, verified_local_mtime = NULL
          WHERE session_id = ?`,
      ).run(record.sessionId);
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
