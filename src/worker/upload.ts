import fsp from 'node:fs/promises';
import { UploadSessionExpired, RetryableError } from '../core/errors.ts';
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
  appProperties?: Record<string, string>;
  chunkSize?: number;
};

export async function uploadWithResume(ctx: WorkerContext, args: UploadArgs): Promise<RemoteFile> {
  const log = ctx.logger.child({ session_id: args.job.sessionId ?? '', name: args.name });
  const chunkSize = alignChunkSize(args.chunkSize ?? CHUNK_SIZE);

  let uploadUri = args.job.uploadUri;
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
      log.info('upload.already_complete');
      return progress.file;
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
    if (existing !== null && matchesLocal(existing, args)) {
      log.info('upload.found_existing', { file_id: existing.id });
      return existing;
    }
    if (existing !== null) {
      // Refuse rather than replace. This used to delete the remote file and
      // then upload — permanently, since Drive's DELETE bypasses the
      // wastebasket — which meant an interrupted upload destroyed the archived
      // copy and left nothing. Bundle names now carry a hash of their contents,
      // so a same-name mismatch is a genuine anomaly rather than the ordinary
      // case of a session that changed.
      throw new RetryableError(
        `a different file already exists on Drive as ${args.name}; refusing to replace it`,
      );
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
    setUploadUri(ctx.db, args.job, uploadUri, ctx.clock.now());
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
export function matchesLocal(
  remote: RemoteFile,
  args: { totalBytes: number; sha256: string },
): boolean {
  if (remote.size !== null && remote.size !== args.totalBytes) return false;
  if (remote.sha256 !== null) return remote.sha256.toLowerCase() === args.sha256.toLowerCase();
  return false;
}
