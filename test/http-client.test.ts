import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { createHttpClient, describeApiError, readJson } from '../src/adapters/http-client.ts';
import { fakeClock } from './helpers.ts';

/** A fetch that replays a queue of canned outcomes and records what it saw. */
function scriptedFetch(outcomes: (Response | Error)[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  let index = 0;
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, method: init.method ?? 'GET' });
      const outcome = outcomes[Math.min(index++, outcomes.length - 1)];
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome ?? new Response(null, { status: 500 }));
    },
  };
}

function networkError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('createHttpClient', () => {
  it('returns a successful response without retrying', async () => {
    const scripted = scriptedFetch([new Response('ok', { status: 200 })]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    const response = await client.send('https://drive.test/files');
    assert.equal(response.status, 200);
    assert.equal(scripted.calls.length, 1);
  });

  it('retries a 503 and succeeds', async () => {
    const scripted = scriptedFetch([
      new Response('', { status: 503 }),
      new Response('ok', { status: 200 }),
    ]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    assert.equal((await client.send('https://drive.test/files')).status, 200);
    assert.equal(scripted.calls.length, 2);
  });

  it('retries a dropped connection', async () => {
    const scripted = scriptedFetch([
      networkError('ECONNRESET'),
      new Response('ok', { status: 200 }),
    ]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    assert.equal((await client.send('https://drive.test/files')).status, 200);
  });

  it('never retries a 400, which would fail identically every time', async () => {
    const scripted = scriptedFetch([new Response('', { status: 400 })]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    assert.equal((await client.send('https://drive.test/files')).status, 400);
    assert.equal(scripted.calls.length, 1);
  });

  it('waits exactly as long as Retry-After says', async () => {
    const clock = fakeClock();
    const scripted = scriptedFetch([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('ok', { status: 200 }),
    ]);
    const started = clock.now();
    const client = createHttpClient({ fetch: scripted.fetch, clock });
    await client.send('https://drive.test/files');
    assert.equal(clock.now() - started, 2000);
  });

  it('gives up once the run is out of budget instead of retrying forever', async () => {
    const scripted = scriptedFetch([new Response('', { status: 503 })]);
    const client = createHttpClient({
      fetch: scripted.fetch,
      clock: fakeClock(),
      budgetMs: 1,
      maxAttempts: 20,
    });
    assert.equal((await client.send('https://drive.test/files')).status, 503);
    assert.equal(scripted.calls.length, 1, 'no time to wait means no second attempt');
  });

  it('does not retry when the caller forbade it', async () => {
    const scripted = scriptedFetch([new Response('', { status: 503 })]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    await client.send('https://drive.test/files', { retry: false });
    assert.equal(scripted.calls.length, 1);
  });

  it('returns an expected status instead of treating it as a failure', async () => {
    const scripted = scriptedFetch([new Response('', { status: 308 })]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    const response = await client.send('https://upload.test/s', { expect: [308] });
    assert.equal(response.status, 308);
    assert.equal(scripted.calls.length, 1);
  });

  it('rethrows an error that retrying cannot fix', async () => {
    const scripted = scriptedFetch([networkError('ERR_INVALID_URL')]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    await assert.rejects(client.send('https://drive.test/files'), /ERR_INVALID_URL/);
  });

  it('stops at the caller abort rather than retrying', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by caller'));
    const scripted = scriptedFetch([networkError('ECONNRESET')]);
    const client = createHttpClient({ fetch: scripted.fetch, clock: fakeClock() });
    await assert.rejects(
      client.send('https://drive.test/files', { signal: controller.signal }),
      /cancelled by caller/,
    );
  });
});

describe('createHttpClient over the real fetch', () => {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  after(async () => {
    agent.assertNoPendingInterceptors();
    await agent.close();
    setGlobalDispatcher(previous);
  });

  it('sends the method, headers and body it was given', async () => {
    agent
      .get('https://drive.example')
      .intercept({
        path: '/upload',
        method: 'PUT',
        headers: { 'content-range': 'bytes 0-9/10' },
        body: 'payload',
      })
      .reply(200, { id: 'file-1' });

    const client = createHttpClient({ clock: fakeClock() });
    const response = await client.send('https://drive.example/upload', {
      method: 'PUT',
      headers: { 'content-range': 'bytes 0-9/10' },
      body: 'payload',
    });
    assert.deepEqual(await readJson(response), { id: 'file-1' });
  });
});

describe('readJson', () => {
  it('returns null for an empty body', async () => {
    assert.equal(await readJson(new Response('')), null);
  });

  it('keeps a non-JSON body rather than throwing', async () => {
    assert.deepEqual(await readJson(new Response('<html>502</html>')), { raw: '<html>502</html>' });
  });
});

describe('describeApiError', () => {
  it('reads the Drive error envelope', () => {
    assert.equal(
      describeApiError(403, { error: { message: 'The user has exceeded their quota.' } }),
      'HTTP 403: The user has exceeded their quota.',
    );
  });

  it('reads the OAuth error envelope', () => {
    assert.equal(
      describeApiError(400, { error: 'invalid_grant', error_description: 'Token expired' }),
      'HTTP 400: invalid_grant (Token expired)',
    );
  });

  it('falls back to the status alone', () => {
    assert.equal(describeApiError(500, null), 'HTTP 500');
  });
});
