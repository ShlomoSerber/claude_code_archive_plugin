import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  circuitBackoffMs,
  fullJitterDelay,
  nextAttemptAt,
  parseRetryAfter,
} from '../src/core/backoff.ts';

describe('fullJitterDelay', () => {
  it('spreads retries across the whole window', () => {
    assert.equal(
      fullJitterDelay(0, () => 0),
      0,
    );
    assert.equal(
      fullJitterDelay(0, () => 0.999),
      999,
    );
    assert.equal(
      fullJitterDelay(3, () => 1 - Number.EPSILON, { baseMs: 1000 }),
      7999,
    );
  });

  it('honours the cap', () => {
    assert.equal(
      fullJitterDelay(30, () => 0.5, { baseMs: 1000, capMs: 60_000 }),
      30_000,
    );
  });

  it('does not overflow at absurd attempt counts', () => {
    const delay = fullJitterDelay(1000, () => 0.5, { capMs: 90_000 });
    assert.ok(Number.isFinite(delay) && delay <= 90_000);
  });
});

describe('nextAttemptAt', () => {
  it('lets Retry-After win over our own guess', () => {
    const at = nextAttemptAt({ now: 1000, attempt: 9, random: () => 0.9, retryAfterSeconds: 2 });
    assert.equal(at, 3000);
  });

  it('accepts a zero-second Retry-After', () => {
    assert.equal(
      nextAttemptAt({ now: 500, attempt: 3, random: () => 0.9, retryAfterSeconds: 0 }),
      500,
    );
  });

  it('falls back to jitter when the server said nothing', () => {
    const at = nextAttemptAt({ now: 0, attempt: 1, random: () => 0.5, options: { baseMs: 1000 } });
    assert.equal(at, 1000);
  });
});

describe('circuitBackoffMs', () => {
  it('starts at thirty minutes and doubles', () => {
    assert.equal(circuitBackoffMs(0), 0);
    assert.equal(circuitBackoffMs(1), 30 * 60_000);
    assert.equal(circuitBackoffMs(2), 60 * 60_000);
    assert.equal(circuitBackoffMs(3), 120 * 60_000);
  });

  it('caps at six hours no matter how bad it gets', () => {
    assert.equal(circuitBackoffMs(50), 6 * 60 * 60_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads the delay-seconds form', () => {
    assert.equal(parseRetryAfter('120', 0), 120);
  });

  it('reads the HTTP-date form relative to now', () => {
    const now = Date.parse('2026-08-31T12:00:00Z');
    assert.equal(parseRetryAfter('Mon, 31 Aug 2026 12:00:30 GMT', now), 30);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-08-31T12:00:00Z');
    assert.equal(parseRetryAfter('Mon, 31 Aug 2026 11:00:00 GMT', now), 0);
  });

  it('returns undefined for nothing usable', () => {
    assert.equal(parseRetryAfter(null, 0), undefined);
    assert.equal(parseRetryAfter('  ', 0), undefined);
    assert.equal(parseRetryAfter('soon', 0), undefined);
  });
});
