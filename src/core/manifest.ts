/**
 * The manifest that ships beside every bundle (SPEC §8).
 *
 * It exists so a bundle stays recoverable with `tar` and `zstd` alone, without
 * this plugin and without the catalog. Everything needed to put a session back
 * where it came from is in here.
 */

export const MANIFEST_VERSION = 1;

export type ManifestFile = {
  /** Path inside the tar, always `/`-separated and relative. */
  path: string;
  bytes: number;
  sha256: string;
};

export type BundleManifest = {
  manifestVersion: number;
  archiverVersion: string;
  sessionId: string;
  /** The directory Claude Code encoded, verbatim, since the encoding is lossy. */
  projectCwd: string | null;
  encodedDir: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  bundle: {
    name: string;
    sha256: string;
    bytes: number;
    compression: 'zstd';
    compressionLevel: number;
  };
  files: ManifestFile[];
  uncompressedBytes: number;
};

export function buildManifest(args: {
  archiverVersion: string;
  sessionId: string;
  projectCwd: string | null;
  encodedDir: string;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  bundleName: string;
  bundleSha256: string;
  bundleBytes: number;
  compressionLevel: number;
  files: ManifestFile[];
}): BundleManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    archiverVersion: args.archiverVersion,
    sessionId: args.sessionId,
    projectCwd: args.projectCwd,
    encodedDir: args.encodedDir,
    title: args.title,
    startedAt: toIso(args.startedAt),
    endedAt: toIso(args.endedAt),
    createdAt: new Date(args.createdAt).toISOString(),
    bundle: {
      name: args.bundleName,
      sha256: args.bundleSha256,
      bytes: args.bundleBytes,
      compression: 'zstd',
      compressionLevel: args.compressionLevel,
    },
    files: args.files,
    uncompressedBytes: args.files.reduce((total, file) => total + file.bytes, 0),
  };
}

function toIso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

/** Parse a manifest defensively; a corrupt one must not throw mid-restore. */
export function parseManifest(text: string): BundleManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<BundleManifest>;
  if (typeof candidate.sessionId !== 'string' || typeof candidate.encodedDir !== 'string') {
    return null;
  }
  return candidate as BundleManifest;
}
