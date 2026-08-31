import type { Db } from '../adapters/db.ts';
import type { ArchiveConfig } from '../core/config.ts';
import type { ArchivePaths } from '../core/paths.ts';
import type { Clock } from '../ports/clock.ts';
import type { DriveTransport } from '../ports/drive.ts';
import type { Logger } from '../ports/logger.ts';

/** Everything a worker job needs, assembled once in the composition root. */
export type WorkerContext = {
  db: Db;
  paths: ArchivePaths;
  config: ArchiveConfig;
  drive: DriveTransport;
  logger: Logger;
  clock: Clock;
  version: string;
  signal: AbortSignal | undefined;
};
