import path from 'node:path';
import { BugError } from './errors.ts';

/**
 * Validation for the two strings that become filesystem paths.
 *
 * A session id comes from a filename on disk, and an encoded project directory
 * can come from a catalog downloaded off Drive. Both are joined into paths that
 * the reaper deletes recursively. `path.join` resolves `..`, so an unchecked
 * id of `..` turns a per-session delete into a delete of the whole projects
 * tree. Nothing downstream may assume these strings are well formed.
 */

/**
 * Conservative, but it has to admit the names Claude Code actually writes.
 *
 * Encoded project directories always begin with a dash, because the leading
 * slash of an absolute path encodes to one: `/home/a/shop` becomes
 * `-home-a-shop`. A leading dash is therefore normal and safe. A leading dot
 * is not: it is what `.` and `..` start with, and those are the values that
 * escape the directory.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,190}$/;

export function isSafePathSegment(value: string): boolean {
  if (!SAFE_SEGMENT.test(value)) return false;
  // Belt and braces: the pattern already excludes these, and they are the
  // failures that matter, so check them explicitly rather than by inference.
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return true;
}

export const isSafeSessionId = isSafePathSegment;
export const isSafeEncodedDir = isSafePathSegment;

/**
 * Refuse to act on a path that escaped where it was supposed to be.
 *
 * The last line of defence before a delete or an unpack: even if validation
 * upstream is wrong, the resolved target still has to sit inside its root.
 */
export function assertInside(root: string, target: string, what: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) {
    throw new BugError(`${what} resolved to the root itself: ${resolvedTarget}`);
  }
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new BugError(`${what} escaped ${resolvedRoot}: ${resolvedTarget}`);
  }
}

/** True when the path is safely inside root, without throwing. */
export function isInside(root: string, target: string): boolean {
  try {
    assertInside(root, target, 'path');
    return true;
  } catch {
    return false;
  }
}
