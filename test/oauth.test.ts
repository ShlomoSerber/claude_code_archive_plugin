import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  DRIVE_FILE_SCOPE,
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  isUnrecoverableAuthError,
  needsRefresh,
  parseTokenResponse,
  readRedirect,
} from '../src/core/oauth.ts';

const CLIENT = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'secret' };

describe('createPkcePair', () => {
  it('derives the challenge as the S256 hash of the verifier', () => {
    const pkce = createPkcePair();
    const expected = createHash('sha256').update(pkce.verifier).digest('base64url');
    assert.equal(pkce.challenge, expected);
    assert.equal(pkce.method, 'S256');
  });

  it('produces a verifier inside the length RFC 7636 allows', () => {
    const { verifier } = createPkcePair();
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  });

  it('is different every time', () => {
    assert.notEqual(createPkcePair().verifier, createPkcePair().verifier);
    assert.notEqual(createState(), createState());
  });
});

describe('buildAuthorizationUrl', () => {
  const url = new URL(
    buildAuthorizationUrl({
      client: CLIENT,
      redirectUri: 'http://127.0.0.1:51234/callback',
      pkce: createPkcePair(),
      state: 'state-abc',
    }),
  );

  it('asks for the drive.file scope and nothing wider', () => {
    assert.equal(url.searchParams.get('scope'), DRIVE_FILE_SCOPE);
  });

  it('asks for offline access, without which there is no refresh token', () => {
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
  });

  it('carries the PKCE challenge and the state', () => {
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'state-abc');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:51234/callback');
  });
});

describe('parseTokenResponse', () => {
  it('shortens the expiry so a token never expires in flight', () => {
    const parsed = parseTokenResponse({ access_token: 'a', expires_in: 3600 }, 1_000_000);
    assert.equal(parsed?.expiresAt, 1_000_000 + 3540 * 1000);
  });

  it('keeps the refresh token when a refresh response omits it', () => {
    const parsed = parseTokenResponse({ access_token: 'new' }, 0, 'old-refresh');
    assert.equal(parsed?.refreshToken, 'old-refresh');
  });

  it('prefers a refresh token the server did send', () => {
    const parsed = parseTokenResponse({ access_token: 'a', refresh_token: 'fresh' }, 0, 'old');
    assert.equal(parsed?.refreshToken, 'fresh');
  });

  it('returns null when there is no access token', () => {
    assert.equal(parseTokenResponse({ error: 'invalid_grant' }, 0), null);
  });
});

describe('isUnrecoverableAuthError', () => {
  it('knows which errors will never succeed on retry', () => {
    assert.equal(isUnrecoverableAuthError('invalid_grant'), true);
    assert.equal(isUnrecoverableAuthError('invalid_client'), true);
    assert.equal(isUnrecoverableAuthError('slow_down'), false);
    assert.equal(isUnrecoverableAuthError(undefined), false);
  });
});

describe('needsRefresh', () => {
  it('refreshes a minute before the token actually expires', () => {
    assert.equal(needsRefresh(100_000, 39_000), false);
    assert.equal(needsRefresh(100_000, 40_000), true);
    assert.equal(needsRefresh(100_000, 200_000), true);
  });
});

describe('readRedirect', () => {
  const base = 'http://127.0.0.1:1/callback';

  it('accepts a matching state', () => {
    const result = readRedirect(new URL(`${base}?code=abc&state=s1`), 's1');
    assert.deepEqual(result, { code: 'abc' });
  });

  it('rejects a mismatched state, which is the CSRF guard', () => {
    assert.deepEqual(readRedirect(new URL(`${base}?code=abc&state=other`), 's1'), {
      error: 'state_mismatch',
    });
  });

  it('reports the error Google sent', () => {
    assert.deepEqual(readRedirect(new URL(`${base}?error=access_denied&state=s1`), 's1'), {
      error: 'access_denied',
    });
  });

  it('rejects a redirect with no code', () => {
    assert.deepEqual(readRedirect(new URL(`${base}?state=s1`), 's1'), { error: 'missing_code' });
  });
});
