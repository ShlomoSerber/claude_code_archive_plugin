import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AUTH_ENDPOINT,
  DEVICE_CODE_ENDPOINT,
  DRIVE_FILE_SCOPE,
  REVOKE_ENDPOINT,
  TOKEN_ENDPOINT,
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  isUnrecoverableAuthError,
  needsRefresh,
  parseTokenResponse,
  readRedirect,
  type OAuthClient,
} from '../core/oauth.ts';
import { FatalError, RetryableError } from '../core/errors.ts';
import { readJson, type HttpClient } from './http-client.ts';
import { systemClock, type Clock } from '../ports/clock.ts';
import { nullLogger, type Logger } from '../ports/logger.ts';
import type { StoredTokens, TokenStore } from '../ports/token-store.ts';
import { openUrl } from './browser.ts';

/**
 * Google sign-in and token upkeep (SPEC §9).
 *
 * Loopback is the primary flow: a Desktop-app client, a one-shot server on
 * 127.0.0.1, and PKCE. The device flow is the fallback for machines with no
 * browser, which for this plugin means SSH sessions — a real case, since people
 * run Claude Code on remote boxes.
 */

export const REAUTH_REMEDIATION = 'Run /archive:setup to sign in to Google again.';

export type AuthProvider = {
  /** A valid access token, refreshing first when the current one is stale. */
  getAccessToken(signal?: AbortSignal): Promise<string>;
  hasCredentials(): Promise<boolean>;
  currentTokens(): Promise<StoredTokens | null>;
  signOut(signal?: AbortSignal): Promise<void>;
};

export type AuthDeps = {
  client: OAuthClient;
  tokenStore: TokenStore;
  http: HttpClient;
  clock?: Clock;
  logger?: Logger;
};

export function createAuthProvider(deps: AuthDeps): AuthProvider {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? nullLogger;

  return {
    async hasCredentials(): Promise<boolean> {
      const tokens = await deps.tokenStore.read();
      return tokens !== null && tokens.refreshToken !== null;
    },

    currentTokens: () => deps.tokenStore.read(),

    async getAccessToken(signal?: AbortSignal): Promise<string> {
      const tokens = await deps.tokenStore.read();
      if (tokens === null) {
        throw new FatalError('not signed in to Google', REAUTH_REMEDIATION);
      }
      if (tokens.clientId !== '' && tokens.clientId !== deps.client.clientId) {
        throw new FatalError(
          'the stored token belongs to a different OAuth client',
          REAUTH_REMEDIATION,
        );
      }
      if (!needsRefresh(tokens.expiresAt, clock.now())) return tokens.accessToken;
      if (tokens.refreshToken === null) {
        throw new FatalError(
          'the access token expired and there is no refresh token',
          REAUTH_REMEDIATION,
        );
      }
      const refreshed = await refreshTokens(deps, tokens, clock, signal);
      logger.debug('auth.refreshed', { expires_at: refreshed.expiresAt });
      return refreshed.accessToken;
    },

    async signOut(signal?: AbortSignal): Promise<void> {
      const tokens = await deps.tokenStore.read();
      await deps.tokenStore.clear();
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token === undefined) return;
      try {
        await deps.http.send(REVOKE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        // The local credential is already gone; a failed revoke is cosmetic.
      }
    },
  };
}

async function refreshTokens(
  deps: AuthDeps,
  tokens: StoredTokens,
  clock: Clock,
  signal?: AbortSignal,
): Promise<StoredTokens> {
  const response = await deps.http.send(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: deps.client.clientId,
      client_secret: deps.client.clientSecret,
      refresh_token: tokens.refreshToken ?? '',
      grant_type: 'refresh_token',
    }).toString(),
    expect: [400, 401],
    ...(signal === undefined ? {} : { signal }),
  });
  const body = (await readJson(response)) as Record<string, unknown> | null;

  if (!response.ok) {
    const error = body?.['error'];
    if (isUnrecoverableAuthError(error)) {
      // The grant is gone: the user revoked access, or it expired. Retrying
      // this forever is exactly the hot loop the circuit breaker exists to stop.
      throw new FatalError(
        `Google rejected the refresh token (${String(error)})`,
        REAUTH_REMEDIATION,
      );
    }
    throw new RetryableError(`token refresh failed with HTTP ${response.status}`, {
      status: response.status,
    });
  }

  const parsed = parseTokenResponse(body ?? {}, clock.now(), tokens.refreshToken);
  if (parsed === null) {
    throw new RetryableError('token refresh returned no access token');
  }
  const next: StoredTokens = { ...parsed, clientId: deps.client.clientId };
  await deps.tokenStore.write(next);
  return next;
}

export type LoginResult = {
  tokens: StoredTokens;
  method: 'loopback' | 'device';
};

export type LoopbackOptions = {
  timeoutMs?: number;
  /** Print progress for the user. Defaults to nothing, for tests. */
  onMessage?: (message: string) => void;
  openBrowser?: (url: string) => boolean;
  signal?: AbortSignal;
};

/**
 * The browser flow: spin up a loopback listener, send the user to Google, and
 * take the code from the redirect.
 */
export async function loginWithLoopback(
  deps: AuthDeps,
  options: LoopbackOptions = {},
): Promise<LoginResult> {
  const clock = deps.clock ?? systemClock;
  const notify = options.onMessage ?? ((): void => undefined);
  const pkce = createPkcePair();
  const state = createState();

  const server = http.createServer();
  const redirectUri = await listenLoopback(server);
  const codePromise = waitForRedirect(
    server,
    state,
    options.timeoutMs ?? 5 * 60_000,
    deps.client.audience,
  );

  const url = buildAuthorizationUrl({ client: deps.client, redirectUri, pkce, state });
  if (deps.client.audience !== undefined) {
    notify(`This build signs in ${deps.client.audience}.`);
    notify('Any other account needs its own OAuth client — see the README.');
  }
  notify(`Opening ${AUTH_ENDPOINT} in your browser.`);
  notify(`If nothing opens, paste this URL into a browser:\n${url}`);
  const opened = (options.openBrowser ?? openUrl)(url);
  if (!opened) notify('Could not launch a browser automatically.');

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const tokens = await exchangeCode(
    deps,
    { code, redirectUri, verifier: pkce.verifier },
    clock,
    options.signal,
  );
  return { tokens, method: 'loopback' };
}

function listenLoopback(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the OS picks a free one. Desktop OAuth clients accept any
    // loopback port, so there is nothing to configure and nothing to collide.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new FatalError('could not open a loopback port', 'Try /archive:setup --device.'));
        return;
      }
      // Root path, no segment of our own. For a Desktop client Google matches
      // the loopback redirect ignoring the port, but a path we invented is a
      // needless way to earn redirect_uri_mismatch. The registered value in the
      // downloaded client JSON is a bare "http://localhost".
      resolve(`http://127.0.0.1:${String(address.port)}/`);
    });
  });
}

function waitForRedirect(
  server: http.Server,
  state: string,
  timeoutMs: number,
  audience: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new FatalError(
          'timed out waiting for the Google sign-in redirect',
          audience === undefined
            ? REAUTH_REMEDIATION
            : `Nothing came back from Google. The usual cause is signing in with an ` +
                `account this build does not accept: it only allows ${audience}. ` +
                `Google blocks other accounts on its own page and never returns here. ` +
                `To use a different account, supply your own OAuth client — see the README.`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Match on the query, not the path: browsers also ask this server for
      // /favicon.ico, and answering that as if it were the redirect would end
      // the flow with no code.
      if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
        response.writeHead(404).end();
        return;
      }
      const result = readRedirect(url, state);
      const ok = 'code' in result;
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(resultPage(ok, ok ? null : result.error));
      clearTimeout(timer);
      if (ok) resolve(result.code);
      else
        reject(
          new FatalError(
            `Google sign-in failed: ${result.error}`,
            refusalHelp(result.error, audience),
          ),
        );
    });
  });
}

/** Google reports a wrong-domain account as a plain access denial. */
function refusalHelp(error: string, audience: string | undefined): string {
  const refused = error === 'access_denied' || error === 'org_internal';
  if (refused && audience !== undefined) {
    return (
      `That account was refused. This build only accepts ${audience}. ` +
      `To archive from another account, supply your own OAuth client — see the README.`
    );
  }
  return REAUTH_REMEDIATION;
}

function resultPage(ok: boolean, error: string | null): string {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  const body = ok
    ? 'You can close this tab and go back to your terminal.'
    : `Something went wrong: ${error ?? 'unknown error'}. Go back to your terminal and try again.`;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;margin:4rem auto;max-width:30rem">
<h1>${title}</h1><p>${body}</p></body>`;
}

async function exchangeCode(
  deps: AuthDeps,
  args: { code: string; redirectUri: string; verifier: string },
  clock: Clock,
  signal?: AbortSignal,
): Promise<StoredTokens> {
  const response = await deps.http.send(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: deps.client.clientId,
      client_secret: deps.client.clientSecret,
      code: args.code,
      code_verifier: args.verifier,
      grant_type: 'authorization_code',
      redirect_uri: args.redirectUri,
    }).toString(),
    expect: [400, 401],
    retry: false,
    ...(signal === undefined ? {} : { signal }),
  });
  const body = (await readJson(response)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new FatalError(
      `Google rejected the sign-in (${describeAuthError(body, response.status)})`,
      REAUTH_REMEDIATION,
    );
  }
  const parsed = parseTokenResponse(body ?? {}, clock.now());
  if (parsed === null) throw new FatalError('Google returned no access token', REAUTH_REMEDIATION);
  if (parsed.refreshToken === null) {
    throw new FatalError(
      'Google returned no refresh token, so the plugin could not stay signed in',
      REAUTH_REMEDIATION,
    );
  }
  const tokens: StoredTokens = { ...parsed, clientId: deps.client.clientId };
  await deps.tokenStore.write(tokens);
  return tokens;
}

export type DeviceOptions = {
  onPrompt: (prompt: {
    userCode: string;
    verificationUrl: string;
    expiresInSeconds: number;
  }) => void;
  signal?: AbortSignal;
};

/** The no-browser fallback, for SSH and headless machines. */
export async function loginWithDeviceCode(
  deps: AuthDeps,
  options: DeviceOptions,
): Promise<LoginResult> {
  const clock = deps.clock ?? systemClock;
  const startResponse = await deps.http.send(DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: deps.client.clientId,
      scope: DRIVE_FILE_SCOPE,
    }).toString(),
    expect: [400, 401, 403],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const start = (await readJson(startResponse)) as Record<string, unknown> | null;
  if (!startResponse.ok) {
    throw new FatalError(
      `Google refused a device login (${describeAuthError(start, startResponse.status)})`,
      'Use the browser flow instead: /archive:setup',
    );
  }

  const deviceCode = asString(start?.['device_code']);
  const userCode = asString(start?.['user_code']);
  const verificationUrl =
    asString(start?.['verification_url']) ?? asString(start?.['verification_uri']);
  if (deviceCode === null || userCode === null || verificationUrl === null) {
    throw new FatalError('Google returned an unusable device code', REAUTH_REMEDIATION);
  }
  const expiresIn = typeof start?.['expires_in'] === 'number' ? start['expires_in'] : 600;
  let intervalMs = (typeof start?.['interval'] === 'number' ? start['interval'] : 5) * 1000;

  options.onPrompt({ userCode, verificationUrl, expiresInSeconds: expiresIn });

  const deadline = clock.now() + expiresIn * 1000;
  while (clock.now() < deadline) {
    await clock.sleep(intervalMs, options.signal);
    const response = await deps.http.send(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: deps.client.clientId,
        client_secret: deps.client.clientSecret,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      expect: [400, 401, 403, 428],
      retry: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = (await readJson(response)) as Record<string, unknown> | null;
    if (response.ok) {
      const parsed = parseTokenResponse(body ?? {}, clock.now());
      if (parsed === null)
        throw new FatalError('Google returned no access token', REAUTH_REMEDIATION);
      const tokens: StoredTokens = { ...parsed, clientId: deps.client.clientId };
      await deps.tokenStore.write(tokens);
      return { tokens, method: 'device' };
    }
    const error = asString(body?.['error']);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    throw new FatalError(
      `Google device login failed (${error ?? String(response.status)})`,
      REAUTH_REMEDIATION,
    );
  }
  throw new FatalError('the device code expired before you approved it', REAUTH_REMEDIATION);
}

/**
 * Where the OAuth client comes from, most specific first.
 *
 * Bring-your-own is a documented override, not a fallback of last resort: a
 * user who would rather not share a client id with everyone else can drop their
 * own into the data directory.
 */
export async function resolveOAuthClient(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): Promise<OAuthClient> {
  const envId = env['ARCHIVE_GOOGLE_CLIENT_ID'];
  const envSecret = env['ARCHIVE_GOOGLE_CLIENT_SECRET'];
  if (envId !== undefined && envId.length > 0) {
    return { clientId: envId, clientSecret: envSecret ?? '' };
  }

  const fromFile = await readClientFile(path.join(dataDir, 'oauth-client.json'));
  if (fromFile !== null) return fromFile;

  if (BUNDLED_CLIENT.clientId.length > 0) return BUNDLED_CLIENT;

  throw new FatalError(
    'no Google OAuth client is configured',
    'Create a Desktop-app OAuth client in Google Cloud Console, then save it as ' +
      `${path.join(dataDir, 'oauth-client.json')} with {"clientId":"...","clientSecret":"..."}, ` +
      'or set ARCHIVE_GOOGLE_CLIENT_ID and ARCHIVE_GOOGLE_CLIENT_SECRET.',
  );
}

/**
 * The shared client shipped with the plugin (SPEC §9, "zero-setup onboarding").
 *
 * These are committed on purpose. RFC 8252 classifies a native app as a public
 * client and says its "secret" cannot be kept confidential in a distributed
 * binary; Google's installed-app documentation says the same. PKCE is what
 * actually protects the flow.
 *
 * The containment here is stronger than convention, though: the app behind this
 * client has an Internal audience, so Google itself refuses to authorize any
 * account outside the greelow.com Workspace domain. A copy of these strings is
 * useless to anyone else. Everyone else supplies their own client — see
 * {@link resolveOAuthClient} and the README.
 */
export const BUNDLED_CLIENT: OAuthClient = {
  clientId: '23933894059-4sbrl2ejv8ifcjqt4r4r51vtg6n025ki.apps.googleusercontent.com',
  clientSecret: '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',
  audience: 'Google accounts on the greelow.com domain',
};

async function readClientFile(file: string): Promise<OAuthClient | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    // Accept the shape Google Cloud Console downloads, as well as our own.
    const installed = record['installed'];
    const source = (
      typeof installed === 'object' && installed !== null ? installed : record
    ) as Record<string, unknown>;
    const clientId = asString(source['clientId']) ?? asString(source['client_id']);
    if (clientId === null || clientId.length === 0) return null;
    const clientSecret =
      asString(source['clientSecret']) ?? asString(source['client_secret']) ?? '';
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Google returns `error` as a string here, but never trust an error payload. */
function describeAuthError(body: Record<string, unknown> | null, status: number): string {
  return asString(body?.['error']) ?? String(status);
}
