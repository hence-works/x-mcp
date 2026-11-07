import type { ServerConfig } from '../config.js';
import type { FetchLike } from '../x/client.js';
import { XApiError } from '../x/errors.js';
import { OAuth2Client, type TokenSet } from './oauth2.js';
import { createPkce, randomToken } from './pkce.js';
import { EncryptedFileTokenStore, MemoryTokenStore, type StoredAccount, type TokenStore } from './store.js';
import { TOOL_OAUTH2_SCOPES } from './tool-scopes.js';

/** Every OAuth 2.0 scope X documents for the tools in this server, plus offline.access. */
export const KNOWN_SCOPES = new Set([...Object.values(TOOL_OAUTH2_SCOPES).flat(), 'offline.access']);

/** Needed to verify which X account a new token belongs to (GET /2/users/me). */
const IDENTITY_SCOPES = ['tweet.read', 'users.read'];

/** Refresh this long before expiry. */
const REFRESH_SKEW_MS = 60_000;
const MAX_PENDING = 5;

export interface AccountSummary {
  user_id: string;
  username: string;
  scopes: string[];
  expires_at: string;
  refreshable: boolean;
  active: boolean;
}

export interface ActiveCredential {
  token: string;
  userId: string;
  scopes: readonly string[];
}

interface PendingAuthorization {
  verifier: string;
  scopes: string[];
  persistent: boolean;
  expiresAt: number;
}

export interface AuthorizationRequest {
  authorization_url: string;
  redirect_uri: string;
  scopes: string[];
  persistent: boolean;
  expires_at: string;
}

export interface AccountManagerDeps {
  fetch: FetchLike;
  now?: () => number;
  /** Resolves the X user behind an access token (GET /2/users/me with that token). */
  identify: (accessToken: string) => Promise<{ id: string; username: string }>;
  store?: TokenStore;
}

/** Scopes for a set of tools (all OAuth 2.0-capable tools when none are named). */
export function scopesForTools(tools?: readonly string[]): string[] {
  const names = tools && tools.length > 0 ? tools : Object.keys(TOOL_OAUTH2_SCOPES);
  const scopes = new Set(IDENTITY_SCOPES);
  for (const name of names) {
    const needed = TOOL_OAUTH2_SCOPES[name];
    if (!needed) throw new XApiError('invalid_input', `${name} cannot use an OAuth 2.0 user token (unknown tool or app-only endpoint)`);
    for (const s of needed) scopes.add(s);
  }
  return [...scopes].sort();
}

/**
 * Connected X accounts for OAuth 2.0 user authorization. The active account is chosen by the
 * operator (X_MCP_ACCOUNT_ID), else the account connected in this session, else the only stored
 * account; tool arguments never choose it. Tokens never leave this class except as request
 * headers built by the X client.
 */
export class AccountManager {
  readonly store: TokenStore;
  readonly oauth?: OAuth2Client;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly refreshing = new Map<string, Promise<StoredAccount>>();
  private sessionAccount?: string;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly config: ServerConfig,
    private readonly deps: AccountManagerDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.store =
      deps.store ??
      (config.tokenStore.key ? new EncryptedFileTokenStore(config.tokenStore.dir, config.tokenStore.key) : new MemoryTokenStore());
    if (config.oauth) this.oauth = new OAuth2Client(config.oauth, deps.fetch, this.now);
  }

  get configured(): boolean {
    return this.oauth !== undefined;
  }

  /** Called whenever pending authorizations change (the callback listener closes when none remain). */
  onPendingChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pendingCount(): number {
    this.purgeExpired();
    return this.pending.size;
  }

  private purgeExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [state, p] of this.pending) {
      if (p.expiresAt <= now) {
        this.pending.delete(state);
        changed = true;
      }
    }
    if (changed) this.listeners.forEach((l) => l());
  }

  private requireOAuth(): OAuth2Client {
    if (!this.oauth) {
      throw new XApiError('auth_not_configured', 'OAuth 2.0 user authorization is not configured; set X_OAUTH2_CLIENT_ID (and X_OAUTH2_REDIRECT_URI).');
    }
    return this.oauth;
  }

  /** Starts an authorization: returns the URL the user opens in a browser. */
  startAuthorization(input: { tools?: readonly string[]; scopes?: readonly string[]; persistent?: boolean } = {}): AuthorizationRequest {
    const oauth = this.requireOAuth();
    const persistent = input.persistent ?? this.store.persistent;
    if (persistent && !this.store.persistent) {
      throw new XApiError('invalid_input', 'Persistent authorization needs X_MCP_TOKEN_KEY so tokens can be stored encrypted.');
    }
    const scopes = new Set(scopesForTools(input.tools));
    for (const s of input.scopes ?? []) {
      if (!KNOWN_SCOPES.has(s)) throw new XApiError('invalid_input', `Unknown or unsupported scope ${s}`);
      scopes.add(s);
    }
    if (persistent) scopes.add('offline.access');
    else scopes.delete('offline.access');
    this.purgeExpired();
    if (this.pending.size >= MAX_PENDING) {
      throw new XApiError('invalid_input', 'Too many authorization requests are pending; finish or wait for one to expire.');
    }
    const state = randomToken(32);
    const pkce = createPkce();
    const expiresAt = this.now() + oauth.config.callbackTimeoutMs;
    const sorted = [...scopes].sort();
    this.pending.set(state, { verifier: pkce.verifier, scopes: sorted, persistent, expiresAt });
    this.listeners.forEach((l) => l());
    return {
      authorization_url: oauth.authorizeUrl({ scopes: sorted, state, challenge: pkce.challenge }),
      redirect_uri: oauth.config.redirectUri,
      scopes: sorted,
      persistent,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Completes an authorization from the redirect parameters. The state is consumed before any
   * other check, so a replayed or forged callback can never be completed twice.
   */
  async completeAuthorization(params: { code?: string | null; state?: string | null; error?: string | null }): Promise<AccountSummary> {
    const oauth = this.requireOAuth();
    this.purgeExpired();
    const pending = params.state ? this.pending.get(params.state) : undefined;
    if (!pending || !params.state) {
      throw new XApiError('oauth_error', 'Unknown, expired or already used authorization state; start a new connection.');
    }
    this.pending.delete(params.state);
    this.listeners.forEach((l) => l());
    if (params.error) {
      throw new XApiError('oauth_error', params.error === 'access_denied' ? 'The user denied the authorization request.' : 'X returned an authorization error.', {
        title: params.error.slice(0, 100),
      });
    }
    if (!params.code) throw new XApiError('oauth_error', 'The authorization callback did not include a code.');
    const tokens = await oauth.exchangeCode(params.code, pending.verifier);
    let identity: { id: string; username: string };
    try {
      if (pending.persistent && !tokens.refreshToken) {
        throw new XApiError('oauth_error', 'X did not return a refresh token; offline.access was not granted.');
      }
      identity = await this.deps.identify(tokens.accessToken);
      if (!/^\d{1,19}$/.test(identity.id)) throw new XApiError('unexpected_response', 'Could not verify the authorized X account');
    } catch (error) {
      await oauth.revoke(tokens.accessToken, 'access_token').catch(() => undefined);
      throw error;
    }
    const account: StoredAccount = {
      userId: identity.id,
      username: identity.username,
      scopes: tokens.scopes.length ? tokens.scopes : pending.scopes,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      clientId: oauth.config.clientId,
      updatedAt: this.now(),
    };
    const store = pending.persistent ? this.store : this.sessionStore();
    await store.put(account);
    this.sessionAccount = account.userId;
    return this.summarize(account, account.userId);
  }

  private memory?: MemoryTokenStore;
  /** Non-persistent connections live in memory even when an encrypted store is configured. */
  private sessionStore(): TokenStore {
    if (!this.store.persistent) return this.store;
    this.memory ??= new MemoryTokenStore();
    return this.memory;
  }

  private async load(userId: string): Promise<{ account: StoredAccount; store: TokenStore } | undefined> {
    if (this.memory) {
      const m = await this.memory.get(userId);
      if (m) return { account: m, store: this.memory };
    }
    const a = await this.store.get(userId);
    return a ? { account: a, store: this.store } : undefined;
  }

  private async allIds(): Promise<string[]> {
    const ids = new Set(await this.store.list());
    if (this.memory) for (const id of await this.memory.list()) ids.add(id);
    return [...ids].sort();
  }

  /** Resolves the active account id without exposing any choice to tool callers. */
  async activeAccountId(): Promise<string | undefined> {
    if (this.config.accountId) return this.config.accountId;
    if (this.sessionAccount) return this.sessionAccount;
    const ids = await this.allIds();
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) {
      throw new XApiError('auth_not_configured', 'Several X accounts are connected; set X_MCP_ACCOUNT_ID to choose one.');
    }
    return undefined;
  }

  /** Access token for the active account, refreshed when close to expiry; undefined when none is connected. */
  async activeCredential(): Promise<ActiveCredential | undefined> {
    const userId = await this.activeAccountId();
    if (!userId) return undefined;
    const loaded = await this.load(userId);
    if (!loaded) {
      if (this.config.accountId) {
        throw new XApiError('reauthorization_required', `X_MCP_ACCOUNT_ID ${userId} is not connected; connect it first.`);
      }
      return undefined;
    }
    let { account } = loaded;
    if (this.oauth && account.clientId !== this.oauth.config.clientId) {
      throw new XApiError('reauthorization_required', `Account ${userId} was authorized for a different OAuth client; connect it again.`);
    }
    if (account.expiresAt - REFRESH_SKEW_MS <= this.now()) account = await this.refresh(userId);
    return { token: account.accessToken, userId: account.userId, scopes: account.scopes };
  }

  /** Refreshes once per account at a time; the rotated refresh token is saved before use. */
  refresh(userId: string): Promise<StoredAccount> {
    let inflight = this.refreshing.get(userId);
    if (!inflight) {
      inflight = this.doRefresh(userId).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, inflight);
    }
    return inflight;
  }

  private async doRefresh(userId: string): Promise<StoredAccount> {
    const oauth = this.requireOAuth();
    const loaded = await this.load(userId);
    if (!loaded) throw new XApiError('reauthorization_required', `Account ${userId} is not connected.`);
    const { account, store } = loaded;
    if (!account.refreshToken) {
      throw new XApiError('reauthorization_required', `The access token for account ${userId} expired and no refresh token was granted; connect it again.`);
    }
    let tokens: TokenSet;
    try {
      tokens = await oauth.refresh(account.refreshToken);
    } catch (error) {
      if (error instanceof XApiError && error.kind === 'reauthorization_required') {
        await store.delete(userId);
        if (this.sessionAccount === userId) this.sessionAccount = undefined;
        throw new XApiError('reauthorization_required', `X rejected the stored grant for account ${userId} (revoked or expired); connect it again.`, error.details);
      }
      throw error;
    }
    const next: StoredAccount = {
      ...account,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? account.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes.length ? tokens.scopes : account.scopes,
      updatedAt: this.now(),
    };
    await store.put(next);
    return next;
  }

  /** Revokes and deletes the active account's tokens. Returns which revocations X confirmed. */
  async disconnectActive(): Promise<{ user_id: string; revoked: { refresh_token: boolean; access_token: boolean } } | undefined> {
    const userId = await this.activeAccountId();
    return userId ? this.disconnect(userId) : undefined;
  }

  async disconnect(userId: string): Promise<{ user_id: string; revoked: { refresh_token: boolean; access_token: boolean } }> {
    const loaded = await this.load(userId).catch(() => undefined);
    const revoked = { refresh_token: false, access_token: false };
    if (loaded && this.oauth) {
      if (loaded.account.refreshToken) {
        revoked.refresh_token = await this.oauth.revoke(loaded.account.refreshToken, 'refresh_token').then(() => true, () => false);
      }
      revoked.access_token = await this.oauth.revoke(loaded.account.accessToken, 'access_token').then(() => true, () => false);
    }
    await this.store.delete(userId);
    await this.memory?.delete(userId);
    if (this.sessionAccount === userId) this.sessionAccount = undefined;
    return { user_id: userId, revoked };
  }

  async listAccounts(): Promise<AccountSummary[]> {
    let active: string | undefined;
    try {
      active = await this.activeAccountId();
    } catch {
      active = undefined;
    }
    const out: AccountSummary[] = [];
    for (const id of await this.allIds()) {
      const loaded = await this.load(id).catch(() => undefined);
      if (loaded) out.push(this.summarize(loaded.account, active));
    }
    return out;
  }

  private summarize(account: StoredAccount, active: string | undefined): AccountSummary {
    return {
      user_id: account.userId,
      username: account.username,
      scopes: [...account.scopes],
      expires_at: new Date(account.expiresAt).toISOString(),
      refreshable: Boolean(account.refreshToken),
      active: account.userId === active,
    };
  }
}
