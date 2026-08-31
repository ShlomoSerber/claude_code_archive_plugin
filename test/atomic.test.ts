import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  removePartials,
  renameRetryDelay,
  renameWithRetry,
  siblingTempPath,
  writeFileAtomic,
  writeFileAtomicSync,
} from '../src/adapters/atomic.ts';
import { tempDir } from './helpers.ts';

describe('siblingTempPath', () => {
  it('stays in the same directory, so the rename cannot cross a filesystem', () => {
    const target = path.join(path.sep, 'archive', '2026', 'bundle.tar.zst');
    const temp = siblingTempPath(target);
    assert.equal(path.dirname(temp), path.dirname(target));
    assert.ok(temp.endsWith('.partial'));
  });

  it('is different every time, so two workers cannot collide', () => {
    const target = path.join(path.sep, 'a', 'b.tar.zst');
    assert.notEqual(siblingTempPath(target), siblingTempPath(target));
  });
});

describe('renameRetryDelay', () => {
  it('starts at 10 ms and caps at 1 s', () => {
    assert.equal(renameRetryDelay(0), 10);
    assert.equal(renameRetryDelay(1), 30);
    assert.equal(renameRetryDelay(2), 90);
    assert.equal(renameRetryDelay(9), 1000);
  });
});

describe('renameWithRetry', () => {
  it('renames on the first try in the normal case', async () => {
    const dir = tempDir();
    const from = path.join(dir, 'a');
    const to = path.join(dir, 'b');
    await fsp.writeFile(from, 'data');
    await renameWithRetry(from, to);
    assert.equal(await fsp.readFile(to, 'utf8'), 'data');
  });

  it('gives up on an error that retrying cannot fix', async () => {
    const dir = tempDir();
    await assert.rejects(
      renameWithRetry(path.join(dir, 'missing'), path.join(dir, 'to')),
      /ENOENT/,
    );
  });
});

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp behind', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'status.json');
    await writeFileAtomic(target, '{"ok":true}');
    assert.equal(await fsp.readFile(target, 'utf8'), '{"ok":true}');
    assert.deepEqual(await fsp.readdir(dir), ['status.json']);
  });

  it('creates missing parent directories', async () => {
    const target = path.join(tempDir(), 'deep', 'deeper', 'file.json');
    await writeFileAtomic(target, 'x');
    assert.equal(await fsp.readFile(target, 'utf8'), 'x');
  });

  it('replaces an existing file rather than appending to it', async () => {
    const target = path.join(tempDir(), 'f');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    assert.equal(await fsp.readFile(target, 'utf8'), 'second');
  });

  it('creates the file readable only by its owner', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const target = path.join(tempDir(), 'tokens.json');
    await writeFileAtomic(target, 'secret');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  });
});

describe('writeFileAtomicSync', () => {
  it('matches the async behaviour', () => {
    const target = path.join(tempDir(), 'sync.json');
    writeFileAtomicSync(target, 'value');
    assert.equal(fs.readFileSync(target, 'utf8'), 'value');
  });

  it('cleans up its temp file when the write fails', () => {
    const dir = tempDir();
    const target = path.join(dir, 'x');
    assert.throws(() => {
      writeFileAtomicSync(target, 'ok', { mode: -1 });
    });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('removePartials', () => {
  it('deletes interrupted bundles and leaves finished ones', async () => {
    const dir = tempDir();
    await fsp.writeFile(path.join(dir, 'a.tar.zst'), 'keep');
    await fsp.writeFile(path.join(dir, 'b.tar.zst.abc123.partial'), 'discard');
    const removed = await removePartials(dir);
    assert.equal(removed.length, 1);
    assert.deepEqual(await fsp.readdir(dir), ['a.tar.zst']);
  });

  it('returns nothing for a directory that does not exist yet', async () => {
    assert.deepEqual(await removePartials(path.join(tempDir(), 'absent')), []);
  });
});
