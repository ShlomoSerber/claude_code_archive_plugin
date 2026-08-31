import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRuntime, readConfigFile } from '../src/composition.ts';
import { resolveConfig, unknownConfigKeys } from '../src/core/config.ts';
import { tempDir } from './helpers.ts';

/**
 * A setting whose only job is to prevent deletion must fail closed.
 *
 * An audit found that every route to "do not delete my history" failed open: a
 * trailing comma, a misspelled key, `1` instead of `true`, or `0` days all
 * silently resolved to the defaults, which delete.
 */

async function withConfig(content: string | null): Promise<ReturnType<typeof resolveConfig>> {
  const dataDir = tempDir();
  if (content !== null) await fsp.writeFile(path.join(dataDir, 'config.json'), content);
  const runtime = await createRuntime({
    env: { ARCHIVE_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: tempDir() },
  });
  try {
    return runtime.config;
  } finally {
    runtime.close();
  }
}

describe('readConfigFile', () => {
  it('tells absent apart from unreadable', async () => {
    const dataDir = tempDir();
    assert.equal((await readConfigFile(dataDir)).status, 'absent');

    await fsp.writeFile(path.join(dataDir, 'config.json'), '{"retentionDays": 90}');
    assert.equal((await readConfigFile(dataDir)).status, 'ok');

    await fsp.writeFile(path.join(dataDir, 'config.json'), '{"retentionDays": 90,}');
    assert.equal((await readConfigFile(dataDir)).status, 'unusable');
  });

  it('treats an empty file as absent, and a JSON array as unusable', async () => {
    const dataDir = tempDir();
    await fsp.writeFile(path.join(dataDir, 'config.json'), '  \n');
    assert.equal((await readConfigFile(dataDir)).status, 'absent');
    await fsp.writeFile(path.join(dataDir, 'config.json'), '[1,2,3]');
    assert.equal((await readConfigFile(dataDir)).status, 'unusable');
  });
});

describe('a config that cannot be read', () => {
  it('stops deletion rather than falling back to the deleting defaults', async () => {
    for (const broken of [
      '{"keepLocalForever": true,}',
      '{ // keep everything\n "keepLocalForever": true }',
      'not json at all',
      '[]',
    ]) {
      const config = await withConfig(broken);
      assert.equal(config.keepLocalForever, true, broken);
    }
  });

  it('leaves the defaults alone when there is genuinely no config', async () => {
    const config = await withConfig(null);
    assert.equal(config.keepLocalForever, false);
    assert.equal(config.retentionDays, 30);
  });
});

describe('settings that mean "do not delete"', () => {
  it('accepts 1 and 0 for keepLocalForever, which is how people write booleans', () => {
    assert.equal(resolveConfig({ keepLocalForever: 1 }, {}).keepLocalForever, true);
    assert.equal(resolveConfig({ keepLocalForever: 0 }, {}).keepLocalForever, false);
    assert.equal(resolveConfig({ keepLocalForever: true }, {}).keepLocalForever, true);
  });

  it('reads a retention of zero or less as "never", not as "after one day"', () => {
    // Clamping 0 to 1 resolved the likeliest typo in the direction that loses
    // data: the user asking for no deletion got the most aggressive setting.
    assert.equal(resolveConfig({ retentionDays: 0 }, {}).keepLocalForever, true);
    assert.equal(resolveConfig({ retentionDays: -1 }, {}).keepLocalForever, true);
    assert.equal(resolveConfig({ retentionDays: 30 }, {}).keepLocalForever, false);
  });

  it('reports a misspelled key instead of silently ignoring it', () => {
    assert.deepEqual(unknownConfigKeys({ keepLocalForver: true }), ['keepLocalForver']);
    assert.deepEqual(unknownConfigKeys({ keepLocalForever: true, retentionDays: 5 }), []);
  });
});

describe('the archive grace period', () => {
  it('defaults to a week, so a first install cannot upload and delete at once', () => {
    assert.equal(resolveConfig(null, {}).archiveGraceDays, 7);
  });

  it('can be turned off deliberately, but not set to nonsense', () => {
    assert.equal(resolveConfig({ archiveGraceDays: 0 }, {}).archiveGraceDays, 0);
    assert.equal(resolveConfig({ archiveGraceDays: -5 }, {}).archiveGraceDays, 0);
    assert.equal(resolveConfig({ archiveGraceDays: 99_999 }, {}).archiveGraceDays, 3_650);
  });
});
