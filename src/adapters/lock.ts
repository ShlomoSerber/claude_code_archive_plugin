import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemClock, type Clock } from '../ports/clock.ts';
import { nullLogger, type Logger } from '../ports/logger.ts';

/**
 * Single-instance lock (ARCHITECTURE §3).
 *
 * A lock *directory*, not a lock file: `mkdir` is atomic on every filesystem we
 * target, and a directory cannot be left half-open by a Windows zombie handle.
 *
 * Liveness comes from an mtime heartbeat, not from the pid. PIDs recycle —
 * fast, on Windows — so `process.kill(pid, 0)` is a hint that lets us reclaim a
 * dead lock early, never the proof that lets us break a live one.
 */

const META_FILE = 'owner.json';

export type LockOptions = {
  /** How often the holder refreshes the lock's mtime. */
  heartbeatMs?: number;
  /** Age past which a lock is considered abandoned. Keep at 2-3x heartbeat. */
  staleMs?: number;
  clock?: Clock;
  logger?: Logger;
};

export type LockOwner = {
  pid: number;
  hostname: string;
  startedAt: number;
};

export type Lock = {
  readonly dir: string;
  readonly owner: LockOwner;
  release(): void;
};

const DEFAULT_HEARTBEAT_MS = 5_000;
/** Floor of 10 s: FAT-family filesystems store mtime at 2 s granularity. */
const MIN_STALE_MS = 10_000;

/**
 * Take the lock, or return `null` if another live process holds it.
 *
 * Returning `null` is a normal outcome, not an error: it means another worker
 * is already doing the work, so this process has nothing to do.
 */
export function acquireLock(dir: string, options: LockOptions = {}): Lock | null {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = Math.max(MIN_STALE_MS, options.staleMs ?? heartbeatMs * 4);

  const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), startedAt: clock.now() };

  if (!tryMkdir(dir)) {
    const existing = readOwner(dir);
    if (!isStale(dir, staleMs, clock, existing)) {
      logger.debug('lock.busy', { holder_pid: existing?.pid ?? null });
      return null;
    }
    logger.warn('lock.breaking_stale', { holder_pid: existing?.pid ?? null });
    if (!breakLock(dir)) return null;
    if (!tryMkdir(dir)) return null;
  }

  try {
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(owner), { mode: 0o600 });
  } catch {
    // The heartbeat touches the directory itself, so a missing meta file costs
    // us only the diagnostic pid, never correctness.
  }

  const timer = setInterval(() => {
    heartbeat(dir, clock);
  }, heartbeatMs);
  timer.unref();

  let released = false;
  return {
    dir,
    owner,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      // Only if it is still the lock we took. A suspended laptop freezes the
      // heartbeat's mtime, so another worker can call this lock stale and
      // replace it while we sleep — and removing it then would delete the new
      // holder's lock and let a third worker in beside it.
      if (!stillOurs(dir, owner)) {
        logger.debug('lock.not_ours_on_release', { dir });
        return;
      }
      releaseWithRetry(dir, logger);
    },
  };
}

function tryMkdir(dir: string): boolean {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') return false;
    if ((err as { code?: string }).code === 'ENOENT') {
      // Parent missing on first ever run.
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      return tryMkdir(dir);
    }
    throw err;
  }
}

function heartbeat(dir: string, clock: Clock): void {
  const now = new Date(clock.now());
  try {
    fs.utimesSync(dir, now, now);
  } catch {
    // Lock already broken or removed; the release path handles it.
  }
}

export function readOwner(dir: string): LockOwner | null {
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, hostname, startedAt } = parsed as Partial<LockOwner>;
    if (typeof pid !== 'number' || typeof hostname !== 'string') return null;
    return { pid, hostname, startedAt: typeof startedAt === 'number' ? startedAt : 0 };
  } catch {
    return null;
  }
}

function isStale(dir: string, staleMs: number, clock: Clock, owner: LockOwner | null): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    // Vanished between mkdir failing and the stat: treat as free.
    return true;
  }
  const age = clock.now() - mtimeMs;
  if (age > staleMs) return true;
  // Fast path only: a dead pid on this host means the lock will never be
  // refreshed, so there is no reason to wait out the full stale window.
  if (owner !== null && owner.hostname === os.hostname() && !isPidAlive(owner.pid)) return true;
  return false;
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0 || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as { code?: string }).code === 'EPERM';
  }
}

function breakLock(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Does the lock on disk still name the owner we wrote? */
function stillOurs(dir: string, owner: LockOwner): boolean {
  const current = readOwner(dir);
  // Unreadable or gone counts as not ours: leave it alone.
  return current !== null && current.pid === owner.pid && current.startedAt === owner.startedAt;
}

function releaseWithRetry(dir: string, logger: Logger): void {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        logger.warn('lock.release_failed', {}, err);
        return;
      }
      sleepSync(Math.min(500, 10 * 3 ** attempt));
    }
  }
  logger.warn('lock.release_gave_up', { dir });
}

/**
 * Blocking sleep. Release runs on the exit path, where there is no event loop
 * left to await on, and the total budget here is under a second.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
