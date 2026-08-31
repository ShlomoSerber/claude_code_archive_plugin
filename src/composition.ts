import fsp from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, checkpointAndClose, type Db } from './adapters/db.ts';
import { createNdjsonLogger } from './adapters/ndjson-logger.ts';
import { createFileTokenStore } from './adapters/token-file.ts';
import { createHttpClient, type HttpClient } from './adapters/http-client.ts';
import {
  createAuthProvider,
  resolveOAuthClient,
  type AuthProvider,
} from './adapters/google-auth.ts';
import { createDriveTransport } from './adapters/drive-http.ts';
import { resolveConfig, type ArchiveConfig } from './core/config.ts';
import { resolvePaths, type ArchivePaths, type Environment } from './core/paths.ts';
import { systemClock, type Clock } from './ports/clock.ts';
import type { Logger, LogLevel } from './ports/logger.ts';
import type { DriveTransport } from './ports/drive.ts';
import type { TokenStore } from './ports/token-store.ts';
import { ARCHIVER_VERSION } from './version.ts';

/**
 * The composition root: the one place that knows which real adapter backs each
 * port. Everything above it takes its collaborators as arguments, which is what
 * lets the tests run the whole engine against fakes.
 *
 * Drive and auth are built lazily. A `SessionEnd` hook has milliseconds to do
 * its work and has no business constructing an HTTP client.
 */

export type Runtime = {
  env: Environment;
  paths: ArchivePaths;
  config: ArchiveConfig;
  logger: Logger;
  clock: Clock;
  version: string;
  tokenStore: TokenStore;
  db(): Db;
  http(): HttpClient;
  auth(): Promise<AuthProvider>;
  drive(): Promise<DriveTransport>;
  close(): void;
};

export type RuntimeOptions = {
  env?: Environment;
  clock?: Clock;
  logLevel?: LogLevel;
  /** Signal passed to every HTTP call the runtime makes. */
  signal?: AbortSignal;
};

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const paths = resolvePaths(env);
  const config = resolveConfig(await readConfigFile(paths.dataDir), env);

  const logger = createNdjsonLogger({
    file: paths.logFile,
    level: options.logLevel ?? (env['ARCHIVE_LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
    base: { pid: process.pid, v: ARCHIVER_VERSION },
  });

  let database: Db | undefined;
  let httpClient: HttpClient | undefined;
  let authProvider: AuthProvider | undefined;
  let transport: DriveTransport | undefined;

  const tokenStore = createFileTokenStore(paths.tokenFile, logger);

  const runtime: Runtime = {
    env,
    paths,
    config,
    logger,
    clock,
    version: ARCHIVER_VERSION,
    tokenStore,

    db(): Db {
      database ??= openDatabase(paths.dbFile);
      return database;
    },

    http(): HttpClient {
      httpClient ??= createHttpClient({ clock, logger });
      return httpClient;
    },

    async auth(): Promise<AuthProvider> {
      if (authProvider === undefined) {
        const client = await resolveOAuthClient(env, paths.dataDir);
        authProvider = createAuthProvider({
          client,
          tokenStore,
          http: runtime.http(),
          clock,
          logger,
        });
      }
      return authProvider;
    },

    async drive(): Promise<DriveTransport> {
      transport ??= createDriveTransport({
        http: runtime.http(),
        auth: await runtime.auth(),
        logger,
      });
      return transport;
    },

    close(): void {
      if (database !== undefined) {
        checkpointAndClose(database);
        database = undefined;
      }
      logger.close();
    },
  };

  return runtime;
}

export async function readConfigFile(dataDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(path.join(dataDir, 'config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
