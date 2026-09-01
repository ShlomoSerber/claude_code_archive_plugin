import fsp from 'node:fs/promises';
import { UploadSessionExpired, RetryableError, FatalError } from '../core/errors.ts';
import { setUploadUri, type Job } from '../core/queue.ts';
import { CHUNK_SIZE, alignChunkSize } from '../adapters/drive-http.ts';
import type { RemoteFile } from '../ports/drive.ts';
import type { WorkerContext } from './context.ts';

/**
 * Resumable upload with the session URI held in the job row (ARCHITECTURE §6).
 *
 * The rule that shapes everything here: never assume the last chunk landed.
 * After any interruption we ask Drive how much it holds and continue from
 * *its* answer, because the alternative — trusting our own memory of what we
 * sent — is how an upload silently loses a range in the middle.
 */

export type UploadArgs = {
  job: Job;
  filePath: string;
  name: string;
  parentId: string;
  mimeType: string;
  totalBytes: number;
  sha256: string;
  /** Fallback hash, for a Drive that answers with md5 and nothing else. */
  md5?: string;
  appProperties?: Record<string, string>;
  chunkSize?: number;
};

/** Attempts at a same-named remote Drive will not vouch for, before we stop. */
const UNKNOWN_CHECKSUM_LIMIT = 8;

export async function uploadWithResume(ctx: WorkerContext, args: UploadArgs): Promise<RemoteFile> {
  const log = ctx.logger.child({ session_id: args.job.sessionId ?? '', name: args.name });
  const chunkSize = alignChunkSize(args.chunkSize ?? CHUNK_SIZE);

  // The URI is stored tagged with the hash of the bundle it was opened for.
  // Resuming one against different bytes produces a file that is neither.
  const stored = parseUploadUri(args.job.uploadUri);
  let uploadUri = stored !== null && stored.sha256 === args.sha256 ? stored.uri : null;
  if (stored !== null && uploadUri === null) {
    log.info('upload.uri_belongs_to_another_bundle');
    setUploadUri(ctx.db, args.job, null, ctx.clock.now());
  }
  let confirmed = 0;

  if (uploadUri !== null) {
    const progress = await ctx.drive.probeUpload(
      { uploadUri, totalBytes: args.totalBytes },
      ctx.signal,
    );
    if (progress === null) {
      // Sessions expire after about a week; start over rather than guess.
      log.info('upload.session_expired');
      uploadUri = null;
      setUploadUri(ctx.db, args.job, null, ctx.clock.now());
    } else if (progress.done && progress.file !== null) {
      // "Complete" only counts if what landed is what we are uploading.
      // Our own resumable URI is tagged with this bundle's hash, so a
      // completed upload at it is ours even when Drive cannot yet say so.
      if (matchesLocal(progress.file, args) !== 'mismatch') {
        log.info('upload.already_complete');
        setUploadUri(ctx.db, args.job, null, ctx.clock.now());
        return progress.file;
      }
      log.warn('upload.complete_but_mismatched', { file_id: progress.file.id });
      uploadUri = null;
      setUploadUri(ctx.db, args.job, null, ctx.clock.now());
    } else {
      confirmed = progress.confirmedBytes;
      log.info('upload.resuming', { confirmed_bytes: confirmed });
    }
  }

  if (uploadUri === null) {
    // Check before create: a previous run may have finished the upload and died
    // before recording it. Re-uploading would leave two files with one name.
    const existing = await ctx.drive.findFile(
      { name: args.name, parentId: args.parentId },
      ctx.signal,
    );
    const verdict = existing === null ? 'mismatch' : matchesLocal(existing, args);
    if (existing !== null && verdict === 'match') {
      log.info('upload.found_existing', { file_id: existing.id });
      return existing;
    }
    if (existing !== null && verdict === 'unknown') {
      // Leave it alone. Drive has not answered the question yet, and the only
      // destructive options here — trash it, or overwrite it — are both wrong
      // if the answer turns out to be "that is your archive".
      //
      // A retryable error never blocks, and its backoff window is short, so a
      // Drive that will never answer wedged this session with /archive:status
      // showing nothing wrong. After enough attempts it becomes a fault with a
      // name and a remediation.
      if (args.job.attempts >= UNKNOWN_CHECKSUM_LIMIT) {
        throw new FatalError(
          `Drive has never reported a checksum for the existing ${args.name}`,
          "Check that file in Drive: if it is not this session's bundle, move it to " +
            'the wastebasket and run /archive:now.',
        );
      }
      throw new RetryableError(
        `Drive has not reported a checksum for the existing ${args.name}; leaving it alone`,
      );
    }
    if (existing !== null) {
      // A name carries a hash of its contents, so a same-name mismatch means
      // the bytes on Drive are not what they claim to be — bit rot, or a
      // half-written upload. Refusing outright made that permanent: every
      // retry regenerates the same name and collides again, so the session
      // could never be archived and the advice /archive:verify prints was a
      // loop. Move the impostor to the wastebasket, where it stays recoverable
      // for thirty days, and upload the real thing.
      log.warn('upload.trashing_mismatched_remote', { file_id: existing.id });
      await ctx.drive.trashFile(existing.id, ctx.signal);
    }

    uploadUri = await ctx.drive.startResumableUpload(
      {
        name: args.name,
        parentId: args.parentId,
        mimeType: args.mimeType,
        totalBytes: args.totalBytes,
        // Stamped on the file so an audit can verify it without local state.
        appProperties: { sha256: args.sha256, ...args.appProperties },
      },
      ctx.signal,
    );
    // Persisted before a single byte is sent: this URI is the idempotency key.
    setUploadUri(ctx.db, args.job, tagUploadUri(uploadUri, args.sha256), ctx.clock.now());
    confirmed = 0;
  }

  const handle = await fsp.open(args.filePath, 'r');
  try {
    while (confirmed < args.totalBytes) {
      ctx.signal?.throwIfAborted();
      const length = Math.min(chunkSize, args.totalBytes - confirmed);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, confirmed);
      if (bytesRead !== length) {
        throw new RetryableError(
          `the bundle shrank while uploading: wanted ${String(length)} bytes at ${String(confirmed)}`,
        );
      }

      let progress;
      try {
        progress = await ctx.drive.uploadChunk(
          { uploadUri, body: buffer, offset: confirmed, totalBytes: args.totalBytes },
          ctx.signal,
        );
      } catch (err) {
        if (err instanceof UploadSessionExpired) {
          setUploadUri(ctx.db, args.job, null, ctx.clock.now());
          throw new RetryableError('the upload session expired mid-transfer', { cause: err });
        }
        throw err;
      }

      if (progress.done && progress.file !== null) {
        setUploadUri(ctx.db, args.job, null, ctx.clock.now());
        return progress.file;
      }
      if (progress.confirmedBytes <= confirmed) {
        // Drive accepted nothing. Retrying the same chunk forever is a hot loop.
        throw new RetryableError(
          `Drive confirmed no progress past ${String(confirmed)} of ${String(args.totalBytes)} bytes`,
        );
      }
      confirmed = progress.confirmedBytes;
      log.debug('upload.progress', { confirmed_bytes: confirmed, total_bytes: args.totalBytes });
    }
  } finally {
    await handle.close();
  }

  throw new RetryableError('the upload finished without Drive returning the file');
}

/**
 * Does a file already on Drive match the bundle we were about to upload?
 *
 * Size alone is not enough — two different bundles can be the same length — so
 * a checksum must agree. When Drive gives us neither checksum, we treat the
 * remote as unknown and replace it.
 */
/** `<bundle sha256>|<uri>`, so a stored URI can never outlive its bundle. */
export function tagUploadUri(uri: string, sha256: string): string {
  return `${sha256}|${uri}`;
}

export function parseUploadUri(stored: string | null): { sha256: string; uri: string } | null {
  if (stored === null) return null;
  const separator = stored.indexOf('|');
  // An untagged value predates this format and cannot be trusted to a bundle.
  if (separator <= 0) return null;
  return { sha256: stored.slice(0, separator), uri: stored.slice(separator + 1) };
}

/**
 * Is the file on Drive the one we are about to upload?
 *
 * Three answers, not two. 'unknown' is the whole point: Drive computes
 * checksums asynchronously and documents sha256Checksum as present only "if
 * available", so a read can legitimately come back with neither hash. Folding
 * that into 'mismatch' meant a transient metadata glitch was read as bit rot,
 * and the caller trashed a good, verified archive on the strength of it.
 */
export function matchesLocal(
  remote: RemoteFile,
  args: { totalBytes: number; sha256: string; md5?: string },
): 'match' | 'mismatch' | 'unknown' {
  if (remote.size !== null && remote.size !== args.totalBytes) return 'mismatch';
  if (remote.sha256 !== null) {
    return remote.sha256.toLowerCase() === args.sha256.toLowerCase() ? 'match' : 'mismatch';
  }
  if (remote.md5 !== null && args.md5 !== undefined) {
    return remote.md5.toLowerCase() === args.md5.toLowerCase() ? 'match' : 'mismatch';
  }
  return 'unknown';
}
