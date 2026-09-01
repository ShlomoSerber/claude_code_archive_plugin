import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHUNK_ALIGNMENT,
  alignChunkSize,
  confirmedFromRange,
  escapeQuery,
  interpretUploadResponse,
  toRemoteFile,
} from '../src/adapters/drive-http.ts';
import { FatalError, RetryableError, UploadSessionExpired } from '../src/core/errors.ts';
import { createLazyDrive } from '../src/adapters/lazy-drive.ts';
import { FakeDrive } from './fakes/fake-drive.ts';
import { matchesLocal } from '../src/worker/upload.ts';
import { compareChecksums } from '../src/worker/backup.ts';

describe('confirmedFromRange', () => {
  it('reads an inclusive range as a byte count', () => {
    assert.equal(confirmedFromRange('bytes=0-262143'), 262_144);
  });

  it('treats a missing header as nothing received', () => {
    assert.equal(confirmedFromRange(null), 0);
    assert.equal(confirmedFromRange('nonsense'), 0);
  });
});

describe('alignChunkSize', () => {
  it('rounds down to Drive 256 KiB requirement', () => {
    assert.equal(alignChunkSize(CHUNK_ALIGNMENT * 3 + 17), CHUNK_ALIGNMENT * 3);
  });

  it('never returns zero', () => {
    assert.equal(alignChunkSize(1), CHUNK_ALIGNMENT);
  });
});

describe('escapeQuery', () => {
  it('escapes the quote that would break a Drive q expression', () => {
    assert.equal(escapeQuery("o'brien"), "o\\'brien");
    assert.equal(escapeQuery('a\\b'), 'a\\\\b');
  });
});

describe('toRemoteFile', () => {
  it('parses the 64-bit size Drive sends as a string', () => {
    const file = toRemoteFile({ id: 'x', name: 'b.tar.zst', size: '4294967296' });
    assert.equal(file.size, 4_294_967_296);
  });

  it('reports absent checksums as absent, not as empty strings', () => {
    const file = toRemoteFile({ id: 'x', name: 'n' });
    assert.equal(file.sha256, null);
    assert.equal(file.md5, null);
  });

  it('refuses a response with no id', () => {
    assert.throws(() => toRemoteFile({ name: 'no id' }), /no id/);
  });
});

describe('interpretUploadResponse', () => {
  it('reads a 308 as progress, from the Range header', async () => {
    const response = new Response(null, { status: 308, headers: { range: 'bytes=0-99' } });
    const progress = await interpretUploadResponse(response, 1000);
    assert.deepEqual(progress, { confirmedBytes: 100, done: false, file: null });
  });

  it('reads a 200 as the finished file', async () => {
    const response = new Response(JSON.stringify({ id: 'f1', name: 'b', size: '10' }), {
      status: 200,
    });
    const progress = await interpretUploadResponse(response, 10);
    assert.equal(progress.done, true);
    assert.equal(progress.file?.id, 'f1');
  });

  it('treats 404 and 410 as an expired session, not as a failure to retry', async () => {
    await assert.rejects(
      interpretUploadResponse(new Response(null, { status: 404 }), 10),
      UploadSessionExpired,
    );
    await assert.rejects(
      interpretUploadResponse(new Response(null, { status: 410 }), 10),
      UploadSessionExpired,
    );
  });

  it('treats a 403 as fatal and a 500 as retryable', async () => {
    await assert.rejects(
      interpretUploadResponse(new Response('{"error":{"message":"denied"}}', { status: 403 }), 10),
      /Drive refused the upload/,
    );
    await assert.rejects(
      interpretUploadResponse(new Response('{}', { status: 500 }), 10),
      /Drive upload failed/,
    );
  });
});

describe('matchesLocal', () => {
  const bundle = { totalBytes: 100, sha256: 'abc', md5: 'def' };

  it('accepts a remote file with the same size and hash', () => {
    assert.equal(
      matchesLocal(
        { id: 'x', name: 'n', size: 100, sha256: 'ABC', md5: null, trashed: false },
        bundle,
      ),
      'match',
    );
  });

  it('rejects a different size when Drive offers no hash', () => {
    assert.equal(
      matchesLocal(
        { id: 'x', name: 'n', size: 99, sha256: null, md5: null, trashed: false },
        bundle,
      ),
      'mismatch',
    );
  });

  it('trusts a matching hash over a size that disagrees with it', () => {
    // The caller's answer to a mismatch is the wastebasket, and a size that
    // contradicts a matching hash is Drive contradicting itself.
    assert.equal(
      matchesLocal(
        { id: 'x', name: 'n', size: 99, sha256: 'abc', md5: null, trashed: false },
        bundle,
      ),
      'match',
    );
  });

  it('falls back to md5 when Drive reports no sha256', () => {
    assert.equal(
      matchesLocal(
        { id: 'x', name: 'n', size: 100, sha256: null, md5: 'DEF', trashed: false },
        bundle,
      ),
      'match',
    );
    assert.equal(
      matchesLocal(
        { id: 'x', name: 'n', size: 100, sha256: null, md5: 'other', trashed: false },
        bundle,
      ),
      'mismatch',
    );
  });

  it('says unknown, not mismatch, when Drive reports no hash at all', () => {
    // The caller trashes on a mismatch. Drive computes checksums
    // asynchronously, so "not yet" must never read as "wrong".
    assert.equal(
      matchesLocal(
        { id: 'x', name: 'n', size: 100, sha256: null, md5: null, trashed: false },
        bundle,
      ),
      'unknown',
    );
  });
});

describe('compareChecksums', () => {
  const bundle = { bytes: 100, sha256: 'aa', md5: 'bb' };

  it('passes when sha256 agrees', () => {
    assert.equal(
      compareChecksums(
        { id: 'x', name: 'n', size: 100, sha256: 'AA', md5: null, trashed: false },
        bundle,
      ),
      null,
    );
  });

  it('falls back to md5 when Drive has no sha256', () => {
    assert.equal(
      compareChecksums(
        { id: 'x', name: 'n', size: 100, sha256: null, md5: 'BB', trashed: false },
        bundle,
      ),
      null,
    );
  });

  it('fails when neither checksum is available', () => {
    assert.equal(
      compareChecksums(
        { id: 'x', name: 'n', size: 100, sha256: null, md5: null, trashed: false },
        bundle,
      ),
      'Drive returned no checksum',
    );
  });

  it('fails on a size mismatch when no hash agrees', () => {
    assert.match(
      compareChecksums(
        { id: 'x', name: 'n', size: 7, sha256: 'ff', md5: 'ff', trashed: false },
        bundle,
      ) ?? '',
      /^size /,
    );
  });

  it('trusts a matching hash over a size Drive contradicts itself on', () => {
    // The answer to a size mismatch is to trash the remote file. Doing that on
    // the strength of a size, against a hash that proves the bytes are right,
    // destroys a copy that was correct.
    assert.equal(
      compareChecksums(
        { id: 'x', name: 'n', size: 7, sha256: 'aa', md5: 'bb', trashed: false },
        bundle,
      ),
      null,
    );
  });

  it('fails on a hash mismatch', () => {
    assert.equal(
      compareChecksums(
        { id: 'x', name: 'n', size: 100, sha256: 'zz', md5: null, trashed: false },
        bundle,
      ),
      'sha256 mismatch',
    );
  });
});

describe('createLazyDrive', () => {
  it('does not build the transport until a call needs it', async () => {
    let built = 0;
    const drive = createLazyDrive(() => {
      built++;
      return Promise.resolve(new FakeDrive());
    });
    assert.equal(built, 0, 'constructing the wrapper touches nothing');
    await drive.ensureFolder(['ClaudeArchive']);
    assert.equal(built, 1);
  });

  it('builds it once, however many calls follow', async () => {
    let built = 0;
    const drive = createLazyDrive(() => {
      built++;
      return Promise.resolve(new FakeDrive());
    });
    await drive.ensureFolder(['a']);
    await drive.ensureFolder(['b']);
    await drive.storageQuota();
    assert.equal(built, 1);
  });

  it('propagates the failure to build, so the user sees the real reason', async () => {
    const drive = createLazyDrive(() =>
      Promise.reject(new FatalError('not signed in', 'Run /archive:setup.')),
    );
    await assert.rejects(drive.storageQuota(), /not signed in/);
  });
});

describe('classifying a chunk upload response', () => {
  it('treats 429 as retryable, with the window it asked for', async () => {
    const err = await interpretUploadResponse(
      new Response('{"error":{"message":"rate limit"}}', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
      10,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.ok(err instanceof RetryableError, 'a rate limit is not a refusal');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSeconds, 120);
  });

  it('still treats a genuine refusal as fatal', async () => {
    const err = await interpretUploadResponse(
      new Response('{"error":{"message":"bad request"}}', { status: 400 }),
      10,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.ok(err instanceof FatalError);
  });
});

describe('a rate limit on a chunk upload', () => {
  it('is retryable, not a refusal', async () => {
    // The heaviest Drive traffic this plugin ever makes is the initial
    // backfill, and 403 is Drive's other way of saying "slow down". Calling it
    // fatal blocked that session's backup permanently.
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'Rate Limit Exceeded',
        errors: [{ reason: 'rateLimitExceeded' }],
      },
    });
    const err = await interpretUploadResponse(new Response(body, { status: 403 }), 10).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.ok(err instanceof RetryableError, `classified as ${String(err)}`);
  });

  it('is still fatal when Drive is actually full', async () => {
    const body = JSON.stringify({
      error: { code: 403, errors: [{ reason: 'storageQuotaExceeded' }] },
    });
    const err = await interpretUploadResponse(new Response(body, { status: 403 }), 10).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.ok(err instanceof FatalError);
  });
});

describe('a resumable range that is not a prefix', () => {
  it('restarts rather than uploading around a hole', () => {
    assert.equal(confirmedFromRange('bytes=0-99'), 100);
    assert.equal(confirmedFromRange('bytes=100-200'), 0, 'a gap is not a resume point');
  });
});
