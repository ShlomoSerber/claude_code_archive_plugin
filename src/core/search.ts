import type { Db } from '../adapters/db.ts';
import { SESSION_COLUMNS, toRecord, type SessionRecord, type SessionRow } from './catalog.ts';

/**
 * The prefilter half of search (SPEC §5).
 *
 * This is deliberately dumb. It casts a wide keyword net over the catalog and
 * returns ~30 cards; Claude then reads those cards and ranks them by meaning.
 * Recall is what matters here — precision is the model's job, and a candidate
 * this stage drops is one the model can never recover.
 */

export type ParsedQuery = {
  terms: string[];
  since: number | null;
  until: number | null;
};

export type SearchOptions = {
  limit?: number;
  since?: number | null;
  until?: number | null;
  project?: string | null;
  /** Rows to score before ranking. Bounds the work on a huge catalog. */
  scanLimit?: number;
};

export type Candidate = {
  session: SessionRecord;
  score: number;
  /** The prompts that matched, for the card Claude reads. */
  matchedPrompts: string[];
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'that',
  'this',
  'was',
  'were',
  'with',
  'for',
  'from',
  'about',
  'when',
  'where',
  'what',
  'which',
  'who',
  'i',
  'we',
  'my',
  'our',
  'it',
  'its',
  'to',
  'of',
  'in',
  'on',
  'at',
  'is',
  'are',
  'be',
  'been',
  'session',
  'chat',
  'conversation',
  'find',
  'me',
  'the',
  'one',
  'where',
  'did',
]);

const DAY_MS = 86_400_000;

/**
 * Pull keywords and a date window out of free text.
 *
 * The date phrases handled here are the ones people actually type when they are
 * looking for an old session. Anything richer is Claude's job: it can pass
 * `--since` and `--until` explicitly.
 */
export function parseQuery(text: string, now: number): ParsedQuery {
  let since: number | null = null;
  let until: number | null = null;
  const lower = text.toLowerCase();

  const isoDay = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  const isoMonth = /\b(\d{4})-(\d{2})\b(?!-)/.exec(lower);
  if (isoDay !== null) {
    const start = Date.parse(`${isoDay[1] ?? ''}-${isoDay[2] ?? ''}-${isoDay[3] ?? ''}T00:00:00Z`);
    if (!Number.isNaN(start)) {
      since = start;
      until = start + DAY_MS;
    }
  } else if (isoMonth !== null) {
    const start = Date.parse(`${isoMonth[1] ?? ''}-${isoMonth[2] ?? ''}-01T00:00:00Z`);
    if (!Number.isNaN(start)) {
      since = start;
      until = addMonths(start, 1);
    }
  } else if (/\byesterday\b/.test(lower)) {
    since = startOfUtcDay(now) - DAY_MS;
    until = startOfUtcDay(now);
  } else if (/\btoday\b/.test(lower)) {
    since = startOfUtcDay(now);
    until = startOfUtcDay(now) + DAY_MS;
  } else if (/\blast week\b|\bpast week\b/.test(lower)) {
    since = now - 7 * DAY_MS;
  } else if (/\blast month\b|\bpast month\b/.test(lower)) {
    since = now - 31 * DAY_MS;
  } else if (/\blast year\b|\bpast year\b/.test(lower)) {
    since = now - 366 * DAY_MS;
  }

  return { terms: extractTerms(text), since, until };
}

export function extractTerms(text: string): string[] {
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
  const rest = text.replace(/"[^"]+"/g, ' ');
  const words = rest
    .toLowerCase()
    // Unicode letters and digits, not just ASCII. "認証リダイレクト" and
    // "поиск счетов" tokenized to nothing at all, and a query with no terms
    // silently degrades to "the thirty most recent sessions" — which looks
    // like an answer.
    .split(/[^\p{L}\p{N}_./\\:-]+/u)
    .map((word) => word.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  const all = [...quoted.map((term) => term.toLowerCase()), ...words.flatMap(expandCjk)];
  return [...new Set(all)].slice(0, 12);
}

/**
 * Japanese and Chinese are written without spaces, so a whole clause tokenizes
 * as one word and `LIKE '%<clause>%'` matches nothing at all. Character
 * bigrams are what a search engine without a segmenter can offer: they match
 * on the pieces, and scoring still favours the sessions that match more of them.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function expandCjk(word: string): string[] {
  if (!CJK.test(word) || word.length <= 3) return [word];
  // Code points, deliberately: CJK is exactly the case this exists for, and a
  // pair of them is the unit that matches. Intl.Segmenter would be right for
  // grapheme clusters, which is not the question here.
  const characters = Array.from(word);
  const bigrams: string[] = [];
  for (let index = 0; index + 1 < characters.length; index++) {
    bigrams.push(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`);
  }
  return bigrams;
}

/**
 * Return the best candidates for a query.
 *
 * With no usable keywords this degrades to "most recent sessions", which is the
 * right answer for "what was I doing last week".
 */
export function prefilter(
  db: Db,
  query: string,
  now: number,
  options: SearchOptions = {},
): Candidate[] {
  const parsed = parseQuery(query, now);
  const since = options.since ?? parsed.since;
  const until = options.until ?? parsed.until;
  const limit = options.limit ?? 30;
  const scanLimit = options.scanLimit ?? 400;
  const terms = parsed.terms;

  const rows = selectRows(db, { terms, since, until, project: options.project ?? null, scanLimit });
  const promptStatement = db.prepare(
    'SELECT text FROM prompts WHERE session_id = ? ORDER BY seq ASC LIMIT 200',
  );

  const candidates = rows.map((row) => {
    const session = toRecord(row);
    const prompts = (promptStatement.all(session.sessionId) as { text: string }[]).map(
      (prompt) => prompt.text,
    );
    return scoreCandidate(session, prompts, terms);
  });

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return recency(b.session) - recency(a.session);
  });
  return candidates.slice(0, limit);
}

function selectRows(
  db: Db,
  args: {
    terms: string[];
    since: number | null;
    until: number | null;
    project: string | null;
    scanLimit: number;
  },
): SessionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (args.since !== null) {
    where.push('COALESCE(s.ended_at, s.started_at, s.created_at) >= ?');
    params.push(args.since);
  }
  if (args.until !== null) {
    where.push('COALESCE(s.started_at, s.ended_at, s.created_at) <= ?');
    params.push(args.until);
  }
  if (args.project !== null && args.project.length > 0) {
    where.push("(s.project_cwd LIKE ? ESCAPE '\\' OR s.encoded_dir LIKE ? ESCAPE '\\')");
    params.push(likeTerm(args.project), likeTerm(args.project));
  }

  if (args.terms.length > 0) {
    const clauses: string[] = [];
    for (const term of args.terms) {
      const pattern = likeTerm(term);
      clauses.push(
        `(s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\'
          OR s.project_cwd LIKE ? ESCAPE '\\' OR s.git_branch LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM prompts p WHERE p.session_id = s.session_id
                       AND p.text LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM session_files f WHERE f.session_id = s.session_id
                       AND f.path LIKE ? ESCAPE '\\'))`,
      );
      params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(args.scanLimit);
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       ${clause}
       ORDER BY COALESCE(s.ended_at, s.started_at, s.created_at) DESC
       LIMIT ?`,
    )
    .all(...params) as SessionRow[];
}

/** Weights, highest first: a title hit says more than a path hit. */
const WEIGHTS = { title: 6, summary: 4, prompt: 3, project: 2, branch: 2, file: 1 } as const;

export function scoreCandidate(
  session: SessionRecord,
  prompts: string[],
  terms: string[],
): Candidate {
  if (terms.length === 0) {
    return { session, score: 0, matchedPrompts: prompts.slice(0, 3) };
  }
  let score = 0;
  const matched: string[] = [];
  const seen = new Set<number>();

  for (const term of terms) {
    let hit = false;
    if (includes(session.title, term)) {
      score += WEIGHTS.title;
      hit = true;
    }
    if (includes(session.summary, term)) {
      score += WEIGHTS.summary;
      hit = true;
    }
    if (includes(session.projectCwd, term) || includes(session.encodedDir, term)) {
      score += WEIGHTS.project;
      hit = true;
    }
    if (includes(session.gitBranch, term)) {
      score += WEIGHTS.branch;
      hit = true;
    }
    for (const [index, prompt] of prompts.entries()) {
      if (!includes(prompt, term)) continue;
      score += WEIGHTS.prompt;
      hit = true;
      if (!seen.has(index) && matched.length < 3) {
        seen.add(index);
        matched.push(prompt);
      }
      break;
    }
    if (!hit) score -= 1;
  }
  return { session, score, matchedPrompts: matched.length > 0 ? matched : prompts.slice(0, 2) };
}

function includes(haystack: string | null, needle: string): boolean {
  return haystack?.toLowerCase().includes(needle) ?? false;
}

function recency(session: SessionRecord): number {
  return session.endedAt ?? session.startedAt ?? session.createdAt;
}

/** Escape the LIKE wildcards so a query containing `%` means a literal `%`. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addMonths(epochMs: number, months: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}
