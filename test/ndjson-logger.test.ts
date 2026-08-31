import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createNdjsonLogger } from '../src/adapters/ndjson-logger.ts';
import { FatalError } from '../src/core/errors.ts';
import { tempDir } from './helpers.ts';

function readLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createNdjsonLogger', () => {
  it('writes one JSON object per line, synchronously', () => {
    const file = path.join(tempDir(), 'archive.log');
    const log = createNdjsonLogger({ file });
    log.info('backup.start', { session_id: 's1' });
    log.info('backup.done', { session_id: 's1', bytes: 42 });
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.['event'], 'backup.start');
    assert.equal(lines[1]?.['bytes'], 42);
    assert.equal(typeof lines[0]?.['ts'], 'string');
  });

  it('creates the data directory on first write', () => {
    const file = path.join(tempDir(), 'made', 'up', 'archive.log');
    createNdjsonLogger({ file }).info('hello');
    assert.equal(readLines(file).length, 1);
  });

  it('drops levels below the threshold', () => {
    const file = path.join(tempDir(), 'archive.log');
    const log = createNdjsonLogger({ file, level: 'warn' });
    log.debug('noise');
    log.info('noise');
    log.warn('kept');
    assert.deepEqual(
      readLines(file).map((line) => line['event']),
      ['kept'],
    );
  });

  it('flattens an error into name, message and remediation-free fields', () => {
    const file = path.join(tempDir(), 'archive.log');
    createNdjsonLogger({ file }).error(
      'upload.failed',
      { session_id: 's1' },
      new FatalError('token revoked', 'run /archive:setup'),
    );
    const err = readLines(file)[0]?.['err'] as Record<string, unknown>;
    assert.equal(err['name'], 'FatalError');
    assert.equal(err['message'], 'token revoked');
    assert.equal(typeof err['stack'], 'string');
  });

  it('stamps child fields onto every line', () => {
    const file = path.join(tempDir(), 'archive.log');
    const child = createNdjsonLogger({ file, base: { run: 'r1' } }).child({ session_id: 's9' });
    child.info('event');
    const line = readLines(file)[0];
    assert.equal(line?.['run'], 'r1');
    assert.equal(line?.['session_id'], 's9');
  });

  it('rotates one generation once the cap is passed', () => {
    const dir = tempDir();
    const file = path.join(dir, 'archive.log');
    const log = createNdjsonLogger({ file, maxBytes: 1 });
    log.info('first');
    // The size check is amortized, so force it by writing past the threshold.
    for (let i = 0; i < 2000; i++) log.info('filler', { i });
    log.info('after');
    assert.equal(fs.existsSync(`${file}.1`), true);
    assert.ok(fs.readFileSync(file, 'utf8').includes('after'));
  });

  it('never throws, even when the path cannot be written', () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a directory');
    const log = createNdjsonLogger({ file: path.join(blocker, 'archive.log') });
    assert.doesNotThrow(() => {
      log.error('should be swallowed', {}, new Error('boom'));
    });
  });
});
