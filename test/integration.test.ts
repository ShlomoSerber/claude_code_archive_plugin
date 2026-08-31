import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/adapters/db.ts';
import { sha256File } from '../src/adapters/hashing.ts';
import { getSession } from '../src/core/catalog.ts';
import { DEFAULT_CONFIG, type ArchiveConfig, DAY_MS } from '../src/core/config.ts';
import { resolvePaths } from '../src/core/paths.ts';
import { listJobs } from '../src/core/queue.ts';
import { runSweep } from '../src/worker/sweep.ts';
import { restoreSession } from '../src/worker/restore.ts';
import { reapLocalCopies } from '../src/worker/reap.ts';
import type { WorkerContext } from '../src/worker/context.ts';
import { nullLogger } from '../src/ports/logger.ts';
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
    // on 2026-08-31. The name must follow the session, not the sweep.
    assert.equal(record.bundleName, '2026-08-20_auth-redirect-fix_aaaaaaaa.tar.zst');
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
    assert.ok(harness.drive.fileByName('catalog.sqlite'));
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
    await assert.rejects(restoreSession(harness.ctx, SESSION_A), /no verified copy/);
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
