import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { MediaReader } from '../src/media.js';
import { createRedactor, errorResult } from '../src/server.js';
import { XApiError } from '../src/x/errors.js';
import { oauth1Header } from '../src/x/oauth1.js';
import { queueFetch, TEST_SECRETS, testClient, testConfig } from './helpers.js';

describe('OAuth 1.0a signing', () => {
  it('matches the worked example from the X "Creating a signature" guide', () => {
    const header = oauth1Header({
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      credentials: {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        accessTokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      extraParams: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']],
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
    });
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header.startsWith('OAuth ')).toBe(true);
  });
});

describe('configuration', () => {
  it('requires https except for loopback hosts', () => {
    expect(() => loadConfig({ X_API_BASE_URL: 'http://api.x.com' })).toThrow(ConfigError);
    expect(loadConfig({ X_API_BASE_URL: 'http://127.0.0.1:9999/' }).baseUrl).toBe('http://127.0.0.1:9999');
    expect(loadConfig({}).baseUrl).toBe('https://api.x.com');
  });

  it('rejects partial OAuth 1.0a credentials', () => {
    expect(() => loadConfig({ X_API_KEY: 'k', X_API_SECRET: 's' })).toThrow(/requires all of/);
  });

  it('validates numeric options', () => {
    expect(() => loadConfig({ X_MCP_MAX_RETRIES: 'lots' })).toThrow(ConfigError);
    expect(() => loadConfig({ X_MCP_MAX_RETRIES: '9' })).toThrow(ConfigError);
  });
});

describe('X client', () => {
  it('prefers user-context credentials and falls back by accepted auth', async () => {
    const { fetch, requests } = queueFetch([{ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }]);
    const client = testClient(fetch);
    await client.request({ method: 'GET', path: '/2/tweets', auth: ['oauth2_user', 'oauth1_user', 'app_bearer'] });
    await client.request({ method: 'GET', path: '/2/compliance/jobs', auth: ['app_bearer'] });
    await client.request({ method: 'GET', path: '/2/tweets/1', auth: ['oauth1_user', 'app_bearer'] });
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${TEST_SECRETS.X_OAUTH2_ACCESS_TOKEN}`);
    expect(requests[1]!.headers.authorization).toBe(`Bearer ${TEST_SECRETS.X_BEARER_TOKEN}`);
    expect(requests[2]!.headers.authorization).toMatch(/^OAuth oauth_consumer_key="consumer-key-SECRET-cccccccc"/);
  });

  it('sends no Authorization header to unauthenticated endpoints', async () => {
    const { fetch, requests } = queueFetch([{ body: { openapi: '3.0.0' } }]);
    await testClient(fetch).request({ method: 'GET', path: '/2/openapi.json', auth: [] });
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it('fails before any request when no accepted credential is configured', async () => {
    const { fetch, requests } = queueFetch([]);
    const client = testClient(fetch, { X_OAUTH2_ACCESS_TOKEN: 'only-user' });
    await expect(client.request({ method: 'GET', path: '/2/usage/tweets', auth: ['app_bearer'] })).rejects.toMatchObject({
      kind: 'auth_not_configured',
    });
    expect(requests).toHaveLength(0);
  });

  it('retries an idempotent GET after a 429 whose reset is within the wait cap', async () => {
    const sleeps: number[] = [];
    const now = 1_800_000_000;
    const { fetch, requests } = queueFetch([
      { status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-limit': '300', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(now + 2) } },
      { body: { data: { id: '1' } }, headers: { 'x-rate-limit-limit': '300', 'x-rate-limit-remaining': '299', 'x-rate-limit-reset': String(now + 900) } },
    ]);
    const res = await testClient(fetch, TEST_SECRETS, sleeps).request({ method: 'GET', path: '/2/users/me', auth: ['oauth2_user'] });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(res.rateLimit).toEqual({ limit: 300, remaining: 299, reset: now + 900 });
  });

  it('returns rate_limited without waiting when the reset exceeds the wait cap', async () => {
    const sleeps: number[] = [];
    const { fetch, requests } = queueFetch([
      { status: 429, body: { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank', status: 429 }, headers: { 'x-rate-limit-reset': String(1_800_000_000 + 600) } },
    ]);
    const err = await testClient(fetch, TEST_SECRETS, sleeps)
      .request({ method: 'GET', path: '/2/users/me', auth: ['oauth2_user'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).kind).toBe('rate_limited');
    expect((err as XApiError).details.retryAfterSeconds).toBe(600);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('never retries non-idempotent writes on 429, 5xx or network failure', async () => {
    const sleeps: number[] = [];
    const r1 = queueFetch([{ status: 429, body: {}, headers: { 'x-rate-limit-reset': String(1_800_000_001) } }]);
    await expect(
      testClient(r1.fetch, TEST_SECRETS, sleeps).request({ method: 'POST', path: '/2/tweets', auth: ['oauth2_user'], body: { kind: 'json', value: { text: 'x' } } }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(r1.requests).toHaveLength(1);

    const r2 = queueFetch([{ status: 503, body: { title: 'Service Unavailable' } }]);
    await expect(
      testClient(r2.fetch, TEST_SECRETS, sleeps).request({ method: 'POST', path: '/2/tweets', auth: ['oauth2_user'], body: { kind: 'json', value: { text: 'x' } } }),
    ).rejects.toMatchObject({ kind: 'http_error', details: { status: 503 } });
    expect(r2.requests).toHaveLength(1);

    let calls = 0;
    const failing = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    const err = await testClient(failing, TEST_SECRETS, sleeps)
      .request({ method: 'POST', path: '/2/tweets', auth: ['oauth2_user'], body: { kind: 'json', value: { text: 'x' } } })
      .then(() => undefined, (e: unknown) => e as XApiError);
    if (!err) throw new Error('expected a failure');
    expect(calls).toBe(1);
    expect(err.kind).toBe('network_error');
    expect(err.message).toMatch(/may or may not have been applied/);
    expect(sleeps).toEqual([]);
  });

  it('retries GET on 503 with bounded backoff, then surfaces the error', async () => {
    const sleeps: number[] = [];
    const { fetch, requests } = queueFetch([
      { status: 503, body: { title: 'Service Unavailable' } },
      { status: 503, body: { title: 'Service Unavailable' } },
      { status: 503, body: { title: 'Service Unavailable' } },
    ]);
    await expect(
      testClient(fetch, TEST_SECRETS, sleeps).request({ method: 'GET', path: '/2/users/me', auth: ['oauth2_user'] }),
    ).rejects.toMatchObject({ kind: 'http_error', details: { status: 503 } });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('parses X v2 error arrays and problem+json bodies', async () => {
    const { fetch } = queueFetch([
      { status: 400, body: { errors: [{ parameters: { ids: ['x'] }, message: 'The `ids` query parameter value [x] is not valid' }], title: 'Invalid Request', detail: 'One or more parameters to your request was invalid.', type: 'https://api.twitter.com/2/problems/invalid-request' } },
      { status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' } },
    ]);
    const client = testClient(fetch);
    const e1 = (await client.request({ method: 'GET', path: '/2/tweets', auth: ['oauth2_user'] }).catch((e: unknown) => e)) as XApiError;
    expect(e1.details).toMatchObject({ status: 400, title: 'Invalid Request', type: 'https://api.twitter.com/2/problems/invalid-request' });
    expect(e1.details.errors).toHaveLength(1);
    const e2 = (await client.request({ method: 'GET', path: '/2/tweets', auth: ['oauth2_user'] }).catch((e: unknown) => e)) as XApiError;
    expect(e2).toMatchObject({ kind: 'http_error', details: { status: 401, title: 'Unauthorized' } });
  });

  it('resolves and caches the authenticated user id', async () => {
    const { fetch, requests } = queueFetch([{ body: { data: { id: '2244994945', username: 'XDevelopers' } } }]);
    const client = testClient(fetch);
    expect(await client.getMeId()).toBe('2244994945');
    expect(await client.getMeId()).toBe('2244994945');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/2/users/me');
  });

  it('refuses non-v2 paths', () => {
    const { fetch } = queueFetch([]);
    expect(() => testClient(fetch).buildUrl('/1.1/statuses/update.json')).toThrow(/non-v2/);
  });
});

describe('error results', () => {
  it('are result-level errors with every configured secret redacted', () => {
    const config = testConfig(TEST_SECRETS);
    const err = new XApiError('http_error', `X API returned 401: token ${TEST_SECRETS.X_OAUTH2_ACCESS_TOKEN} rejected`, {
      status: 401,
      detail: `Authorization: Bearer ${TEST_SECRETS.X_BEARER_TOKEN} and oauth_signature="abc"`,
    });
    const result = errorResult(err, createRedactor(config));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    for (const secret of Object.values(TEST_SECRETS)) expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
    expect(result.structuredContent).toMatchObject({ error: { type: 'http_error', status: 401 } });
  });

  it('hide internal error details', () => {
    const result = errorResult(new Error(`boom ${TEST_SECRETS.X_ACCESS_TOKEN}`), createRedactor(testConfig(TEST_SECRETS)));
    expect(result.structuredContent).toEqual({
      error: { type: 'internal_error', message: 'The tool failed unexpectedly; see server diagnostics.' },
    });
  });
});

describe('media reader', () => {
  it('disables path inputs without X_MCP_MEDIA_ROOT', async () => {
    const reader = new MediaReader({ maxMediaBytes: 1024 });
    await expect(reader.load({ path: '/etc/passwd' })).rejects.toThrow(/X_MCP_MEDIA_ROOT/);
  });

  it('confines paths to the media root, including via symlinks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-media-'));
    const root = path.join(dir, 'root');
    await mkdir(root);
    await writeFile(path.join(root, 'ok.png'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, 'secret.txt'), 'secret');
    await symlink(path.join(dir, 'secret.txt'), path.join(root, 'link.png'));
    const reader = new MediaReader({ mediaRoot: root, maxMediaBytes: 1024 });
    await expect(reader.load({ path: 'ok.png' })).resolves.toMatchObject({ mimeType: 'image/png' });
    await expect(reader.load({ path: '../secret.txt' })).rejects.toThrow(/inside X_MCP_MEDIA_ROOT/);
    await expect(reader.load({ path: 'link.png' })).rejects.toThrow(/inside X_MCP_MEDIA_ROOT/);
    await expect(reader.load({ path: path.join(dir, 'secret.txt') })).rejects.toThrow(/inside X_MCP_MEDIA_ROOT/);
  });

  it('validates base64 and size limits', async () => {
    const reader = new MediaReader({ maxMediaBytes: 4 });
    await expect(reader.load({ base64: 'not base64!' })).rejects.toThrow(/not valid base64/);
    await expect(reader.load({ base64: Buffer.from('12345678').toString('base64') })).rejects.toThrow(/limit/);
    await expect(reader.load({ base64: Buffer.from('1234').toString('base64'), filename: 'a.gif' })).resolves.toMatchObject({
      mimeType: 'image/gif',
    });
    await expect(reader.load({ base64: 'AA==', path: 'x' })).rejects.toThrow(/exactly one/);
  });
});

describe('redaction safety', () => {
  it('never corrupts payload structure, even with short or JSON-like credential values', () => {
    const config = testConfig({ X_API_KEY: 't', X_API_SECRET: 'error', X_ACCESS_TOKEN: 'type', X_ACCESS_TOKEN_SECRET: 'long-secret-value-123' });
    const result = errorResult(
      new XApiError('http_error', 'failed with long-secret-value-123', { status: 400, detail: 'type error' }),
      createRedactor(config),
    );
    expect(result.structuredContent).toEqual({
      error: { type: 'http_error', message: 'failed with [REDACTED]', status: 400, detail: 'type error' },
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });
});
