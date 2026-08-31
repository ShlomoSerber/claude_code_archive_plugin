import { createRequire } from 'node:module';
import type * as SqliteModule from 'node:sqlite';
import { FatalError } from '../core/errors.ts';
import { NODE_REMEDIATION, nodeVersionProblem } from '../core/runtime-check.ts';

/**
 * Load `node:sqlite` lazily, through `require`, and never at import time.
 *
 * Two reasons, both load-bearing:
 *
 *  - A static `import` is hoisted above every statement in the module, including
 *    the code in `core/quiet.ts` that silences Node 22's experimental warning.
 *  - On a Node older than 22.16 the module does not exist at all. Requiring it
 *    at import time would throw before any entry point could catch it and
 *    explain what is wrong.
 */

const requireModule = createRequire(import.meta.url);

let cached: typeof SqliteModule | undefined;
let attempted = false;

export function getSqlite(): typeof SqliteModule {
  if (cached !== undefined) return cached;
  if (!attempted) {
    attempted = true;
    try {
      cached = requireModule('node:sqlite') as typeof SqliteModule;
      return cached;
    } catch {
      // Fall through to the diagnosis below.
    }
  }
  throw new FatalError(
    nodeVersionProblem() ?? 'node:sqlite is missing from this Node build',
    NODE_REMEDIATION,
  );
}

export type DatabaseSyncInstance = SqliteModule.DatabaseSync;
