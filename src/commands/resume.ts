import { prefilter } from '../core/search.ts';
import { restoreSession, resumeCommand } from '../worker/restore.ts';
import type { Runtime } from '../composition.ts';
import { commandContext } from './context.ts';
import { print, printJson } from './output.ts';
import { toCard } from './search.ts';

/**
 * `/archive:resume` — find, restore, hand back the command (SPEC §5).
 *
 * With a session id it restores. With free text it returns candidates and stops:
 * picking the wrong session and unpacking it is worse than asking.
 */

export type ResumeOptions = {
  query: string;
  limit?: number;
  json?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runResume(runtime: Runtime, options: ResumeOptions): Promise<number> {
  const query = options.query.trim();
  const sessionId = resolveSessionId(runtime, query);

  if (sessionId === null) {
    const candidates = prefilter(runtime.db(), query, runtime.clock.now(), {
      limit: options.limit ?? 30,
    });
    const payload = {
      action: 'choose' as const,
      query,
      count: candidates.length,
      candidates: candidates.map((candidate) => toCard(runtime, candidate, false)),
    };
    if (options.json !== false) printJson(payload);
    else print(`${String(candidates.length)} candidates; rerun with a session id.`);
    return 0;
  }

  const ctx = commandContext(runtime);
  const result = await restoreSession(ctx, sessionId);

  if (options.json !== false) {
    printJson({ action: 'restored', ...result });
    return 0;
  }
  print(result.alreadyLocal ? 'Session is already on this machine.' : 'Session restored.');
  if (result.projectCwd !== null) print(`Run this from ${result.projectCwd}:`);
  print(`  ${result.resumeCommand}`);
  return 0;
}

/**
 * Accept a full session id, or a short prefix of one, or nothing.
 *
 * The prefix form matters because that is what bundle filenames carry, so it is
 * what a user is most likely to have in front of them.
 */
export function resolveSessionId(runtime: Runtime, query: string): string | null {
  if (UUID.test(query)) return query;
  // Restricted to hex and dashes, so the value cannot carry a LIKE wildcard.
  if (!/^[0-9a-f-]{6,}$/i.test(query)) return null;
  const row = runtime
    .db()
    .prepare('SELECT session_id FROM sessions WHERE session_id LIKE ? LIMIT 2')
    .all(`${query}%`) as { session_id: string }[];
  // Two matches means the prefix is ambiguous, so it is not an id.
  if (row.length !== 1) return null;
  return row[0]?.session_id ?? null;
}

export { resumeCommand };
