import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  openDatabase,
  schemaVersion,
  migrate,
  kvGet,
  kvSet,
  kvGetNumber,
} from '../src/adapters/db.ts';
import type { Db } from '../src/adapters/db.ts';
import {
  block,
  claim,
  complete,
  countJobs,
  dedupeKey,
  enqueue,
  getJob,
  heartbeatClaim,
  listJobs,
  parsePayload,
  retryLater,
  setUploadUri,
} from '../src/core/queue.ts';
import { SCHEMA_VERSION } from '../src/core/migrations.ts';
import { MAX_RETRY_AFTER_MS, nextAttemptAt } from '../src/core/backoff.ts';
import { tempDir } from './helpers.ts';

function freshDb(): Db {
  return openDatabase(path.join(tempDir(), 'archive.sqlite'));
}

describe('migrations', () => {
  it('brings a new database to the current version', () => {
    const db = freshDb();
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
  });

  it('is idempotent, so hooks and the worker can both run it', () => {
    const db = freshDb();
    assert.equal(migrate(db), SCHEMA_VERSION);
    assert.equal(migrate(db), SCHEMA_VERSION);
  });

  it('enables the pragmas the queue depends on', () => {
    const db = freshDb();
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    const keys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(journal.journal_mode, 'wal');
    assert.equal(busy.timeout, 5000);
    assert.equal(keys.foreign_keys, 1);
  });
});

describe('enqueue', () => {
  it('coalesces repeated fires for one session into a single job', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1001);
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1002);
    assert.equal(listJobs(db).length, 1);
  });

  it('keeps different sessions and kinds apart', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    enqueue(db, { kind: 'backup', sessionId: 's2' }, 1000);
    enqueue(db, { kind: 'catalog_upload' }, 1000);
    assert.equal(listJobs(db).length, 3);
  });

  it('never lets a fresh fire cancel an active backoff', () => {
    const db = freshDb();
    const id = enqueue(db, { kind: 'backup', sessionId: 's1', notBefore: 50_000 }, 1000);
    enqueue(db, { kind: 'backup', sessionId: 's1', notBefore: 2000 }, 1500);
    assert.equal(getJob(db, id)?.notBefore, 50_000);
  });

  it('stores the payload for the worker', () => {
    const db = freshDb();
    const id = enqueue(db, { kind: 'backup', sessionId: 's1', payload: { encodedDir: '-a-b' } }, 1);
    const job = getJob(db, id);
    assert.deepEqual(parsePayload(job!), { encodedDir: '-a-b' });
  });

  it('unblocks a job only when a real session event says to', () => {
    const db = freshDb();
    const id = enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    block(db, job, { error: 'invalid_grant', now: 1001 });
    assert.equal(getJob(db, id)?.blocked, true);

    // The sweep rescans constantly. If its enqueue cleared the block, a parked
    // job would be retried every pass and "stop and make a person look" would
    // mean nothing.
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 2000);
    assert.equal(getJob(db, id)?.blocked, true, 'a rescan does not unblock');

    // A hook fires when someone actually used the session again.
    enqueue(db, { kind: 'backup', sessionId: 's1', unblock: true }, 3000);
    assert.equal(getJob(db, id)?.blocked, false);
  });
});

describe('claim', () => {
  it('returns nothing when the queue is empty', () => {
    assert.equal(claim(freshDb(), 1000, 60_000), null);
  });

  it('hides a claimed job from the next claimer', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    assert.ok(claim(db, 1000, 60_000));
    assert.equal(claim(db, 1000, 60_000), null);
  });

  it('hands the job back once the visibility timeout expires', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const first = claim(db, 1000, 60_000)!;
    const second = claim(db, 61_001, 60_000);
    assert.equal(second?.id, first.id);
    assert.equal(second?.attempts, 2);
  });

  it('respects not_before', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1', notBefore: 5000 }, 1000);
    assert.equal(claim(db, 4999, 60_000), null);
    assert.ok(claim(db, 5000, 60_000));
  });

  it('skips blocked jobs', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    block(db, job, { error: 'needs auth', now: 1001 });
    assert.equal(claim(db, 2000, 60_000), null);
  });

  it('takes the oldest runnable job first', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 'late', notBefore: 3000 }, 1000);
    enqueue(db, { kind: 'backup', sessionId: 'early', notBefore: 2000 }, 1000);
    assert.equal(claim(db, 5000, 60_000)?.sessionId, 'early');
  });

  it('counts the attempt as it claims', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    assert.equal(claim(db, 1000, 60_000)?.attempts, 1);
  });
});

describe('complete', () => {
  it('removes the job it claimed', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    assert.equal(complete(db, job), 'deleted');
    assert.equal(listJobs(db).length, 0);
  });

  it('leaves work that arrived while the job was running', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    // The session was resumed and closed again mid-upload.
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 2000);
    assert.equal(complete(db, job), 'superseded');
    assert.equal(listJobs(db).length, 1);
    assert.ok(claim(db, 3000, 60_000), 'the newer work is claimable immediately');
  });
});

describe('retryLater', () => {
  it('makes the job visible again at the chosen time', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    retryLater(db, job, { at: 9000, error: 'ECONNRESET' });
    assert.equal(claim(db, 8999, 60_000), null);
    const again = claim(db, 9000, 60_000);
    assert.equal(again?.lastError, 'ECONNRESET');
  });
});

describe('heartbeatClaim', () => {
  it('extends a claim that is still ours', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    heartbeatClaim(db, job, 50_000, 60_000);
    assert.equal(claim(db, 100_000, 60_000), null);
    assert.ok(claim(db, 110_001, 60_000));
  });

  it('does nothing once the claim has been superseded', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 2000);
    heartbeatClaim(db, job, 50_000, 60_000);
    // Had the heartbeat applied, the job would stay hidden until 110_000.
    assert.ok(claim(db, 61_001, 60_000));
  });
});

describe('setUploadUri', () => {
  it('persists the resumable session URI across processes', () => {
    const db = freshDb();
    const id = enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    setUploadUri(db, job, 'https://upload.example/session/1', 1200);
    assert.equal(getJob(db, id)?.uploadUri, 'https://upload.example/session/1');
  });
});

describe('countJobs', () => {
  it('separates runnable, blocked and retrying work', () => {
    const db = freshDb();
    enqueue(db, { kind: 'backup', sessionId: 'ok' }, 1000);
    enqueue(db, { kind: 'backup', sessionId: 'blocked' }, 1000);
    enqueue(db, { kind: 'backup', sessionId: 'later', notBefore: 900_000 }, 1000);
    const stuck = claim(db, 1000, 60_000)!;
    block(db, stuck, { error: 'x', now: 1000 });
    const counts = countJobs(db, 70_000);
    assert.equal(counts.total, 3);
    assert.equal(counts.blocked, 1);
    assert.equal(counts.runnable, 1);
  });
});

describe('dedupeKey', () => {
  it('distinguishes a session job from the global one', () => {
    assert.equal(dedupeKey('backup', 's1'), 'backup:s1');
    assert.equal(dedupeKey('catalog_upload', null), 'catalog_upload:');
  });
});

describe('kv', () => {
  it('round-trips and overwrites', () => {
    const db = freshDb();
    kvSet(db, 'circuit.until', '1234', 1);
    assert.equal(kvGet(db, 'circuit.until'), '1234');
    kvSet(db, 'circuit.until', '5678', 2);
    assert.equal(kvGetNumber(db, 'circuit.until'), 5678);
  });

  it('returns undefined for an unknown key', () => {
    assert.equal(kvGet(freshDb(), 'nope'), undefined);
  });
});

describe('a server that asks for an unreasonable wait', () => {
  it('caps how far a Retry-After can push a job out', () => {
    // Nothing in the queue can lower a not_before once written, and the
    // HTTP-date form is parsed against this machine's clock — so a slow clock
    // or a misconfigured proxy could park a session's backup for a year.
    const at = nextAttemptAt({ now: 1_000, attempt: 1, random: () => 0.5, retryAfterSeconds: 4e7 });
    assert.equal(at, 1_000 + MAX_RETRY_AFTER_MS);
  });

  it('still honours a reasonable one exactly', () => {
    const at = nextAttemptAt({ now: 1_000, attempt: 1, random: () => 0.5, retryAfterSeconds: 120 });
    assert.equal(at, 121_000);
  });

  it('lets /archive:now pull a backing-off job forward', () => {
    const db = openDatabase(':memory:');
    const id = enqueue(db, { kind: 'backup', sessionId: 's1' }, 1_000);
    const job = claim(db, 1_000, 60_000)!;
    retryLater(db, job, { at: 1_000 + 6 * 60 * 60_000, error: 'rate limited' });
    assert.equal(claim(db, 2_000, 60_000), null, 'it is waiting');

    enqueue(db, { kind: 'backup', sessionId: 's1', unblock: true, runNow: true }, 2_000);
    assert.ok(claim(db, 2_000, 60_000), 'the user asking for it now means now');
    assert.ok(getJob(db, id));
  });

  it('does not let a closing session cancel a server-mandated wait', () => {
    // The SessionEnd hook sets unblock, which is what clears a parked job. It
    // must not also discard an hour of Retry-After: resuming a session and
    // closing it again is ordinary, and Drive asked us to wait.
    const db = openDatabase(':memory:');
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1_000);
    const job = claim(db, 1_000, 60_000)!;
    retryLater(db, job, { at: 1_000 + 60 * 60_000, error: 'rate limited' });

    enqueue(db, { kind: 'backup', sessionId: 's1', unblock: true }, 2_000);
    assert.equal(claim(db, 3_000, 60_000), null, 'the wait survives the hook');
  });

  it('counts a job that has failed once as failing', () => {
    const db = openDatabase(':memory:');
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1_000);
    const job = claim(db, 1_000, 60_000)!;
    retryLater(db, job, { at: 500_000, error: 'rate limited' });
    assert.equal(countJobs(db, 2_000).failing, 1, 'the first failure was invisible');
  });
});
