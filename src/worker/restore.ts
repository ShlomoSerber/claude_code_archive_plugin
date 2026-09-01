import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractBundle } from '../adapters/bundle.ts';
import { renameWithRetry } from '../adapters/atomic.ts';
import { sha256File } from '../adapters/hashing.ts';
import { statSession, type LocalSession } from '../adapters/session-scan.ts';
import {
  getSession,
  markLocalPresent,
  type SessionRecord,
  listRetainedBundles,
} from '../core/catalog.ts';
import { FatalError, RetryableError } from '../core/errors.ts';
import { assertInside, isSafeEncodedDir, isSafeSessionId } from '../core/identifiers.ts';
import { clearVerification, markVerified } from '../core/catalog.ts';
import type { WorkerContext } from './context.ts';

/**
 * Bringing an archived session back (SPEC §5, step 4).
 *
 * Download, verify, unpack into the exact directory Claude Code expects, and
 * hand back the command. The hand-off is last on purpose: a running session
 * cannot become an old one, so the user has to start the resumed session
 * themselves.
 */

/** True when what is on disk is smaller than what the archive holds. */
function isIncomplete(record: SessionRecord, onDisk: LocalSession): boolean {
  const smaller = (floor: number | null, current: number): boolean =>
    floor !== null && current < floor;
  return (
    smaller(record.verifiedTranscriptBytes, onDisk.transcriptBytes) ||
    smaller(record.verifiedSidecarBytes, onDisk.sidecarBytes)
  );
}

export type RestoreResult = {
  sessionId: string;
  encodedDir: string;
  projectCwd: string | null;
  transcriptPath: string;
  entries: string[];
  alreadyLocal: boolean;
  /** Where an archived copy was unpacked beside an incomplete local one. */
  recoveredTo?: string;
  resumeCommand: string;
};

/**
 * Unpack a bundle the plugin deliberately kept, beside the current session.
 *
 * When a new bundle cannot be proved to contain the old one, the old one stays
 * on Drive and `remote_file_id` moves on — so its unique contents survived with
 * no command that could get them back. /archive:status names these; this is how
 * they are retrieved.
 */
export async function restoreRetainedBundle(
  ctx: WorkerContext,
  fileId: string,
): Promise<RestoreResult> {
  const retained = listRetainedBundles(ctx.db).find((entry) => entry.fileId === fileId);
  if (retained === undefined) {
    throw new FatalError(
      `no retained bundle with the id ${fileId}`,
      'Run /archive:status to see the bundles that were kept, with their ids.',
    );
  }
  const record = getSession(ctx.db, retained.sessionId);
  if (
    record === null ||
    !isSafeSessionId(record.sessionId) ||
    !isSafeEncodedDir(record.encodedDir)
  ) {
    throw new FatalError(
      `the catalog entry for ${retained.sessionId} cannot be located on disk`,
      'Run /archive:now to rescan, then try again.',
    );
  }

  const targetDir = path.join(ctx.paths.projectsDir, record.encodedDir);
  // Beside, never over: the live session is the one the user is working with.
  const destination = path.join(
    targetDir,
    `${record.sessionId}.retained-${String(ctx.clock.now())}`,
  );
  const staged = path.join(ctx.paths.restoreDir, `${record.sessionId}.retained.tar.zst`);
  let entries: string[] = [];
  try {
    await ctx.drive.downloadToFile({ fileId, destination: staged }, ctx.signal);
    const actual = await sha256File(staged, ctx.signal);
    // The catalog's hash when it has one. A row recovered from an older
    // catalog may not, and unpacking unchecked bytes beside a live session —
    // then telling the user to "remove whichever you do not want" — is not a
    // position to put them in. Drive stamps the hash into appProperties at
    // upload time, so there is a second source.
    const expected = retained.bundleSha256 ?? (await stampedSha256(ctx, fileId));
    if (expected === null) {
      throw new FatalError(
        `no recorded hash for the retained bundle ${fileId}`,
        'Download it from Drive by hand: it is a plain .tar.zst that tar and zstd can read.',
      );
    }
    if (actual !== expected) {
      throw new RetryableError(`the retained bundle ${fileId} does not match its recorded hash`);
    }
    await fsp.mkdir(destination, { recursive: true });
    const result = await extractBundle({
      bundlePath: staged,
      targetDir: destination,
      onlySession: record.sessionId,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    entries = result.entries;
  } finally {
    await fsp.rm(staged, { force: true }).catch(() => undefined);
  }
  if (entries.length === 0) {
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw new RetryableError(`nothing could be unpacked from ${fileId}`);
  }
  ctx.logger.info('restore.retained', { session_id: record.sessionId, path: destination });
  return {
    sessionId: record.sessionId,
    encodedDir: record.encodedDir,
    projectCwd: record.projectCwd,
    transcriptPath: path.join(destination, `${record.sessionId}.jsonl`),
    entries,
    alreadyLocal: false,
    recoveredTo: destination,
    resumeCommand: resumeCommand(record.sessionId),
  };
}

/**
 * The sha256 the uploader stamped into appProperties, when the catalog has none.
 *
 * Drive's own checksum would only prove the download arrived intact; this one
 * was written by the process that built the bundle, so it also says the bytes
 * are the bytes that were archived.
 */
async function stampedSha256(ctx: WorkerContext, fileId: string): Promise<string | null> {
  try {
    const remote = await ctx.drive.getFile(fileId, ctx.signal);
    const stamped = remote.appProperties?.['sha256'];
    return typeof stamped === 'string' && /^[0-9a-f]{64}$/.test(stamped) ? stamped : null;
  } catch {
    return null;
  }
}

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
  // "Already local" means the transcript is here. A surviving sidecar with no
  // transcript is a half-present session — what a crash between the reaper's two
  // deletes leaves behind — and calling that "already on this machine" was the
  // one state the plugin could not get itself out of. The stale sidecar is moved
  // aside first so unpacking cannot overwrite it.
  const existing = await statSession(ctx.paths, record.encodedDir, sessionId);
  if (existing !== null && isIncomplete(record, existing)) {
    // Present but smaller than the archive: a half-finished reap, a deleted
    // sidecar, a truncated write. Unpacking over it would destroy whatever the
    // live session has added since, so the archived copy goes beside it and the
    // user decides. Without this the session was simply stuck.
    // The directory is created only once verified bytes exist to put in it,
    // so a failed recovery leaves nothing behind to be mistaken for one.
    const recovery = path.join(targetDir, `${sessionId}.archived-${String(ctx.clock.now())}`);
    const staged = path.join(ctx.paths.restoreDir, `${sessionId}.recover.tar.zst`);
    let recovered: string[] = [];
    try {
      await ctx.drive.downloadToFile(
        { fileId: requireRemote(record), destination: staged },
        ctx.signal,
      );
      // The same check the main restore path makes. This branch is what the
      // shrink guard's remediation tells the user to run, and it ends with
      // "remove whichever you do not want" — so handing them an empty or
      // partial directory in silence is a route to deleting the good copy.
      const actual = await sha256File(staged, ctx.signal);
      if (actual !== record.verifiedBundleSha256) {
        throw new RetryableError(
          `the downloaded bundle does not match the catalog hash for ${sessionId}`,
        );
      }
      await fsp.mkdir(recovery, { recursive: true });
      const result = await extractBundle({
        bundlePath: staged,
        targetDir: recovery,
        onlySession: sessionId,
      });
      recovered = result.entries;
    } finally {
      await fsp.rm(staged, { force: true }).catch(() => undefined);
    }
    if (recovered.length === 0) {
      await fsp.rm(recovery, { recursive: true, force: true }).catch(() => undefined);
      throw new RetryableError(`nothing could be recovered for ${sessionId}`);
    }
    ctx.logger.warn('restore.recovered_beside', {
      session_id: sessionId,
      path: recovery,
      entries: recovered.length,
    });
    return {
      sessionId,
      encodedDir: record.encodedDir,
      projectCwd: record.projectCwd,
      transcriptPath: existing.transcriptPath,
      entries: recovered,
      alreadyLocal: true,
      recoveredTo: recovery,
      resumeCommand: resumeCommand(sessionId),
    };
  }
  if (existing !== null) {
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
  if (await isDirectory(path.join(targetDir, sessionId))) {
    const aside = path.join(targetDir, `${sessionId}.superseded-${String(ctx.clock.now())}`);
    // Checked, and retried: every other must-succeed rename here uses
    // renameWithRetry for the Windows EPERM/EBUSY class. Unpacking into a
    // sidecar that is still there would overwrite the files it holds.
    try {
      await renameWithRetry(path.join(targetDir, sessionId), aside);
    } catch (err) {
      throw new FatalError(
        `the sidecar left at ${path.join(targetDir, sessionId)} could not be moved aside`,
        'Move or remove that directory yourself, then run /archive:resume again. ' +
          'Nothing has been unpacked over it.',
        { cause: err },
      );
    }
    ctx.logger.warn('restore.sidecar_moved_aside', { session_id: sessionId, path: aside });
  }

  const remoteFileId = requireRemote(record);
  const staged = path.join(ctx.paths.restoreDir, `${sessionId}.restore.tar.zst`);
  try {
    await ctx.drive.downloadToFile({ fileId: remoteFileId, destination: staged }, ctx.signal);

    // Unconditional: requireRemote has already refused a row without a hash,
    // so there is no path here that unpacks unverified bytes.
    const actual = await sha256File(staged, ctx.signal);
    if (actual !== record.verifiedBundleSha256) {
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

    // Check what actually landed. Extraction can end short without raising —
    // a full disk, a quota, a signal — and a truncated transcript left on disk
    // is worse than none: the next sweep would archive it over the good copy.
    const problem = await describeRestoreProblem(ctx, record, targetDir, sessionId);
    if (problem !== null) {
      const quarantine = await removePartialRestore(targetDir, sessionId, ctx.clock.now());
      ctx.logger.error('restore.quarantined', { session_id: sessionId, path: quarantine ?? '' });
      throw new RetryableError(
        quarantine === null
          ? `the restored session is incomplete: ${problem}. It could not be moved aside, ` +
            `so it is still in ${targetDir} — remove it by hand before archiving runs again.`
          : `the restored session is incomplete: ${problem}. What was unpacked has been ` +
            `moved to ${quarantine} rather than deleted.`,
      );
    }

    const restored = await statSession(ctx.paths, record.encodedDir, sessionId);
    const now = ctx.clock.now();
    if (restored !== null) {
      markLocalPresent(ctx.db, sessionId, Math.trunc(restored.mtimeMs), now);
      // The unpacked files just matched the archive byte for byte, so this is
      // the archived state. Without re-recording it, tar's second-granularity
      // mtimes make every restore look like a change and force a full re-bundle
      // and re-upload of a session nobody touched.
      markVerified(
        ctx.db,
        sessionId,
        {
          fileId: remoteFileId,
          path: record.remotePath ?? '',
          localMtime: Math.trunc(restored.mtimeMs),
          localBytes: restored.transcriptBytes + restored.sidecarBytes,
          transcriptBytes: restored.transcriptBytes,
          sidecarBytes: restored.sidecarBytes,
          bundleBytes: record.verifiedBundleBytes,
          manifest: record.verifiedManifest,
          bundleMd5: record.verifiedBundleMd5,
          bundleSha256: record.verifiedBundleSha256,
          transcriptSha256: record.verifiedTranscriptSha256,
        },
        now,
      );
    }

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

/**
 * Compare what was unpacked against what the catalog says the session was.
 *
 * Returns a reason when the restore is incomplete, or null when it is whole.
 */
async function describeRestoreProblem(
  ctx: WorkerContext,
  record: SessionRecord,
  targetDir: string,
  sessionId: string,
): Promise<string | null> {
  const restored = await statSession(ctx.paths, record.encodedDir, sessionId);
  if (restored === null) return 'the transcript is not there';

  const expected = record.verifiedTranscriptSha256;
  if (expected !== null) {
    const hash = await sha256File(path.join(targetDir, `${sessionId}.jsonl`)).catch(() => null);
    if (hash === null) return 'the transcript could not be read back';
    if (hash !== expected) return 'the transcript does not match the hash of the archived copy';
  }

  const bytes = restored.transcriptBytes + restored.sidecarBytes;
  if (record.verifiedLocalBytes !== null && bytes !== record.verifiedLocalBytes) {
    return `${String(bytes)} bytes on disk, ${String(record.verifiedLocalBytes)} expected`;
  }
  return null;
}

/**
 * Move a rejected restore out of the way under a name Claude Code ignores.
 *
 * It must not stay where it is, or the next sweep would archive it over the
 * good copy. It must not be deleted either: it came off Drive and matched the
 * bundle hash, so it is the best evidence available about what went wrong.
 */
async function removePartialRestore(
  targetDir: string,
  sessionId: string,
  stamp: number,
): Promise<string | null> {
  const quarantine = path.join(targetDir, `${sessionId}.rejected-${String(stamp)}`);
  await fsp.mkdir(quarantine, { recursive: true });
  let moved = 0;
  for (const name of [`${sessionId}.jsonl`, sessionId]) {
    const from = path.join(targetDir, name);
    if (!(await exists(from))) continue;
    try {
      await renameWithRetry(from, path.join(quarantine, name));
      moved++;
    } catch {
      // Reported, not swallowed: the caller's message used to say the partial
      // restore had been moved even when it was still sitting in place.
    }
  }
  return moved > 0 ? quarantine : null;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fsp.lstat(candidate);
    return true;
  } catch {
    return false;
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
  if (record.verifiedBundleSha256 === null) {
    throw new FatalError(
      `session ${record.sessionId} has no verified hash, so a download cannot be checked`,
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
  mismatched: { sessionId: string; reason: string; localDeleted: boolean }[];
  /** The sessions that actually passed. "Not mismatched" is not the same set. */
  okIds: string[];
  missing: string[];
  /** Rows Drive could not be asked about. Not a verdict, and not a failure. */
  unchecked: { sessionId: string; reason: string }[];
};

/**
 * Check the bundles the plugin kept because a newer one did not contain them.
 *
 * Nothing else looks at these. /archive:status says "they hold data the newer
 * bundle does not" — which is precisely why an unnoticed trashing of one is
 * the loss of the only copy of something.
 */
export async function verifyRetained(ctx: WorkerContext): Promise<{
  checked: number;
  ok: number;
  problems: { fileId: string; reason: string }[];
  /** Bundles Drive would not vouch for. Not a verdict, and not "intact". */
  unchecked: { fileId: string; reason: string }[];
}> {
  const problems: { fileId: string; reason: string }[] = [];
  const unchecked: { fileId: string; reason: string }[] = [];
  let checked = 0;
  let ok = 0;
  for (const entry of listRetainedBundles(ctx.db)) {
    checked++;
    try {
      const remote = await ctx.drive.getFile(entry.fileId, ctx.signal);
      if (remote.trashed === true) {
        problems.push({ fileId: entry.fileId, reason: 'it is in the Drive wastebasket' });
        continue;
      }
      if (remote.size !== null && entry.bundleBytes !== null && remote.size !== entry.bundleBytes) {
        problems.push({
          fileId: entry.fileId,
          reason: `it is ${String(remote.size)} bytes, not ${String(entry.bundleBytes)}`,
        });
        continue;
      }
      // Same shape as verifyArchive: a hash that matches is intact, a hash
      // that disagrees is a problem, and no hash at all is neither. Counting
      // the third as intact told the user a bundle nothing else holds a copy
      // of had been checked when it had not.
      const strong = compareHash(remote.sha256, entry.bundleSha256);
      const weak = compareHash(remote.md5, entry.bundleMd5);
      if (strong === 'differs' || weak === 'differs') {
        problems.push({ fileId: entry.fileId, reason: 'its hash no longer matches' });
        continue;
      }
      if (strong === 'matches' || weak === 'matches') {
        ok++;
        continue;
      }
      unchecked.push({ fileId: entry.fileId, reason: 'Drive reported no checksum for it' });
    } catch (err) {
      unchecked.push({
        fileId: entry.fileId,
        reason: err instanceof Error ? err.message : 'Drive could not be asked',
      });
    }
  }
  return { checked, ok, problems, unchecked };
}

function compareHash(
  remote: string | null,
  recorded: string | null,
): 'matches' | 'differs' | 'unknown' {
  if (remote === null || recorded === null) return 'unknown';
  return remote.toLowerCase() === recorded.toLowerCase() ? 'matches' : 'differs';
}

export async function verifyArchive(
  ctx: WorkerContext,
  records: SessionRecord[],
): Promise<VerifyReport> {
  const report: VerifyReport = { checked: 0, ok: 0,
    okIds: [], mismatched: [], missing: [], unchecked: [] };
  for (const record of records) {
    ctx.signal?.throwIfAborted();
    if (record.remoteFileId === null) {
      report.missing.push(record.sessionId);
      continue;
    }
    report.checked++;
    try {
      const remote = await ctx.drive.getFile(record.remoteFileId, ctx.signal);
      const canCheck =
        remote.sha256 !== null || (remote.md5 !== null && record.verifiedBundleMd5 !== null);
      if (remote.trashed !== true && !canCheck) {
        // Drive computes checksums asynchronously and sometimes answers without
        // one. That is "I could not check", the same class as a network
        // failure — not a mismatch, and certainly not grounds for withdrawing
        // verification across a whole archive in one /archive:verify --all.
        report.checked--;
        report.unchecked.push({
          sessionId: record.sessionId,
          reason: 'Drive returned no checksum',
        });
        continue;
      }
      const reason =
        remote.trashed === true
          ? 'the bundle is in the Drive wastebasket and will be purged'
          : describeMismatch(record, remote.size, remote.sha256, remote.md5);
      if (reason === null) {
        report.ok++;
        report.okIds.push(record.sessionId);
      } else {
        // Drive answered, and its answer was bad. Withdrawing verification is
        // what stops the reaper deleting a local copy against a bundle Drive
        // no longer holds intact.
        clearVerification(ctx.db, record.sessionId, ctx.clock.now());
        report.mismatched.push({
          sessionId: record.sessionId,
          reason,
          // No local copy means "run /archive:now" cannot be the advice: there
          // is nothing left on this machine to upload.
          localDeleted: !record.localPresent,
        });
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
  remoteMd5: string | null,
): string | null {
  const expectedBytes = record.verifiedBundleBytes;
  if (expectedBytes !== null && remoteSize !== null && remoteSize !== expectedBytes) {
    return `size ${String(remoteSize)} != ${String(expectedBytes)}`;
  }
  if (remoteSha256 !== null && record.verifiedBundleSha256 !== null) {
    return remoteSha256.toLowerCase() === record.verifiedBundleSha256.toLowerCase()
      ? null
      : 'sha256 mismatch';
  }
  // The reaper already falls back to md5, because a Drive that answers with
  // md5 alone would otherwise never let anything be reclaimed. Without the
  // same fallback here, exactly those archives could be deleted locally and
  // then never checked again, however badly they rotted.
  if (remoteMd5 !== null && record.verifiedBundleMd5 !== null) {
    return remoteMd5.toLowerCase() === record.verifiedBundleMd5.toLowerCase()
      ? null
      : 'md5 mismatch';
  }
  if (record.verifiedBundleSha256 === null) {
    return 'the catalog has no verified hash for this bundle';
  }
  return 'Drive returned no checksum';
}
