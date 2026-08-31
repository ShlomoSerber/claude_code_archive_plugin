import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { renameWithRetry, siblingTempPath } from './atomic.ts';
import { createHashTee, sha256File } from './hashing.ts';
import type { ManifestFile } from '../core/manifest.ts';

/**
 * Bundling (ARCHITECTURE §5): one session becomes one `.tar.zst`.
 *
 * The bundle is written to a `.partial` sibling and renamed only once the
 * bytes are on disk. An interrupted bundle is therefore never mistaken for a
 * finished one, and rebuilding it is cheap enough that resuming a half-written
 * zstd stream is not worth attempting.
 */

export const DEFAULT_ZSTD_LEVEL = 19;

/**
 * node-tar refuses to read an archive that expands more than 1000:1, as a
 * defence against archives from strangers. Every archive read here is one this
 * plugin created moments earlier from the user's own files.
 *
 * Leaving the default on meant a highly compressible session — a short parent
 * transcript with a large sidecar of repeated build output — bundled fine and
 * was then unreadable by the code that has to read it back, so the session
 * could never be archived and nothing said so.
 */
const TAR_READ_OPTIONS = { maxDecompressionRatio: Infinity } as const;

export type BundleInput = {
  /** Directory the tar paths are relative to: the encoded project directory. */
  cwd: string;
  /** Entries relative to `cwd`, `/`-separated. Directories are added whole. */
  entries: string[];
  outputPath: string;
  compressionLevel?: number;
  signal?: AbortSignal;
};

export type BundleResult = {
  path: string;
  bytes: number;
  sha256: string;
  /** Drive does not return sha256 for every file, so md5 is the fallback. */
  md5: string;
  compressionLevel: number;
};

export async function createBundle(input: BundleInput): Promise<BundleResult> {
  const level = input.compressionLevel ?? DEFAULT_ZSTD_LEVEL;
  await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
  const temp = siblingTempPath(input.outputPath);
  const tee = createHashTee();

  try {
    const pack = tar.create(
      {
        cwd: input.cwd,
        // Portable mode drops uid/gid/atime, so the same session bundles to the
        // same bytes on macOS, Windows and Linux.
        portable: true,
        follow: false,
        noDirRecurse: false,
      },
      input.entries,
    );
    const compress = zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
    });
    const sink = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
    const options = input.signal === undefined ? {} : { signal: input.signal };
    await pipeline(pack, compress, tee.stream, sink, options);
    await fsyncPath(temp);
    await renameWithRetry(temp, input.outputPath);
    return {
      path: input.outputPath,
      bytes: tee.bytes(),
      sha256: tee.digest('sha256'),
      md5: tee.digest('md5'),
      compressionLevel: level,
    };
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function fsyncPath(file: string): Promise<void> {
  // Reopened read-write: on Windows, flushing buffers needs write access.
  const handle = await fsp.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type ExtractResult = {
  entries: string[];
  /** Entries refused by `onlySession`, for the caller to log. */
  rejected: string[];
};

/**
 * Unpack a bundle into `targetDir`.
 *
 * tar's absolute-path and `..` protections stay at their defaults; the pinned
 * 7.5.x is the reason those defaults can be trusted.
 */
export async function extractBundle(args: {
  bundlePath: string;
  targetDir: string;
  /**
   * Unpack only this session's own files.
   *
   * The target is a project directory shared with every other session of that
   * project, so without a filter a bundle carrying a neighbour's transcript
   * overwrites it. tar's traversal defences stop a path leaving the
   * directory; nothing stops it landing on the wrong file inside it.
   */
  onlySession?: string;
  signal?: AbortSignal;
}): Promise<ExtractResult> {
  await fsp.mkdir(args.targetDir, { recursive: true });
  const entries: string[] = [];
  const rejected: string[] = [];
  await tar.extract({
    ...TAR_READ_OPTIONS,
    file: args.bundlePath,
    cwd: args.targetDir,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    filter: (entryPath) => {
      if (args.onlySession === undefined) return true;
      if (belongsToSession(entryPath, args.onlySession)) return true;
      rejected.push(entryPath);
      return false;
    },
    onReadEntry: (entry) => {
      entries.push(entry.path);
    },
  });
  return { entries, rejected };
}

/** `<id>.jsonl`, `<id>` or anything beneath `<id>/`, and nothing else. */
export function belongsToSession(entryPath: string, sessionId: string): boolean {
  const normalized = toPosix(entryPath).replace(/^\.\//, '').replace(/\/$/, '');
  return (
    normalized === `${sessionId}.jsonl` ||
    normalized === sessionId ||
    normalized.startsWith(`${sessionId}/`)
  );
}

/** List what a bundle contains without writing anything. */
export async function listBundle(bundlePath: string): Promise<{ path: string; size: number }[]> {
  const entries: { path: string; size: number }[] = [];
  await tar.list({
    ...TAR_READ_OPTIONS,
    file: bundlePath,
    onReadEntry: (entry) => {
      entries.push({ path: entry.path, size: entry.size });
    },
  });
  return entries;
}

/**
 * Walk the files that make up a session and hash each one.
 *
 * These hashes go in the manifest, so a bundle can be audited against its own
 * contents years later without the catalog.
 */
export async function describeSessionFiles(args: {
  cwd: string;
  entries: string[];
  signal?: AbortSignal;
}): Promise<ManifestFile[]> {
  const described: ManifestFile[] = [];
  for (const entry of args.entries) {
    // Top level only: a session with no sidecar directory is normal.
    await describeInto(described, args.cwd, entry, args.signal, true);
  }
  described.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return described;
}

async function describeInto(
  out: ManifestFile[],
  cwd: string,
  relative: string,
  signal: AbortSignal | undefined,
  optional = false,
): Promise<void> {
  const absolute = path.join(cwd, relative);
  let stat: fs.Stats;
  try {
    // lstat, not stat: tar is configured not to follow links, so following one
    // here would put a file in the manifest that the bundle does not contain,
    // and the content check would then disagree with itself forever.
    stat = await fsp.lstat(absolute);
  } catch (err) {
    // Silently dropping an unreadable file would produce a manifest that omits
    // it, and the manifest is what the bundle is checked against — so the
    // bundle would then verify as complete while missing data.
    //
    // `optional` means "this entry need not exist", not "any failure is fine":
    // a session with no sidecar is ordinary, a sidecar we cannot read is not.
    if (optional && (err as { code?: string }).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isFile()) {
    out.push({
      path: toPosix(relative),
      bytes: stat.size,
      sha256: await sha256File(absolute, signal),
    });
    return;
  }
  if (!stat.isDirectory()) return;
  const children = await fsp.readdir(absolute);
  for (const child of children) {
    await describeInto(out, cwd, path.join(relative, child), signal);
  }
}

/** tar paths are always `/`-separated, on every platform. */
export function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * Prove a finished bundle actually contains the session.
 *
 * The integrity chain up to this point compares a local hash with the remote's
 * hash, which proves the *transfer* and says nothing about the *contents*. A
 * bundle that is intact but wrong — the wrong session, a truncated sidecar, an
 * empty archive — would pass every other check and then authorise deleting the
 * only real copy.
 *
 * Reads the bundle back and hashes each entry, comparing against the manifest.
 * Returns null when the bundle is what it claims to be, or a reason when not.
 */
export async function verifyBundleContents(
  bundlePath: string,
  expected: ManifestFile[],
): Promise<string | null> {
  const wanted = new Map(expected.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const problems: string[] = [];

  await tar.list({
    ...TAR_READ_OPTIONS,
    file: bundlePath,
    onReadEntry: (entry) => {
      const entryPath = toPosix(entry.path).replace(/\/$/, '');
      const want = wanted.get(entryPath);
      if (want === undefined) {
        // Directories carry no bytes and are not in the manifest.
        entry.resume();
        return;
      }
      seen.add(entryPath);
      const hash = createHash('sha256');
      let bytes = 0;
      entry.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      entry.on('end', () => {
        if (bytes !== want.bytes) {
          problems.push(`${entryPath}: ${String(bytes)} bytes, expected ${String(want.bytes)}`);
        } else if (hash.digest('hex') !== want.sha256) {
          problems.push(`${entryPath}: content does not match its hash`);
        }
      });
    },
  });

  for (const file of expected) {
    if (!seen.has(file.path)) problems.push(`${file.path}: missing from the bundle`);
  }
  return problems.length === 0 ? null : problems.slice(0, 5).join('; ');
}
