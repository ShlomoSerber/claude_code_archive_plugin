import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquireLock, isPidAlive, readOwner } from '../src/adapters/lock.ts';
import { fakeClock, tempDir } from './helpers.ts';

describe('acquireLock', () => {
  it('creates the lock directory and records the owner', () => {
    const clock = fakeClock();
    const dir = path.join(tempDir(), 'worker.lock');
    const lock = acquireLock(dir, { clock });
    assert.ok(lock);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(readOwner(dir)?.pid, process.pid);
    lock.release();
    assert.equal(fs.existsSync(dir), false);
  });

  it('creates a missing parent directory on first run', () => {
    const dir = path.join(tempDir(), 'nested', 'deeper', 'worker.lock');
    const lock = acquireLock(dir, { clock: fakeClock() });
    assert.ok(lock);
    lock.release();
  });

  it('refuses a lock another live process holds', () => {
    const clock = fakeClock();
    const dir = path.join(tempDir(), 'worker.lock');
    const held = acquireLock(dir, { clock });
    assert.ok(held);
    assert.equal(acquireLock(dir, { clock }), null);
    held.release();
    assert.ok(acquireLock(dir, { clock }));
  });

  it('breaks a lock whose heartbeat stopped', () => {
    const dir = path.join(tempDir(), 'worker.lock');
    fs.mkdirSync(dir);
    // A holder on another machine, so the pid fast path cannot apply.
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: 999999, hostname: 'other-machine', startedAt: 0 }),
    );
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(dir, stale, stale);

    const lock = acquireLock(dir, { staleMs: 20_000 });
    assert.ok(lock, 'a lock older than the stale window is reclaimable');
    assert.equal(readOwner(dir)?.pid, process.pid);
    lock.release();
  });

  it('reclaims early when the recorded pid is dead on this host', () => {
    const dir = path.join(tempDir(), 'worker.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: 999999, hostname: os.hostname(), startedAt: 0 }),
    );
    const lock = acquireLock(dir, { staleMs: 3_600_000 });
    assert.ok(lock, 'a dead pid means the lock will never be refreshed again');
    lock.release();
  });

  it('waits out the stale window when the pid belongs to another machine', () => {
    const dir = path.join(tempDir(), 'worker.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: 999999, hostname: 'other-machine', startedAt: 0 }),
    );
    assert.equal(acquireLock(dir, { staleMs: 3_600_000 }), null);
  });

  it('is safe to release twice', () => {
    const dir = path.join(tempDir(), 'worker.lock');
    const lock = acquireLock(dir, { clock: fakeClock() })!;
    lock.release();
    lock.release();
    assert.equal(fs.existsSync(dir), false);
  });

  it('tolerates an unreadable owner file', () => {
    const dir = path.join(tempDir(), 'worker.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), 'not json');
    assert.equal(readOwner(dir), null);
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(dir, stale, stale);
    const lock = acquireLock(dir, { staleMs: 20_000 });
    assert.ok(lock);
    lock.release();
  });

  it('enforces a floor on the stale window for coarse filesystems', () => {
    const dir = path.join(tempDir(), 'worker.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: 999999, hostname: 'other-machine', startedAt: 0 }),
    );
    const recent = new Date(Date.now() - 4000);
    fs.utimesSync(dir, recent, recent);
    // Asking for a 1 ms stale window must not make a 4-second-old lock stale.
    assert.equal(acquireLock(dir, { staleMs: 1 }), null);
  });
});

describe('isPidAlive', () => {
  it('knows this process is alive', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it('reports a pid that cannot exist as dead', () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
  });
});

describe('releasing a lock that was taken over', () => {
  it('leaves the new holder alone', () => {
    // A suspended laptop freezes the heartbeat's mtime, so another worker can
    // call the lock stale and replace it. Removing it then would delete the
    // new holder's lock and let a third worker in beside it.
    const dir = path.join(tempDir(), 'worker.lock');
    const first = acquireLock(dir, { clock: fakeClock() });
    assert.ok(first);
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({ pid: process.pid + 1, hostname: 'other', startedAt: 42 }),
    );

    first.release();
    assert.equal(fs.existsSync(dir), true, "the other worker's lock survives");
  });
});
