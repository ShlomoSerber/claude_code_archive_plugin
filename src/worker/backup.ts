import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBundle, describeSessionFiles } from '../adapters/bundle.ts';
import { bundleEntries, statSession, type LocalSession } from '../adapters/session-scan.ts';
import { extractFromFile } from '../adapters/transcript-file.ts';
import { sha256File } from '../adapters/hashing.ts';
import {
  markBundled,
  markVerified,
  clearVerification,
  replaceFiles,
  replacePrompts,
  upsertSession,
} from '../core/catalog.ts';
import { RetryableError } from '../core/errors.ts';
import { buildManifest } from '../core/manifest.ts';
import { bundleBaseName, isoDate, isoYear } from '../core/slug.ts';
import type { Job } from '../core/queue.ts';
import type { RemoteFile } from '../ports/drive.ts';
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

  const now = ctx.clock.now();
  const summary = await indexSession(ctx, session, now);
  const bundle = await buildBundle(ctx, session, summary, now);

  try {
    const remote = await publish(ctx, job, session, bundle, summary, now);
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
  const base = bundleBaseName({ date, title, sessionId: session.sessionId });
  const name = `${base}.tar.zst`;
  const outputPath = path.join(ctx.paths.stagingDir, name);

  const result = await createBundle({
    cwd: path.dirname(session.transcriptPath),
    entries: bundleEntries(session),
    outputPath,
    compressionLevel: ctx.config.zstdLevel,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

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
  now: number,
): Promise<RemoteFile> {
  const folderPath = [ctx.config.driveRootFolder, session.encodedDir, bundle.year];
  const parentId = await ctx.drive.ensureFolder(folderPath, ctx.signal);

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

  const files = await describeSessionFiles({
    cwd: path.dirname(session.transcriptPath),
    entries: bundleEntries(session),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
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

  // The state recorded here is what the reaper will later compare the disk
  // against. It must describe the files this bundle was actually made from, so
  // it is taken from the same stat the bundling used, not from a fresh one.
  markVerified(
    ctx.db,
    session.sessionId,
    {
      fileId: remote.id,
      path: `${folderPath.join('/')}/${bundle.name}`,
      localMtime: Math.trunc(session.mtimeMs),
      localBytes: session.transcriptBytes + session.sidecarBytes,
    },
    ctx.clock.now(),
  );
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
  const meta = await ctx.drive.getFile(uploaded.id, ctx.signal);
  const problem = compareChecksums(meta, bundle);
  if (problem === null) return;

  ctx.logger.error('backup.verification_failed', { session_id: sessionId, reason: problem });
  clearVerification(ctx.db, sessionId, ctx.clock.now());
  await ctx.drive.deleteFile(uploaded.id, ctx.signal).catch(() => undefined);
  throw new RetryableError(`Drive copy did not match the local bundle: ${problem}`);
}

/** Returns null when the remote copy is provably ours, or a reason when not. */
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
