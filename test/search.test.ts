import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/adapters/db.ts';
import { replaceFiles, replacePrompts, upsertSession } from '../src/core/catalog.ts';
import { extractTerms, likeTerm, parseQuery, prefilter } from '../src/core/search.ts';
import { tempDir } from './helpers.ts';

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const DAY = 86_400_000;

function seeded(): Db {
  const db = openDatabase(path.join(tempDir(), 'archive.sqlite'));
  upsertSession(
    db,
    {
      sessionId: 'auth',
      encodedDir: '-home-a-shop',
      projectCwd: '/home/a/shop',
      title: 'Auth redirect loop',
      gitBranch: 'fix/auth',
      startedAt: NOW - 2 * DAY,
      endedAt: NOW - 2 * DAY,
    },
    1,
  );
  replacePrompts(db, 'auth', [
    { seq: 0, ts: NOW - 2 * DAY, text: 'the login page keeps bouncing back to itself' },
    { seq: 1, ts: NOW - 2 * DAY, text: 'try clearing the cookie' },
  ]);
  replaceFiles(db, 'auth', ['/home/a/shop/src/auth.ts']);

  upsertSession(
    db,
    {
      sessionId: 'invoice',
      encodedDir: '-home-a-billing',
      projectCwd: '/home/a/billing',
      title: 'Invoice PDF layout',
      startedAt: NOW - 40 * DAY,
      endedAt: NOW - 40 * DAY,
    },
    1,
  );
  replacePrompts(db, 'invoice', [
    { seq: 0, ts: NOW - 40 * DAY, text: 'the totals column overflows' },
  ]);

  upsertSession(
    db,
    {
      sessionId: 'recent',
      encodedDir: '-home-a-shop',
      projectCwd: '/home/a/shop',
      title: 'Bump dependencies',
      startedAt: NOW - 3600_000,
      endedAt: NOW - 3600_000,
    },
    1,
  );
  return db;
}

describe('extractTerms', () => {
  it('drops filler words', () => {
    assert.deepEqual(extractTerms('the session where I fixed the auth redirect'), [
      'fixed',
      'auth',
      'redirect',
    ]);
  });

  it('keeps a quoted phrase whole', () => {
    assert.deepEqual(extractTerms('"auth redirect" bug'), ['auth redirect', 'bug']);
  });

  it('keeps paths and identifiers intact', () => {
    assert.deepEqual(extractTerms('src/auth.ts failed'), ['src/auth.ts', 'failed']);
  });

  it('deduplicates', () => {
    assert.deepEqual(extractTerms('auth auth AUTH'), ['auth']);
  });

  it('returns nothing for a query of pure filler', () => {
    assert.deepEqual(extractTerms('the one where we did it'), []);
  });
});

describe('parseQuery', () => {
  it('reads an exact date as a one-day window', () => {
    const parsed = parseQuery('what happened on 2026-08-30', NOW);
    assert.equal(parsed.since, Date.UTC(2026, 7, 30));
    assert.equal(parsed.until, Date.UTC(2026, 7, 31));
  });

  it('reads a month as a one-month window', () => {
    const parsed = parseQuery('the invoice work in 2026-07', NOW);
    assert.equal(parsed.since, Date.UTC(2026, 6, 1));
    assert.equal(parsed.until, Date.UTC(2026, 7, 1));
  });

  it('reads yesterday and today', () => {
    assert.equal(parseQuery('yesterday', NOW).since, Date.UTC(2026, 7, 30));
    assert.equal(parseQuery('today', NOW).since, Date.UTC(2026, 7, 31));
  });

  it('reads a relative window with no end', () => {
    const parsed = parseQuery('last week', NOW);
    assert.equal(parsed.since, NOW - 7 * DAY);
    assert.equal(parsed.until, null);
  });

  it('leaves the window open when no date is mentioned', () => {
    const parsed = parseQuery('auth redirect', NOW);
    assert.equal(parsed.since, null);
    assert.equal(parsed.until, null);
  });
});

describe('prefilter', () => {
  it('finds a session by a word in its title', () => {
    const results = prefilter(seeded(), 'auth redirect', NOW);
    assert.equal(results[0]?.session.sessionId, 'auth');
  });

  it('finds a session by a phrase only its prompts contain', () => {
    const results = prefilter(seeded(), 'login page bouncing', NOW);
    assert.equal(results[0]?.session.sessionId, 'auth');
    assert.ok(results[0]?.matchedPrompts[0]?.includes('bouncing'));
  });

  it('finds a session by a file it touched', () => {
    const results = prefilter(seeded(), 'src/auth.ts', NOW);
    assert.equal(results[0]?.session.sessionId, 'auth');
  });

  it('finds a session by its git branch', () => {
    const results = prefilter(seeded(), 'fix/auth', NOW);
    assert.equal(results[0]?.session.sessionId, 'auth');
  });

  it('falls back to the most recent sessions when the query is pure filler', () => {
    const results = prefilter(seeded(), 'the one where we did it', NOW);
    assert.equal(results[0]?.session.sessionId, 'recent');
    assert.equal(results.length, 3);
  });

  it('honours a date window taken from the query', () => {
    const results = prefilter(seeded(), 'totals column last week', NOW);
    assert.equal(results.length, 0, 'the invoice session is 40 days old');
  });

  it('honours an explicit window over one inferred from the text', () => {
    const results = prefilter(seeded(), 'totals column last week', NOW, {
      since: NOW - 60 * DAY,
      until: null,
    });
    assert.equal(results[0]?.session.sessionId, 'invoice');
  });

  it('narrows by project', () => {
    const results = prefilter(seeded(), '', NOW, { project: '/home/a/billing' });
    assert.deepEqual(
      results.map((candidate) => candidate.session.sessionId),
      ['invoice'],
    );
  });

  it('respects the limit', () => {
    assert.equal(prefilter(seeded(), '', NOW, { limit: 2 }).length, 2);
  });

  it('ranks a session matching two terms above one matching one', () => {
    const results = prefilter(seeded(), 'auth cookie', NOW);
    assert.equal(results[0]?.session.sessionId, 'auth');
    assert.ok((results[0]?.score ?? 0) > 0);
  });

  it('returns nothing for a term nobody used', () => {
    assert.deepEqual(prefilter(seeded(), 'kubernetes', NOW), []);
  });

  it('treats a wildcard in the query as a literal character, not a match-all', () => {
    // Quoted, so it survives tokenizing and reaches the LIKE clause as one term.
    assert.deepEqual(prefilter(seeded(), '"%auth%"', NOW), []);
  });
});

describe('likeTerm', () => {
  it('escapes the LIKE wildcards', () => {
    assert.equal(likeTerm('100%_done'), '%100\\%\\_done%');
  });
});

describe('queries that are not in English', () => {
  it('finds terms in any script', () => {
    // ASCII-only tokenizing returned nothing at all for these, and a query
    // with no terms silently degrades to "the most recent sessions", which
    // looks like an answer.
    assert.deepEqual(extractTerms('認証リダイレクト'), ['認証リダイレクト']);
    assert.deepEqual(extractTerms('поиск счетов'), ['поиск', 'счетов']);
    assert.deepEqual(extractTerms('búsqueda facturación'), ['búsqueda', 'facturación']);
  });

  it('still tokenizes ordinary English the same way', () => {
    assert.deepEqual(extractTerms('fix the auth redirect'), ['fix', 'auth', 'redirect']);
  });
});
