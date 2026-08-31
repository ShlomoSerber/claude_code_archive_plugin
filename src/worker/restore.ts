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
  // "Already local" has to mean any part of the session, not only the
  // transcript. With the transcript gone but the sidecar still here, unpacking
  // would overwrite tool results that are newer than the archived ones.
  const existing = await statSession(ctx.paths, record.encodedDir, sessionId);
  const sidecarSurvives = await isDirectory(path.join(targetDir, sessionId));
  if (existing !== null || sidecarSurvives) {
    if (existing !== null) {
      markLocalPresent(ctx.db, sessionId, Math.trunc(existing.mtimeMs), ctx.clock.now());
    }
    return {
      sessionId,
      encodedDir: record.encodedDir,
      projectCwd: record.projectCwd,
      transcriptPath: existing?.transcriptPath ?? path.join(targetDir, `${sessionId}.jsonl`),
      entries: [],
      alreadyLocal: true,
      resumeCommand: resumeCommand(sessionId),
    };
  }

  const remoteFileId = requireRemote(record);
  const staged = path.join(ctx.paths.stagingDir, `${sessionId}.restore.tar.zst`);
  try {
    await ctx.drive.downloadToFile({ fileId: remoteFileId, destination: staged }, ctx.signal);

    // Unconditional: requireRemote has already refused a row without a hash,
    // so there is no path here that unpacks unverified bytes.
    const actual = await sha256File(staged, ctx.signal);
    if (actual !== record.bundleSha256) {
      throw new RetryableError(
        `the downloaded bundle does not match the catalog hash for ${sessionId}`,
      );
    }

    const { entries, rejected } = await extractBundle({
      bundlePath: staged,
      targetDir,
      // The project directory is shared with every other session of that
      // project. Without this, a bundle containing another session's
      // transcript would overwrite it — and that bundle can arrive from a
      // catalog downloaded off Drive.
      onlySession: sessionId,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (rejected.length > 0) {
      ctx.logger.warn('restore.rejected_entries', {
        session_id: sessionId,
        count: rejected.length,
        first: rejected[0] ?? '',
      });
    }

    // The transcript hash was recorded at backup time and never read until
    // now. Comparing it here is what turns it from decoration into a check.
    if (record.transcriptSha256 !== null) {
      const restoredHash = await sha256File(path.join(targetDir, `${sessionId}.jsonl`)).catch(
        () => null,
      );
      if (restoredHash !== null && restoredHash !== record.transcriptSha256) {
        ctx.logger.error('restore.transcript_hash_mismatch', { session_id: sessionId });
      }
    }

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

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What restore needs is a pointer and a hash, not `verified_at`.
 *
 * `verified_at` records the authority to *delete* a local copy. Requiring it
 * here would make a session unrecoverable the moment a network blip withdrew
 * that authority, which is exactly backwards: the bytes are still on Drive and
 * the download is checked against the hash either way.
 */
function requireRemote(record: SessionRecord): string {
  if (record.remoteFileId === null) {
    throw new FatalError(
      `session ${record.sessionId} has no copy on Drive`,
      'Run /archive:now to finish backing it up, then try again.',
    );
  }
  if (record.bundleSha256 === null) {
    throw new FatalError(
      `session ${record.sessionId} has no stored hash, so a download cannot be checked`,
      'Run /archive:now to archive it again, which records the hash.',
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
  /** Rows Drive could not be asked about. Not a verdict, and not a failure. */
  unchecked: { sessionId: string; reason: string }[];
};

export async function verifyArchive(
  ctx: WorkerContext,
  records: SessionRecord[],
): Promise<VerifyReport> {
  const report: VerifyReport = { checked: 0, ok: 0, mismatched: [], missing: [], unchecked: [] };
  for (const record of records) {
    ctx.signal?.throwIfAborted();
    if (record.remoteFileId === null) {
      report.missing.push(record.sessionId);
      continue;
    }
    report.checked++;
    try {
      const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
      const reason = remote.trashed
        ? 'the bundle is in the Drive wastebasket and will be purged'
        : describeMismatch(record, remote.size, remote.sha256);
      if (reason === null) {
        report.ok++;
      } else {
        // Drive answered, and its answer was bad. Withdrawing verification is
        // what stops the reaper deleting a local copy against a bundle Drive
        // no longer holds intact.
        clearVerification(ctx.db, record.sessionId, ctx.clock.now());
        report.mismatched.push({ sessionId: record.sessionId, reason });
      }
    } catch (err) {
      // Drive did not answer. That is a statement about the network, not about
      // the archive. `/archive:verify --all` walks hundreds of files fast
      // enough to earn a rate limit, and treating those as verification
      // failures would withdraw trust from a healthy archive wholesale.
      report.checked--;
      report.unchecked.push({
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
  if (record.bundleSha256 === null) return 'the catalog has no hash for this bundle';
  if (remoteSha256 === null) return 'Drive returned no checksum';
  return remoteSha256.toLowerCase() === record.bundleSha256.toLowerCase()
    ? null
    : 'sha256 mismatch';
}
