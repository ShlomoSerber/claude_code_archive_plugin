import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detachDisabled, workerSpawnSpec } from '../src/core/spawn.ts';
import { openCommand } from '../src/adapters/browser.ts';

describe('workerSpawnSpec', () => {
  const spec = workerSpawnSpec({
    execPath: '/usr/bin/node',
    workerPath: '/plugin/dist/worker.mjs',
    env: { PATH: '/bin' },
    cwd: '/data',
  });

  it('uses the running interpreter, not whatever "node" resolves to', () => {
    assert.equal(spec.command, '/usr/bin/node');
    assert.deepEqual(spec.args, ['/plugin/dist/worker.mjs']);
  });

  it('sets all three options the child needs to outlive its parent', () => {
    assert.equal(spec.options.detached, true);
    assert.equal(spec.options.stdio, 'ignore');
    assert.equal(spec.options.windowsHide, true);
  });

  it('passes extra arguments through', () => {
    const forced = workerSpawnSpec({
      execPath: 'node',
      workerPath: 'w.mjs',
      env: {},
      cwd: '.',
      extraArgs: ['--force'],
    });
    assert.deepEqual(forced.args, ['w.mjs', '--force']);
  });
});

describe('detachDisabled', () => {
  it('is off unless the escape hatch is set', () => {
    assert.equal(detachDisabled({}), false);
    assert.equal(detachDisabled({ ARCHIVE_NO_DETACH: '' }), false);
    assert.equal(detachDisabled({ ARCHIVE_NO_DETACH: '0' }), false);
    assert.equal(detachDisabled({ ARCHIVE_NO_DETACH: '1' }), true);
  });
});

describe('openCommand', () => {
  it('never passes an OAuth URL through a shell', () => {
    const command = openCommand('https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2');
    assert.ok(command);
    // `&` in a URL is a command separator to cmd.exe, so no cmd.exe.
    assert.notEqual(command.file, 'cmd');
    assert.notEqual(command.file, 'cmd.exe');
    assert.equal(command.args.at(-1), 'https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2');
  });

  it('refuses anything that is not http', () => {
    assert.equal(openCommand('file:///etc/passwd'), null);
    assert.equal(openCommand('javascript:alert(1)'), null);
  });
});
