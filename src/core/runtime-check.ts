/**
 * Node version guard.
 *
 * Claude Code runs a plugin hook with whatever `node` resolves to on the user's
 * PATH, which is often not the newest one they have installed. On anything
 * below 22.16 there is no `node:sqlite`, and because hooks swallow every error
 * to protect the session, the plugin would archive nothing and say nothing.
 *
 * Failing loudly at the one place it is safe to be loud is the whole point of
 * this module.
 */

export const MIN_NODE_VERSION = '22.16.0';

export const NODE_REMEDIATION =
  `Install Node ${MIN_NODE_VERSION} or newer (24 LTS recommended) and make sure the ` +
  '`node` on your PATH is that version — Claude Code runs plugin hooks with whatever ' +
  '`node` resolves to, not with the newest version installed.';

/** A human-readable problem, or null when this runtime is supported. */
export function nodeVersionProblem(version: string = process.versions.node): string | null {
  const comparison = compareVersions(version, MIN_NODE_VERSION);
  // 22.16.0-pre is 22.16.0 minus whatever landed last, and what landed in
  // 22.16.0 is sqlite.backup(), which this plugin needs.
  if (comparison > 0 || (comparison === 0 && !version.includes('-'))) return null;
  return `the archive plugin needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${version}`;
}

/** Numeric compare of dotted versions; any pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function parts(version: string): number[] {
  const core = version.replace(/^v/, '').split('-')[0] ?? '';
  return core.split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}
