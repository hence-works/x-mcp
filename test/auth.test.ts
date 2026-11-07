import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { s256 } from '../src/auth/pkce.js';
import { EncryptedFileTokenStore, MemoryTokenStore, type StoredAccount, type TokenStore } from '../src/auth/store.js';
import { loadConfig } from '../src/config.js';
import { connectHarness, type Harness } from './harness.js';
import { freeLoopbackPort, type MockReply, type RecordedRequest } from './helpers.js';

const NOW = 1_800_000_000_000;
const A = { id: '2244994945', username: 'XDevelopers' };
const B = { id: '783214', username: 'X' };

let nextPort = 0;
beforeEach(async () => {
  nextPort = await freeLoopbackPort();
});

function oauthEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    X_API_BASE_URL: 'https://api.x.test',
    X_OAUTH2_CLIENT_ID: 'client-abc',
    X_OAUTH2_REDIRECT_URI: `http://127.0.0.1:${nextPort}/callback`,
    X_MCP_MAX_RETRY_WAIT_MS: '0',
    ...extra,
  };
}

/** A fake X authorization server and API that tracks issued, rotated and revoked tokens. */
class FakeX {
  tokens = new Map<string, { user: typeof A; scopes: string[] }>();
  refreshTokens = new Map<string, { user: typeof A; scopes: string[] }>();
  revoked: string[] = [];
  codes = new Map<string, { challenge: string; user: typeof A; scopes: string[] }>();
  rejectNextApiCall = false;
  grantScopes?: string[];
  omitRefreshToken = false;
  private n = 0;

  issue(user: typeof A, scopes: string[], withRefresh = true) {
    this.n++;
    const access = `access-${this.n}-${randomBytes(4).toString('hex')}`;
    const refresh = withRefresh ? `refresh-${this.n}-${randomBytes(4).toString('hex')}` : undefined;
    this.tokens.set(access, { user, scopes });
    if (refresh) this.refreshTokens.set(refresh, { user, scopes });
    return { access_token: access, refresh_token: refresh, expires_in: 7200, scope: scopes.join(' '), token_type: 'bearer' };
  }

  handler = (req: RecordedRequest): MockReply => {
    const p = req.url.pathname;
    if (p === '/2/oauth2/token') {
      const form = req.body as Record<string, string>;
      if (form.grant_type === 'authorization_code') {
        const code = this.codes.get(form.code ?? '');
        this.codes.delete(form.code ?? '');
        if (!code || s256(form.code_verifier ?? '') !== code.challenge) {
          return { status: 400, body: { error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' } };
        }
        const t = this.issue(code.user, this.grantScopes ?? code.scopes, !this.omitRefreshToken);
        return { body: this.omitRefreshToken ? { ...t, refresh_token: undefined } : t };
      }
      if (form.grant_type === 'refresh_token') {
        const grant = this.refreshTokens.get(form.refresh_token ?? '');
        if (!grant) return { status: 400, body: { error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' } };
        this.refreshTokens.delete(form.refresh_token!); // single-use
        return { body: this.issue(grant.user, grant.scopes) };
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } };
    }
    if (p === '/2/oauth2/revoke') {
      const token = (req.body as Record<string, string>).token!;
      this.revoked.push(token);
      this.tokens.delete(token);
      this.refreshTokens.delete(token);
      return { body: { revoked: true } };
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const grant = bearer ? this.tokens.get(bearer) : undefined;
    if (!grant || this.rejectNextApiCall) {
      this.rejectNextApiCall = false;
      return { status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' } };
    }
    if (p === '/2/users/me') return { body: { data: { id: grant.user.id, name: grant.user.username, username: grant.user.username } } };
    return { status: 200, body: { data: { ok: true, as: grant.user.id, path: p } } };
  };

  /** What the browser does after the user approves: X redirects to the callback with code+state. */
  approve(authorizationUrl: string, user: typeof A): string {
    const url = new URL(authorizationUrl);
    const code = `code-${randomBytes(8).toString('hex')}`;
    this.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, user, scopes: url.searchParams.get('scope')!.split(' ') });
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', url.searchParams.get('state')!);
    return redirect.toString();
  }
}

async function browse(url: string): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function connect(h: Harness, fake: FakeX, user: typeof A, args: Record<string, unknown> = {}) {
  const started = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: args });
  expect(started.isError, JSON.stringify(started.content)).toBeFalsy();
  const { authorization_url } = (started.structuredContent as { data: { authorization_url: string } }).data;
  const callback = fake.approve(authorization_url, user);
  return { authorization_url, callback, page: await browse(callback) };
}

function account(user: typeof A, over: Partial<StoredAccount> = {}): StoredAccount {
  return {
    userId: user.id,
    username: user.username,
    scopes: ['tweet.read', 'users.read', 'like.write', 'offline.access'],
    accessToken: `seed-access-${user.id}`,
    refreshToken: `seed-refresh-${user.id}`,
    expiresAt: NOW + 3_600_000,
    clientId: 'client-abc',
    updatedAt: NOW,
    ...over,
  };
}

const open: Harness[] = [];
async function harness(fake: FakeX, opts: { env?: NodeJS.ProcessEnv; store?: TokenStore; now?: () => number } = {}) {
  const h = await connectHarness(fake.handler, { env: opts.env ?? oauthEnv(), store: opts.store, now: opts.now });
  open.push(h);
  return h;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function everything(h: Harness, ...results: unknown[]): string {
  return JSON.stringify(results) + h.logs.join('\n');
}

describe('OAuth 2.0 authorization (PKCE S256)', () => {
  it('builds an authorize URL with exact redirect, S256 challenge, unpredictable state and minimal scopes', async () => {
    const fake = new FakeX();
    const env = oauthEnv();
    const h = await harness(fake, { env });
    const first = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: { tools: ['TWITTER_USER_LIKE_POST'], persistent: false } });
    const second = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: { tools: ['TWITTER_USER_LIKE_POST'], persistent: false } });
    const u1 = new URL((first.structuredContent as { data: { authorization_url: string } }).data.authorization_url);
    const u2 = new URL((second.structuredContent as { data: { authorization_url: string } }).data.authorization_url);
    expect(Object.fromEntries(u1.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: env.X_OAUTH2_REDIRECT_URI,
      code_challenge_method: 'S256',
      scope: 'like.write tweet.read users.read',
    });
    expect(u1.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u1.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u1.searchParams.get('state')).not.toBe(u2.searchParams.get('state'));
    expect(u1.searchParams.get('code_challenge')).not.toBe(u2.searchParams.get('code_challenge'));
    expect(fake.tokens.size).toBe(0);
  });

  it('requests offline.access only for persistent authorization, which needs X_MCP_TOKEN_KEY', async () => {
    const fake = new FakeX();
    const h = await harness(fake);
    const refused = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: { persistent: true } });
    expect(refused.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
    expect((refused.content as { text: string }[])[0]!.text).toMatch(/X_MCP_TOKEN_KEY/);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-tokens-'));
    const key = randomBytes(32);
    const h2 = await harness(fake, { env: oauthEnv(), store: new EncryptedFileTokenStore(dir, key) });
    const ok = await h2.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: { tools: ['TWITTER_GET_USER_BY_ID'] } });
    expect((ok.structuredContent as { data: { scopes: string[]; persistent: boolean } }).data).toMatchObject({
      persistent: true,
      scopes: ['offline.access', 'tweet.read', 'users.read'],
    });
  });

  it('completes through the loopback callback, binds the verified user id and uses the account', async () => {
    const fake = new FakeX();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-tokens-'));
    const h = await harness(fake, { store: new EncryptedFileTokenStore(dir, randomBytes(32)) });
    const { page, callback } = await connect(h, fake, A, { tools: ['TWITTER_USER_LIKE_POST', 'TWITTER_RETWEET_POST'] });
    expect(page.status).toBe(200);
    expect(page.text).toContain('@XDevelopers');
    expect(page.text).not.toContain(new URL(callback).searchParams.get('code')!);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');

    const status = await h.mcp.callTool({ name: 'X_AUTH_STATUS', arguments: {} });
    const accounts = (status.structuredContent as { data: { accounts: { user_id: string; active: boolean; refreshable: boolean; scopes: string[] }[] } }).data.accounts;
    expect(accounts).toEqual([
      expect.objectContaining({ user_id: A.id, active: true, refreshable: true, scopes: ['like.write', 'offline.access', 'tweet.read', 'tweet.write', 'users.read'] }),
    ]);

    const before = h.requests.length;
    const repost = await h.mcp.callTool({ name: 'TWITTER_RETWEET_POST', arguments: { tweet_id: '1' } });
    expect(repost.isError).toBeFalsy();
    const sent = h.requests.slice(before);
    expect(sent.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([`POST /2/users/${A.id}/retweets`]); // no extra /2/users/me
    expect(fake.tokens.has(sent[0]!.headers.authorization!.replace('Bearer ', ''))).toBe(true);
    expect(everything(h, status, repost)).not.toMatch(/access-\d|refresh-\d|code-[0-9a-f]{16}/);
    const files = await readdir(dir);
    expect(files).toEqual([`${A.id}.json`]);
  });

  it('reports a user denial without requesting tokens', async () => {
    const fake = new FakeX();
    const h = await harness(fake);
    const started = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: {} });
    const url = new URL((started.structuredContent as { data: { authorization_url: string } }).data.authorization_url);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', url.searchParams.get('state')!);
    const page = await browse(redirect.toString());
    expect(page.status).toBe(400);
    expect(page.text).toMatch(/denied/);
    expect(h.requests.filter((r) => r.url.pathname === '/2/oauth2/token')).toHaveLength(0);
    expect(await h.accounts.listAccounts()).toEqual([]);
  });

  it('rejects a mismatched state and a replayed callback, exchanging each code at most once', async () => {
    const fake = new FakeX();
    const h = await harness(fake);
    const { callback, page } = await connect(h, fake, A);
    expect(page.status).toBe(200);
    // Nothing is pending any more, so the listener has shut down...
    await expect(browse(callback)).rejects.toThrow();
    // ...and the consumed state cannot be completed again even if delivered another way.
    await expect(h.accounts.completeAuthorization(Object.fromEntries(new URL(callback).searchParams))).rejects.toMatchObject({
      kind: 'oauth_error',
      message: expect.stringMatching(/already used/),
    });

    const started = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: {} });
    const authUrl = (started.structuredContent as { data: { authorization_url: string } }).data.authorization_url;
    const forged = new URL(fake.approve(authUrl, B));
    forged.searchParams.set('state', 'attacker-chosen-state');
    const mismatch = await browse(forged.toString());
    expect(mismatch.status).toBe(400);
    expect(h.requests.filter((r) => r.url.pathname === '/2/oauth2/token')).toHaveLength(1);
    expect((await h.accounts.listAccounts()).map((a) => a.user_id)).toEqual([A.id]);
  });

  it('expires pending authorizations after the callback lifetime', async () => {
    const fake = new FakeX();
    let now = NOW;
    const h = await harness(fake, { now: () => now, env: oauthEnv({ X_OAUTH2_CALLBACK_TIMEOUT_MS: '60000' }) });
    const started = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: {} });
    const callback = fake.approve((started.structuredContent as { data: { authorization_url: string } }).data.authorization_url, A);
    now += 61_000;
    await expect(h.accounts.completeAuthorization(Object.fromEntries(new URL(callback).searchParams))).rejects.toMatchObject({ kind: 'oauth_error' });
    expect(h.requests.filter((r) => r.url.pathname === '/2/oauth2/token')).toHaveLength(0);
    expect(h.accounts.pendingCount()).toBe(0);
  });

  it('serves only GET on the exact registered callback path', async () => {
    const fake = new FakeX();
    const env = oauthEnv();
    const h = await harness(fake, { env });
    await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: {} });
    const base = new URL(env.X_OAUTH2_REDIRECT_URI!);
    expect((await browse(`${base.origin}/callback/extra?code=x&state=y`)).status).toBe(404);
    expect((await browse(`${base.origin}/`)).status).toBe(404);
    expect((await fetch(base, { method: 'POST' })).status).toBe(404);
    expect(h.accounts.pendingCount()).toBe(1);
  });

  it('revokes the new token when persistent authorization comes back without a refresh token', async () => {
    const fake = new FakeX();
    fake.omitRefreshToken = true;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-tokens-'));
    const h = await harness(fake, { store: new EncryptedFileTokenStore(dir, randomBytes(32)) });
    const { page } = await connect(h, fake, A);
    expect(page.status).toBe(400);
    expect(fake.revoked).toHaveLength(1);
    expect(await h.accounts.listAccounts()).toEqual([]);
  });

  it('uses HTTP Basic client authentication for confidential clients', async () => {
    const fake = new FakeX();
    const h = await harness(fake, { env: oauthEnv({ X_OAUTH2_CLIENT_SECRET: 'client-secret-value-123456' }) });
    await connect(h, fake, A);
    const tokenReq = h.requests.find((r) => r.url.pathname === '/2/oauth2/token')!;
    expect(tokenReq.headers.authorization).toBe(`Basic ${Buffer.from('client-abc:client-secret-value-123456').toString('base64')}`);
    expect(tokenReq.body).not.toHaveProperty('client_id');
    expect(h.logs.join('\n')).not.toContain('client-secret-value-123456');
  });
});

describe('token lifecycle', () => {
  it('refreshes an expiring token once for concurrent calls and stores the rotated refresh token', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    const seeded = fake.issue(A, ['tweet.read', 'users.read', 'offline.access']);
    await store.put(account(A, { accessToken: seeded.access_token, refreshToken: seeded.refresh_token, expiresAt: NOW + 30_000 }));
    const h = await harness(fake, { store });
    const results = await Promise.all([
      h.mcp.callTool({ name: 'TWITTER_GET_USER_BY_ID', arguments: { id: '1' } }),
      h.mcp.callTool({ name: 'TWITTER_GET_USER_BY_ID', arguments: { id: '2' } }),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    const refreshes = h.requests.filter((r) => r.url.pathname === '/2/oauth2/token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: seeded.refresh_token, client_id: 'client-abc' });
    const stored = (await store.get(A.id))!;
    expect(stored.refreshToken).not.toBe(seeded.refresh_token);
    expect(fake.refreshTokens.has(stored.refreshToken!)).toBe(true);
    expect(stored.expiresAt).toBe(NOW + 7_200_000);
  });

  it('refreshes and retries once after a 401, even for a write', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    const seeded = fake.issue(A, ['tweet.read', 'users.read', 'tweet.write', 'offline.access']);
    await store.put(account(A, { accessToken: seeded.access_token, refreshToken: seeded.refresh_token, scopes: ['tweet.read', 'users.read', 'tweet.write'] }));
    const h = await harness(fake, { store });
    fake.rejectNextApiCall = true;
    const result = await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'hi' } });
    expect(result.isError).toBeFalsy();
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /2/tweets', 'POST /2/oauth2/token', 'POST /2/tweets']);
  });

  it('requires reauthorization when the grant was revoked, and forgets the dead grant', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    await store.put(account(A, { accessToken: 'stale-access', refreshToken: 'revoked-refresh', expiresAt: NOW - 1 }));
    const h = await harness(fake, { store });
    const result = await h.mcp.callTool({ name: 'TWITTER_GET_USER_BY_ID', arguments: { id: '1' } });
    expect(result.structuredContent).toMatchObject({ error: { type: 'reauthorization_required' } });
    expect((result.content as { text: string }[])[0]!.text).not.toContain('revoked-refresh');
    expect(await store.get(A.id)).toBeUndefined();
    expect(h.requests.filter((r) => r.url.pathname === '/2/users/1')).toHaveLength(0);
  });

  it('requires reauthorization for an expired token without a refresh token', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    await store.put(account(A, { refreshToken: undefined, expiresAt: NOW - 1 }));
    const h = await harness(fake, { store });
    const result = await h.mcp.callTool({ name: 'TWITTER_GET_USER_BY_ID', arguments: { id: '1' } });
    expect(result.structuredContent).toMatchObject({ error: { type: 'reauthorization_required' } });
    expect(h.requests).toHaveLength(0);
  });

  it('rejects tools whose scopes the account was not granted, before calling X', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    await store.put(account(A, { scopes: ['tweet.read', 'users.read'] }));
    const h = await harness(fake, { store });
    const result = await h.mcp.callTool({ name: 'TWITTER_ADD_POST_TO_BOOKMARKS', arguments: { id: A.id, tweet_id: '1' } });
    expect(result.structuredContent).toMatchObject({ error: { type: 'missing_scopes', detail: 'bookmark.write' } });
    expect(h.requests).toHaveLength(0);
  });

  it('disconnect revokes both tokens with X and deletes the account', async () => {
    const fake = new FakeX();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-tokens-'));
    const store = new EncryptedFileTokenStore(dir, randomBytes(32));
    const h = await harness(fake, { store });
    await connect(h, fake, A);
    const stored = (await store.get(A.id))!;
    const result = await h.mcp.callTool({ name: 'X_AUTH_DISCONNECT', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { disconnected: true, user_id: A.id, revoked: { refresh_token: true, access_token: true } } });
    expect(fake.revoked).toEqual([stored.refreshToken, stored.accessToken]);
    expect(await readdir(dir)).toEqual([]);
    const after = await h.mcp.callTool({ name: 'TWITTER_USER_LOOKUP_ME', arguments: {} });
    expect(after.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
  });
});

describe('account isolation and storage', () => {
  it('uses only the operator-pinned account and rejects acting-user ids of other accounts', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    const ta = fake.issue(A, ['tweet.read', 'users.read', 'like.write']);
    const tb = fake.issue(B, ['tweet.read', 'users.read', 'like.write']);
    await store.put(account(A, { accessToken: ta.access_token, refreshToken: ta.refresh_token, scopes: ['tweet.read', 'users.read', 'like.write', 'follows.write'] }));
    await store.put(account(B, { accessToken: tb.access_token, refreshToken: tb.refresh_token }));
    const h = await harness(fake, { store, env: oauthEnv({ X_MCP_ACCOUNT_ID: A.id }) });

    const other = await h.mcp.callTool({ name: 'TWITTER_USER_LIKE_POST', arguments: { id: B.id, tweet_id: '1' } });
    expect(other.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
    expect(h.requests).toHaveLength(0);

    const mine = await h.mcp.callTool({ name: 'TWITTER_USER_LIKE_POST', arguments: { id: A.id, tweet_id: '1' } });
    expect(mine.structuredContent).toMatchObject({ data: { data: { as: A.id } } });
    expect(h.requests[0]!.headers.authorization).toBe(`Bearer ${ta.access_token}`);

    const unmute = await h.mcp.callTool({ name: 'TWITTER_UNFOLLOW_USER', arguments: { source_user_id: B.id, target_user_id: '5' } });
    expect(unmute.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
  });

  it('refuses to guess between several stored accounts without X_MCP_ACCOUNT_ID', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    await store.put(account(A));
    await store.put(account(B));
    const h = await harness(fake, { store });
    const result = await h.mcp.callTool({ name: 'TWITTER_USER_LOOKUP_ME', arguments: {} });
    expect(result.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
    expect((result.content as { text: string }[])[0]!.text).toMatch(/X_MCP_ACCOUNT_ID/);
    expect(h.requests).toHaveLength(0);
  });

  it('encrypts each account file, binds it to its account id and restricts permissions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-tokens-'));
    const key = randomBytes(32);
    const store = new EncryptedFileTokenStore(path.join(dir, 'accounts'), key);
    await store.put(account(A));
    await store.put(account(B));
    const raw = await readFile(path.join(dir, 'accounts', `${A.id}.json`), 'utf8');
    expect(raw).not.toContain('seed-access');
    expect(raw).not.toContain('seed-refresh');
    expect((await stat(path.join(dir, 'accounts', `${A.id}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, 'accounts'))).mode & 0o777).toBe(0o700);
    expect((await store.get(A.id))!.accessToken).toBe(`seed-access-${A.id}`);

    // Swapping files so account B's name holds account A's grant must not yield A's tokens as B.
    await rename(path.join(dir, 'accounts', `${A.id}.json`), path.join(dir, 'accounts', `${B.id}.json`));
    await expect(store.get(B.id)).rejects.toMatchObject({ kind: 'reauthorization_required' });
    // A different key cannot read the store.
    await store.put(account(A));
    await expect(new EncryptedFileTokenStore(path.join(dir, 'accounts'), randomBytes(32)).get(A.id)).rejects.toMatchObject({
      kind: 'reauthorization_required',
    });
  });

  it('refuses grants issued to a different OAuth client', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    await store.put(account(A, { clientId: 'another-client' }));
    const h = await harness(fake, { store });
    const result = await h.mcp.callTool({ name: 'TWITTER_USER_LOOKUP_ME', arguments: {} });
    expect(result.structuredContent).toMatchObject({ error: { type: 'reauthorization_required' } });
    expect(h.requests).toHaveLength(0);
  });

  it('never routes app-only tools through a connected user account', async () => {
    const fake = new FakeX();
    const store = new MemoryTokenStore();
    await store.put(account(A));
    const h = await harness(fake, { store });
    const result = await h.mcp.callTool({ name: 'TWITTER_GET_POST_USAGE', arguments: {} });
    expect(result.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
    expect(h.requests).toHaveLength(0);
  });
});

describe('OAuth configuration', () => {
  it('validates the redirect URI and token key', () => {
    expect(() => loadConfig({ X_OAUTH2_CLIENT_ID: 'c', X_OAUTH2_REDIRECT_URI: 'http://example.com/cb' })).toThrow(/https/);
    expect(() => loadConfig({ X_OAUTH2_CLIENT_ID: 'c', X_OAUTH2_REDIRECT_URI: 'http://127.0.0.1/cb' })).toThrow(/port/);
    expect(() => loadConfig({ X_OAUTH2_CLIENT_ID: 'c', X_OAUTH2_REDIRECT_URI: 'http://127.0.0.1:1/cb?x=1' })).toThrow(/query/);
    expect(() => loadConfig({ X_MCP_TOKEN_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ X_OAUTH2_CLIENT_SECRET: 's' })).toThrow(/CLIENT_ID/);
    expect(() => loadConfig({ X_MCP_ACCOUNT_ID: '@me' })).toThrow(/numeric/);
    const c = loadConfig({ X_OAUTH2_CLIENT_ID: 'c', X_MCP_TOKEN_KEY: randomBytes(32).toString('base64') });
    expect(c.oauth).toMatchObject({ redirectUri: 'http://127.0.0.1:8723/callback', tokenUrl: 'https://api.x.com/2/oauth2/token', revokeUrl: 'https://api.x.com/2/oauth2/revoke' });
    expect(c.tokenStore.key).toHaveLength(32);
  });

  it('reports OAuth as unconfigured without a client id', async () => {
    const h = await connectHarness(new FakeX().handler, { env: { X_API_BASE_URL: 'https://api.x.test' } });
    open.push(h);
    const result = await h.mcp.callTool({ name: 'X_AUTH_CONNECT', arguments: {} });
    expect(result.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
  });
});
