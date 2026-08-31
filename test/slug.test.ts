import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bundleBaseName,
  fitPathBudget,
  isWindowsReservedName,
  isoDate,
  isoYear,
  sanitizeFileName,
  shortSessionId,
  slugifyTitle,
  truncateUtf8,
} from '../src/core/slug.ts';

describe('sanitizeFileName', () => {
  it('replaces every character Windows rejects', () => {
    assert.equal(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), 'a-b-c-d-e-f-g-h-i-j');
  });

  it('strips control characters rather than replacing them', () => {
    assert.equal(sanitizeFileName('fix\u0000auth\u001fredirect'), 'fixauthredirect');
  });

  it('drops the trailing dots and spaces Windows would strip silently', () => {
    assert.equal(sanitizeFileName('report...  '), 'report');
    assert.equal(sanitizeFileName('.hidden'), 'hidden');
  });

  it('escapes reserved basenames, extension or not', () => {
    assert.equal(sanitizeFileName('CON'), '_CON');
    assert.equal(sanitizeFileName('com1.tar.zst'), '_com1.tar.zst');
    assert.equal(sanitizeFileName('console'), 'console');
  });

  it('normalizes to NFC so macOS and Linux agree on the bytes', () => {
    const nfd = 'cafe\u0301';
    assert.equal(sanitizeFileName(nfd), 'caf\u00e9');
  });

  it('falls back when nothing usable survives', () => {
    assert.equal(sanitizeFileName('///', 'fallback'), 'fallback');
  });

  it('caps the name at 200 bytes, not 200 characters', () => {
    const name = sanitizeFileName('\u00e9'.repeat(300));
    assert.ok(Buffer.byteLength(name, 'utf8') <= 200);
  });
});

describe('isWindowsReservedName', () => {
  it('matches case-insensitively and through extensions', () => {
    assert.equal(isWindowsReservedName('nul'), true);
    assert.equal(isWindowsReservedName('NUL.txt'), true);
    assert.equal(isWindowsReservedName('LPT9.tar.zst'), true);
    assert.equal(isWindowsReservedName('nullable'), false);
  });
});

describe('slugifyTitle', () => {
  it('produces lowercase kebab case', () => {
    assert.equal(slugifyTitle('Fix Auth Redirect!'), 'fix-auth-redirect');
  });

  it('folds accents instead of dropping the word', () => {
    assert.equal(slugifyTitle('Añadir sesión'), 'anadir-sesion');
  });

  it('never ends in a separator after truncation', () => {
    assert.equal(slugifyTitle('alpha beta gamma', 6), 'alpha');
  });

  it('has a fallback for titles with no usable characters', () => {
    assert.equal(slugifyTitle('!!!'), 'session');
    assert.equal(slugifyTitle(''), 'session');
  });
});

describe('truncateUtf8', () => {
  it('never splits a code point', () => {
    assert.equal(truncateUtf8('\u00e9\u00e9\u00e9', 3), '\u00e9');
    assert.equal(truncateUtf8('a\u{1f600}b', 2), 'a');
  });

  it('leaves short input untouched', () => {
    assert.equal(truncateUtf8('abc', 10), 'abc');
  });
});

describe('bundleBaseName', () => {
  it('orders date, slug and session id', () => {
    assert.equal(
      bundleBaseName({
        date: '2026-08-31',
        title: 'Fix auth redirect',
        sessionId: '1a2b3c4d-5e6f-7890-abcd-ef1234567890',
      }),
      '2026-08-31_fix-auth-redirect_1a2b3c4d',
    );
  });

  it('stays unique when two same-day sessions share a title', () => {
    const first = bundleBaseName({ date: '2026-08-31', title: 'same', sessionId: 'aaaaaaaa-1' });
    const second = bundleBaseName({ date: '2026-08-31', title: 'same', sessionId: 'bbbbbbbb-2' });
    assert.notEqual(first, second);
  });

  it('survives a missing title', () => {
    assert.equal(
      bundleBaseName({ date: '2026-08-31', title: null, sessionId: 'abcdefgh' }),
      '2026-08-31_session_abcdefgh',
    );
  });
});

describe('shortSessionId', () => {
  it('drops separators and keeps eight characters', () => {
    assert.equal(shortSessionId('1a2b-3c4d-5e6f'), '1a2b3c4d');
  });

  it('has a fallback for an empty id', () => {
    assert.equal(shortSessionId(''), 'nosessid');
  });
});

describe('isoDate / isoYear', () => {
  it('formats in UTC so the name does not shift with the timezone', () => {
    const ts = Date.UTC(2026, 7, 31, 23, 30);
    assert.equal(isoDate(ts), '2026-08-31');
    assert.equal(isoYear(ts), '2026');
  });
});

describe('fitPathBudget', () => {
  it('keeps the whole path inside the budget', () => {
    const directory = 'C:/Users/someone/'.padEnd(200, 'x');
    const name = fitPathBudget({
      directory,
      date: '2026-08-31',
      title: 'a very long session title that will not fit anywhere near this path',
      sessionId: '1a2b3c4d-5e6f',
      suffix: '.tar.zst',
    });
    assert.ok(`${directory}/${name}`.length <= 240, `${directory}/${name}`.length.toString());
  });

  it('sacrifices the slug before the identity', () => {
    const directory = 'x'.repeat(230);
    const name = fitPathBudget({
      directory,
      date: '2026-08-31',
      title: 'dropped entirely',
      sessionId: '1a2b3c4d',
      suffix: '.tar.zst',
    });
    assert.equal(name, '2026-08-31_1a2b3c4d.tar.zst');
  });

  it('keeps the slug when there is room', () => {
    const name = fitPathBudget({
      directory: '/archive/2026',
      date: '2026-08-31',
      title: 'fix auth redirect',
      sessionId: '1a2b3c4d',
      suffix: '.tar.zst',
    });
    assert.equal(name, '2026-08-31_fix-auth-redirect_1a2b3c4d.tar.zst');
  });
});
