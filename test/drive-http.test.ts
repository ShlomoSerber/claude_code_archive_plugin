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
import { FatalError, UploadSessionExpired } from '../src/core/errors.ts';
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
  const bundle = { totalBytes: 100, sha256: 'abc' };

  it('accepts a remote file with the same size and hash', () => {
    assert.equal(
      matchesLocal({ id: 'x', name: 'n', size: 100, sha256: 'ABC', md5: null }, bundle),
      true,
    );
  });

  it('rejects a different size', () => {
    assert.equal(
      matchesLocal({ id: 'x', name: 'n', size: 99, sha256: 'abc', md5: null }, bundle),
      false,
    );
  });

  it('rejects a remote file whose hash Drive will not tell us', () => {
    assert.equal(
      matchesLocal({ id: 'x', name: 'n', size: 100, sha256: null, md5: 'x' }, bundle),
      false,
    );
  });
});

describe('compareChecksums', () => {
  const bundle = { bytes: 100, sha256: 'aa', md5: 'bb' };

  it('passes when sha256 agrees', () => {
    assert.equal(
      compareChecksums({ id: 'x', name: 'n', size: 100, sha256: 'AA', md5: null }, bundle),
      null,
    );
  });

  it('falls back to md5 when Drive has no sha256', () => {
    assert.equal(
      compareChecksums({ id: 'x', name: 'n', size: 100, sha256: null, md5: 'BB' }, bundle),
      null,
    );
  });

  it('fails when neither checksum is available', () => {
    assert.equal(
      compareChecksums({ id: 'x', name: 'n', size: 100, sha256: null, md5: null }, bundle),
      'Drive returned no checksum',
    );
  });

  it('fails on a size mismatch before looking at hashes', () => {
    assert.match(
      compareChecksums({ id: 'x', name: 'n', size: 7, sha256: 'aa', md5: 'bb' }, bundle) ?? '',
      /^size /,
    );
  });

  it('fails on a hash mismatch', () => {
    assert.equal(
      compareChecksums({ id: 'x', name: 'n', size: 100, sha256: 'zz', md5: null }, bundle),
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
