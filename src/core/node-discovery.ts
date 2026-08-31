import { compareVersions, MIN_NODE_VERSION } from './runtime-check.ts';

/**
 * Choosing a usable Node interpreter (pure half).
 *
 * Claude Code launches a hook with whatever `node` is on PATH, which is
 * regularly not the newest one installed. Every mainstream version manager
 * writes the version into the install path, so most candidates can be ranked
 * without executing anything.
 */

export type NodeCandidate = {
  path: string;
  /** Parsed from the path when the layout encodes it, else null. */
  version: string | null;
};

/** `.../v22.16.0/bin/node` and `.../22.16.0/bin/node` both yield `22.16.0`. */
export function versionFromPath(candidatePath: string): string | null {
  const segments = candidatePath.split(/[\\/]/);
  // Last match wins: `~/.nvm/versions/node/v22.16.0/bin/node` has only one, but
  // a path containing a versioned parent directory should not outrank it.
  for (let index = segments.length - 1; index >= 0; index--) {
    const match = /^v?(\d+\.\d+\.\d+)$/.exec(segments[index] ?? '');
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Rank candidates best-first.
 *
 * Ones whose version is known and too old are dropped outright. Ones with an
 * unknown version are kept, but last: they cost a process spawn to check, and
 * that is the expense worth deferring.
 */
export function rankCandidates(
  candidates: NodeCandidate[],
  minVersion: string = MIN_NODE_VERSION,
): NodeCandidate[] {
  const known: NodeCandidate[] = [];
  const unknown: NodeCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    if (candidate.version === null) {
      unknown.push(candidate);
    } else if (compareVersions(candidate.version, minVersion) >= 0) {
      known.push(candidate);
    }
  }

  // Newest first: a machine with 22.16 and 24 should get 24.
  known.sort((a, b) => compareVersions(b.version ?? '0', a.version ?? '0'));
  return [...known, ...unknown];
}

export function satisfiesFloor(version: string, minVersion: string = MIN_NODE_VERSION): boolean {
  return compareVersions(version, minVersion) >= 0;
}
