import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  assertInside,
  isInside,
  isSafeEncodedDir,
  isSafeSessionId,
} from '../src/core/identifiers.ts';
import { BugError } from '../src/core/errors.ts';

describe('isSafeSessionId', () => {
  it('accepts the ids Claude Code actually writes', () => {
    assert.equal(isSafeSessionId('a4d9e59d-5613-4c50-b8b3-46d0cccb3b27'), true);
    assert.equal(isSafeSessionId('sess-1'), true);
  });

  it('rejects the two values that escape the directory', () => {
    // `...jsonl` strips to `..`; `.jsonl` strips to the empty string.
    assert.equal(isSafeSessionId('..'), false);
    assert.equal(isSafeSessionId('.'), false);
    assert.equal(isSafeSessionId(''), false);
  });

  it('rejects anything carrying a separator', () => {
    assert.equal(isSafeSessionId('a/b'), false);
    assert.equal(isSafeSessionId('a\\b'), false);
    assert.equal(isSafeSessionId('../../etc'), false);
  });

  it('rejects a leading dot, which is how traversal starts', () => {
    assert.equal(isSafeSessionId('.hidden'), false);
    assert.equal(isSafeSessionId('..foo'), false);
  });

  it('rejects absurd lengths', () => {
    assert.equal(isSafeSessionId('a'.repeat(500)), false);
  });
});

describe('isSafeEncodedDir', () => {
  it('accepts a leading dash, because every encoded directory has one', () => {
    // `/home/a/shop` encodes to `-home-a-shop`: the leading slash becomes a dash.
    assert.equal(isSafeEncodedDir('-home-shlomo-serber-Desktop-My-Projects-x'), true);
    assert.equal(isSafeEncodedDir('-home-a-shop'), true);
  });

  it('still rejects traversal', () => {
    assert.equal(isSafeEncodedDir('..'), false);
    assert.equal(isSafeEncodedDir('../..'), false);
    assert.equal(isSafeEncodedDir('../../Documents'), false);
  });
});

describe('assertInside', () => {
  const root = path.join(path.sep, 'home', 'a', '.claude', 'projects');

  it('allows a path below the root', () => {
    assert.doesNotThrow(() => {
      assertInside(root, path.join(root, '-home-a-shop', 's.jsonl'), 'transcript');
    });
  });

  it('rejects the root itself, which a recursive delete would empty', () => {
    assert.throws(() => {
      assertInside(root, root, 'target');
    }, BugError);
  });

  it('rejects a path that climbs out', () => {
    assert.throws(() => {
      assertInside(root, path.join(root, '..', '..', 'Documents'), 'target');
    }, BugError);
  });

  it('rejects a sibling whose name merely starts the same', () => {
    assert.equal(isInside(root, `${root}-evil`), false);
  });
});
