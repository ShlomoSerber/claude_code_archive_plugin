import { getFiles } from '../core/catalog.ts';
import { prefilter, prefilterTruncated, type Candidate } from '../core/search.ts';
import type { Runtime } from '../composition.ts';
import { formatDate, print, printJson, snippet } from './output.ts';

/**
 * `/archive:search` — the prefilter half of natural-language search (SPEC §5).
 *
 * It returns candidate cards, not answers. Claude reads the cards and does the
 * semantic ranking, which is why this stage optimises for recall and why its
 * default output is JSON: the model is the consumer.
 */

export type SearchOptions = {
  query: string;
  limit?: number;
  since?: number | null;
  until?: number | null;
  project?: string | null;
  json?: boolean;
  /** Include the files each session touched. Off by default; it is verbose. */
  files?: boolean;
};

export function runSearch(runtime: Runtime, options: SearchOptions): number {
  const db = runtime.db();
  const now = runtime.clock.now();
  const candidates = prefilter(db, options.query, now, {
    limit: options.limit ?? 30,
    since: options.since ?? null,
    until: options.until ?? null,
    project: options.project ?? null,
  });

  if (options.json !== false) {
    printJson({
      query: options.query,
      count: candidates.length,
      // The scan orders by recency, so a truncated one hides older matches.
      // Saying so lets the reranker narrow the window rather than reword.
      truncated: prefilterTruncated(db, options.query, now, {
        since: options.since ?? null,
        until: options.until ?? null,
        project: options.project ?? null,
      }),
      candidates: candidates.map((candidate) => toCard(runtime, candidate, options.files === true)),
    });
    return 0;
  }

  if (candidates.length === 0) {
    print('No sessions matched.');
    return 0;
  }
  for (const candidate of candidates) {
    const session = candidate.session;
    print(`${formatDate(session.endedAt ?? session.startedAt)}  ${session.title ?? '(untitled)'}`);
    print(`  id:      ${session.sessionId}`);
    print(`  project: ${session.projectCwd ?? session.encodedDir}`);
    if (candidate.matchedPrompts[0] !== undefined) {
      print(`  prompt:  ${snippet(candidate.matchedPrompts[0])}`);
    }
    print(`  local:   ${session.localPresent ? 'yes' : 'archived only'}`);
    print();
  }
  return 0;
}

/** One candidate as Claude sees it: enough to rank, small enough to read 30 of. */
export function toCard(
  runtime: Runtime,
  candidate: Candidate,
  includeFiles: boolean,
): Record<string, unknown> {
  const session = candidate.session;
  return {
    sessionId: session.sessionId,
    title: session.title,
    project: session.projectCwd ?? session.encodedDir,
    gitBranch: session.gitBranch,
    startedAt: session.startedAt === null ? null : new Date(session.startedAt).toISOString(),
    endedAt: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
    messageCount: session.messageCount,
    prompts: candidate.matchedPrompts.map((prompt) => snippet(prompt, 300)),
    localPresent: session.localPresent,
    archived: session.verifiedAt !== null,
    score: candidate.score,
    ...(includeFiles ? { files: getFiles(runtime.db(), session.sessionId, 20) } : {}),
  };
}
