import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/adapters/db.ts';
import { sha256File } from '../src/adapters/hashing.ts';
import { clearVerification, getSession, upsertSession } from '../src/core/catalog.ts';
import { DEFAULT_CONFIG, type ArchiveConfig, DAY_MS } from '../src/core/config.ts';
import { RetryableError } from '../src/core/errors.ts';
import { resolvePaths } from '../src/core/paths.ts';
import { listJobs } from '../src/core/queue.ts';
import { catalogFileName, runSweep } from '../src/worker/sweep.ts';
import { restoreSession, verifyArchive } from '../src/worker/restore.ts';
import { reapLocalCopies } from '../src/worker/reap.ts';
import type { WorkerContext } from '../src/worker/context.ts';
import { nullLogger } from '../src/ports/logger.ts';
import { competingCleanupSettings } from '../src/adapters/claude-settings.ts';
import { createExtractor } from '../src/core/transcript.ts';
import { kvGetNumber, kvSetNumber } from '../src/adapters/db.ts';
import { KV, activeSessionKey } from '../src/core/state-keys.ts';
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
    assert.ok(harness.drive.fileByName(catalogFileName()));
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

  it('deletes the bad remote copy rather than leaving it to be trusted later', async () => {
    const harness = makeHarness({}, new FakeDrive({ corruptChecksums: true }));
    await runSweep(harness.ctx);
    const bundles = [...harness.drive.files.values()].filter((file) =>
      file.name.endsWith('.tar.zst'),
    );
    assert.deepEqual(bundles, []);
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
    const harness = makeHarness({ retentionDays: 30 }, new FakeDrive({ trashed: true }));
    await runSweep(harness.ctx);
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

    harness.clock.advance(31 * DAY);
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
    assert.equal(harness.drive.files.has(original), false, 'the old one was retired after');
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
