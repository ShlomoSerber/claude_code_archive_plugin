import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth pieces that are pure functions (SPEC §9).
 *
 * Keeping URL building, PKCE and token-response parsing out of the network
 * adapter is what makes the auth flow testable without a browser.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const DEVICE_CODE_ENDPOINT = 'https://oauth2.googleapis.com/device/code';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export type OAuthClient = {
  clientId: string;
  /** Desktop clients ship a "secret" that is not one; Google requires it anyway. */
  clientSecret: string;
  /**
   * Who this client will accept, when it is restricted.
   *
   * A client belonging to an app with an Internal audience only authorizes
   * accounts in its own Workspace domain. Google blocks everyone else on its
   * own error page and never redirects back, so without this hint the failure
   * reaches the user as an unexplained timeout.
   */
  audience?: string;
};

export type PkcePair = {
  verifier: string;
  challenge: string;
  method: 'S256';
};

/** RFC 7636: 43-128 characters from the unreserved set. */
export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64Url(random(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function createState(random: (size: number) => Buffer = randomBytes): string {
  return base64Url(random(16));
}

export function buildAuthorizationUrl(args: {
  client: OAuthClient;
  redirectUri: string;
  pkce: PkcePair;
  state: string;
  scope?: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', args.client.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', args.scope ?? DRIVE_FILE_SCOPE);
  url.searchParams.set('code_challenge', args.pkce.challenge);
  url.searchParams.set('code_challenge_method', args.pkce.method);
  url.searchParams.set('state', args.state);
  // A refresh token only comes back with both of these, and without one the
  // user would have to log in again every hour.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (args.loginHint !== undefined) url.searchParams.set('login_hint', args.loginHint);
  return url.toString();
}

export type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
};

export type ParsedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  tokenType: string;
};

/**
 * Turn a token response into what we store.
 *
 * The expiry is shortened by a minute so a token never expires in flight,
 * between our check and the server's.
 */
export function parseTokenResponse(
  body: TokenResponse,
  now: number,
  previousRefreshToken: string | null = null,
): ParsedTokens | null {
  if (typeof body.access_token !== 'string') return null;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    // A refresh response usually omits the refresh token; keep the one we have.
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : previousRefreshToken,
    expiresAt: now + Math.max(0, expiresIn - 60) * 1000,
    scope: typeof body.scope === 'string' ? body.scope : DRIVE_FILE_SCOPE,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
  };
}

/** Errors that mean the grant is gone for good, so retrying is pointless. */
const UNRECOVERABLE = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export function isUnrecoverableAuthError(error: unknown): boolean {
  return typeof error === 'string' && UNRECOVERABLE.has(error);
}

/** True when the token is gone or close enough to gone to refresh now. */
export function needsRefresh(expiresAt: number, now: number, skewMs = 60_000): boolean {
  return expiresAt - skewMs <= now;
}

/**
 * Validate the redirect Google sent back to our loopback server.
 * Returns the code, or an error to show the user.
 */
export function readRedirect(
  url: URL,
  expectedState: string,
): { code: string } | { error: string } {
  const error = url.searchParams.get('error');
  if (error !== null) return { error };
  const state = url.searchParams.get('state');
  if (state !== expectedState) return { error: 'state_mismatch' };
  const code = url.searchParams.get('code');
  if (code === null || code.length === 0) return { error: 'missing_code' };
  return { code };
}
