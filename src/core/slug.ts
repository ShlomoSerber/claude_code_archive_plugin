/**
 * Filename and path hygiene (ARCHITECTURE §10).
 *
 * Bundle names must survive a round trip through macOS (NFD), Windows (reserved
 * basenames, trailing-dot stripping, path length) and Linux, and must stay
 * readable to a human browsing Drive. Uniqueness never comes from the title;
 * it comes from the session id.
 */

const WINDOWS_ILLEGAL = /[<>:"/\\|?*]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** Leaves room for the longest suffix we append: `.tar.zst.partial`. */
export const MAX_FILENAME_BYTES = 200;

/**
 * True when a basename is reserved on Windows, including with an extension:
 * `CON`, `con.txt` and `COM1.tar.zst` are all unusable.
 */
export function isWindowsReservedName(name: string): boolean {
  const stem = name.split('.')[0] ?? '';
  return WINDOWS_RESERVED.has(stem.toLowerCase());
}

/**
 * Make an arbitrary string safe as a single path segment on every platform.
 * Returns `fallback` when nothing usable survives.
 */
export function sanitizeFileName(input: string, fallback = 'untitled'): string {
  let name = input.normalize('NFC').replace(CONTROL_CHARS, '').replace(WINDOWS_ILLEGAL, '-');
  name = name.replace(/\s+/g, ' ').trim();
  // Windows silently strips trailing dots and spaces; strip them ourselves so
  // the name we record matches the name that lands on disk.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  name = truncateUtf8(name, MAX_FILENAME_BYTES).replace(/[. ]+$/, '');
  // A name made only of separators carries no information and reads as noise.
  if (name.length === 0 || /^[-_. ]+$/.test(name)) return fallback;
  if (isWindowsReservedName(name)) return `_${name}`;
  return name;
}

/**
 * Lowercase kebab form used for the human-readable middle of a bundle name.
 * Everything outside `[a-z0-9]` collapses to a single `-`.
 */
export function slugifyTitle(title: string, maxBytes = 60): string {
  const slug = title
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) return 'session';
  return truncateUtf8(slug, maxBytes).replace(/-+$/, '') || 'session';
}

/** Short, still-unique-in-practice form of a session id, used in filenames. */
export function shortSessionId(sessionId: string): string {
  const compact = sessionId.replace(/[^a-zA-Z0-9]/g, '');
  return compact.slice(0, 8) || 'nosessid';
}

/**
 * `2026-08-31_fix-auth-redirect_1a2b3c4d` — date first so Drive listings sort
 * chronologically, session id last so two same-day sessions never collide.
 */
export function bundleBaseName(args: {
  date: string;
  title: string | null | undefined;
  sessionId: string;
  /**
   * Hash of the bundle's bytes. Including a prefix of it makes the remote name
   * describe the *content*, not the title.
   *
   * Without it, re-archiving a session whose content changed produces the same
   * name as the existing archive, and the only way to store the new bundle is
   * to destroy the old one first. With it, the two are different files, so a
   * replacement is uploaded before anything is retired.
   */
  contentHash?: string | null;
}): string {
  const slug = slugifyTitle(args.title ?? '');
  const short = shortSessionId(args.sessionId);
  const digest = contentTag(args.contentHash);
  const base = `${args.date}_${slug}_${short}${digest}`;
  return sanitizeFileName(base, `${args.date}_session_${short}${digest}`);
}

/** Eight hex characters of the bundle hash, or nothing when it is unknown. */
export function contentTag(hash: string | null | undefined): string {
  if (typeof hash !== 'string') return '';
  const hex = hash
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  return hex.length === 8 ? `_${hex}` : '';
}

/**
 * Keep a timestamp inside the range that produces a four-digit year.
 *
 * These two functions name files and Drive folders, and both are called from
 * outside the fail-soft boundary around transcript parsing — so `new Date(x)`
 * throwing `Invalid time value` on a nonsense timestamp blocked the session's
 * backup for good, and a negative one produced a folder named `-029`.
 */
function nameableEpoch(epochMs: number): number {
  if (!Number.isFinite(epochMs)) return 0;
  return Math.min(Math.max(Math.trunc(epochMs), 0), MAX_NAMEABLE_EPOCH_MS);
}

/** 9999-12-31T23:59:59.999Z, the last epoch with a four-digit ISO year. */
const MAX_NAMEABLE_EPOCH_MS = 253_402_300_799_999;

/** `YYYY-MM-DD` in UTC. Bundle names must not shift with the user's timezone. */
export function isoDate(epochMs: number): string {
  return new Date(nameableEpoch(epochMs)).toISOString().slice(0, 10);
}

/** Calendar year in UTC, used for the Drive year subfolder. */
export function isoYear(epochMs: number): string {
  return new Date(nameableEpoch(epochMs)).toISOString().slice(0, 4);
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * Surrogate pairs count as one unit, so an emoji survives or vanishes whole.
 */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let bytes = 0;
  let out = '';
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

