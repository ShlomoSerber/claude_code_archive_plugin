import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomic file replacement (ARCHITECTURE §5).
 *
 * Two platform facts drive the whole design:
 *  - `rename` is only atomic within a filesystem, so the temp file must be a
 *    sibling of the final path, never in a global temp directory.
 *  - On Windows, antivirus and the search indexer hold transient handles, so a
 *    rename that is correct still fails with `EPERM`/`EBUSY`. Retry it.
 */

const RENAME_ATTEMPTS = 6;

export type RenameOptions = {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff for rename retries: 10 ms, 30, 90, 270, 810, capped at 1 s. */
export function renameRetryDelay(attempt: number): number {
  return Math.min(1000, 10 * 3 ** attempt);
}

function isTransientRenameError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/** `fs.rename`, retried through the Windows transient-failure window. */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? RENAME_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts - 1 || !isTransientRenameError(err)) throw err;
      await sleep(renameRetryDelay(attempt));
    }
  }
}

/** A sibling temp path, so the later rename stays on one filesystem. */
export function siblingTempPath(finalPath: string, suffix = '.partial'): string {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  return path.join(dir, `${base}.${randomBytes(6).toString('hex')}${suffix}`);
}

/**
 * Force the file's data to disk. Without this, a crash after `rename` can leave
 * a correctly named file full of zeroes.
 */
export async function fsyncFile(handle: fsp.FileHandle): Promise<void> {
  await handle.sync();
}

/**
 * Force the directory entry itself. POSIX-only: Windows cannot open a directory
 * for this, and NTFS does not need it.
 */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    // Best effort: some filesystems refuse fsync on directories.
  } finally {
    await handle?.close();
  }
}

/** Write `data` so that readers see either the old file or the whole new one. */
export async function writeFileAtomic(
  finalPath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  const temp = siblingTempPath(finalPath);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(temp, 'wx', options.mode ?? 0o600);
    await handle.writeFile(data);
    await fsyncFile(handle);
    await handle.close();
    handle = undefined;
    await renameWithRetry(temp, finalPath);
    await fsyncDir(path.dirname(finalPath));
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Same guarantees, synchronous, for the sub-second hook processes. */
export function writeFileAtomicSync(
  finalPath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): void {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const temp = siblingTempPath(finalPath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', options.mode ?? 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, finalPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Delete leftover `*.partial` files in a directory. Run at worker startup:
 * an interrupted bundle is cheap to rebuild and impossible to resume.
 */
export async function removePartials(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.partial')) continue;
    const full = path.join(dir, entry);
    try {
      await fsp.rm(full, { force: true });
      removed.push(full);
    } catch {
      // Locked by a still-running worker; the next sweep will get it.
    }
  }
  return removed;
}
