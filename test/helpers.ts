import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import type { Clock } from '../src/ports/clock.ts';

/** A temp directory removed when the current test file finishes. */
export function tempDir(prefix = 'archive-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A clock the test drives by hand, so backoff and staleness need no waiting. */
export function fakeClock(start = 1_700_000_000_000): Clock & {
  advance(ms: number): void;
  setRandom(value: number | (() => number)): void;
} {
  let current = start;
  let randomValue: () => number = () => 0.5;
  return {
    now: () => current,
    random: () => randomValue(),
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
    setRandom: (value) => {
      randomValue = typeof value === 'function' ? value : () => value;
    },
  };
}
