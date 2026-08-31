import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
import type { ArchivePaths } from '../core/paths.ts';

/**
 * Finding sessions on disk.
 *
 * A session is `<projects>/<encoded-cwd>/<session-id>.jsonl` plus an optional
 * directory of the same name holding tool results and subagent transcripts.
 */

export type ScanSkip = { kind: 'project' | 'session'; name: string };

export type LocalSession = {
  sessionId: string;
  encodedDir: string;
  transcriptPath: string;
  sidecarDir: string;
  hasSidecar: boolean;
  transcriptBytes: number;
  sidecarBytes: number;
  /** Newest mtime across the transcript and the sidecar: the idle clock. */
  mtimeMs: number;
};

export async function statSession(
  paths: ArchivePaths,
  encodedDir: string,
  sessionId: string,
): Promise<LocalSession | null> {
  const dir = path.join(paths.projectsDir, encodedDir);
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const sidecarDir = path.join(dir, sessionId);

  let transcript: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    transcript = await fsp.stat(transcriptPath);
  } catch {
    return null;
  }
  if (!transcript.isFile()) return null;

  const sidecar = await measureDirectory(sidecarDir);
  return {
    sessionId,
    encodedDir,
    transcriptPath,
    sidecarDir,
    hasSidecar: sidecar !== null,
    transcriptBytes: transcript.size,
    sidecarBytes: sidecar?.bytes ?? 0,
    mtimeMs: Math.max(transcript.mtimeMs, sidecar?.mtimeMs ?? 0),
  };
}

/**
 * Walk every session under the projects directory.
 *
 * A generator, not an array: a four-week-old install already holds hundreds of
 * sessions, and the sweep processes them one at a time anyway.
 */
export async function* scanSessions(
  paths: ArchivePaths,
  skipped?: ScanSkip[],
): AsyncGenerator<LocalSession> {
  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(paths.projectsDir);
  } catch {
    return;
  }
  for (const encodedDir of projectDirs) {
    // A directory name that is not a plain segment cannot be joined safely.
    // Recorded rather than dropped: a silent skip means a whole project is
    // absent from the archive with nothing anywhere saying so.
    if (!isSafeEncodedDir(encodedDir)) {
      skipped?.push({ kind: 'project', name: encodedDir });
      continue;
    }
    let entries: string[];
    try {
      entries = await fsp.readdir(path.join(paths.projectsDir, encodedDir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      // `...jsonl` yields `..`, and `.jsonl` yields the empty string. Both
      // join into the parent directory, which the reaper would then delete.
      if (!isSafeSessionId(sessionId)) {
        skipped?.push({ kind: 'session', name: entry });
        continue;
      }
      const session = await statSession(paths, encodedDir, sessionId);
      if (session !== null) yield session;
    }
  }
}

async function measureDirectory(dir: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let bytes = 0;
  let mtimeMs = 0;
  const stack = entries.map((entry) => path.join(dir, entry));
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(current);
    } catch {
      continue;
    }
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    if (stat.isDirectory()) {
      try {
        for (const child of await fsp.readdir(current)) stack.push(path.join(current, child));
      } catch {
        // Unreadable subdirectory; the bundle still gets what it can.
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
    }
  }
  return { bytes, mtimeMs };
}

/** The tar entries that make up one session, relative to its project directory. */
export function bundleEntries(session: LocalSession): string[] {
  const entries = [`${session.sessionId}.jsonl`];
  if (session.hasSidecar) entries.push(session.sessionId);
  return entries;
}
