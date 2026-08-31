import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic.ts';
import { CLEANUP_PERIOD_DAYS } from '../core/config.ts';
import { FatalError } from '../core/errors.ts';

/**
 * Reading and writing Claude Code's own `settings.json` (SPEC §2).
 *
 * This file belongs to the user and holds their permissions, hooks, model and
 * MCP servers. The plugin changes exactly one key in it.
 *
 * The rule that matters: "absent" and "unreadable" are different answers.
 * Treating them alike means a file with a trailing comma or a stray comment
 * gets replaced by a fresh one containing only our key, silently destroying
 * everything else in it.
 */

export type SettingsResult = {
  changed: boolean;
  previous: number | null;
  current: number;
};

export type SettingsRead =
  | { status: 'ok'; settings: Record<string, unknown> }
  | { status: 'absent' }
  | { status: 'unparseable' };

export async function readCleanupPeriodDays(file: string): Promise<number | null> {
  const read = await readSettings(file);
  if (read.status !== 'ok') return null;
  const value = read.settings['cleanupPeriodDays'];
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

  const read = await readSettings(file);
  if (read.status === 'unparseable') {
    // Refusing is the whole point. Rewriting the file would take the user's
    // permissions, hooks and MCP servers with it.
    throw new FatalError(
      `${file} is not valid JSON, so the plugin will not modify it`,
      `Fix the JSON in ${file}, or move it aside, then run /archive:setup again. ` +
        `Until then Claude Code's own 30-day transcript cleanup stays in charge.`,
    );
  }

  const settings = read.status === 'ok' ? read.settings : {};
  const previous =
    typeof settings['cleanupPeriodDays'] === 'number' ? settings['cleanupPeriodDays'] : null;
  if (previous === days) return { changed: false, previous, current: days };

  settings['cleanupPeriodDays'] = days;
  // Follow a symlink to its target: dotfile repositories commonly link this
  // file, and an atomic rename would otherwise replace the link with a file.
  const target = await resolveLink(file);
  await writeFileAtomic(target, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: await currentMode(target, 0o600),
  });
  return { changed: true, previous, current: days };
}

/**
 * Every settings file that can set `cleanupPeriodDays`, most specific last.
 *
 * The plugin writes only the user file. Claude Code also reads a local
 * override, and a value there outranks the one we wrote — so "we own deletion"
 * is a claim that has to be checked against all of them, not asserted from the
 * one we control.
 */
/**
 * Where a cleanupPeriodDays that outranks ours can live.
 *
 * Managed settings are installed by an administrator at fixed OS paths, not
 * under the Claude config directory, and CLAUDE_CONFIG_DIR does not move them.
 * Looking in the wrong place is worse than not looking: it produces a clean
 * report that means nothing.
 */
export function competingSettingsPaths(claudeDir: string): string[] {
  const managed =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
        : '/etc/claude-code/managed-settings.json';
  return [path.join(claudeDir, 'settings.local.json'), managed];
}

export async function competingCleanupSettings(
  claudeDir: string,
): Promise<{ file: string; value: number }[]> {
  const found: { file: string; value: number }[] = [];
  for (const file of competingSettingsPaths(claudeDir)) {
    let read: SettingsRead;
    try {
      read = await readSettings(file);
    } catch {
      // Unreadable is not the same as absent, but this runs inside a status
      // report: crashing the diagnostic helps nobody.
      continue;
    }
    if (read.status !== 'ok') continue;
    const value = read.settings['cleanupPeriodDays'];
    if (typeof value === 'number') found.push({ file, value });
  }
  return found;
}

export async function readSettings(file: string): Promise<SettingsRead> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { status: 'absent' };
    throw err;
  }
  // A byte-order mark is legal in a file and illegal in JSON.parse.
  const text = raw.replace(/^﻿/, '').trim();
  if (text.length === 0) return { status: 'absent' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'unparseable' };
    }
    return { status: 'ok', settings: parsed as Record<string, unknown> };
  } catch {
    return { status: 'unparseable' };
  }
}

async function resolveLink(file: string): Promise<string> {
  try {
    return await fsp.realpath(file);
  } catch {
    return file;
  }
}

/** Keep whatever permissions the user's file already had. */
async function currentMode(file: string, fallback: number): Promise<number> {
  try {
    return (await fsp.stat(file)).mode & 0o777;
  } catch {
    return fallback;
  }
}
