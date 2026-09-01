import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBundle, describeSessionFiles, verifyBundleContents } from '../adapters/bundle.ts';
import { bundleEntries, statSession, type LocalSession } from '../adapters/session-scan.ts';
import { extractFromFile } from '../adapters/transcript-file.ts';
import { sha256File, sha256Prefix } from '../adapters/hashing.ts';
import {
  markBundled,
  getSession,
  markVerified,
  clearVerification,
  replaceFiles,
  replacePrompts,
  upsertSession,
} from '../core/catalog.ts';
import { FatalError, RetryableError } from '../core/errors.ts';
import { buildManifest, type ManifestFile } from '../core/manifest.ts';
import { bundleBaseName, isoDate, isoYear } from '../core/slug.ts';
import type { Job } from '../core/queue.ts';
import type { RemoteFile } from '../ports/drive.ts';
import type { SessionRecord } from '../core/catalog.ts';
import type { WorkerContext } from './context.ts';
import { uploadWithResume } from './upload.ts';

/**
 * One session, from disk to verified on Drive (SPEC §1).
 *
 * The order is deliberate. The catalog is written first, while the transcript
 * is still local and cheap to read; the bundle is hashed before it is uploaded;
 * and the session is marked verified only after Drive's own checksum agrees
 * with ours. That last step is what SPEC invariant 1 rests on.
 */

export type BackupOutcome =
  | { status: 'verified'; bundleBytes: number; remoteFileId: string }
  | { status: 'missing' }
  | { status: 'skipped'; reason: string };

export async function backupSession(
  ctx: WorkerContext,
  job: Job,
  args: { sessionId: string; encodedDir: string },
): Promise<BackupOutcome> {
  const log = ctx.logger.child({ session_id: args.sessionId });
  const session = await statSession(ctx.paths, args.encodedDir, args.sessionId);
  if (session === null) {
    // The transcript is gone. Either we already reaped it or the user deleted
    // it; either way there is nothing left to archive.
    log.info('backup.transcript_missing');
    return { status: 'missing' };
  }

  if (session.sidecarUnreadable) {
    // Archiving now would store the transcript alone and record the session as
    // verified, with the tool results and subagent transcripts on Drive nowhere
    // and nothing anywhere saying so.
    throw new FatalError(
      `the sidecar directory for ${args.sessionId} exists but cannot be read`,
      `Fix the permissions on the session directory beside its transcript, then ` +
        `run /archive:now. Nothing has been archived or deleted for this session.`,
    );
  }

  const now = ctx.clock.now();
  // Read before anything clears it: markBundled withdraws verification the
  // moment a new bundle is built, and this is the record of what Drive held.
  const previous = getSession(ctx.db, session.sessionId);
  const summary = await indexSession(ctx, session, now);
  const bundle = await buildBundle(ctx, session, summary, now);

  try {
    const remote = await publish(ctx, job, session, bundle, summary, previous, now);
    log.info('backup.verified', { bytes: bundle.bytes, file_id: remote.id });
    return { status: 'verified', bundleBytes: bundle.bytes, remoteFileId: remote.id };
  } finally {
    // The staged bundle is disposable: Drive holds the copy that matters, and
    // rebuilding is cheaper than reasoning about a stale one.
    await fsp.rm(bundle.path, { force: true }).catch(() => undefined);
  }
}

type IndexResult = {
  title: string | null;
  projectCwd: string | null;
  startedAt: number | null;
  endedAt: number | null;
};

/**
 * Read what the catalog needs out of the transcript.
 *
 * Parsing is allowed to fail: the format is internal to Claude Code and
 * changes. A session we cannot parse still gets a catalog row and still gets
 * archived byte for byte (SPEC invariant 2).
 */
async function indexSession(
  ctx: WorkerContext,
  session: LocalSession,
  now: number,
): Promise<IndexResult> {
  const log = ctx.logger.child({ session_id: session.sessionId });
  let summary: Awaited<ReturnType<typeof extractFromFile>> | null = null;
  try {
    summary = await extractFromFile(session.transcriptPath, ctx.signal);
  } catch (err) {
    log.warn('catalog.extract_failed', {}, err);
  }

  const transcriptSha256 = await sha256File(session.transcriptPath, ctx.signal);

  upsertSession(
    ctx.db,
    {
      sessionId: session.sessionId,
      encodedDir: session.encodedDir,
      projectCwd: summary?.projectCwd ?? null,
      title: summary?.title ?? null,
      summary: summary?.lastPrompt ?? null,
      gitBranch: summary?.gitBranch ?? null,
      startedAt: summary?.startedAt ?? null,
      endedAt: summary?.endedAt ?? null,
      messageCount: summary?.messageCount ?? null,
      transcriptBytes: session.transcriptBytes,
      transcriptSha256,
      sidecarBytes: session.sidecarBytes,
      lastLocalMtime: Math.trunc(session.mtimeMs),
    },
    now,
  );
  if (summary !== null) {
    replacePrompts(ctx.db, session.sessionId, summary.prompts);
    replaceFiles(ctx.db, session.sessionId, summary.files);
    if (summary.malformedLines > 0) {
      log.warn('catalog.malformed_lines', { count: summary.malformedLines });
    }
  }

  return {
    title: summary?.title ?? null,
    projectCwd: summary?.projectCwd ?? null,
    startedAt: summary?.startedAt ?? null,
    endedAt: summary?.endedAt ?? null,
  };
}

type StagedBundle = {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  md5: string;
  date: string;
  year: string;
};

async function buildBundle(
  ctx: WorkerContext,
  session: LocalSession,
  index: IndexResult,
  now: number,
): Promise<StagedBundle> {
  // The date in the name and the year folder come from the conversation itself,
  // falling back to the file's mtime only when the transcript could not be
  // parsed. mtime is not the session's date: restoring a bundle, copying a
  // machine or an rsync all reset it, which would file an old session under
  // today and put it in the wrong year folder on Drive.
  const stamp = (index.endedAt ?? index.startedAt ?? Math.trunc(session.mtimeMs)) || now;
  const title = index.title;
  const date = isoDate(stamp);
  // Staged under a provisional name; the remote name comes from the hash of
  // the bytes that actually get written, which is not known until then.
  const outputPath = path.join(ctx.paths.stagingDir, `${session.sessionId}.building.tar.zst`);

  const result = await createBundle({
    cwd: path.dirname(session.transcriptPath),
    entries: bundleEntries(session),
    outputPath,
    compressionLevel: ctx.config.zstdLevel,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

  const name = `${bundleBaseName({
    date,
    title,
    sessionId: session.sessionId,
    contentHash: result.sha256,
  })}.tar.zst`;

  markBundled(
    ctx.db,
    session.sessionId,
    {
      bundleName: name,
      bundleBytes: result.bytes,
      bundleSha256: result.sha256,
      archiverVersion: ctx.version,
    },
    ctx.clock.now(),
  );

  return {
    path: result.path,
    name,
    bytes: result.bytes,
    sha256: result.sha256,
    md5: result.md5,
    date,
    year: isoYear(stamp),
  };
}

async function publish(
  ctx: WorkerContext,
  job: Job,
  session: LocalSession,
  bundle: StagedBundle,
  index: IndexResult,
  previous: SessionRecord | null,
  now: number,
): Promise<RemoteFile> {
  const folderPath = [ctx.config.driveRootFolder, session.encodedDir, bundle.year];
  const parentId = await ctx.drive.ensureFolder(folderPath, ctx.signal);

  // Hash every file the session is made of, then read the bundle back and
  // check it holds exactly those bytes. Everything downstream compares our
  // hash of the bundle with Drive's hash of the bundle, which proves the
  // transfer and would happily certify a bundle of the wrong session.
  // Stat before hashing, so the closing stat below can prove nothing moved
  // while the files were being read. Without it the recorded mtime described a
  // moment *after* the hashes, and a same-size in-place rewrite landing between
  // the two was invisible to both checks — the session was marked verified and
  // the reaper then deleted bytes the archive did not contain.
  const before = await statSession(ctx.paths, session.encodedDir, session.sessionId);

  const files = await describeSessionFiles({
    cwd: path.dirname(session.transcriptPath),
    entries: bundleEntries(session),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  const contentProblem = await verifyBundleContents(bundle.path, files);
  if (contentProblem !== null) {
    throw new RetryableError(`the bundle does not match the session on disk: ${contentProblem}`);
  }

  // Take the fingerprint here, not from the stat at the start of the backup.
  // Indexing and compression both take time, and a fingerprint measured before
  // them would describe a state the bundle does not contain.
  const archivedBytes = files.reduce((total, file) => total + file.bytes, 0);
  const confirmed = await statSession(ctx.paths, session.encodedDir, session.sessionId);
  if (confirmed === null || confirmed.transcriptBytes + confirmed.sidecarBytes !== archivedBytes) {
    throw new RetryableError('the session changed while it was being archived');
  }
  if (before === null || Math.trunc(confirmed.mtimeMs) !== Math.trunc(before.mtimeMs)) {
    // Same size, different mtime: something rewrote a file in place while it
    // was being hashed. The bundle and the fingerprint would disagree.
    throw new RetryableError('the session was written to while it was being archived');
  }

  // A session that has shrunk since it was archived is the signature of
  // damage, not of normal use: a half-finished delete, a truncated restore, a
  // filesystem error. Archiving over the good copy is precisely how that
  // damage would become permanent, so stop and make a person look.
  // Falls back to the plain byte counts the row has always carried. A column
  // added by a migration is NULL for every existing session, and an imported
  // catalog deliberately drops the fingerprint — in both cases the guard would
  // otherwise be off for exactly the first re-archive, across the whole archive.
  // Component by component, and only ever against columns markVerified
  // writes. A total hides the case that matters — a transcript truncated by a
  // crashed write while a resumed session adds sidecar bytes sums to more than
  // before — and a column that this same attempt has already rewritten turns
  // the guard into a one-shot that waves the retry through.
  const archivedTranscript =
    files.find((file) => file.path === `${session.sessionId}.jsonl`)?.bytes ?? 0;
  const archivedSidecar = archivedBytes - archivedTranscript;
  const shrank = describeShrink(previous, {
    transcript: archivedTranscript,
    sidecar: archivedSidecar,
    total: archivedBytes,
  });
  if (shrank !== null) {
    throw new FatalError(
      `${session.sessionId} has less on disk than the copy on Drive: ${shrank}`,
      'Archiving now would replace the fuller copy with the smaller one. Run ' +
        '/archive:resume to recover the archived copy beside the local files, ' +
        'then remove whichever you do not want. Nothing has been changed.',
    );
  }

  {
  }

  const remote = await uploadWithResume(ctx, {
    job,
    filePath: bundle.path,
    name: bundle.name,
    parentId,
    mimeType: 'application/zstd',
    totalBytes: bundle.bytes,
    sha256: bundle.sha256,
    appProperties: { sessionId: session.sessionId, archiver: ctx.version },
  });

  await verifyRemote(ctx, session.sessionId, remote, bundle);

  const manifest = buildManifest({
    archiverVersion: ctx.version,
    sessionId: session.sessionId,
    projectCwd: index.projectCwd,
    encodedDir: session.encodedDir,
    title: index.title,
    startedAt: index.startedAt,
    endedAt: index.endedAt,
    createdAt: now,
    bundleName: bundle.name,
    bundleSha256: bundle.sha256,
    bundleBytes: bundle.bytes,
    compressionLevel: ctx.config.zstdLevel,
    files,
  });
  const manifestName = `${bundle.name.replace(/\.tar\.zst$/, '')}.manifest.json`;
  const existingManifest = await ctx.drive.findFile({ name: manifestName, parentId }, ctx.signal);
  await ctx.drive.uploadSmallFile(
    {
      name: manifestName,
      parentId,
      mimeType: 'application/json',
      body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      appProperties: { sessionId: session.sessionId },
      ...(existingManifest === null ? {} : { replaceFileId: existingManifest.id }),
    },
    ctx.signal,
  );

  // The state recorded here is what later authorises deleting the local copy.
  // It comes from the stat taken immediately after the bundle was proved to
  // match the disk, so it describes exactly what Drive now holds.
  const supersededId = previous?.remoteFileId ?? null;

  markVerified(
    ctx.db,
    session.sessionId,
    {
      fileId: remote.id,
      path: `${folderPath.join('/')}/${bundle.name}`,
      localMtime: Math.trunc(confirmed.mtimeMs),
      localBytes: archivedBytes,
      transcriptBytes: archivedTranscript,
      sidecarBytes: archivedSidecar,
      bundleBytes: bundle.bytes,
      bundleSha256: bundle.sha256,
      manifest: encodeManifest(files),
      // From the same hashing pass that verifyBundleContents checked the
      // bundle against, so it describes the archived bytes. Hashing the file
      // separately opens a window in which a live session appends between the
      // hash and the read, leaving a row that verifies but cannot be restored.
      transcriptSha256:
        files.find((file) => file.path === `${session.sessionId}.jsonl`)?.sha256 ?? null,
    },
    ctx.clock.now(),
  );

  // Only now, with the replacement verified and recorded, is the previous
  // bundle safe to retire. Failing to remove it wastes space and loses nothing.
  const sameProject = previous?.encodedDir === session.encodedDir;
  // The shrink guard should already have stopped anything smaller reaching
  // here. This is the second lock on the door: retiring the previous archive is
  // the one remaining act in this codebase that can make data unrecoverable.
  // Retiring the previous archive is the only operation left in this codebase
  // that can make data unrecoverable, so it demands proof that the new bundle
  // contains the old one — not merely that it is bigger. Three integer
  // comparisons let one sidecar file be swapped for a larger one, and the
  // archived subagent transcript then existed nowhere.
  const contains = await describeContainment(ctx, session, previous, files);
  if (contains !== null) {
    ctx.logger.warn('backup.superseded_kept', {
      session_id: session.sessionId,
      file_id: supersededId ?? '',
      reason: contains,
    });
  }
  if (supersededId !== null && supersededId !== remote.id && sameProject && contains === null) {
    try {
      // Trashed, not deleted. This bundle was a good archive a moment ago, and
      // every chain that has destroyed data in this codebase ended with a
      // permanent delete of something that turned out to be the only copy.
      await ctx.drive.trashFile(supersededId, ctx.signal);
    } catch (err) {
      ctx.logger.warn('backup.superseded_cleanup_failed', { file_id: supersededId }, err);
    }
  }
  return remote;
}

/**
 * The last link in the integrity chain (ARCHITECTURE §6).
 *
 * A mismatch deletes the remote copy and requeues rather than papering over it:
 * a wrong file on Drive is worse than no file, because a wrong file would later
 * authorise deleting the good local one.
 */
export async function verifyRemote(
  ctx: WorkerContext,
  sessionId: string,
  uploaded: RemoteFile,
  bundle: { bytes: number; sha256: string; md5: string },
): Promise<void> {
  let meta = await ctx.drive.getFile(uploaded.id, ctx.signal);
  let problem = compareChecksums(meta, bundle);
  if (problem === null) return;

  // Drive computes checksums asynchronously, so a read taken immediately after
  // an upload can legitimately come back without one. Ask a second time before
  // concluding the file is wrong, because the conclusion deletes it.
  if (meta.sha256 === null && meta.md5 === null) {
    await ctx.clock.sleep(2_000);
    meta = await ctx.drive.getFile(uploaded.id, ctx.signal);
    problem = compareChecksums(meta, bundle);
    if (problem === null) return;
  }

  ctx.logger.error('backup.verification_failed', { session_id: sessionId, reason: problem });
  clearVerification(ctx.db, sessionId, ctx.clock.now());
  // Trashed, not deleted. uploadWithResume can hand back a *pre-existing*
  // file it found by name, so "the file this run just created" is not always
  // true, and a permanent delete would be unrecoverable if it were the copy
  // remote_file_id still points at.
  await ctx.drive.trashFile(uploaded.id, ctx.signal).catch(() => undefined);
  throw new RetryableError(`Drive copy did not match the local bundle: ${problem}`);
}

/** Returns null when the remote copy is provably ours, or a reason when not. */
/**
 * Would archiving these sizes replace the copy on Drive with a smaller one?
 *
 * Returns a description of what shrank, or null when nothing did. Every
 * comparison is against a column written only by markVerified, so the answer
 * does not change just because an earlier step of this attempt rewrote the
 * row — which is how the two previous versions of this guard became one-shots.
 */
/**
 * Do we know how big every part of the archived copy is?
 *
 * A missing measurement means "unknown", never "smaller than this". Retiring a
 * bundle on the strength of a floor we do not have is how a complete archive
 * ends up in the wastebasket with nothing pointing at it.
 */
/** `[[path, sha256], …]`, the compact form stored on the row. */
export function encodeManifest(files: ManifestFile[]): string {
  return JSON.stringify(files.map((file) => [file.path, file.sha256]));
}

export function decodeManifest(encoded: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (encoded === null) return out;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        out.set(entry[0], entry[1]);
      }
    }
  } catch {
    // A row written by something else, or corrupted: treated as "unknown",
    // which the caller reads as "do not retire".
  }
  return out;
}

/**
 * Is everything the archived bundle held still present in what we just built?
 *
 * Returns null when containment is proved, or a reason when it is not. Every
 * uncertainty is a reason: an unknown manifest, an unreadable prefix, a missing
 * hash. The cost of refusing is a bundle left on Drive; the cost of a wrong yes
 * is the only copy of a conversation.
 */
export async function describeContainment(
  ctx: WorkerContext,
  session: LocalSession,
  previous: SessionRecord | null,
  files: ManifestFile[],
): Promise<string | null> {
  if (!hasAllFloors(previous) || previous === null)
    return 'the archived copy is not fully described';

  const archived = decodeManifest(previous.verifiedManifest);
  if (archived.size === 0) return 'the archived file list is not recorded';

  const current = new Map(files.map((file) => [file.path, file.sha256]));
  const transcript = `${session.sessionId}.jsonl`;

  for (const [entryPath, hash] of archived) {
    if (entryPath === transcript) continue;
    const now = current.get(entryPath);
    if (now === undefined) return `${entryPath} is no longer present`;
    if (now !== hash) return `${entryPath} has different content`;
  }

  // The transcript is allowed to have grown, and only to have grown: its first
  // N bytes must still hash to what was archived.
  const floor = previous.verifiedTranscriptBytes;
  const expected = previous.verifiedTranscriptSha256;
  if (floor === null || expected === null) return 'the archived transcript is not described';
  const prefix = await sha256Prefix(session.transcriptPath, floor, ctx.signal);
  if (prefix === null) return 'the transcript is shorter than the archived one';
  if (prefix !== expected) return 'the transcript no longer begins with the archived content';
  return null;
}

export function hasAllFloors(previous: SessionRecord | null): boolean {
  return (
    previous?.verifiedTranscriptBytes != null &&
    previous.verifiedSidecarBytes !== null &&
    previous.verifiedLocalBytes !== null &&
    previous.verifiedTranscriptSha256 !== null
  );
}

export function describeShrink(
  previous: SessionRecord | null,
  now: { transcript: number; sidecar: number; total: number },
): string | null {
  if (previous?.remoteFileId == null) return null;
  const complaints: string[] = [];
  const check = (label: string, floor: number | null, current: number): void => {
    if (floor !== null && current < floor) {
      complaints.push(`${label} ${String(current)} bytes, archived ${String(floor)}`);
    }
  };
  check('transcript', previous.verifiedTranscriptBytes, now.transcript);
  check('sidecar', previous.verifiedSidecarBytes, now.sidecar);
  check('total', previous.verifiedLocalBytes, now.total);
  return complaints.length === 0 ? null : complaints.join('; ');
}

export function compareChecksums(
  remote: RemoteFile,
  bundle: { bytes: number; sha256: string; md5: string },
): string | null {
  if (remote.size !== null && remote.size !== bundle.bytes) {
    return `size ${String(remote.size)} != ${String(bundle.bytes)}`;
  }
  if (remote.sha256 !== null) {
    return remote.sha256.toLowerCase() === bundle.sha256.toLowerCase() ? null : 'sha256 mismatch';
  }
  if (remote.md5 !== null) {
    return remote.md5.toLowerCase() === bundle.md5.toLowerCase() ? null : 'md5 mismatch';
  }
  // No checksum means no verification, and no verification means we must never
  // delete the local copy. Treat it as a failure rather than a pass.
  return 'Drive returned no checksum';
}
