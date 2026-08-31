import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/adapters/db.ts';
import {
  catalogStats,
  clearVerification,
  getFiles,
  getPrompts,
  getSession,
  listReapable,
  listUnverified,
  markBundled,
  markLocalDeleted,
  markLocalPresent,
  markVerified,
  replaceFiles,
  replacePrompts,
  upsertSession,
} from '../src/core/catalog.ts';
import { tempDir } from './helpers.ts';

function freshDb(): Db {
  return openDatabase(path.join(tempDir(), 'archive.sqlite'));
}

const BASE = {
  sessionId: 's1',
  encodedDir: '-home-a-project',
  projectCwd: '/home/a/project',
  title: 'Auth redirect fix',
  startedAt: 1000,
  endedAt: 2000,
  transcriptBytes: 500,
  sidecarBytes: 100,
  lastLocalMtime: 2000,
};

describe('upsertSession', () => {
  it('inserts a new session as locally present', () => {
    const db = freshDb();
    upsertSession(db, BASE, 5000);
    const session = getSession(db, 's1');
    assert.equal(session?.title, 'Auth redirect fix');
    assert.equal(session?.localPresent, true);
    assert.equal(session?.createdAt, 5000);
  });

  it('never erases what an earlier pass knew', () => {
    const db = freshDb();
    upsertSession(db, BASE, 5000);
    // A later pass that could not parse the transcript.
    upsertSession(db, { sessionId: 's1', encodedDir: '-home-a-project' }, 6000);
    const session = getSession(db, 's1');
    assert.equal(session?.title, 'Auth redirect fix');
    assert.equal(session?.projectCwd, '/home/a/project');
    assert.equal(session?.updatedAt, 6000);
  });

  it('overwrites a title that has been refined', () => {
    const db = freshDb();
    upsertSession(db, BASE, 5000);
    upsertSession(db, { ...BASE, title: 'Auth redirect fix, take two' }, 6000);
    assert.equal(getSession(db, 's1')?.title, 'Auth redirect fix, take two');
  });

  it('returns null for a session it has never seen', () => {
    assert.equal(getSession(freshDb(), 'nope'), null);
  });
});

describe('replacePrompts', () => {
  it('stores prompts in order', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1);
    replacePrompts(db, 's1', [
      { seq: 0, ts: 10, text: 'first' },
      { seq: 1, ts: 20, text: 'second' },
    ]);
    assert.deepEqual(getPrompts(db, 's1'), ['first', 'second']);
  });

  it('replaces rather than appends, so a resumed session does not duplicate', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1);
    replacePrompts(db, 's1', [{ seq: 0, ts: 10, text: 'first' }]);
    replacePrompts(db, 's1', [
      { seq: 0, ts: 10, text: 'first' },
      { seq: 1, ts: 20, text: 'second' },
    ]);
    assert.equal(getPrompts(db, 's1').length, 2);
  });

  it('cascades away when the session is deleted', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1);
    replacePrompts(db, 's1', [{ seq: 0, ts: 10, text: 'first' }]);
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');
    assert.deepEqual(getPrompts(db, 's1'), []);
  });
});

describe('replaceFiles', () => {
  it('deduplicates paths', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1);
    replaceFiles(db, 's1', ['/a.ts', '/b.ts', '/a.ts']);
    assert.deepEqual(getFiles(db, 's1'), ['/a.ts', '/b.ts']);
  });
});

describe('the backup lifecycle', () => {
  it('walks from bundled to verified to reaped', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1000);
    markBundled(
      db,
      's1',
      { bundleName: 'b.tar.zst', bundleBytes: 120, bundleSha256: 'abc', archiverVersion: '0.1.0' },
      2000,
    );
    assert.equal(getSession(db, 's1')?.verifiedAt, null);

    markVerified(
      db,
      's1',
      {
        fileId: 'drive-1',
        path: 'ClaudeArchive/x/b.tar.zst',
        localMtime: 2000,
        localBytes: 600,
        bundleSha256: 'abc',
        transcriptSha256: 't1',
      },
      3000,
    );
    const verified = getSession(db, 's1');
    assert.equal(verified?.verifiedAt, 3000);
    assert.equal(verified?.remoteFileId, 'drive-1');

    markLocalDeleted(db, 's1', 4000);
    const reaped = getSession(db, 's1');
    assert.equal(reaped?.localPresent, false);
    assert.equal(reaped?.localDeletedAt, 4000);
  });

  it('re-bundling a resumed session clears the old verification', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1000);
    markVerified(
      db,
      's1',
      {
        fileId: 'drive-1',
        path: 'p',
        localMtime: 2000,
        localBytes: 600,
        bundleSha256: 'abc',
        transcriptSha256: 't1',
      },
      3000,
    );
    markBundled(
      db,
      's1',
      { bundleName: 'b2.tar.zst', bundleBytes: 130, bundleSha256: 'def', archiverVersion: '0.1.0' },
      4000,
    );
    const rebuilt = getSession(db, 's1');
    assert.equal(rebuilt?.verifiedAt, null, 'the new bundle is not verified yet');
    assert.notEqual(
      rebuilt?.verifiedLocalBytes,
      null,
      'but what Drive already holds is still described, or the shrink guard has no evidence',
    );
  });

  it('marks a restored session present again', () => {
    const db = freshDb();
    upsertSession(db, BASE, 1000);
    markLocalDeleted(db, 's1', 4000);
    markLocalPresent(db, 's1', 9000, 9000);
    const session = getSession(db, 's1');
    assert.equal(session?.localPresent, true);
    assert.equal(session?.localDeletedAt, null);
  });
});

describe('listReapable', () => {
  function seed(db: Db): void {
    upsertSession(db, { ...BASE, sessionId: 'verified-old', lastLocalMtime: 1000 }, 1);
    markBundled(
      db,
      'verified-old',
      {
        bundleName: 'a',
        bundleBytes: 1,
        bundleSha256: 'h',
        archiverVersion: '0',
      },
      1,
    );
    markVerified(
      db,
      'verified-old',
      {
        fileId: 'f',
        path: 'p',
        localMtime: 1000,
        localBytes: 600,
        bundleSha256: 'h',
        transcriptSha256: 't1',
      },
      1,
    );

    upsertSession(db, { ...BASE, sessionId: 'verified-recent', lastLocalMtime: 90_000 }, 1);
    markBundled(
      db,
      'verified-recent',
      {
        bundleName: 'a',
        bundleBytes: 1,
        bundleSha256: 'h',
        archiverVersion: '0',
      },
      1,
    );
    markVerified(
      db,
      'verified-recent',
      {
        fileId: 'f',
        path: 'p',
        localMtime: 90_000,
        localBytes: 600,
        bundleSha256: 'h',
        transcriptSha256: 't1',
      },
      1,
    );

    upsertSession(db, { ...BASE, sessionId: 'unverified-old', lastLocalMtime: 1000 }, 1);
  }

  it('offers only sessions that are old, verified and still on disk', () => {
    const db = freshDb();
    seed(db);
    assert.deepEqual(
      listReapable(db, 50_000).map((session) => session.sessionId),
      ['verified-old'],
    );
  });

  it('never offers an unverified session, which is SPEC invariant 1', () => {
    const db = freshDb();
    seed(db);
    const ids = listReapable(db, Number.MAX_SAFE_INTEGER).map((session) => session.sessionId);
    assert.ok(!ids.includes('unverified-old'));
  });

  it('stops offering a session once its verification is withdrawn', () => {
    const db = freshDb();
    seed(db);
    clearVerification(db, 'verified-old', 2);
    assert.deepEqual(listReapable(db, 50_000), []);
  });

  it('skips a session whose local copy is already gone', () => {
    const db = freshDb();
    seed(db);
    markLocalDeleted(db, 'verified-old', 2);
    assert.deepEqual(listReapable(db, 50_000), []);
  });
});

describe('listUnverified', () => {
  it('returns the most recent unbacked-up sessions first', () => {
    const db = freshDb();
    upsertSession(db, { ...BASE, sessionId: 'older', endedAt: 1000 }, 1);
    upsertSession(db, { ...BASE, sessionId: 'newer', endedAt: 9000 }, 1);
    upsertSession(db, { ...BASE, sessionId: 'done', endedAt: 5000 }, 1);
    markVerified(
      db,
      'done',
      {
        fileId: 'f',
        path: 'p',
        localMtime: 1000,
        localBytes: 600,
        bundleSha256: 'h',
        transcriptSha256: 't1',
      },
      1,
    );
    assert.deepEqual(
      listUnverified(db).map((session) => session.sessionId),
      ['newer', 'older'],
    );
  });
});

describe('catalogStats', () => {
  it('reports zeroes for an empty catalog', () => {
    const stats = catalogStats(freshDb());
    assert.equal(stats.sessions, 0);
    assert.equal(stats.localBytes, 0);
    assert.equal(stats.oldestSession, null);
  });

  it('separates bytes still on disk from bytes reclaimed', () => {
    const db = freshDb();
    upsertSession(db, { ...BASE, sessionId: 'local' }, 1);
    upsertSession(db, { ...BASE, sessionId: 'reaped' }, 1);
    markBundled(
      db,
      'reaped',
      {
        bundleName: 'b',
        bundleBytes: 200,
        bundleSha256: 'h',
        archiverVersion: '0',
      },
      1,
    );
    markVerified(
      db,
      'reaped',
      {
        fileId: 'f',
        path: 'p',
        localMtime: 1000,
        localBytes: 600,
        bundleSha256: 'h',
        transcriptSha256: 't1',
      },
      1,
    );
    markLocalDeleted(db, 'reaped', 2);

    const stats = catalogStats(db);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.verified, 1);
    assert.equal(stats.localPresent, 1);
    assert.equal(stats.localBytes, 600);
    assert.equal(stats.reclaimedBytes, 600);
    assert.equal(stats.archivedBytes, 200);
  });
});
