import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { rankCandidates, satisfiesFloor, versionFromPath } from '../src/core/node-discovery.ts';
import {
  alreadyReexeced,
  collectCandidates,
  findCompatibleNode,
} from '../src/adapters/node-locator.ts';
import { tempDir } from './helpers.ts';

describe('versionFromPath', () => {
  it('reads the layouts every version manager uses', () => {
    assert.equal(versionFromPath('/home/a/.nvm/versions/node/v22.16.0/bin/node'), '22.16.0');
    assert.equal(versionFromPath('/home/a/.volta/tools/image/node/22.16.0/bin/node'), '22.16.0');
    assert.equal(
      versionFromPath('/home/a/.fnm/node-versions/v24.4.0/installation/bin/node'),
      '24.4.0',
    );
    assert.equal(
      versionFromPath('C:\\Users\\a\\AppData\\Roaming\\nvm\\v22.16.0\\node.exe'),
      '22.16.0',
    );
  });

  it('returns null when the path says nothing', () => {
    assert.equal(versionFromPath('/usr/local/bin/node'), null);
    assert.equal(versionFromPath('/opt/node-latest/bin/node'), null);
  });
});

describe('rankCandidates', () => {
  const candidates = [
    { path: '/nvm/v20.19.2/bin/node', version: '20.19.2' },
    { path: '/nvm/v22.16.0/bin/node', version: '22.16.0' },
    { path: '/nvm/v24.4.0/bin/node', version: '24.4.0' },
    { path: '/usr/local/bin/node', version: null },
  ];

  it('drops versions known to be too old', () => {
    const ranked = rankCandidates(candidates);
    assert.ok(!ranked.some((candidate) => candidate.version === '20.19.2'));
  });

  it('puts the newest qualifying version first', () => {
    assert.equal(rankCandidates(candidates)[0]?.version, '24.4.0');
  });

  it('keeps unknown versions, but last, because checking them costs a spawn', () => {
    const ranked = rankCandidates(candidates);
    assert.equal(ranked.at(-1)?.path, '/usr/local/bin/node');
  });

  it('deduplicates repeated paths', () => {
    const ranked = rankCandidates([
      { path: '/a/node', version: '22.16.0' },
      { path: '/a/node', version: '22.16.0' },
    ]);
    assert.equal(ranked.length, 1);
  });

  it('returns nothing when every candidate is too old', () => {
    assert.deepEqual(rankCandidates([{ path: '/a', version: '18.0.0' }]), []);
  });
});

describe('satisfiesFloor', () => {
  it('accepts the floor itself', () => {
    assert.equal(satisfiesFloor('22.16.0'), true);
    assert.equal(satisfiesFloor('22.15.9'), false);
  });
});

describe('collectCandidates', () => {
  it('finds interpreters laid out the way nvm lays them out', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = tempDir();
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const version of ['v20.19.2', 'v22.16.0']) {
      fs.mkdirSync(path.join(nvm, version, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(nvm, version, 'bin', 'node'), '');
    }
    const found = collectCandidates({}, home);
    assert.deepEqual(
      found
        .map((candidate) => candidate.version)
        .filter((v) => v !== null)
        .sort(),
      ['20.19.2', '22.16.0'],
    );
  });

  it('honours NVM_DIR when it points somewhere unusual', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = tempDir();
    const custom = path.join(tempDir(), 'nvm-elsewhere');
    fs.mkdirSync(path.join(custom, 'versions', 'node', 'v24.0.0', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(custom, 'versions', 'node', 'v24.0.0', 'bin', 'node'), '');
    const found = collectCandidates({ NVM_DIR: custom }, home);
    assert.ok(found.some((candidate) => candidate.version === '24.0.0'));
  });

  it('survives a home directory with nothing in it', () => {
    assert.doesNotThrow(() => collectCandidates({}, tempDir()));
  });
});

describe('findCompatibleNode', () => {
  function layout(): string {
    const home = tempDir();
    for (const version of ['v20.19.2', 'v22.16.0', 'v24.4.0']) {
      const bin = path.join(home, '.nvm', 'versions', 'node', version, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'node'), '');
    }
    return home;
  }

  it('picks the newest interpreter that clears the floor', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = layout();
    const found = findCompatibleNode({
      env: {},
      homedir: () => home,
      verify: (candidate) => versionFromPath(candidate),
    });
    assert.equal(found?.version, '24.4.0');
  });

  it('returns null when nothing installed is new enough', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = tempDir();
    const bin = path.join(home, '.nvm', 'versions', 'node', 'v18.20.0', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '');
    const found = findCompatibleNode({
      env: {},
      homedir: () => home,
      verify: (candidate) => versionFromPath(candidate),
    });
    assert.equal(found, null);
  });

  it('trusts the path only after the interpreter confirms its own version', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = layout();
    // A directory named v24.4.0 that actually holds an ancient interpreter.
    const found = findCompatibleNode({
      env: {},
      homedir: () => home,
      verify: (candidate) =>
        candidate.includes('v24.4.0') ? '18.0.0' : versionFromPath(candidate),
    });
    assert.equal(found?.version, '22.16.0');
  });

  it('caches what it found, and reuses it without rescanning', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = layout();
    const cacheFile = path.join(tempDir(), 'runtime.json');
    const first = findCompatibleNode({
      env: {},
      homedir: () => home,
      verify: (candidate) => versionFromPath(candidate),
      cacheFile,
    });
    assert.ok(fs.existsSync(cacheFile));

    let verified = 0;
    const second = findCompatibleNode({
      env: {},
      homedir: () => home,
      verify: (candidate) => {
        verified++;
        return versionFromPath(candidate);
      },
      cacheFile,
    });
    assert.equal(verified, 0, 'the cached interpreter is reused as-is');
    assert.deepEqual(second, first);
  });

  it('rescans when the cached interpreter has been uninstalled', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX layout');
      return;
    }
    const home = layout();
    const cacheFile = path.join(tempDir(), 'runtime.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ path: '/gone/node', version: '24.0.0' }));
    const found = findCompatibleNode({
      env: {},
      homedir: () => home,
      verify: (candidate) => versionFromPath(candidate),
      cacheFile,
    });
    assert.equal(found?.version, '24.4.0');
  });
});

describe('alreadyReexeced', () => {
  it('is false unless the marker is set, so one re-exec is the limit', () => {
    assert.equal(alreadyReexeced({}), false);
    assert.equal(alreadyReexeced({ ARCHIVE_REEXEC: '' }), false);
    assert.equal(alreadyReexeced({ ARCHIVE_REEXEC: '0' }), false);
    assert.equal(alreadyReexeced({ ARCHIVE_REEXEC: '1' }), true);
  });
});
