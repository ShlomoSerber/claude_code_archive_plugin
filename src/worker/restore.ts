import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractBundle } from '../adapters/bundle.ts';
import { sha256File } from '../adapters/hashing.ts';
import { statSession } from '../adapters/session-scan.ts';
import { getSession, markLocalPresent, type SessionRecord } from '../core/catalog.ts';
import { FatalError, RetryableError } from '../core/errors.ts';
import { assertInside, isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
import { clearVerification } from '../core/catalog.ts';
import type { WorkerContext } from './context.ts';

/**
 * Bringing an archived session back (SPEC §5, step 4).
 *
 * Download, verify, unpack into the exact directory Claude Code expects, and
 * hand back the command. The hand-off is last on purpose: a running session
 * cannot become an old one, so the user has to start the resumed session
 * themselves.
 */

export type RestoreResult = {
  sessionId: string;
  encodedDir: string;
  projectCwd: string | null;
  transcriptPath: string;
  entries: string[];
  alreadyLocal: boolean;
  resumeCommand: string;
};

export async function restoreSession(
  ctx: WorkerContext,
  sessionId: string,
): Promise<RestoreResult> {
  const record = getSession(ctx.db, sessionId);
  if (record === null) {
    throw new FatalError(
      `session ${sessionId} is not in the catalog`,
      'Run /archive:search to find the session id, or /archive:now to rescan.',
    );
  }

  if (!isSafeSessionId(record.sessionId) || !isSafeEncodedDir(record.encodedDir)) {
    throw new FatalError(
      `the catalog entry for ${sessionId} has an unusable project or session id`,
      'Run /archive:now to rebuild the catalog from the sessions on disk.',
    );
  }
  const targetDir = path.join(ctx.paths.projectsDir, record.encodedDir);
  assertInside(ctx.paths.projectsDir, targetDir, 'restore target');
  const existing = await statSession(ctx.paths, record.encodedDir, sessionId);
  if (existing !== null) {
    // Already on disk. Restoring over it could only lose the newer copy.
    markLocalPresent(ctx.db, sessionId, Math.trunc(existing.mtimeMs), ctx.clock.now());
    return {
      sessionId,
      encodedDir: record.encodedDir,
      projectCwd: record.projectCwd,
      transcriptPath: existing.transcriptPath,
      entries: [],
      alreadyLocal: true,
      resumeCommand: resumeCommand(sessionId),
    };
  }

  const remoteFileId = requireRemote(record);
  const staged = path.join(ctx.paths.stagingDir, `${sessionId}.restore.tar.zst`);
  try {
    await ctx.drive.downloadToFile({ fileId: remoteFileId, destination: staged }, ctx.signal);

    if (record.bundleSha256 !== null) {
      const actual = await sha256File(staged, ctx.signal);
      if (actual !== record.bundleSha256) {
        throw new RetryableError(
          `the downloaded bundle does not match the catalog hash for ${sessionId}`,
        );
      }
    }

    const { entries } = await extractBundle({
      bundlePath: staged,
      targetDir,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    const restored = await statSession(ctx.paths, record.encodedDir, sessionId);
    const now = ctx.clock.now();
    if (restored !== null) markLocalPresent(ctx.db, sessionId, Math.trunc(restored.mtimeMs), now);

    ctx.logger.info('restore.done', { session_id: sessionId, entries: entries.length });
    return {
      sessionId,
      encodedDir: record.encodedDir,
      projectCwd: record.projectCwd,
      transcriptPath: path.join(targetDir, `${sessionId}.jsonl`),
      entries,
      alreadyLocal: false,
      resumeCommand: resumeCommand(sessionId),
    };
  } finally {
    await fsp.rm(staged, { force: true }).catch(() => undefined);
  }
}

function requireRemote(record: SessionRecord): string {
  if (record.remoteFileId === null || record.verifiedAt === null) {
    throw new FatalError(
      `session ${record.sessionId} has no verified copy on Drive`,
      'Run /archive:now to finish backing it up, then try again.',
    );
  }
  return record.remoteFileId;
}

/**
 * The command the user runs. It must be run from the session's own working
 * directory: Claude Code looks for transcripts under the encoded cwd.
 */
export function resumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

/** Verify archived bundles against their stored hashes (SPEC §7, /archive:verify). */
export type VerifyReport = {
  checked: number;
  ok: number;
  mismatched: { sessionId: string; reason: string }[];
  missing: string[];
};

export async function verifyArchive(
  ctx: WorkerContext,
  records: SessionRecord[],
): Promise<VerifyReport> {
  const report: VerifyReport = { checked: 0, ok: 0, mismatched: [], missing: [] };
  for (const record of records) {
    ctx.signal?.throwIfAborted();
    if (record.remoteFileId === null) {
      report.missing.push(record.sessionId);
      continue;
    }
    report.checked++;
    try {
      const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
      const reason = describeMismatch(record, remote.size, remote.sha256);
      if (reason === null) {
        report.ok++;
      } else {
        // A check that only reports is decoration. Withdrawing verification is
        // what stops the reaper deleting the local copy of a bundle that Drive
        // no longer holds intact.
        clearVerification(ctx.db, record.sessionId, ctx.clock.now());
        report.mismatched.push({ sessionId: record.sessionId, reason });
      }
    } catch (err) {
      clearVerification(ctx.db, record.sessionId, ctx.clock.now());
      report.mismatched.push({
        sessionId: record.sessionId,
        reason: err instanceof Error ? err.message : 'unreadable',
      });
    }
  }
  return report;
}

function describeMismatch(
  record: SessionRecord,
  remoteSize: number | null,
  remoteSha256: string | null,
): string | null {
  if (record.bundleBytes !== null && remoteSize !== null && remoteSize !== record.bundleBytes) {
    return `size ${String(remoteSize)} != ${String(record.bundleBytes)}`;
  }
  if (record.bundleSha256 !== null && remoteSha256 !== null) {
    return remoteSha256.toLowerCase() === record.bundleSha256.toLowerCase()
      ? null
      : 'sha256 mismatch';
  }
  // Nothing to compare is not the same as a match, and must not read as one.
  return remoteSha256 === null ? 'Drive returned no checksum' : null;
}
