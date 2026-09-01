import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLEANUP_PERIOD_DAYS,
  DEFAULT_CONFIG,
  reapCutoff,
  resolveConfig,
} from '../src/core/config.ts';
import {
  NODE_REMEDIATION,
  compareVersions,
  nodeVersionProblem,
} from '../src/core/runtime-check.ts';

describe('resolveConfig', () => {
  it('needs no configuration at all', () => {
    assert.deepEqual(resolveConfig(null, {}), DEFAULT_CONFIG);
  });

  it('takes values from the config file', () => {
    const config = resolveConfig({ retentionDays: 7, driveRootFolder: 'Backups' }, {});
    assert.equal(config.retentionDays, 7);
    assert.equal(config.driveRootFolder, 'Backups');
  });

  it('lets the environment override the file', () => {
    const config = resolveConfig({ retentionDays: 7 }, { ARCHIVE_RETENTION_DAYS: '90' });
    assert.equal(config.retentionDays, 90);
  });

  it('reads booleans in the forms people actually write', () => {
    assert.equal(resolveConfig(null, { ARCHIVE_ENABLED: 'false' }).enabled, false);
    assert.equal(resolveConfig(null, { ARCHIVE_ENABLED: '0' }).enabled, false);
    assert.equal(resolveConfig(null, { ARCHIVE_KEEP_LOCAL_FOREVER: 'yes' }).keepLocalForever, true);
  });

  it('ignores a value it cannot make sense of', () => {
    assert.equal(resolveConfig(null, { ARCHIVE_RETENTION_DAYS: 'soon' }).retentionDays, 30);
    assert.equal(resolveConfig(null, { ARCHIVE_ENABLED: 'maybe' }).enabled, true);
  });

  it('refuses a retention of zero days, which would delete on verification', () => {
    assert.equal(resolveConfig({ retentionDays: 0 }, {}).retentionDays, 1);
  });

  it('keeps the zstd level inside the range zstd accepts', () => {
    assert.equal(resolveConfig({ zstdLevel: 99 }, {}).zstdLevel, 22);
    assert.equal(resolveConfig({ zstdLevel: -5 }, {}).zstdLevel, 1);
  });

  it('bounds the worker budget so a run always ends', () => {
    assert.equal(resolveConfig({ workerBudgetMs: 1 }, {}).workerBudgetMs, 10_000);
    assert.equal(resolveConfig({ workerBudgetMs: 1e12 }, {}).workerBudgetMs, 6 * 3_600_000);
  });
});

describe('CLEANUP_PERIOD_DAYS', () => {
  it('is 365000 — never 0, which would stop transcripts being written at all', () => {
    assert.equal(CLEANUP_PERIOD_DAYS, 365_000);
    assert.ok(CLEANUP_PERIOD_DAYS > 0);
  });
});

describe('reapCutoff', () => {
  it('is the retention window before now', () => {
    const now = Date.UTC(2026, 7, 31);
    assert.equal(reapCutoff(now, 30), now - 30 * 86_400_000);
  });
});

describe('nodeVersionProblem', () => {
  it('accepts the documented floor and anything above it', () => {
    assert.equal(nodeVersionProblem('22.16.0'), null);
    assert.equal(nodeVersionProblem('22.20.1'), null);
    assert.equal(nodeVersionProblem('24.4.0'), null);
    assert.equal(nodeVersionProblem('v24.4.0'), null);
  });

  it('rejects the versions that have no node:sqlite', () => {
    assert.match(nodeVersionProblem('20.19.2') ?? '', /needs Node 22\.16\.0 or newer/);
    assert.match(nodeVersionProblem('18.20.0') ?? '', /Node 18\.20\.0/);
  });

  it('rejects 22.15, where sqlite.backup did not exist yet', () => {
    assert.notEqual(nodeVersionProblem('22.15.0'), null);
  });

  it('tells the user that PATH is the thing to fix', () => {
    assert.match(NODE_REMEDIATION, /PATH/);
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    assert.equal(compareVersions('22.9.0', '22.16.0'), -1);
    assert.equal(compareVersions('22.16.0', '22.9.0'), 1);
    assert.equal(compareVersions('22.16.0', '22.16.0'), 0);
  });

  it('ignores a pre-release suffix', () => {
    assert.equal(compareVersions('24.0.0-nightly', '24.0.0'), 0);
  });

  it('treats a missing segment as zero', () => {
    assert.equal(compareVersions('23', '22.16.0'), 1);
  });
});

describe('safety switches in the environment', () => {
  it('treats an unreadable value as a request to stop deleting', () => {
    // The file source already did this. Someone exporting
    // ARCHIVE_KEEP_LOCAL_FOREVER="yes please" is asking for deletion to stop,
    // and discarding it silently gave them deletion.
    const config = resolveConfig(null, { ARCHIVE_KEEP_LOCAL_FOREVER: 'yes please' });
    assert.equal(config.keepLocalForever, true);
  });

  it('still reads a value it understands', () => {
    assert.equal(
      resolveConfig(null, { ARCHIVE_KEEP_LOCAL_FOREVER: 'false' }).keepLocalForever,
      false,
    );
    assert.equal(
      resolveConfig(null, { ARCHIVE_KEEP_LOCAL_FOREVER: 'true' }).keepLocalForever,
      true,
    );
  });
});
