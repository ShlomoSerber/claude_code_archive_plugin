import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { writeFileAtomic } from './atomic.ts';
import { nullLogger, type Logger } from '../ports/logger.ts';
import type { StoredTokens, TokenStore } from '../ports/token-store.ts';

/**
 * Token storage (ARCHITECTURE §7).
 *
 * A `0600` file in the plugin data directory, which is what the AWS CLI and
 * gcloud do on a personal machine. The native keychain wrappers are all native
 * modules, and this project bans those.
 *
 * The real containment is the scope: `drive.file` means a leaked token reaches
 * only the files this plugin created, never the rest of the user's Drive.
 */
export function createFileTokenStore(file: string, logger: Logger = nullLogger): TokenStore {
  return {
    location: file,

    async read(): Promise<StoredTokens | null> {
      let raw: string;
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null;
        throw err;
      }
      warnIfWorldReadable(file, logger);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn('tokens.unreadable', { file });
        return null;
      }
      return normalize(parsed);
    },

    async write(tokens: StoredTokens): Promise<void> {
      await writeFileAtomic(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    },

    async clear(): Promise<void> {
      await fsp.rm(file, { force: true });
    },
  };
}

/**
 * Permissions are re-checked on every read, not just at write time: a restore
 * from backup or a careless `chmod` can widen them long after we created it.
 */
function warnIfWorldReadable(file: string, logger: Logger): void {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn('tokens.permissions_too_open', { file, mode: mode.toString(8) });
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // Reading permissions is a diagnostic, never a reason to fail the read.
  }
}

function normalize(parsed: unknown): StoredTokens | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<StoredTokens>;
  if (typeof candidate.accessToken !== 'string' || typeof candidate.expiresAt !== 'number') {
    return null;
  }
  return {
    accessToken: candidate.accessToken,
    refreshToken: typeof candidate.refreshToken === 'string' ? candidate.refreshToken : null,
    expiresAt: candidate.expiresAt,
    scope: typeof candidate.scope === 'string' ? candidate.scope : '',
    tokenType: typeof candidate.tokenType === 'string' ? candidate.tokenType : 'Bearer',
    clientId: typeof candidate.clientId === 'string' ? candidate.clientId : '',
  };
}

/** In-memory store, for tests and for `--dry-run`. */
export function createMemoryTokenStore(initial: StoredTokens | null = null): TokenStore {
  let tokens = initial;
  return {
    location: '<memory>',
    read: () => Promise.resolve(tokens),
    write: (next) => {
      tokens = next;
      return Promise.resolve();
    },
    clear: () => {
      tokens = null;
      return Promise.resolve();
    },
  };
}
