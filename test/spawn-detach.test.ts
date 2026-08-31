import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

/**
 * The spawn seam, tested for real (ARCHITECTURE §12).
 *
 * A parent process spawns the worker and exits at once. If the child still
 * writes its file afterwards, `detached` + non-inherited stdio + `unref()` are
 * doing what they are there for.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function waitFor(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      if (fs.existsSync(file)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

describe('spawnWorker', () => {
  it('starts a child that outlives the process which started it', async () => {
    const target = path.join(tempDir(), 'heartbeat.txt');
    const parent = path.join(here, 'fixtures', 'spawn-parent.ts');
    const worker = path.join(here, 'fixtures', 'heartbeat.mjs');

    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', parent, worker, target],
        { stdio: 'ignore' },
      );
      child.on('exit', resolve);
    });

    assert.equal(exitCode, 0, 'the parent exits straight away');
    assert.equal(fs.existsSync(target), false, 'and before the child has written anything');
    assert.equal(await waitFor(target, 8_000), true, 'the detached child kept running');
  });
});
