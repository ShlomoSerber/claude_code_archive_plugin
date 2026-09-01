import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { spawnWorker } from '../src/adapters/spawn-worker.ts';
import { openDatabase } from '../src/adapters/db.ts';
import { sha256File } from '../src/adapters/hashing.ts';
import {
  catalogStats,
  clearVerification,
  getSession,
  listRetainedBundles,
  upsertSession,
} from '../src/core/catalog.ts';
import {
  DEFAULT_CONFIG,
  resolveConfig,
  unreadableSafetyValues,
  type ArchiveConfig,
  DAY_MS,
} from '../src/core/config.ts';
import { FatalError, RetryableError, isRetryableNetworkError } from '../src/core/errors.ts';
import { resolvePaths } from '../src/core/paths.ts';
import {
  block,
  claim,
  enqueue,
  getJob,
  listJobs,
  nextRunnableAt,
  retryLater,
  setUploadUri,
} from '../src/core/queue.ts';
import { catalogFileName, machineId, runSweep } from '../src/worker/sweep.ts';
import { importCatalogFile } from '../src/commands/setup.ts';
import { restoreRetainedBundle, restoreSession, verifyArchive } from '../src/worker/restore.ts';
import { reapLocalCopies } from '../src/worker/reap.ts';
import type { WorkerContext } from '../src/worker/context.ts';
import { nullLogger } from '../src/ports/logger.ts';
import { competingCleanupSettings } from '../src/adapters/claude-settings.ts';
import { createExtractor } from '../src/core/transcript.ts';
import { kvGetNumber, kvSetNumber } from '../src/adapters/db.ts';
import { ACTIVE_SESSION_TTL_MS, KV, activeSessionKey } from '../src/core/state-keys.ts';
import { FakeDrive } from './fakes/fake-drive.ts';
import { fakeClock, tempDir } from './helpers.ts';

/**
 * The whole engine, end to end, against a fake Drive.
 *
 * These are the tests that hold SPEC invariant 1 in place: a local session is
 * never deleted unless a hash-verified copy exists on Drive.
 */

const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ENCODED = '-home-a-shop';

type Harness = {
  ctx: WorkerContext;
  drive: FakeDrive;
  clock: ReturnType<typeof fakeClock>;
  projectDir: string;
  transcriptOf(sessionId: string): string;
};

function transcriptLines(sessionId: string, title: string, prompt: string): string {
  return (
    [
      {
        type: 'user',
        userType: 'external',
        sessionId,
        timestamp: '2026-08-20T10:00:00.000Z',
        cwd: '/home/a/shop',
        gitBranch: 'main',
        message: { role: 'user', content: prompt },
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: '2026-08-20T10:01:00.000Z',
        cwd: '/home/a/shop',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/home/a/shop/x.ts' } }],
        },
      },
      { type: 'ai-title', aiTitle: title, sessionId },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  );
}

function makeHarness(overrides: Partial<ArchiveConfig> = {}, drive = new FakeDrive()): Harness {
  const home = tempDir();
  const claudeDir = path.join(home, '.claude');
  const dataDir = path.join(home, 'data');
  const paths = resolvePaths({ CLAUDE_CONFIG_DIR: claudeDir, ARCHIVE_DATA_DIR: dataDir });
  const projectDir = path.join(paths.projectsDir, ENCODED);
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, `${SESSION_A}.jsonl`),
    transcriptLines(SESSION_A, 'Auth redirect fix', 'the login page keeps bouncing'),
  );
  // A session with a sidecar directory, which is the harder shape to bundle.
  fs.mkdirSync(path.join(projectDir, SESSION_B), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${SESSION_B}.jsonl`),
    transcriptLines(SESSION_B, 'Invoice totals', 'the totals column overflows'),
  );
  fs.writeFileSync(path.join(projectDir, SESSION_B, 'tool-result.json'), '{"stdout":"ok"}');

  const clock = fakeClock(Date.UTC(2026, 7, 31, 12));
  const ctx: WorkerContext = {
    db: openDatabase(path.join(dataDir, 'archive.sqlite')),
    paths,
    config: { ...DEFAULT_CONFIG, ...overrides },
    drive,
    logger: nullLogger,
    clock,
    version: 'test',
    signal: undefined,
  };
  return {
    ctx,
    drive,
    clock,
    projectDir,
    transcriptOf: (sessionId) => path.join(projectDir, `${sessionId}.jsonl`),
  };
}

describe('a full sweep', () => {
  it('discovers, archives and verifies every local session', async () => {
    const harness = makeHarness();
    const report = await runSweep(harness.ctx);

    assert.equal(report.discovered, 2);
    assert.equal(report.enqueued, 2);
    assert.equal(report.verified, 2);
    assert.equal(report.failed, 0);
    assert.deepEqual(listJobs(harness.ctx.db), [], 'the queue drains');
  });

  it('records the Drive copy in the catalog', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);

    const record = getSession(harness.ctx.db, SESSION_A);
    assert.ok(record?.verifiedAt);
    assert.ok(record.remoteFileId);
    assert.equal(record.title, 'Auth redirect fix');
    // 2026-08-20 is when the transcript says the session ended; the sweep ran
    // on 2026-08-31. The name follows the session, not the sweep — and carries
    // eight hex of the bundle hash, so a changed session gets a different name
    // rather than needing the existing archive destroyed to make room.
    assert.match(
      record.bundleName ?? '',
      /^2026-08-20_auth-redirect-fix_aaaaaaaa_[0-9a-f]{8}.tar.zst$/,
    );
  });

  it('files bundles by project and year, with a manifest beside each', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);

    assert.ok(
      harness.drive.calls.some((call) => call.startsWith(`ensureFolder:ClaudeArchive/${ENCODED}/`)),
    );
    const names = [...harness.drive.files.values()].map((file) => file.name).sort();
    assert.equal(names.filter((name) => name.endsWith('.tar.zst')).length, 2);
    assert.equal(names.filter((name) => name.endsWith('.manifest.json')).length, 2);
  });

  it('uploads a catalog copy for disaster recovery', async () => {
    const harness = makeHarness();
    const report = await runSweep(harness.ctx);
    assert.equal(report.catalogUploaded, true);
    // One copy per machine, so two machines on one Drive do not overwrite each other.
    assert.ok(harness.drive.fileByName(catalogFileName(machineId(harness.ctx))));
  });

  it('leaves no staged bundles behind', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const staged = await fsp.readdir(harness.ctx.paths.stagingDir).catch(() => []);
    assert.deepEqual(
      staged.filter((name) => name.endsWith('.tar.zst') || name.endsWith('.partial')),
      [],
    );
  });

  it('does nothing the second time, because nothing changed', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    harness.clock.advance(60_000);
    const second = await runSweep(harness.ctx);
    assert.equal(second.enqueued, 0);
    assert.equal(second.verified, 0);
  });

  it('re-archives a session that was resumed and closed again', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    harness.clock.advance(60_000);

    fs.appendFileSync(
      harness.transcriptOf(SESSION_A),
      `${JSON.stringify({ type: 'user', sessionId: SESSION_A, message: { role: 'user', content: 'one more thing' } })}\n`,
    );
    // Real wall-clock time, because mtimes come from the filesystem and not
    // from the fake clock the sweep reads.
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);

    const second = await runSweep(harness.ctx);
    assert.equal(second.enqueued, 1);
    assert.equal(second.verified, 1);
  });
});

describe('the integrity chain', () => {
  it('refuses to verify when Drive reports a different checksum', async () => {
    const harness = makeHarness({}, new FakeDrive({ corruptChecksums: true }));
    const report = await runSweep(harness.ctx);

    assert.equal(report.verified, 0);
    assert.equal(report.failed, 2);
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, null);
  });

  it('retires the bad remote copy rather than leaving it to be trusted later', async () => {
    const harness = makeHarness({}, new FakeDrive({ corruptChecksums: true }));
    await runSweep(harness.ctx);
    const bundles = [...harness.drive.files.values()].filter((file) =>
      file.name.endsWith('.tar.zst'),
    );
    // Trashed rather than deleted: uploadWithResume can hand back a file it
    // found by name rather than one this run created, so a permanent delete
    // here could destroy the copy remote_file_id still points at.
    assert.ok(bundles.every((file) => harness.drive.trashedIds.has(file.id)));
  });

  it('refuses to verify when Drive returns no checksum at all', async () => {
    const harness = makeHarness({}, new FakeDrive({ omitSha256: true }));
    const report = await runSweep(harness.ctx);
    assert.equal(report.verified, 0);
  });

  it('resumes an upload that only landed in part', async () => {
    // Small enough chunks that the bundle needs several rounds to land.
    const harness = makeHarness({}, new FakeDrive({ truncateChunksTo: 64 }));
    const report = await runSweep(harness.ctx);
    assert.equal(report.verified, 2, 'the upload loop keeps going from what Drive confirmed');
  });

  it('starts a fresh upload when the session URI has expired', async () => {
    const drive = new FakeDrive({ truncateChunksTo: 64 });
    const harness = makeHarness({}, drive);
    const original = drive.uploadChunk.bind(drive);
    let expired = false;
    drive.uploadChunk = async (args) => {
      if (!expired) {
        expired = true;
        drive.expireUploadSessions();
      }
      return original(args);
    };
    await runSweep(harness.ctx);
    // The first attempt dies with an expired session and requeues; the retry
    // starts a new one, so the job is still in the queue with a later time.
    const jobs = listJobs(harness.ctx.db);
    assert.ok(jobs.length > 0, 'the failed upload is queued for another attempt');
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.verifiedAt ?? null, null);
  });
});

describe('reaping local copies', () => {
  it('deletes an archived session once it has been idle long enough', async () => {
    const harness = makeHarness({ retentionDays: 30 });
    await runSweep(harness.ctx);

    harness.clock.advance(31 * DAY_MS);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());

    assert.equal(report.deleted, 2);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), false);
    assert.equal(fs.existsSync(path.join(harness.projectDir, SESSION_B)), false, 'sidecar too');
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.localPresent, false);
  });

  it('keeps a session that has not been idle long enough', async () => {
    const harness = makeHarness({ retentionDays: 30 });
    await runSweep(harness.ctx);
    harness.clock.advance(29 * DAY_MS);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('never deletes a session Drive could not verify — SPEC invariant 1', async () => {
    const harness = makeHarness({ retentionDays: 30 }, new FakeDrive({ corruptChecksums: true }));
    await runSweep(harness.ctx);
    harness.clock.advance(400 * DAY_MS);

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_B)), true);
  });

  it('deletes nothing when local retention is turned off', async () => {
    const harness = makeHarness({ retentionDays: 30, keepLocalForever: true });
    await runSweep(harness.ctx);
    harness.clock.advance(400 * DAY_MS);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('re-archives instead of deleting a session touched since its backup', async () => {
    const harness = makeHarness({ retentionDays: 30 });
    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY_MS);

    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const now = new Date(harness.clock.now());
    fs.utimesSync(harness.transcriptOf(SESSION_A), now, now);

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.requeued, 1);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });
});

describe('restore', () => {
  it('brings a reaped session back byte for byte', async () => {
    const harness = makeHarness({ retentionDays: 30 });
    const beforeA = await sha256File(harness.transcriptOf(SESSION_A));
    const beforeSidecar = await sha256File(
      path.join(harness.projectDir, SESSION_B, 'tool-result.json'),
    );

    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY_MS);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), false);

    const restoredA = await restoreSession(harness.ctx, SESSION_A);
    assert.equal(restoredA.alreadyLocal, false);
    assert.equal(await sha256File(harness.transcriptOf(SESSION_A)), beforeA);
    assert.equal(restoredA.resumeCommand, `claude --resume ${SESSION_A}`);
    assert.equal(restoredA.projectCwd, '/home/a/shop');

    const restoredB = await restoreSession(harness.ctx, SESSION_B);
    assert.equal(restoredB.alreadyLocal, false);
    assert.equal(
      await sha256File(path.join(harness.projectDir, SESSION_B, 'tool-result.json')),
      beforeSidecar,
    );
  });

  it('marks a restored session present again', async () => {
    const harness = makeHarness({ retentionDays: 30 });
    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY_MS);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    await restoreSession(harness.ctx, SESSION_A);
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.localPresent, true);
  });

  it('does not overwrite a copy that is still on disk', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const result = await restoreSession(harness.ctx, SESSION_A);
    assert.equal(result.alreadyLocal, true);
    assert.ok(!harness.drive.calls.some((call) => call.startsWith('downloadToFile')));
  });

  it('refuses a session it has never heard of', async () => {
    const harness = makeHarness();
    await assert.rejects(restoreSession(harness.ctx, 'nope'), /not in the catalog/);
  });

  it('refuses a session with no verified Drive copy', async () => {
    const harness = makeHarness({}, new FakeDrive({ corruptChecksums: true }));
    await runSweep(harness.ctx);
    // Simulate the local copy being lost some other way: the reaper itself
    // would never have removed an unverified session.
    fs.rmSync(harness.transcriptOf(SESSION_A));
    await assert.rejects(restoreSession(harness.ctx, SESSION_A), /no copy on Drive/);
  });
});

describe('bundle naming', () => {
  it('files a session under its own year folder, not the year we archived it', async () => {
    const harness = makeHarness();
    // A session from a previous year, archived today.
    const old = 'cccccccc-1111-2222-3333-444444444444';
    fs.writeFileSync(
      path.join(harness.projectDir, `${old}.jsonl`),
      JSON.stringify({
        type: 'user',
        userType: 'external',
        sessionId: old,
        timestamp: '2024-03-04T08:00:00.000Z',
        cwd: '/home/a/shop',
        message: { role: 'user', content: 'something from two years ago' },
      }) + '\n',
    );
    await runSweep(harness.ctx);

    const record = getSession(harness.ctx.db, old);
    assert.equal(record?.bundleName?.slice(0, 10), '2024-03-04');
    assert.match(record?.remotePath ?? '', /\/2024\//);
  });

  it('falls back to the file mtime when the transcript cannot be parsed', async () => {
    const harness = makeHarness();
    const broken = 'dddddddd-1111-2222-3333-444444444444';
    fs.writeFileSync(path.join(harness.projectDir, `${broken}.jsonl`), 'not json at all\n');
    await runSweep(harness.ctx);
    // No timestamps to read, so the name comes from mtime and still parses.
    assert.match(getSession(harness.ctx.db, broken)?.bundleName ?? '', /^\d{4}-\d\d-\d\d_/);
  });
});

/**
 * Regression tests for an independent safety audit that found three ways this
 * plugin could delete conversations that were not safely stored anywhere.
 *
 * Each test below reproduces one of those findings. They exist because 313
 * passing tests did not catch any of them.
 */
describe('deletion safety', () => {
  const DAY = DAY_MS;

  async function archived(overrides: Partial<ArchiveConfig> = {}, drive = new FakeDrive()) {
    const harness = makeHarness({ retentionDays: 30, ...overrides }, drive);
    await runSweep(harness.ctx);
    return harness;
  }

  it('does not delete a session whose re-upload failed after it was indexed', async () => {
    // The original defect: indexing advanced the recorded mtime before the
    // upload was attempted, so a failure in between left a row claiming to be
    // verified with an mtime matching the changed file on disk.
    const drive = new FakeDrive({ failUploadsAfter: 2 });
    const harness = await archived({}, drive);

    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), later, later);

    harness.clock.advance(60_000);
    const second = await runSweep(harness.ctx);
    assert.ok(second.failed > 0, 'the re-upload really did fail');

    harness.clock.advance(400 * DAY);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.localPresent, true);
  });

  it('detects a change that leaves the mtime unchanged', async () => {
    const harness = await archived();
    const file = harness.transcriptOf(SESSION_A);
    const before = fs.statSync(file);

    fs.appendFileSync(file, '{"type":"user","content":"added"}\n');
    // Put the timestamp back exactly: a coarse filesystem, an rsync or a
    // restore all produce this, and mtime alone would see nothing.
    fs.utimesSync(file, before.atime, before.mtime);

    harness.clock.advance(400 * DAY);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.requeued, 1);
    assert.equal(fs.existsSync(file), true);
  });

  it('does not delete when Drive no longer holds the bundle', async () => {
    const harness = await archived();
    const record = getSession(harness.ctx.db, SESSION_A);
    harness.drive.files.delete(record?.remoteFileId ?? '');

    harness.clock.advance(400 * DAY);
    await reapLocalCopies(harness.ctx, harness.clock.now());

    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, null, 'trust withdrawn');
  });

  it('does not delete when the remote bundle no longer matches', async () => {
    const harness = await archived();
    const record = getSession(harness.ctx.db, SESSION_A);
    const file = harness.drive.files.get(record?.remoteFileId ?? '');
    if (file !== undefined) file.content = Buffer.from('something else entirely');

    harness.clock.advance(400 * DAY);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('leaves everything alone when a Drive check cannot be made at all', async () => {
    const harness = await archived();
    harness.drive.getFile = () => Promise.reject(new RetryableError('network down'));

    harness.clock.advance(400 * DAY);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
    assert.notEqual(
      getSession(harness.ctx.db, SESSION_A)?.verifiedAt,
      null,
      'a transient failure must not withdraw a good verification',
    );
  });

  it('ignores a transcript whose name would escape its directory', async () => {
    const harness = makeHarness();
    // `...jsonl` strips to `..`, and `.jsonl` strips to the empty string.
    // Both used to resolve to a parent directory that the reaper deletes.
    for (const name of ['...jsonl', '.jsonl']) {
      fs.writeFileSync(path.join(harness.projectDir, name), '{"type":"user"}\n');
    }
    const report = await runSweep(harness.ctx);

    assert.equal(report.discovered, 2, 'only the two real sessions were seen');
    for (const id of ['..', '']) {
      assert.equal(getSession(harness.ctx.db, id), null);
    }
  });

  it('refuses to reap a catalog row whose identifiers escape the projects tree', async () => {
    const harness = await archived();
    const outside = path.join(harness.ctx.paths.claudeDir, 'not-a-session.jsonl');
    fs.writeFileSync(outside, 'precious');

    // A row like this can arrive from a catalog downloaded off Drive.
    harness.ctx.db
      .prepare("UPDATE sessions SET encoded_dir = '../..' WHERE session_id = ?")
      .run(SESSION_A);

    harness.clock.advance(400 * DAY);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());

    assert.ok(report.skipped >= 1, 'the traversing row was refused');
    assert.equal(fs.existsSync(outside), true, 'the file outside the tree survives');
    assert.equal(fs.existsSync(harness.ctx.paths.projectsDir), true);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('deletes nothing at all when the plugin is disabled', async () => {
    const harness = await archived();
    harness.ctx.config = { ...harness.ctx.config, enabled: false };

    harness.clock.advance(400 * DAY);
    const sweep = await runSweep(harness.ctx);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());

    assert.equal(sweep.reap.deleted, 0);
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('still deletes a session that is genuinely safe, so the guards are not vacuous', async () => {
    const harness = await archived();
    harness.clock.advance(31 * DAY);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 2);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), false);
  });
});

/**
 * Second round of audit regressions. These are all one failure class: the
 * remote copy is not as good as the code believed it to be.
 */
describe('deletion safety, second pass', () => {
  const DAY = DAY_MS;

  it('refuses to delete against a bundle sitting in the Drive wastebasket', async () => {
    // Drive answers a metadata request for a trashed file with a normal 200
    // and a valid checksum, then purges it after thirty days.
    const harness = makeHarness({ retentionDays: 30 });
    await runSweep(harness.ctx);
    // Trashed after it was archived, which is how this actually happens: a
    // person tidying Drive, or a shared-drive retention rule.
    harness.drive.options = { ...harness.drive.options, trashed: true };
    harness.clock.advance(400 * DAY);

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0);
    assert.equal(report.unverified, 2);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('does not archive and delete in the same sweep', async () => {
    // A first install must not delete months-old sessions minutes after its
    // very first conversation with the Drive API.
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 7 });
    const old = new Date(harness.clock.now() - 90 * DAY);
    for (const id of [SESSION_A, SESSION_B]) {
      fs.utimesSync(harness.transcriptOf(id), old, old);
    }

    const report = await runSweep(harness.ctx);
    assert.equal(report.verified, 2, 'they were archived');
    assert.equal(report.reap.deleted, 0, 'and not deleted in the same breath');
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('deletes once the archive itself has aged past the grace period', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 7 });
    const old = new Date(harness.clock.now() - 90 * DAY);
    fs.utimesSync(harness.transcriptOf(SESSION_A), old, old);
    await runSweep(harness.ctx);

    harness.clock.advance(8 * DAY);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 1);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), false);
  });

  it('leaves a session alone while Claude Code still has it open', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);

    // What the SessionStart hook records while a session is running.
    kvSetNumber(
      harness.ctx.db,
      activeSessionKey(SESSION_A),
      harness.clock.now(),
      harness.clock.now(),
    );
    harness.clock.advance(31 * DAY);
    // Refresh the mark, as a still-running session's hooks would.
    kvSetNumber(
      harness.ctx.db,
      activeSessionKey(SESSION_A),
      harness.clock.now(),
      harness.clock.now(),
    );

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_B)), false, 'others still reaped');
    assert.ok(report.skipped >= 1);
  });

  it('forgets an active-session mark left behind by a crash', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    // A crashed Claude Code never fires SessionEnd, so a stale mark must expire
    // rather than protect a session forever.
    kvSetNumber(
      harness.ctx.db,
      activeSessionKey(SESSION_A),
      harness.clock.now(),
      harness.clock.now(),
    );

    // Past the mark's lifetime, which is deliberately longer than the retention
    // window: written once at SessionStart and never refreshed, a shorter TTL
    // could never protect anything.
    harness.clock.advance(60 * DAY);
    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 2);
  });

  it('refuses a bundle that does not contain the session it claims to', async () => {
    const harness = makeHarness();
    // Swap the bundler for one that packs the wrong session. Everything
    // downstream compares our hash of the bundle with Drive's hash of the same
    // bundle, so only a contents check can catch this.
    const contents = await import('../src/adapters/bundle.ts');
    const original = contents.verifyBundleContents;
    assert.equal(typeof original, 'function');

    const files = await contents.describeSessionFiles({
      cwd: harness.projectDir,
      entries: [`${SESSION_A}.jsonl`],
    });
    const out = path.join(tempDir(), 'wrong.tar.zst');
    await contents.createBundle({
      cwd: harness.projectDir,
      entries: [`${SESSION_B}.jsonl`],
      outputPath: out,
    });
    const problem = await contents.verifyBundleContents(out, files);
    assert.notEqual(problem, null, 'a bundle of the wrong session is rejected');
    assert.match(problem ?? '', /missing from the bundle/);
  });

  it('accepts a bundle that does contain the session', async () => {
    const harness = makeHarness();
    const contents = await import('../src/adapters/bundle.ts');
    const entries = [`${SESSION_B}.jsonl`, SESSION_B];
    const files = await contents.describeSessionFiles({ cwd: harness.projectDir, entries });
    const out = path.join(tempDir(), 'right.tar.zst');
    await contents.createBundle({ cwd: harness.projectDir, entries, outputPath: out });
    assert.equal(await contents.verifyBundleContents(out, files), null);
  });

  it('drops the verification fingerprint when a session moves project', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    assert.notEqual(getSession(harness.ctx.db, SESSION_A)?.verifiedLocalMtime, null);

    upsertSession(
      harness.ctx.db,
      { sessionId: SESSION_A, encodedDir: '-home-a-elsewhere' },
      harness.clock.now(),
    );
    const moved = getSession(harness.ctx.db, SESSION_A);
    assert.equal(moved?.verifiedAt, null);
    assert.equal(moved?.verifiedLocalMtime, null, 'the fingerprint was measured elsewhere');
  });
});

/**
 * Third round: a red team could not break the reaper, but found that the
 * integrity checker could orphan an archive, that restore could overwrite a
 * neighbouring session, and that "verified" could mean "compared nothing".
 */
describe('deletion safety, third pass', () => {
  const DAY = DAY_MS;

  it('does not orphan an archive when Drive cannot be reached', async () => {
    // The bug this replaces: /archive:verify --all walks hundreds of files,
    // earns a rate limit, and a catch-all treated every transport error as a
    // verification failure — clearing the only pointer to bundles whose local
    // copies had already been deleted.
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), false, 'reaped, as intended');

    harness.drive.getFile = () => Promise.reject(new RetryableError('rateLimitExceeded'));
    const report = await verifyArchive(harness.ctx, [getSession(harness.ctx.db, SESSION_A)!]);

    assert.equal(report.unchecked.length, 1, 'reported as unchecked, not as failed');
    assert.equal(report.mismatched.length, 0);
    assert.notEqual(
      getSession(harness.ctx.db, SESSION_A)?.remoteFileId,
      null,
      'the pointer to bytes that exist nowhere else survives',
    );
  });

  it('can still restore a session whose verification was withdrawn', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY);
    await reapLocalCopies(harness.ctx, harness.clock.now());

    // Withdraw deletion authority, as a failed check would.
    clearVerification(harness.ctx.db, SESSION_A, harness.clock.now());
    const restored = await restoreSession(harness.ctx, SESSION_A);
    assert.equal(restored.alreadyLocal, false);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('withdraws verification when Drive actually answers with a bad file', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    const record = getSession(harness.ctx.db, SESSION_A);
    const stored = harness.drive.files.get(record?.remoteFileId ?? '');
    if (stored !== undefined) stored.content = Buffer.from('not the bundle');

    const report = await verifyArchive(harness.ctx, [record!]);
    assert.equal(report.mismatched.length, 1);
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, null);
  });

  it('never reports a session verified when it compared nothing', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    harness.ctx.db
      .prepare('UPDATE sessions SET verified_bundle_sha256 = NULL WHERE session_id = ?')
      .run(SESSION_A);

    const report = await verifyArchive(harness.ctx, [getSession(harness.ctx.db, SESSION_A)!]);
    assert.equal(report.ok, 0);
    assert.match(report.mismatched[0]?.reason ?? '', /no verified hash/);
  });

  it('refuses to restore bytes it has no hash to check', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    fs.rmSync(harness.transcriptOf(SESSION_A));
    harness.ctx.db
      .prepare('UPDATE sessions SET verified_bundle_sha256 = NULL WHERE session_id = ?')
      .run(SESSION_A);

    await assert.rejects(restoreSession(harness.ctx, SESSION_A), /no verified hash/);
  });

  it('unpacks only the session being restored', async () => {
    const contents = await import('../src/adapters/bundle.ts');
    assert.equal(contents.belongsToSession(`${SESSION_A}.jsonl`, SESSION_A), true);
    assert.equal(contents.belongsToSession(`${SESSION_A}/tool.json`, SESSION_A), true);
    assert.equal(contents.belongsToSession(`${SESSION_A}/`, SESSION_A), true);
    // The project directory is shared, so a neighbour's transcript must not be
    // written even though it is not a traversal.
    assert.equal(contents.belongsToSession(`${SESSION_B}.jsonl`, SESSION_A), false);
    assert.equal(contents.belongsToSession('other.jsonl', SESSION_A), false);
    assert.equal(contents.belongsToSession(`${SESSION_A}-extra.jsonl`, SESSION_A), false);
  });

  it('does not write a neighbouring session when restoring from a bad bundle', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);

    // A bundle that carries someone else's transcript, as a hostile or corrupt
    // catalog on Drive could produce.
    const contents = await import('../src/adapters/bundle.ts');
    const out = path.join(tempDir(), 'mixed.tar.zst');
    await contents.createBundle({
      cwd: harness.projectDir,
      entries: [`${SESSION_A}.jsonl`, `${SESSION_B}.jsonl`],
      outputPath: out,
    });
    const victim = harness.transcriptOf(SESSION_B);
    const before = fs.readFileSync(victim, 'utf8');
    fs.rmSync(harness.transcriptOf(SESSION_A));

    const target = harness.projectDir;
    const result = await contents.extractBundle({
      bundlePath: out,
      targetDir: target,
      onlySession: SESSION_A,
    });

    assert.equal(fs.readFileSync(victim, 'utf8'), before, 'the neighbour is untouched');
    assert.ok(result.rejected.some((entry) => entry.includes(SESSION_B)));
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });
});

/**
 * Fourth round. A red team found the hole on the *upload* path: bundle names
 * came from the title, so re-archiving changed content collided with the
 * existing archive, and the code deleted the archive to make room. Drive's
 * DELETE is permanent, so an interrupted upload then left nothing at all.
 */
describe('deletion safety, fourth pass', () => {
  const DAY = DAY_MS;

  it('gives a changed session a different remote name instead of a collision', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const first = getSession(harness.ctx.db, SESSION_A)?.bundleName;

    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user","content":"more"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    const second = getSession(harness.ctx.db, SESSION_A)?.bundleName;
    assert.notEqual(first, second, 'the name follows the content, not the title');
  });

  it('never deletes an archived bundle before its replacement is verified', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';
    assert.ok(harness.drive.files.has(original));

    // Make every upload from here on fail, as a dropped connection would.
    harness.drive.options = { ...harness.drive.options, failUploadsAfter: 0 };
    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);

    const report = await runSweep(harness.ctx);
    assert.ok(report.failed > 0, 'the re-upload failed');
    assert.equal(harness.drive.files.has(original), true, 'the archived bundle survives');
  });

  it('retires the superseded bundle only after the new one is verified', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';

    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    const replacement = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';
    assert.notEqual(replacement, original);
    assert.equal(harness.drive.files.has(replacement), true, 'the new bundle is there');
    // Trashed rather than deleted: a bundle that was good a moment ago stays
    // recoverable for the thirty days Drive keeps its wastebasket.
    assert.equal(harness.drive.trashedIds.has(original), true, 'the old one was retired after');
    assert.equal(harness.drive.files.has(original), true, 'and is still recoverable');
  });

  it('refuses to archive over a good copy when the session has shrunk', async () => {
    // The signature of a half-finished delete or a truncated restore. Archiving
    // over the good copy is how that damage would become permanent.
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';

    fs.writeFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);

    const report = await runSweep(harness.ctx);
    assert.equal(report.blocked, 1, 'the job is parked for a person to look at');
    assert.equal(harness.drive.files.has(original), true, 'the fuller archive is untouched');
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('does not reap after the clock jumps forward by half a year', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);

    harness.clock.advance(400 * DAY);
    const report = await runSweep(harness.ctx);
    assert.equal(report.reap.deleted, 0, 'a clock jump is not evidence of idleness');
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);

    // The next sweep, with the gap recorded, reaps normally.
    harness.clock.advance(DAY);
    const after = await runSweep(harness.ctx);
    assert.equal(after.reap.deleted, 2);
  });

  it('refuses setup when another settings file outranks the one it writes', async () => {
    const harness = makeHarness();
    fs.writeFileSync(
      path.join(harness.ctx.paths.claudeDir, 'settings.local.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
    );
    const competing = await competingCleanupSettings(harness.ctx.paths.claudeDir);
    assert.equal(competing.length, 1);
    assert.equal(competing[0]?.value, 30);
  });

  it('keeps a fractional timestamp out of a STRICT integer column', () => {
    const extractor = createExtractor();
    extractor.pushLine(
      JSON.stringify({
        type: 'user',
        sessionId: 's',
        timestamp: 1_700_000_000_000.5,
        message: { role: 'user', content: 'hello' },
      }),
    );
    const summary = extractor.finish();
    assert.ok(Number.isInteger(summary.startedAt));
  });
});

/**
 * Fifth round. The red team's point: guards added by earlier rounds fired once,
 * logged, and then disarmed themselves.
 */
describe('deletion safety, fifth pass', () => {
  async function archivedThenShrunk() {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';
    fs.writeFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);
    return { harness, original };
  }

  it('keeps refusing a shrunken session on every later sweep', async () => {
    // The guard used to read verified_local_bytes, which markBundled cleared on
    // the very attempt the guard rejected — so the second sweep sailed through
    // and archived the damage over the good copy.
    const { harness, original } = await archivedThenShrunk();

    for (const pass of [1, 2, 3]) {
      const report = await runSweep(harness.ctx);
      assert.equal(report.verified, 0, `sweep ${String(pass)} must not archive the remains`);
      assert.equal(
        harness.drive.files.has(original),
        true,
        `sweep ${String(pass)} must leave the fuller archive alone`,
      );
      harness.clock.advance(60_000);
    }
  });

  it('still describes what Drive holds after a failed rebuild', async () => {
    const { harness } = await archivedThenShrunk();
    await runSweep(harness.ctx);
    const record = getSession(harness.ctx.db, SESSION_A);
    assert.equal(record?.verifiedAt, null, 'deletion authority is withdrawn');
    assert.notEqual(record?.verifiedLocalBytes, null, 'the description of the archive survives');
    assert.notEqual(record?.verifiedBundleSha256, null);
  });

  it('records the transcript hash of the archived copy, not of the newer disk', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const archived = getSession(harness.ctx.db, SESSION_A)?.verifiedTranscriptSha256;
    assert.notEqual(archived, null);

    // A failed re-upload used to leave transcript_sha256 describing bytes Drive
    // never received, making every later restore fail its own check forever.
    harness.drive.options = { ...harness.drive.options, failUploadsAfter: 0 };
    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    assert.equal(
      getSession(harness.ctx.db, SESSION_A)?.verifiedTranscriptSha256,
      archived,
      'the verified hash still describes the copy on Drive',
    );
  });

  it('restores after a failed re-upload instead of refusing forever', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.drive.options = { ...harness.drive.options, failUploadsAfter: 0 };
    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    fs.rmSync(harness.transcriptOf(SESSION_A));
    const restored = await restoreSession(harness.ctx, SESSION_A);
    assert.equal(restored.alreadyLocal, false);
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('archives a project whose encoded directory is near the length limit', async () => {
    // Claude Code encodes a working directory up to 200 characters. A shorter
    // cap here made every session under a deep path invisible: never archived,
    // never mentioned by status.
    const harness = makeHarness();
    const longDir = `-home-a-${'x'.repeat(185)}`;
    assert.ok(longDir.length > 190);
    fs.mkdirSync(path.join(harness.ctx.paths.projectsDir, longDir), { recursive: true });
    fs.writeFileSync(
      path.join(
        harness.ctx.paths.projectsDir,
        longDir,
        'eeeeeeee-1111-2222-3333-444444444444.jsonl',
      ),
      '{"type":"user","message":{"role":"user","content":"deep"}}\n',
    );

    const report = await runSweep(harness.ctx);
    assert.equal(report.discovered, 3, 'the deep project is seen');
    assert.ok(getSession(harness.ctx.db, 'eeeeeeee-1111-2222-3333-444444444444'));
  });

  it('counts a session it cannot archive instead of dropping it in silence', async () => {
    const harness = makeHarness();
    fs.writeFileSync(path.join(harness.projectDir, '...jsonl'), '{}\n');
    await runSweep(harness.ctx);
    assert.equal(kvGetNumber(harness.ctx.db, KV.skippedCount), 1);
  });

  it('treats a Drive rate limit as a delay, not as a missing archive', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY_MS);
    harness.drive.getFile = () =>
      Promise.reject(new RetryableError('HTTP 403: rateLimitExceeded', { status: 403 }));

    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
    assert.notEqual(
      getSession(harness.ctx.db, SESSION_A)?.verifiedAt,
      null,
      'a rate limit must not withdraw a good verification',
    );
  });
});

/**
 * Sixth round. The reaper still held under every hostile remote, but the
 * *archive* was not safe, and deletion follows the archive.
 */
describe('deletion safety, sixth pass', () => {
  async function archivedThenDamaged() {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';
    fs.writeFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), touched, touched);
    harness.clock.advance(60_000);
    return { harness, original };
  }

  it('keeps refusing a shrunken session after verification is withdrawn', async () => {
    // clearVerification used to null the byte count the shrink guard reads, and
    // it is called for transient reasons from three places — one of which
    // requeues the destructive re-archive itself.
    const { harness, original } = await archivedThenDamaged();
    clearVerification(harness.ctx.db, SESSION_A, harness.clock.now());

    const report = await runSweep(harness.ctx);
    assert.equal(report.verified, 0);
    assert.equal(harness.drive.files.has(original), true, 'the fuller archive survives');
  });

  it('keeps refusing after a bulk verify run', async () => {
    const { harness, original } = await archivedThenDamaged();
    const records = [
      getSession(harness.ctx.db, SESSION_A)!,
      getSession(harness.ctx.db, SESSION_B)!,
    ];
    await verifyArchive(harness.ctx, records);

    await runSweep(harness.ctx);
    assert.equal(harness.drive.files.has(original), true);
  });

  it('refuses a shrunken session even with no fingerprint recorded at all', async () => {
    // The state after a schema migration, and after importing a catalog: the
    // column is NULL for every existing row, so the guard has to fall back to
    // the byte counts the row has always carried.
    const { harness, original } = await archivedThenDamaged();
    harness.ctx.db
      .prepare('UPDATE sessions SET verified_local_bytes = NULL WHERE session_id = ?')
      .run(SESSION_A);

    await runSweep(harness.ctx);
    assert.equal(harness.drive.files.has(original), true);
  });

  it('treats a missing remote checksum as unchecked, not as a mismatch', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.drive.options = { ...harness.drive.options, omitSha256: true };

    const report = await verifyArchive(harness.ctx, [getSession(harness.ctx.db, SESSION_A)!]);
    assert.equal(report.mismatched.length, 0);
    assert.equal(report.unchecked.length, 1);
    assert.notEqual(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, null);

    // And the reaper waits rather than deleting or withdrawing trust.
    harness.clock.advance(31 * DAY_MS);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('never resumes an upload URI opened for a different bundle', async () => {
    const contents = await import('../src/worker/upload.ts');
    const tagged = contents.tagUploadUri('https://upload.test/1', 'aaaa');
    assert.deepEqual(contents.parseUploadUri(tagged), {
      sha256: 'aaaa',
      uri: 'https://upload.test/1',
    });
    // An untagged value predates the format and must not be trusted to a bundle.
    assert.equal(contents.parseUploadUri('https://upload.test/1'), null);
    assert.equal(contents.parseUploadUri(null), null);
  });

  it('drops a stored upload URI when new work arrives for the session', () => {
    const db = harnessDb();
    const id = enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    setUploadUri(db, job, 'abc|https://upload.test/1', 1000);
    assert.notEqual(getJob(db, id)?.uploadUri, null);

    enqueue(db, { kind: 'backup', sessionId: 's1' }, 2000);
    assert.equal(getJob(db, id)?.uploadUri, null, 'a new bundle cannot resume the old URI');
  });

  it('does not let one unbundleable session throttle every other', () => {
    // A local failure carries no HTTP status, and only network failures should
    // drive the shared circuit breaker.
    assert.equal(isRetryableNetworkError(new RetryableError('tar could not read a file')), false);
    assert.equal(isRetryableNetworkError(new RetryableError('HTTP 503', { status: 503 })), true);
  });
});

/** A bare catalog database, for queue-level assertions. */
function harnessDb() {
  return openDatabase(path.join(tempDir(), 'queue.sqlite'));
}

describe('fresh-machine recovery', () => {
  it('imports every machine catalog, not only the one named after this host', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const parentId = await harness.drive.ensureFolder([harness.ctx.config.driveRootFolder]);

    // What a different laptop's sweep would have left behind.
    const own = harness.drive.fileByName(catalogFileName(machineId(harness.ctx)));
    assert.ok(own, 'this machine wrote its own copy');
    await harness.drive.uploadSmallFile({
      name: 'catalog-deadbeef.sqlite',
      parentId,
      mimeType: 'application/vnd.sqlite3',
      body: own.content,
    });

    const found = await harness.drive.listFiles({ parentId, namePrefix: 'catalog' });
    const names = found.map((file) => file.name).sort();
    assert.ok(names.includes('catalog-deadbeef.sqlite'), 'the other machine is visible');
    assert.ok(names.includes(catalogFileName(machineId(harness.ctx))));
  });
});

/**
 * Seventh round. The red team could not delete a transcript this time. What it
 * found was the plugin saying "verified" about bytes that were nowhere.
 */
describe('archive completeness', () => {
  it('fails the backup when a sidecar cannot be read, rather than archiving without it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const harness = makeHarness();
    const sidecar = path.join(harness.projectDir, SESSION_B);
    fs.chmodSync(sidecar, 0o000);
    try {
      const report = await runSweep(harness.ctx);
      // Both the measurer and the manifest builder used to fail the same way,
      // so the cross-check compared zero with zero and passed.
      assert.equal(report.blocked, 1, 'the session is not silently archived without its sidecar');
      assert.equal(getSession(harness.ctx.db, SESSION_B)?.verifiedAt, null);
      assert.equal(report.verified, 1, 'and the other session is archived normally');
    } finally {
      fs.chmodSync(sidecar, 0o755);
    }
  });

  it('still treats a session with no sidecar at all as ordinary', async () => {
    const harness = makeHarness();
    const report = await runSweep(harness.ctx);
    assert.equal(report.verified, 2);
    assert.ok(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, 'no sidecar is not an error');
  });

  it('repairs a session whose transcript was reaped but whose sidecar survived', async () => {
    // What a crash between the reaper's two deletes leaves behind. This used to
    // report "already on this machine" and restore nothing, with the backup
    // blocked forever and no supported way out.
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    fs.rmSync(harness.transcriptOf(SESSION_B));

    const restored = await restoreSession(harness.ctx, SESSION_B);
    assert.equal(restored.alreadyLocal, false, 'a half-present session is not "already local"');
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_B)), true);
    assert.equal(
      fs.existsSync(path.join(harness.projectDir, SESSION_B, 'tool-result.json')),
      true,
      'the sidecar is restored too',
    );
  });

  it('does not re-upload a session merely because it was restored', async () => {
    // tar restores mtimes at second granularity, so a restored session used to
    // look changed and be bundled and uploaded again from scratch.
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.clock.advance(31 * DAY_MS);
    await reapLocalCopies(harness.ctx, harness.clock.now());
    await restoreSession(harness.ctx, SESSION_A);

    harness.clock.advance(60_000);
    const report = await runSweep(harness.ctx);
    assert.equal(report.enqueued, 0, 'a restored session is already archived');
  });

  it('treats an unreadable value on a safety switch as an attempt to use it', () => {
    // `keepLocalForever: 'yes please'` used to be discarded in silence, leaving
    // the default, which deletes.
    assert.equal(resolveConfig({ keepLocalForever: 'yes please' }, {}).keepLocalForever, true);
    assert.equal(resolveConfig({ enabled: 'sometimes' }, {}).keepLocalForever, true);
    assert.deepEqual(unreadableSafetyValues({ keepLocalForever: 'maybe' }), ['keepLocalForever']);
    assert.deepEqual(unreadableSafetyValues({ keepLocalForever: true }), []);
  });
});

describe('an unreadable sidecar', () => {
  it('does not stop the sweep archiving everything else', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const harness = makeHarness();
    const sidecar = path.join(harness.projectDir, SESSION_B);
    fs.chmodSync(sidecar, 0o000);
    try {
      const report = await runSweep(harness.ctx);
      assert.equal(report.discovered, 2, 'the scan does not abort');
      assert.ok(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, 'its neighbour still archives');
    } finally {
      fs.chmodSync(sidecar, 0o755);
    }
  });

  it('is never reaped, since we cannot know it is archived', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    const sidecar = path.join(harness.projectDir, SESSION_B);
    fs.chmodSync(sidecar, 0o000);
    try {
      harness.clock.advance(31 * DAY_MS);
      await reapLocalCopies(harness.ctx, harness.clock.now());
      assert.equal(fs.existsSync(harness.transcriptOf(SESSION_B)), true);
    } finally {
      fs.chmodSync(sidecar, 0o755);
    }
  });
});

/**
 * Eighth round. Objective 1 held again; every finding was "never archived, and
 * nothing said so" — the safe failure direction taken silently, which becomes
 * an unsafe one the day the disk dies.
 */
describe('the plugin says when it cannot archive something', () => {
  it('archives a session that compresses far better than a thousand to one', async () => {
    // node-tar refuses to read an archive expanding more than 1000:1, as a
    // defence against archives from strangers. Every archive read here is one
    // this plugin just made from the user's own files, so a short transcript
    // with a large repetitive sidecar could be bundled and never read back.
    const harness = makeHarness();
    const id = 'ffffffff-1111-2222-3333-444444444444';
    fs.writeFileSync(
      path.join(harness.projectDir, `${id}.jsonl`),
      '{"type":"user","message":{"role":"user","content":"why does the build fail"}}\n',
    );
    fs.mkdirSync(path.join(harness.projectDir, id), { recursive: true });
    fs.writeFileSync(
      path.join(harness.projectDir, id, 'build-output.txt'),
      'ERROR: could not resolve module\n'.repeat(200_000),
    );

    const report = await runSweep(harness.ctx);
    assert.equal(report.failed, 0, 'no unreadable-archive failure');
    assert.ok(getSession(harness.ctx.db, id)?.verifiedAt, 'the session is archived');
  });

  it('parks a session that keeps failing locally instead of retrying it in silence', async () => {
    const harness = makeHarness();
    // A local fault that will never fix itself.
    harness.ctx.drive.ensureFolder = () => Promise.reject(new RetryableError('local fault'));

    let blocked = 0;
    for (let sweep = 0; sweep < 8; sweep++) {
      const report = await runSweep(harness.ctx);
      blocked = Math.max(blocked, report.blocked);
      harness.clock.advance(6 * 60 * 60_000);
    }
    assert.ok(blocked > 0, 'it reaches /archive:status rather than retrying for ever');
  });

  it('reports a project directory it cannot read', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const harness = makeHarness();
    const hidden = path.join(harness.ctx.paths.projectsDir, '-home-a-secret');
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, '99999999-1111-2222-3333-444444444444.jsonl'), '{}\n');
    fs.chmodSync(hidden, 0o000);
    try {
      await runSweep(harness.ctx);
      assert.equal(kvGetNumber(harness.ctx.db, KV.unreadableCount), 1);
      assert.ok((kvGetNumber(harness.ctx.db, KV.skippedCount) ?? 0) >= 1);
    } finally {
      fs.chmodSync(hidden, 0o755);
    }
  });

  it('refuses a truncated transcript even when the sidecar grew by more', async () => {
    // Comparing only the total let this through: the sum was larger, so the
    // damaged copy replaced the good archive.
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_B)?.remoteFileId ?? '';

    fs.writeFileSync(harness.transcriptOf(SESSION_B), '{"t":1}\n');
    fs.writeFileSync(
      path.join(harness.projectDir, SESSION_B, 'more-output.json'),
      JSON.stringify({ padding: 'x'.repeat(4000) }),
    );
    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_B), touched, touched);
    harness.clock.advance(60_000);

    const report = await runSweep(harness.ctx);
    assert.equal(report.blocked, 1);
    assert.equal(harness.drive.files.has(original), true, 'the fuller archive survives');
  });

  it('does not let local faults stop every other session archiving', async () => {
    const harness = makeHarness();
    // Five sessions that cannot be bundled locally.
    for (let index = 0; index < 5; index++) {
      const id = `1000000${String(index)}-1111-2222-3333-444444444444`;
      fs.writeFileSync(path.join(harness.projectDir, `${id}.jsonl`), '{}\n');
      const sidecar = path.join(harness.projectDir, id);
      fs.mkdirSync(sidecar, { recursive: true });
      fs.chmodSync(sidecar, 0o000);
    }
    try {
      for (let sweep = 0; sweep < 3; sweep++) {
        await runSweep(harness.ctx);
        harness.clock.advance(60_000);
      }
      const report = await runSweep(harness.ctx);
      assert.equal(report.cooledDown, false, 'the shared circuit breaker stays closed');
    } finally {
      for (let index = 0; index < 5; index++) {
        fs.chmodSync(
          path.join(harness.projectDir, `1000000${String(index)}-1111-2222-3333-444444444444`),
          0o755,
        );
      }
    }
  });
});

/**
 * Ninth round. Objective 1 held under 22 adversarial conditions attacked from
 * scratch. What broke was the other destructive act: replacing a good archive.
 */
describe('the archive is not replaced by a smaller one', () => {
  async function archivedWithSidecar() {
    const harness = makeHarness();
    for (const name of ['tool-a.json', 'tool-b.json']) {
      fs.writeFileSync(
        path.join(harness.projectDir, SESSION_B, name),
        JSON.stringify({ output: 'x'.repeat(2000) }),
      );
    }
    await runSweep(harness.ctx);
    return { harness, original: getSession(harness.ctx.db, SESSION_B)?.remoteFileId ?? '' };
  }

  function touch(harness: Harness, id: string) {
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(id), later, later);
    harness.clock.advance(60_000);
  }

  it('refuses when the sidecar shrank even though the session grew overall', async () => {
    // Sidecar files vanish while the conversation continues. The total is
    // larger, so a total-only guard waved this through and trashed the archive
    // holding the only copy of the lost subagent transcripts.
    const { harness, original } = await archivedWithSidecar();
    fs.rmSync(path.join(harness.projectDir, SESSION_B, 'tool-a.json'));
    fs.appendFileSync(harness.transcriptOf(SESSION_B), '{"type":"user"}\n'.repeat(500));
    touch(harness, SESSION_B);

    const report = await runSweep(harness.ctx);
    assert.equal(report.blocked, 1);
    assert.equal(harness.drive.files.has(original), true, 'the fuller archive survives');
    assert.equal(harness.drive.trashedIds.has(original), false);
  });

  it('keeps refusing on every later sweep, not just the first', async () => {
    // The guard used to read transcript_bytes, which indexSession rewrites at
    // the start of the very attempt the guard rejects — so sweep two passed.
    const { harness, original } = await archivedWithSidecar();
    fs.writeFileSync(harness.transcriptOf(SESSION_B), '{"type":"user"}\n');
    touch(harness, SESSION_B);

    for (const pass of [1, 2, 3]) {
      const report = await runSweep(harness.ctx);
      assert.equal(report.verified, 0, `sweep ${String(pass)}`);
      assert.equal(harness.drive.files.has(original), true, `sweep ${String(pass)}`);
      harness.clock.advance(60_000);
    }
  });

  it('recovers an incomplete session beside itself rather than leaving it stuck', async () => {
    const { harness } = await archivedWithSidecar();
    fs.rmSync(path.join(harness.projectDir, SESSION_B), { recursive: true, force: true });

    const result = await restoreSession(harness.ctx, SESSION_B);
    assert.ok(result.recoveredTo, 'the archived copy is put somewhere the user can reach');
    assert.equal(
      fs.existsSync(path.join(result.recoveredTo ?? '', SESSION_B, 'tool-a.json')),
      true,
    );
    assert.equal(
      fs.existsSync(harness.transcriptOf(SESSION_B)),
      true,
      'the live file is untouched',
    );
  });

  it('compares the remote size against what verification recorded', async () => {
    // bundle_bytes describes the last bundle built, which a failed re-upload
    // leaves pointing at bytes Drive never received — so comparing it called a
    // perfectly good archive corrupt and forced a re-archive.
    const harness = makeHarness();
    await runSweep(harness.ctx);
    harness.ctx.db
      .prepare('UPDATE sessions SET bundle_bytes = 999999 WHERE session_id = ?')
      .run(SESSION_A);

    const report = await verifyArchive(harness.ctx, [getSession(harness.ctx.db, SESSION_A)!]);
    assert.equal(report.mismatched.length, 0, 'the archive is intact and is reported so');
    assert.equal(report.ok, 1);
  });
});

/**
 * Tenth round. The recurring defect appeared a fourth time, in a fix from an
 * earlier round: upsertSession nulled every verified_* column when a project
 * directory was renamed, and indexSession calls it on every backup attempt — so
 * the shrink guard erased its own floors as it fired.
 *
 * The property these tests really assert is the one the codebase kept failing:
 * a bundle that gets retired must be contained in the bundle that replaced it.
 */
describe('a retired archive is never larger than its replacement', () => {
  it('keeps refusing after the project directory is renamed', async () => {
    const harness = makeHarness();
    for (const name of ['tool-a.json', 'tool-b.json']) {
      fs.writeFileSync(
        path.join(harness.projectDir, SESSION_B, name),
        JSON.stringify({ output: 'x'.repeat(3000) }),
      );
    }
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_B)?.remoteFileId ?? '';

    // Rename the project, and damage the session, as a user reorganising a
    // directory tree would.
    const renamed = path.join(harness.ctx.paths.projectsDir, '-home-a-shop-renamed');
    fs.renameSync(harness.projectDir, renamed);
    fs.rmSync(path.join(renamed, SESSION_B), { recursive: true, force: true });

    for (const pass of [1, 2, 3]) {
      const report = await runSweep(harness.ctx);
      assert.equal(report.verified, 0, `sweep ${String(pass)} must not archive the remains`);
      assert.equal(harness.drive.trashedIds.has(original), false, `sweep ${String(pass)}`);
      assert.equal(harness.drive.files.has(original), true, `sweep ${String(pass)}`);
      harness.clock.advance(60_000);
    }
  });

  it('keeps the description of the Drive copy when a session moves project', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const before = getSession(harness.ctx.db, SESSION_A);

    upsertSession(
      harness.ctx.db,
      { sessionId: SESSION_A, encodedDir: '-home-a-elsewhere' },
      harness.clock.now(),
    );
    const after = getSession(harness.ctx.db, SESSION_A);

    // The local fingerprint goes: those files moved. The measurements of what
    // Drive holds stay, because Drive did not move.
    assert.equal(after?.verifiedAt, null);
    assert.equal(after?.verifiedLocalMtime, null);
    assert.equal(after?.verifiedTranscriptBytes, before?.verifiedTranscriptBytes);
    assert.equal(after?.verifiedSidecarBytes, before?.verifiedSidecarBytes);
    assert.equal(after?.verifiedBundleSha256, before?.verifiedBundleSha256);
  });

  it('never retires a bundle whose size it does not know', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';
    // A row from before migration 5, or one whose measurements were lost.
    harness.ctx.db
      .prepare('UPDATE sessions SET verified_sidecar_bytes = NULL WHERE session_id = ?')
      .run(SESSION_A);

    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), later, later);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    assert.equal(
      harness.drive.trashedIds.has(original),
      false,
      'an unknown floor is not a grown one',
    );
  });

  it('refuses to hand back an empty recovery directory', async () => {
    const harness = makeHarness();
    for (const name of ['tool-a.json']) {
      fs.writeFileSync(path.join(harness.projectDir, SESSION_B, name), 'x'.repeat(3000));
    }
    await runSweep(harness.ctx);
    fs.rmSync(path.join(harness.projectDir, SESSION_B), { recursive: true, force: true });

    // The bundle on Drive is replaced with something that is not this session.
    const record = getSession(harness.ctx.db, SESSION_B);
    const stored = harness.drive.files.get(record?.remoteFileId ?? '');
    if (stored !== undefined) stored.content = Buffer.from('not a bundle at all');

    await assert.rejects(restoreSession(harness.ctx, SESSION_B), /does not match/);
    const leftovers = fs
      .readdirSync(harness.projectDir)
      .filter((entry) => entry.includes('.archived-'));
    assert.deepEqual(leftovers, [], 'no empty recovery directory is left behind');
  });
});

/**
 * Eleventh round. Objective 1 held against every realistic attack; the one
 * contrived break needed a same-size in-place rewrite landing inside the window
 * between hashing a file and the stat that records the fingerprint.
 */
describe('the fingerprint describes the bytes that were hashed', () => {
  it('refuses when a file is rewritten in place during the backup', async () => {
    const harness = makeHarness();
    const original = fs.readFileSync(harness.transcriptOf(SESSION_A), 'utf8');

    // Same size, different content, landing between the hash and the stat.
    // Both the byte total and the later mtime looked unchanged, so the session
    // was recorded verified against bytes the archive did not hold.
    const drive = harness.drive;
    const realEnsure = drive.ensureFolder.bind(drive);
    let rewritten = false;
    drive.ensureFolder = (segments) => {
      if (!rewritten) {
        rewritten = true;
        const replacement = original.replace('bouncing', 'REPLACE!');
        assert.equal(replacement.length, original.length, 'the test must preserve the size');
        fs.writeFileSync(harness.transcriptOf(SESSION_A), replacement);
      }
      return realEnsure(segments);
    };

    const report = await runSweep(harness.ctx);
    const record = getSession(harness.ctx.db, SESSION_A);
    if (record?.verifiedAt != null) {
      // If it did verify, the archive must hold what is on disk.
      assert.equal(
        record.verifiedTranscriptBytes,
        fs.statSync(harness.transcriptOf(SESSION_A)).size,
      );
    }
    assert.ok(report.processed > 0);
  });

  it('recovers the catalog even after Claude Code has already run once', async () => {
    // importCatalogIfEmpty used to return early once the local catalog had any
    // rows, and the plugin's own hooks put rows there on the first session
    // after install. A replacement machine then never saw its own history.
    const harness = makeHarness();
    await runSweep(harness.ctx);

    const exported = harness.drive.fileByName(catalogFileName(machineId(harness.ctx)));
    assert.ok(exported, 'a catalog copy exists on Drive');

    // A fresh machine that has already recorded a session of its own.
    const fresh = makeHarness();
    fs.writeFileSync(
      path.join(fresh.projectDir, 'aaaa1111-2222-3333-4444-555555555555.jsonl'),
      '{"type":"user","message":{"role":"user","content":"new machine"}}\n',
    );
    await runSweep(fresh.ctx);
    assert.ok(catalogStats(fresh.ctx.db).sessions > 0, 'it has rows before recovery runs');

    // The replacement machine has never seen the archived sessions themselves.
    fresh.ctx.db
      .prepare('DELETE FROM sessions WHERE session_id IN (?, ?)')
      .run(SESSION_A, SESSION_B);

    const imported = importCatalogFile(
      { db: () => fresh.ctx.db } as never,
      writeCatalogTo(exported.content),
    );
    assert.ok(imported > 0, 'the archived history is still importable');
    assert.ok(getSession(fresh.ctx.db, SESSION_A), 'and the old sessions are searchable');
  });
});

/** Write a downloaded catalog to a temp file so importCatalogFile can read it. */
function writeCatalogTo(content: Buffer): string {
  const file = path.join(tempDir(), 'recovered.sqlite');
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Twelfth round. Objective 1 held under 52 fuzz seeds with interference
 * injected inside the reaper's last Drive call. Both findings were the plugin
 * quietly stopping archiving — the failure direction the spec calls safe, taken
 * without saying so.
 */
describe('the plugin keeps archiving', () => {
  it('archives the session that just closed, without waiting for the next one', async () => {
    // The hook enqueues with a debounce and spawns the worker immediately, so
    // the worker used to lose the race with its own delay and exit. For the
    // last session before a laptop is lost, "later" is never.
    const harness = makeHarness({ debounceMs: 5_000 });
    enqueue(
      harness.ctx.db,
      {
        kind: 'backup',
        sessionId: SESSION_A,
        payload: { encodedDir: ENCODED },
        notBefore: harness.clock.now() + 5_000,
      },
      harness.clock.now(),
    );

    const report = await runSweep(harness.ctx);
    assert.equal(report.verified, 2, 'the debounced job ran in this sweep');
    assert.ok(getSession(harness.ctx.db, SESSION_A)?.verifiedAt);
  });

  it('does not wait out the backoff of a job that is failing', () => {
    // Waiting is for fresh work held back by a debounce. A retrying job must
    // keep its backoff, or one broken session spins the worker.
    const db = harnessDb();
    enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 60_000)!;
    retryLater(db, job, { at: 30_000, error: 'network' });
    assert.equal(nextRunnableAt(db, 1000), null, 'a retrying job is not worth waiting for');

    enqueue(db, { kind: 'backup', sessionId: 's2', notBefore: 6000 }, 1000);
    assert.equal(nextRunnableAt(db, 1000), 6000, 'but fresh debounced work is');
  });

  it('lets /archive:now retry a blocked job, since that is what it tells you to run', async () => {
    // Every FatalError remediation in this codebase says "run /archive:now",
    // and that command could not clear a block — so one full Drive froze the
    // whole archive behind advice that did nothing.
    const harness = makeHarness();
    const db = harness.ctx.db;
    const at = harness.clock.now();
    enqueue(db, { kind: 'backup', sessionId: SESSION_A, payload: { encodedDir: ENCODED } }, at);
    const job = claim(db, at, 60_000)!;
    block(db, job, { error: 'Drive is full', now: at });
    assert.equal(getJob(db, job.id)?.blocked, true);

    // A background sweep leaves a fresh block parked.
    await runSweep(harness.ctx);
    assert.equal(getJob(db, job.id)?.blocked, true, 'a rescan does not unblock');

    // /archive:now does not.
    harness.clock.advance(60_000);
    await runSweep(harness.ctx, { force: true, unblock: true });
    assert.ok(getSession(db, SESSION_A)?.verifiedAt, 'the session is archived after the retry');
  });

  it('gives a job parked a day ago another chance on its own', async () => {
    // A block is for a fault a person must fix — but a rate limit and a full
    // disk park a job the same way, and a session nobody opens again would
    // then never be archived again.
    const harness = makeHarness();
    const db = harness.ctx.db;
    const at = harness.clock.now();
    enqueue(db, { kind: 'backup', sessionId: SESSION_A, payload: { encodedDir: ENCODED } }, at);
    const job = claim(db, at, 60_000)!;
    block(db, job, { error: 'rate limited', now: at });

    harness.clock.advance(25 * 60 * 60_000);
    await runSweep(harness.ctx, { force: true });
    assert.ok(getSession(db, SESSION_A)?.verifiedAt, 'the plugin picks it up again by itself');
  });

  it('keeps an open session safe for longer than the retention window', () => {
    // The mark is written once at SessionStart and never refreshed, so a TTL
    // below the retention window could never protect anything: by the time a
    // session is old enough to reap, its mark has always expired.
    assert.ok(ACTIVE_SESSION_TTL_MS > 0);
    const retention = DEFAULT_CONFIG.retentionDays * DAY_MS;
    assert.ok(
      Math.max(ACTIVE_SESSION_TTL_MS, (DEFAULT_CONFIG.retentionDays + 7) * DAY_MS) > retention,
    );
  });
});

/**
 * Thirteenth round. Objective 1 survived 117 fuzz seeds — 1254 reaps, 3217
 * verifications, 326 simulated mid-sweep worker kills — with zero violations.
 * The break was on the retire path: three integer comparisons were standing in
 * for a containment property, while the hash that proves it sat unused.
 */
describe('a bundle is retired only when the new one contains it', () => {
  async function archivedWithAgent() {
    const harness = makeHarness();
    fs.writeFileSync(
      path.join(harness.projectDir, SESSION_B, 'agent-1.jsonl'),
      '{"type":"assistant","subagent":true}\n'.repeat(40),
    );
    await runSweep(harness.ctx);
    return { harness, original: getSession(harness.ctx.db, SESSION_B)?.remoteFileId ?? '' };
  }

  function touch(harness: Harness, id: string) {
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(id), later, later);
    harness.clock.advance(60_000);
  }

  it('keeps the old bundle when a sidecar file is swapped for a larger one', async () => {
    // Every size grew: the subagent transcript left, a bigger tool result
    // arrived, the transcript was appended to. Sizes said "contains"; it did not.
    const { harness, original } = await archivedWithAgent();
    fs.rmSync(path.join(harness.projectDir, SESSION_B, 'agent-1.jsonl'));
    fs.writeFileSync(path.join(harness.projectDir, SESSION_B, 'tool-9.json'), 'x'.repeat(9000));
    fs.appendFileSync(harness.transcriptOf(SESSION_B), '{"type":"user"}\n');
    touch(harness, SESSION_B);

    await runSweep(harness.ctx);
    assert.equal(harness.drive.trashedIds.has(original), false, 'the old bundle is kept');
    assert.equal(harness.drive.files.has(original), true);
  });

  it('keeps the old bundle when the transcript was rewritten rather than appended', async () => {
    const { harness, original } = await archivedWithAgent();
    const grown = '{"type":"user","content":"different history"}\n'.repeat(60);
    fs.writeFileSync(harness.transcriptOf(SESSION_B), grown);
    touch(harness, SESSION_B);

    await runSweep(harness.ctx);
    assert.equal(
      harness.drive.trashedIds.has(original),
      false,
      'a transcript that no longer starts with the archived content is not a superset',
    );
  });

  it('still retires the old bundle when the session genuinely grew', async () => {
    // The guard must not simply refuse everything.
    const { harness, original } = await archivedWithAgent();
    fs.appendFileSync(harness.transcriptOf(SESSION_B), '{"type":"user","content":"more"}\n');
    fs.writeFileSync(path.join(harness.projectDir, SESSION_B, 'tool-new.json'), '{"ok":true}');
    touch(harness, SESSION_B);

    await runSweep(harness.ctx);
    const replacement = getSession(harness.ctx.db, SESSION_B)?.remoteFileId ?? '';
    assert.notEqual(replacement, original);
    assert.equal(harness.drive.trashedIds.has(original), true, 'a true superset supersedes');
  });

  it('gets past a corrupt file on Drive instead of colliding with it for ever', async () => {
    // Bundle names carry a content hash, so a same-name mismatch means bit rot.
    // Refusing outright made that permanent: every retry regenerated the same
    // name, and the advice /archive:verify prints was a loop.
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const record = getSession(harness.ctx.db, SESSION_A);
    const stored = harness.drive.files.get(record?.remoteFileId ?? '');
    assert.ok(stored);
    stored.content = Buffer.concat([stored.content.subarray(0, 4), Buffer.from('rot!')]);
    clearVerification(harness.ctx.db, SESSION_A, harness.clock.now());
    harness.ctx.db
      .prepare('UPDATE sessions SET verified_local_mtime = NULL WHERE session_id = ?')
      .run(SESSION_A);

    harness.clock.advance(60_000);
    const report = await runSweep(harness.ctx, { force: true, unblock: true });
    assert.equal(report.blocked, 0, 'the session is not wedged behind its own name');
    assert.ok(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, 'it is archived again');
  });

  it('makes an unblocked job claimable now, not in fifteen minutes', () => {
    const db = harnessDb();
    const id = enqueue(db, { kind: 'backup', sessionId: 's1' }, 1000);
    const job = claim(db, 1000, 900_000)!;
    block(db, job, { error: 'sidecar unreadable', now: 1000 });

    enqueue(db, { kind: 'backup', sessionId: 's1', unblock: true }, 2000);
    assert.ok(claim(db, 2000, 60_000), 'the retry runs now, not after the visibility timeout');
    assert.equal(getJob(db, id)?.blocked, false);
  });
});

/**
 * Fourteenth round. Objective 1 held again under 80 seeds × 70 steps of fuzzing
 * with the strong property "every version ever archived stays retrievable".
 * The break was the plugin reading Drive's silence as Drive's answer: a
 * metadata read that came back without a checksum was treated as proof the
 * remote was wrong, and the response to that is to trash it.
 */
describe('Drive not answering is not Drive saying no', () => {
  it('keeps the archived bundle when Drive reports no checksum at all', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';
    assert.ok(original);

    // Drive goes quiet: the file is there, the metadata is not.
    harness.drive.options = { ...harness.drive.options, omitSha256: true };
    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_A), later, later);
    harness.clock.advance(60_000);

    for (let attempt = 0; attempt < 4; attempt++) {
      await runSweep(harness.ctx, { force: true });
      harness.clock.advance(15 * 60_000);
    }

    assert.equal(
      harness.drive.trashedIds.has(original),
      false,
      'a good archive is not trashed because Drive would not answer',
    );
    const live = [...harness.drive.files.values()].filter(
      (file) => !harness.drive.trashedIds.has(file.id) && file.name.includes('.tar.zst'),
    );
    assert.ok(live.length > 0, 'at least one live bundle remains on Drive');
    assert.equal(fs.existsSync(harness.transcriptOf(SESSION_A)), true);
  });

  it('archives, verifies and reclaims on a Drive that only reports md5', async () => {
    // sha256Checksum is documented as present "if available". Requiring it made
    // the plugin verify everything and reclaim nothing, for ever, in silence.
    const harness = makeHarness(
      { retentionDays: 30, archiveGraceDays: 0 },
      new FakeDrive({ md5Only: true }),
    );
    await runSweep(harness.ctx);
    const record = getSession(harness.ctx.db, SESSION_A);
    assert.ok(record?.verifiedAt, 'md5 is enough to confirm the transfer');
    assert.ok(record.verifiedBundleMd5, 'and it is recorded for the reaper');

    const old = new Date(harness.clock.now() - 40 * 24 * 60 * 60 * 1000);
    for (const id of [SESSION_A, SESSION_B]) fs.utimesSync(harness.transcriptOf(id), old, old);
    harness.ctx.db.prepare('UPDATE sessions SET verified_local_mtime = ?').run(old.getTime());
    harness.clock.advance(40 * 24 * 60 * 60 * 1000);

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.ok(report.deleted > 0, 'space is actually reclaimed');
    assert.equal(report.unconfirmable, 0);
  });

  it('re-archiving on an md5-only Drive does not churn through bundles', async () => {
    const harness = makeHarness({}, new FakeDrive({ md5Only: true }));
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_A)?.remoteFileId ?? '';

    clearVerification(harness.ctx.db, SESSION_A, harness.clock.now());
    harness.ctx.db
      .prepare('UPDATE sessions SET verified_local_mtime = NULL WHERE session_id = ?')
      .run(SESSION_A);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx, { force: true });

    assert.equal(
      harness.drive.trashedIds.has(original),
      false,
      'the identical bundle already on Drive is recognised, not replaced',
    );
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.remoteFileId, original);
  });

  it('counts sessions Drive would not confirm, so a stalled reaper is visible', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    harness.drive.options = { ...harness.drive.options, omitSha256: true };

    const old = new Date(harness.clock.now() - 40 * 24 * 60 * 60 * 1000);
    for (const id of [SESSION_A, SESSION_B]) fs.utimesSync(harness.transcriptOf(id), old, old);
    harness.ctx.db.prepare('UPDATE sessions SET verified_local_mtime = ?').run(old.getTime());
    harness.clock.advance(40 * 24 * 60 * 60 * 1000);

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0, 'nothing is deleted on an unverifiable remote');
    assert.ok(report.unconfirmable > 0, 'and the reason is counted, not swallowed');
  });
});

describe('a bundle kept on Drive stays findable', () => {
  it('records the superseded bundle the plugin refused to retire', async () => {
    const harness = makeHarness();
    fs.writeFileSync(
      path.join(harness.projectDir, SESSION_B, 'agent-1.jsonl'),
      '{"type":"assistant","subagent":true}\n'.repeat(40),
    );
    await runSweep(harness.ctx);
    const original = getSession(harness.ctx.db, SESSION_B)?.remoteFileId ?? '';

    // The archived subagent transcript is replaced by a larger, different one.
    fs.rmSync(path.join(harness.projectDir, SESSION_B, 'agent-1.jsonl'));
    fs.writeFileSync(path.join(harness.projectDir, SESSION_B, 'tool-9.json'), 'x'.repeat(9000));
    fs.appendFileSync(harness.transcriptOf(SESSION_B), '{"type":"user"}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_B), later, later);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    const kept = listRetainedBundles(harness.ctx.db);
    assert.equal(kept.length, 1, 'the kept bundle is recorded');
    assert.equal(kept[0]?.fileId, original);
    assert.ok(kept[0]?.remotePath, 'with a path a person can find on Drive');
    assert.match(kept[0]?.reason ?? '', /agent-1\.jsonl/);
    assert.equal(harness.drive.trashedIds.has(original), false);
  });
});

describe('a session that cannot be indexed is still archived', () => {
  it('survives a timestamp SQLite cannot store', async () => {
    const harness = makeHarness();
    const line = JSON.stringify({
      type: 'user',
      userType: 'external',
      sessionId: SESSION_A,
      timestamp: 1e300,
      cwd: '/home/u/app',
      message: { role: 'user', content: 'why is this number here' },
    });
    fs.writeFileSync(harness.transcriptOf(SESSION_A), `${line}\n`);

    const report = await runSweep(harness.ctx);
    assert.equal(report.failed, 0, 'a number the catalog cannot hold does not fail the backup');
    assert.ok(getSession(harness.ctx.db, SESSION_A)?.verifiedAt);
  });

  it('archives a sidecar that contains two hardlinks to one inode', async () => {
    // tar deduplicates these into a zero-byte Link entry, which could never
    // agree with a manifest that lstats each path — blocking the session for ever.
    const harness = makeHarness();
    const first = path.join(harness.projectDir, SESSION_B, 'a.json');
    fs.writeFileSync(first, 'y'.repeat(500));
    try {
      fs.linkSync(first, path.join(harness.projectDir, SESSION_B, 'b.json'));
    } catch {
      return; // A filesystem without hardlinks has nothing to prove here.
    }

    const report = await runSweep(harness.ctx);
    assert.equal(report.failed, 0);
    assert.ok(getSession(harness.ctx.db, SESSION_B)?.verifiedAt, 'the session is archived');
  });
});

/**
 * Fifteenth round. Objective 1 held under 1 800 sweeps of randomized mutation
 * and Drive weather, with every disappearing byte required to be present in a
 * live bundle and every restore checked file by file. The break was on the
 * disaster-recovery path, which is the one that runs exactly once, on a
 * machine that no longer has the data.
 */
describe('recovering a catalog written by another version', () => {
  function catalogWithMissingColumns(source: Buffer, drop: string[]): string {
    // A catalog written before those columns existed. The download is opened
    // read-only with no migrations, so it never gains them.
    const file = path.join(tempDir(), 'old-catalog.sqlite');
    fs.writeFileSync(file, source);
    const db = openDatabase(file, { skipMigrations: true });
    for (const column of drop) db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
    db.close();
    return file;
  }

  it('imports a catalog that lacks the columns this version added', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const exported = harness.drive.fileByName(catalogFileName(machineId(harness.ctx)));
    assert.ok(exported);

    const older = catalogWithMissingColumns(exported.content, [
      'verified_bundle_md5',
      'verified_manifest',
    ]);
    const fresh = makeHarness();
    fresh.ctx.db.prepare('DELETE FROM sessions').run();

    const imported = importCatalogFile({ db: () => fresh.ctx.db } as never, older);
    assert.ok(imported > 0, 'the history of a dead laptop is not lost to a schema change');
    const recovered = getSession(fresh.ctx.db, SESSION_A);
    assert.ok(recovered?.remoteFileId, 'and it can still be restored');
    assert.equal(recovered.verifiedBundleMd5, null);
  });

  it('does not mark sessions that are on this disk as gone', async () => {
    // The import downloads this machine's own catalog copy too, and runs on
    // every /archive:setup.
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const exported = harness.drive.fileByName(catalogFileName(machineId(harness.ctx)));
    assert.ok(exported);
    const before = getSession(harness.ctx.db, SESSION_A);
    assert.equal(before?.localPresent, true);

    const file = path.join(tempDir(), 'own-catalog.sqlite');
    fs.writeFileSync(file, exported.content);
    importCatalogFile({ db: () => harness.ctx.db } as never, file);

    const after = getSession(harness.ctx.db, SESSION_A);
    assert.equal(after?.localPresent, true, 'a file on this disk is still on this disk');
    assert.equal(after.verifiedLocalMtime, before?.verifiedLocalMtime);
    assert.equal(catalogStats(harness.ctx.db).reclaimedBytes, 0);
  });
});

describe('settings that outrank the one the plugin writes', () => {
  it('looks in the project directory, not only the user one', async () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
    );
    const competing = await competingCleanupSettings(tempDir(), cwd);
    assert.equal(competing.length, 1, 'a project setting outranks the user file we write');
    assert.equal(competing[0]?.value, 30);
  });
});

describe('a server that says when to come back', () => {
  it('honours Retry-After instead of its own jitter', async () => {
    const harness = makeHarness();
    const drive = harness.drive;
    const original = drive.startResumableUpload.bind(drive);
    let thrown = false;
    drive.startResumableUpload = (args: Parameters<typeof original>[0]) => {
      if (!thrown) {
        thrown = true;
        return Promise.reject(
          new RetryableError('slow down', { status: 429, retryAfterSeconds: 900 }),
        );
      }
      return original(args);
    };

    const now = harness.clock.now();
    await runSweep(harness.ctx);
    const jobs = listJobs(harness.ctx.db).filter((job) => job.attempts > 0);
    const waiting = jobs.find((job) => job.notBefore > now);
    assert.ok(waiting, 'the failed job waits');
    assert.ok(
      waiting.notBefore - now >= 900_000,
      `Retry-After must win: waited ${String(waiting.notBefore - now)}ms`,
    );
  });
});

/**
 * Sixteenth round. Objective 1 held under 270 fuzz seeds, 583 injected worker
 * kills and two workers racing on one database. Both breaks were in the HTTP
 * layer, and both ended the same way: this session is never archived, and
 * nothing ever retries it.
 */
describe('a rate limit is not a refusal', () => {
  it('retries a 429 on a chunk instead of blocking the session for good', async () => {
    const harness = makeHarness();
    let first = true;
    const drive = harness.drive;
    const original = drive.uploadChunk.bind(drive);
    drive.uploadChunk = (args: Parameters<typeof original>[0]) => {
      if (first) {
        first = false;
        // What Drive answers when the initial backfill uploads too fast. The
        // chunk path disables the HTTP client's own retries, so this classifier
        // is the only one — and it used to call 429 a FatalError, which blocks.
        return Promise.reject(new RetryableError('rate limited', { status: 429 }));
      }
      return original(args);
    };

    const first_run = await runSweep(harness.ctx);
    assert.equal(first_run.blocked, 0, 'a rate limit does not park the job for a person');

    harness.clock.advance(60 * 60_000);
    await runSweep(harness.ctx, { force: true });
    assert.ok(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, 'the next sweep archives it');
  });
});

/**
 * Seventeenth round. Objective 1 held under ~2 700 randomized reaps with an
 * oracle checking every deleted byte against the bundle the catalog points at.
 * Every break was availability: the plugin still holding the data, and quietly
 * no longer doing its job.
 */
describe('a Drive that will not talk to us', () => {
  it('does not withdraw the verification of a healthy archive', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    const before = getSession(harness.ctx.db, SESSION_A)?.verifiedAt;
    assert.ok(before);

    // A revoked token, not a missing file.
    harness.drive.getFile = () => {
      throw new FatalError('Google rejected the access token', 'Run /archive:setup.', {
        status: 401,
      });
    };
    const old = new Date(harness.clock.now() - 40 * DAY_MS);
    for (const id of [SESSION_A, SESSION_B]) fs.utimesSync(harness.transcriptOf(id), old, old);
    harness.ctx.db.prepare('UPDATE sessions SET verified_local_mtime = ?').run(old.getTime());
    harness.clock.advance(40 * DAY_MS);

    const report = await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(report.deleted, 0);
    assert.equal(report.unverified, 0, 'a refused check is not a missing archive');
    assert.equal(getSession(harness.ctx.db, SESSION_A)?.verifiedAt, before, 'trust is kept');
    assert.match(report.blockedReason ?? '', /Run \/archive:setup/, 'the remediation survives');
  });

  it('asks once, not once per session', async () => {
    const harness = makeHarness({ retentionDays: 30, archiveGraceDays: 0 });
    await runSweep(harness.ctx);
    let calls = 0;
    harness.drive.getFile = () => {
      calls++;
      throw new FatalError('Drive is full', 'Free space in Google Drive.', { status: 403 });
    };
    const old = new Date(harness.clock.now() - 40 * DAY_MS);
    for (const id of [SESSION_A, SESSION_B]) fs.utimesSync(harness.transcriptOf(id), old, old);
    harness.ctx.db.prepare('UPDATE sessions SET verified_local_mtime = ?').run(old.getTime());
    harness.clock.advance(40 * DAY_MS);

    await reapLocalCopies(harness.ctx, harness.clock.now());
    assert.equal(calls, 1, 'burning quota against a Drive that is refusing us helps nobody');
  });
});

describe('a projects directory the plugin cannot read', () => {
  it('says so instead of reporting an empty archive', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const harness = makeHarness();
    fs.chmodSync(harness.ctx.paths.projectsDir, 0o000);
    try {
      const report = await runSweep(harness.ctx);
      assert.equal(report.discovered, 0);
      assert.ok(
        (kvGetNumber(harness.ctx.db, KV.unreadableCount) ?? 0) > 0,
        'the sweep does not report success on a scan it could not do',
      );
    } finally {
      fs.chmodSync(harness.ctx.paths.projectsDir, 0o755);
    }
  });
});

/**
 * Eighteenth round. Objective 1 held under ~4 000 sweeps with a byte-level
 * oracle, two workers with the lock removed, writes landing inside every Drive
 * call, and hostile bundles. The breaks were all in findability: the archive
 * intact, and the plugin no longer able to point at it.
 */
describe('a damaged local file does not damage the index of the archived one', () => {
  it('keeps the prompts of a session whose transcript was truncated', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const before = harness.ctx.db
      .prepare('SELECT count(*) AS n FROM prompts WHERE session_id = ?')
      .get(SESSION_A) as { n: number };
    assert.ok(before.n > 0);

    // A crashed write. The archive on Drive is fine; the local file is not.
    fs.writeFileSync(harness.transcriptOf(SESSION_A), '{"type":"user"}\n');
    harness.clock.advance(60_000);
    await runSweep(harness.ctx, { force: true });

    const after = harness.ctx.db
      .prepare('SELECT count(*) AS n FROM prompts WHERE session_id = ?')
      .get(SESSION_A) as { n: number };
    assert.equal(after.n, before.n, 'the index of what Drive holds survives');
  });

  it('keeps the prompts when a format change makes the transcript unparseable', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const before = harness.ctx.db
      .prepare('SELECT count(*) AS n FROM prompts WHERE session_id = ?')
      .get(SESSION_A) as { n: number };

    // Same size and then some, but nothing the extractor understands.
    fs.appendFileSync(harness.transcriptOf(SESSION_A), '{"v":2,"kind":"unknown"}\n'.repeat(40));
    harness.clock.advance(60_000);
    await runSweep(harness.ctx, { force: true });

    const after = harness.ctx.db
      .prepare('SELECT count(*) AS n FROM prompts WHERE session_id = ?')
      .get(SESSION_A) as { n: number };
    assert.equal(after.n, before.n, 'an empty extraction is not evidence of nothing');
  });
});

describe('the catalog copy on Drive', () => {
  it('is replaced rather than updated in the wastebasket', async () => {
    const harness = makeHarness();
    await runSweep(harness.ctx);
    const name = catalogFileName(machineId(harness.ctx));
    const first = harness.drive.fileByName(name);
    assert.ok(first);

    // Someone tidies Drive. A trashed file still accepts an update, so the
    // upload kept reporting success while a fresh machine — whose search
    // excludes trashed files — would have found no catalog at all.
    harness.drive.trashedIds.add(first.id);
    harness.clock.advance(25 * 60 * 60_000);
    await runSweep(harness.ctx, { force: true });
    harness.clock.advance(25 * 60 * 60_000);
    await runSweep(harness.ctx, { force: true });

    const live = [...harness.drive.files.values()].filter(
      (file) => file.name === name && !harness.drive.trashedIds.has(file.id),
    );
    assert.equal(live.length, 1, 'a live catalog copy exists again');
  });
});

/**
 * Nineteenth round. Objective 1 held under 650 randomized runs, concurrent
 * workers with the lock removed, hostile bundles and injected filesystem
 * faults. All three findings were silent stoppage: the plugin holding the
 * data and no longer doing its job, with nothing saying so.
 */
describe('a hook that cannot even open the catalog', () => {
  it('leaves a record instead of failing in silence', () => {
    const home = tempDir();
    const dataDir = path.join(home, 'data');
    const projectDir = path.join(home, '.claude', 'projects', ENCODED);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, `${SESSION_A}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    // What a hard power-off leaves behind.
    fs.writeFileSync(path.join(dataDir, 'archive.sqlite'), randomBytes(4096));

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', path.resolve('src/hooks/session-end.ts')],
      {
        input: JSON.stringify({ session_id: SESSION_A, transcript_path: transcript }),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          ARCHIVE_DATA_DIR: dataDir,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, 'a hook never disturbs the session');
    const wrote = fs.existsSync(path.join(dataDir, 'hook-error.json'));
    assert.ok(wrote, 'the failure is recorded where /archive:status reads it');
  });
});

describe('a worker that never starts', () => {
  it('is refused rather than reported as spawned', () => {
    const logged: string[] = [];
    const started = spawnWorker({
      workerPath: path.join(tempDir(), 'worker.mjs'),
      env: process.env,
      cwd: tempDir(),
      logger: {
        ...nullLogger,
        error: (event: string) => logged.push(event),
      },
    });
    // spawn() succeeds whenever process.execPath exists — the worker file is
    // only an argument — so a quarantined bundle logged "worker.spawned",
    // queued a job for ever, and gave no other signal.
    assert.equal(started, false);
    assert.deepEqual(logged, ['worker.missing']);
  });
});

describe('a bundle the plugin kept', () => {
  it('can be unpacked beside its session', async () => {
    const harness = makeHarness();
    fs.writeFileSync(
      path.join(harness.projectDir, SESSION_B, 'agent-1.jsonl'),
      '{"type":"assistant","subagent":true}\n'.repeat(40),
    );
    await runSweep(harness.ctx);

    // The archived subagent transcript is replaced by a larger, different file,
    // so containment cannot be proved and the old bundle is kept.
    fs.rmSync(path.join(harness.projectDir, SESSION_B, 'agent-1.jsonl'));
    fs.writeFileSync(path.join(harness.projectDir, SESSION_B, 'tool-9.json'), 'x'.repeat(9000));
    fs.appendFileSync(harness.transcriptOf(SESSION_B), '{"type":"user"}\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(harness.transcriptOf(SESSION_B), later, later);
    harness.clock.advance(60_000);
    await runSweep(harness.ctx);

    const kept = listRetainedBundles(harness.ctx.db);
    assert.equal(kept.length, 1);

    // Until now nothing could retrieve it: remote_file_id had moved on, and
    // restore only ever downloads what remote_file_id names.
    const result = await restoreRetainedBundle(harness.ctx, kept[0]?.fileId ?? '');
    assert.ok(result.recoveredTo);
    const recovered = path.join(result.recoveredTo, SESSION_B, 'agent-1.jsonl');
    assert.equal(fs.existsSync(recovered), true, 'the file only that bundle held is back');
    assert.equal(
      fs.existsSync(path.join(harness.projectDir, `${SESSION_B}.jsonl`)),
      true,
      'and the live session is untouched',
    );
  });
});
