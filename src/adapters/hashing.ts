import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BugError } from '../core/errors.ts';

/**
 * Integrity primitives (ARCHITECTURE §6, "integrity chain").
 *
 * Everything here produces lowercase hex, the same form Drive returns in
 * `sha256Checksum` and `md5Checksum`, so comparisons are plain string equality.
 */

export type HashAlgorithm = 'sha256' | 'md5';

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const options = signal === undefined ? {} : { signal };
  await pipeline(createReadStream(file), hash, options);
  return hash.digest('hex');
}

export type HashTee = {
  /** Pass-through stream: put it in the pipeline where the bytes flow. */
  readonly stream: Transform;
  /** Valid only after the pipeline has finished. */
  digest(algorithm?: HashAlgorithm): string;
  /** Bytes seen so far. */
  bytes(): number;
};

/**
 * Hash the exact bytes being written, as they are written.
 *
 * Hashing the file afterwards would describe a *different* read of the disk;
 * this describes the write. When the two disagree, the disk is lying, and that
 * is precisely the failure the integrity chain exists to catch.
 *
 * md5 is computed alongside sha256 because Drive does not return
 * `sha256Checksum` for every file, and a verification we cannot perform is a
 * session we may never delete locally.
 */
export function createHashTee(algorithms: HashAlgorithm[] = ['sha256', 'md5']): HashTee {
  const hashes = new Map<HashAlgorithm, Hash>();
  for (const algorithm of algorithms) hashes.set(algorithm, createHash(algorithm));
  const digests = new Map<HashAlgorithm, string>();
  let seen = 0;

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const hash of hashes.values()) hash.update(chunk);
      seen += chunk.length;
      callback(null, chunk);
    },
  });

  return {
    stream,
    digest: (algorithm = 'sha256') => {
      const cached = digests.get(algorithm);
      if (cached !== undefined) return cached;
      const hash = hashes.get(algorithm);
      if (hash === undefined) throw new BugError(`hash tee was not built for ${algorithm}`);
      const value = hash.digest('hex');
      digests.set(algorithm, value);
      return value;
    },
    bytes: () => seen,
  };
}

export function sha256OfBuffer(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function md5OfBuffer(data: Uint8Array | string): string {
  return createHash('md5').update(data).digest('hex');
}

/**
 * Hash the first `bytes` of a file.
 *
 * Used to prove a transcript still begins with the content that was archived:
 * an append-only file that grew is an extension of its archive, and one that
 * was rewritten is not. Sizes cannot tell those apart.
 */
export async function sha256Prefix(
  file: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (bytes <= 0) return null;
  const handle = await fsp.open(file, 'r');
  try {
    // In chunks. A transcript can be hundreds of megabytes, and allocating the
    // whole prefix meant a matching spike on every re-archive — and, past
    // buffer.constants.MAX_LENGTH, a throw that arrives after markVerified and
    // re-bundles the entire session on every retry.
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(bytes, 1024 * 1024));
    let read = 0;
    while (read < bytes) {
      signal?.throwIfAborted();
      const want = Math.min(buffer.length, bytes - read);
      const { bytesRead } = await handle.read(buffer, 0, want, read);
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
