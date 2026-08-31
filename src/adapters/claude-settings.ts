import fsp from 'node:fs/promises';
import { writeFileAtomic } from './atomic.ts';
import { CLEANUP_PERIOD_DAYS } from '../core/config.ts';

/**
 * Reading and writing Claude Code's own `settings.json` (SPEC §2).
 *
 * This is a file the user owns, so the rules are strict: parse it, change one
 * key, write it back whole, and never touch anything else. A settings file we
 * cannot parse is left exactly as it is.
 */

export type SettingsResult = {
  changed: boolean;
  previous: number | null;
  current: number;
};

export async function readCleanupPeriodDays(file: string): Promise<number | null> {
  const settings = await readSettings(file);
  const value = settings?.['cleanupPeriodDays'];
  return typeof value === 'number' ? value : null;
}

/**
 * Take ownership of deletion by pushing Claude Code's reaper 1000 years out.
 *
 * From here on the plugin is the only thing that deletes a transcript, which is
 * what makes SPEC invariant 1 enforceable at all.
 */
export async function setCleanupPeriodDays(
  file: string,
  days: number = CLEANUP_PERIOD_DAYS,
): Promise<SettingsResult> {
  if (days <= 0 || days > 365_000) {
    throw new RangeError(`refusing to write cleanupPeriodDays=${String(days)}`);
  }
  const settings = (await readSettings(file)) ?? {};
  const previous =
    typeof settings['cleanupPeriodDays'] === 'number' ? settings['cleanupPeriodDays'] : null;
  if (previous === days) return { changed: false, previous, current: days };

  settings['cleanupPeriodDays'] = days;
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o644 });
  return { changed: true, previous, current: days };
}

export async function readSettings(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Malformed settings belong to the user, not to us. Never rewrite them.
    return null;
  }
}
