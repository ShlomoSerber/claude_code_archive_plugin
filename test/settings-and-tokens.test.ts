import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  projectCleanupSettings,
  readCleanupPeriodDays,
  readSettings,
  setCleanupPeriodDays,
} from '../src/adapters/claude-settings.ts';
import { createFileTokenStore, createMemoryTokenStore } from '../src/adapters/token-file.ts';
import { openDatabase } from '../src/adapters/db.ts';
import { CLEANUP_PERIOD_DAYS } from '../src/core/config.ts';
import { FatalError } from '../src/core/errors.ts';
import { buildManifest, parseManifest, MANIFEST_VERSION } from '../src/core/manifest.ts';
import { tempDir } from './helpers.ts';

describe('setCleanupPeriodDays', () => {
  it('creates the settings file when there is none', async () => {
    const file = path.join(tempDir(), 'settings.json');
    const result = await setCleanupPeriodDays(file);
    assert.equal(result.changed, true);
    assert.equal(result.previous, null);
    assert.equal(await readCleanupPeriodDays(file), CLEANUP_PERIOD_DAYS);
  });

  it('changes one key and leaves the rest of the user file alone', async () => {
    const file = path.join(tempDir(), 'settings.json');
    await fsp.writeFile(
      file,
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'] },
        cleanupPeriodDays: 30,
      }),
    );
    await setCleanupPeriodDays(file);
    const read = await readSettings(file);
    assert.equal(read.status, 'ok');
    const settings = read.status === 'ok' ? read.settings : {};
    assert.equal(settings['model'], 'opus');
    assert.deepEqual(settings['permissions'], { allow: ['Bash(ls:*)'] });
    assert.equal(settings['cleanupPeriodDays'], CLEANUP_PERIOD_DAYS);
  });

  it('does not rewrite a file that already says the right thing', async () => {
    const file = path.join(tempDir(), 'settings.json');
    await setCleanupPeriodDays(file);
    const again = await setCleanupPeriodDays(file);
    assert.equal(again.changed, false);
    assert.equal(again.previous, CLEANUP_PERIOD_DAYS);
  });

  it('refuses 0, which stops Claude Code writing transcripts at all', async () => {
    const file = path.join(tempDir(), 'settings.json');
    await assert.rejects(setCleanupPeriodDays(file, 0), RangeError);
  });

  it('refuses a day count large enough to overflow date arithmetic', async () => {
    const file = path.join(tempDir(), 'settings.json');
    await assert.rejects(setCleanupPeriodDays(file, 100_000_000), RangeError);
  });

  it('never overwrites settings it could not parse', async () => {
    const file = path.join(tempDir(), 'settings.json');
    const original = '{ "model": "opus", }';
    await fsp.writeFile(file, original);

    await assert.rejects(setCleanupPeriodDays(file), FatalError);
    assert.equal(await fsp.readFile(file, 'utf8'), original, 'the file is untouched');
  });

  it('refuses every shape of unparseable file rather than replacing it', async () => {
    for (const content of [
      '{ "model": "opus", }', // trailing comma
      '{ // a comment\n "model": "opus" }',
      '\uFEFF{ "model": "opus" ', // BOM plus truncation
      '[1, 2, 3]', // valid JSON, wrong shape
      'null',
    ]) {
      const file = path.join(tempDir(), 'settings.json');
      await fsp.writeFile(file, content);
      await assert.rejects(setCleanupPeriodDays(file), FatalError, content);
      assert.equal(await fsp.readFile(file, 'utf8'), content);
    }
  });

  it('treats an empty file as absent, since there is nothing to lose', async () => {
    const file = path.join(tempDir(), 'settings.json');
    await fsp.writeFile(file, '   \n');
    const result = await setCleanupPeriodDays(file);
    assert.equal(result.changed, true);
    assert.equal(await readCleanupPeriodDays(file), CLEANUP_PERIOD_DAYS);
  });

  it('writes through a symlink instead of replacing it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('symlinks need elevation on Windows');
      return;
    }
    const dir = tempDir();
    const real = path.join(dir, 'real-settings.json');
    const link = path.join(dir, 'settings.json');
    await fsp.writeFile(real, JSON.stringify({ model: 'opus' }));
    await fsp.symlink(real, link);

    await setCleanupPeriodDays(link);

    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link survives');
    const settings = JSON.parse(await fsp.readFile(real, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['model'], 'opus');
    assert.equal(settings['cleanupPeriodDays'], CLEANUP_PERIOD_DAYS);
  });

  it('keeps the permissions the user had on the file', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const file = path.join(tempDir(), 'settings.json');
    await fsp.writeFile(file, '{}', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    await setCleanupPeriodDays(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('createFileTokenStore', () => {
  it('returns null before anything has been written', async () => {
    const store = createFileTokenStore(path.join(tempDir(), 'tokens.json'));
    assert.equal(await store.read(), null);
  });

  it('round-trips the tokens', async () => {
    const store = createFileTokenStore(path.join(tempDir(), 'tokens.json'));
    const tokens = {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 123,
      scope: 'drive.file',
      tokenType: 'Bearer',
      clientId: 'c1',
    };
    await store.write(tokens);
    assert.deepEqual(await store.read(), tokens);
  });

  it('writes the file readable only by its owner', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const file = path.join(tempDir(), 'tokens.json');
    const store = createFileTokenStore(file);
    await store.write({
      accessToken: 'at',
      refreshToken: null,
      expiresAt: 1,
      scope: '',
      tokenType: 'Bearer',
      clientId: 'c',
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('tightens permissions that were widened after the fact', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permissions do not apply on Windows');
      return;
    }
    const file = path.join(tempDir(), 'tokens.json');
    const store = createFileTokenStore(file);
    await store.write({
      accessToken: 'at',
      refreshToken: null,
      expiresAt: 1,
      scope: '',
      tokenType: 'Bearer',
      clientId: 'c',
    });
    fs.chmodSync(file, 0o644);
    await store.read();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('treats an unparsable token file as no credentials', async () => {
    const file = path.join(tempDir(), 'tokens.json');
    await fsp.writeFile(file, 'not json');
    assert.equal(await createFileTokenStore(file).read(), null);
  });

  it('clears without complaining when there is nothing to clear', async () => {
    const store = createFileTokenStore(path.join(tempDir(), 'tokens.json'));
    await store.clear();
    assert.equal(await store.read(), null);
  });
});

describe('createMemoryTokenStore', () => {
  it('behaves like the file store without touching the disk', async () => {
    const store = createMemoryTokenStore();
    assert.equal(await store.read(), null);
    await store.write({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 0,
      scope: '',
      tokenType: 'Bearer',
      clientId: 'c',
    });
    assert.equal((await store.read())?.accessToken, 'a');
    await store.clear();
    assert.equal(await store.read(), null);
  });
});

describe('buildManifest', () => {
  const manifest = buildManifest({
    archiverVersion: '0.1.0',
    sessionId: 's1',
    projectCwd: '/home/a/shop',
    encodedDir: '-home-a-shop',
    title: 'Auth fix',
    startedAt: Date.UTC(2026, 7, 31, 10),
    endedAt: Date.UTC(2026, 7, 31, 11),
    createdAt: Date.UTC(2026, 7, 31, 12),
    bundleName: 'b.tar.zst',
    bundleSha256: 'abc',
    bundleBytes: 500,
    compressionLevel: 19,
    files: [
      { path: 's1.jsonl', bytes: 100, sha256: 'h1' },
      { path: 's1/tool.json', bytes: 50, sha256: 'h2' },
    ],
  });

  it('records the original cwd, because the encoded directory is lossy', () => {
    assert.equal(manifest.projectCwd, '/home/a/shop');
    assert.equal(manifest.encodedDir, '-home-a-shop');
  });

  it('totals the uncompressed size', () => {
    assert.equal(manifest.uncompressedBytes, 150);
  });

  it('writes dates as ISO strings, readable without the plugin', () => {
    assert.equal(manifest.startedAt, '2026-08-31T10:00:00.000Z');
    assert.equal(manifest.manifestVersion, MANIFEST_VERSION);
  });

  it('survives a round trip through JSON', () => {
    assert.deepEqual(parseManifest(JSON.stringify(manifest)), manifest);
  });
});

describe('parseManifest', () => {
  it('rejects anything without the fields restore depends on', () => {
    assert.equal(parseManifest('{}'), null);
    assert.equal(parseManifest('not json'), null);
    assert.equal(parseManifest('{"sessionId":"s"}'), null);
  });
});

describe('the catalog file', () => {
  it('is readable only by its owner', () => {
    // It holds every user prompt verbatim, which is more sensitive than the
    // drive.file-scoped token stored next to it at 0600.
    if (process.platform === 'win32') return;
    const file = path.join(tempDir(), 'archive.sqlite');
    const db = openDatabase(file);
    db.exec('CREATE TABLE t (a INTEGER)');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    db.close();
  });
});

describe('cleanupPeriodDays in another project', () => {
  it('is found, not only the one you happen to be standing in', async () => {
    // Project settings outrank the user file this plugin writes. Checking only
    // process.cwd() meant Claude Code kept deleting another project's
    // transcripts while /archive:status said the plugin owned deletion.
    const projectA = tempDir();
    const projectB = tempDir();
    fs.mkdirSync(path.join(projectB, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(projectB, '.claude', 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
    );

    const found = await projectCleanupSettings([projectA, projectB]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.value, 30);
    assert.match(found[0]?.file ?? '', /settings\.json$/);
  });
});
