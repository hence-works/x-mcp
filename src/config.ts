export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XCredentials {
  /** OAuth 2.0 user-context access token (Authorization Code with PKCE). */
  oauth2UserToken?: string;
  /** OAuth 1.0a user-context credentials. */
  oauth1?: OAuth1Credentials;
  /** App-only OAuth 2.0 bearer token. */
  bearerToken?: string;
}

export interface ServerConfig {
  baseUrl: string;
  credentials: XCredentials;
  /** Directory that `media.path` inputs must resolve inside. Path inputs are disabled when unset. */
  mediaRoot?: string;
  /** Maximum bytes accepted for a single media input. */
  maxMediaBytes: number;
  /** Retries for idempotent (GET) requests on 429/5xx/network errors. Writes are never retried. */
  maxRetries: number;
  /** Upper bound for a single retry wait; a longer 429 reset is returned to the caller instead. */
  maxRetryWaitMs: number;
  requestTimeoutMs: number;
  /** Upper bound for polling media processing status in TWITTER_UPLOAD_LARGE_MEDIA. */
  mediaProcessingTimeoutMs: number;
  /** Browser-based OAuth 2.0 user authorization (Authorization Code with PKCE). Disabled when unset. */
  oauth?: OAuthConfig;
  /** Where connected-account tokens are kept. */
  tokenStore: TokenStoreConfig;
  /** Operator-pinned connected account (X user id). Tool arguments never select an account. */
  accountId?: string;
}

export interface OAuthConfig {
  clientId: string;
  /** Present for confidential clients (Web App, Automated App or bot); sent with HTTP Basic auth. */
  clientSecret?: string;
  /** Exactly as registered in the X developer app. A loopback http URI runs the local callback listener. */
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  /** Lifetime of an authorization request (state, PKCE verifier and callback listener). */
  callbackTimeoutMs: number;
}

export interface TokenStoreConfig {
  /** Directory holding one encrypted file per connected account. */
  dir: string;
  /** 32-byte AES-256-GCM key from X_MCP_TOKEN_KEY. Without it, connections last for the process only. */
  key?: Buffer;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const DEFAULT_BASE_URL = 'https://api.x.com';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = nonEmpty(env[key]);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a non-negative integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return value;
}

/**
 * Validates the API base URL. Credentials are only ever sent over HTTPS, except to a loopback
 * host (used by offline tests against a local mock server).
 */
export function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('X_API_BASE_URL is not a valid URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('X_API_BASE_URL must use https (http is only allowed for loopback hosts)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('X_API_BASE_URL must not contain credentials, a query string or a fragment');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Loopback redirect URIs get a local listener; anything else must be https. */
export function validateRedirectUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('X_OAUTH2_REDIRECT_URI is not a valid URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) throw new ConfigError('X_OAUTH2_REDIRECT_URI must use https unless it is a loopback address');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError('X_OAUTH2_REDIRECT_URI must be http(s)');
  if (loopback && !url.port) throw new ConfigError('A loopback X_OAUTH2_REDIRECT_URI needs an explicit port');
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError('X_OAUTH2_REDIRECT_URI must not contain a query, fragment or credentials');
  }
  return url.toString();
}

function tokenKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new ConfigError('X_MCP_TOKEN_KEY must be 32 bytes, as 64 hex characters or base64');
  return key;
}

function defaultTokenDir(env: NodeJS.ProcessEnv): string {
  const base = nonEmpty(env.XDG_CONFIG_HOME) ?? `${nonEmpty(env.HOME) ?? '.'}/.config`;
  return `${base}/x-mcp/accounts`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const oauth1Parts = {
    consumerKey: nonEmpty(env.X_API_KEY),
    consumerSecret: nonEmpty(env.X_API_SECRET),
    accessToken: nonEmpty(env.X_ACCESS_TOKEN),
    accessTokenSecret: nonEmpty(env.X_ACCESS_TOKEN_SECRET),
  };
  const oauth1Set = Object.values(oauth1Parts).filter((v) => v !== undefined).length;
  if (oauth1Set !== 0 && oauth1Set !== 4) {
    throw new ConfigError(
      'OAuth 1.0a requires all of X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET',
    );
  }
  const credentials: XCredentials = {
    oauth2UserToken: nonEmpty(env.X_OAUTH2_ACCESS_TOKEN),
    bearerToken: nonEmpty(env.X_BEARER_TOKEN),
    oauth1: oauth1Set === 4 ? (oauth1Parts as OAuth1Credentials) : undefined,
  };
  const baseUrl = validateBaseUrl(nonEmpty(env.X_API_BASE_URL) ?? DEFAULT_BASE_URL);
  const clientId = nonEmpty(env.X_OAUTH2_CLIENT_ID);
  const clientSecret = nonEmpty(env.X_OAUTH2_CLIENT_SECRET);
  if (clientSecret && !clientId) throw new ConfigError('X_OAUTH2_CLIENT_SECRET requires X_OAUTH2_CLIENT_ID');
  const oauth: OAuthConfig | undefined = clientId
    ? {
        clientId,
        clientSecret,
        redirectUri: validateRedirectUri(nonEmpty(env.X_OAUTH2_REDIRECT_URI) ?? 'http://127.0.0.1:8723/callback'),
        authorizeUrl: 'https://x.com/i/oauth2/authorize',
        tokenUrl: `${baseUrl}/2/oauth2/token`,
        revokeUrl: `${baseUrl}/2/oauth2/revoke`,
        callbackTimeoutMs: intFromEnv(env, 'X_OAUTH2_CALLBACK_TIMEOUT_MS', 300_000, 30_000, 900_000),
      }
    : undefined;
  const accountId = nonEmpty(env.X_MCP_ACCOUNT_ID);
  if (accountId !== undefined && !/^\d{1,19}$/.test(accountId)) throw new ConfigError('X_MCP_ACCOUNT_ID must be a numeric X user id');
  return {
    baseUrl,
    credentials,
    oauth,
    tokenStore: { dir: nonEmpty(env.X_MCP_TOKEN_DIR) ?? defaultTokenDir(env), key: tokenKey(nonEmpty(env.X_MCP_TOKEN_KEY)) },
    accountId,
    mediaRoot: nonEmpty(env.X_MCP_MEDIA_ROOT),
    maxMediaBytes: intFromEnv(env, 'X_MCP_MAX_MEDIA_BYTES', 512 * 1024 * 1024, 1, 17_179_869_184),
    maxRetries: intFromEnv(env, 'X_MCP_MAX_RETRIES', 2, 0, 5),
    maxRetryWaitMs: intFromEnv(env, 'X_MCP_MAX_RETRY_WAIT_MS', 5_000, 0, 900_000),
    requestTimeoutMs: intFromEnv(env, 'X_MCP_TIMEOUT_MS', 30_000, 1_000, 600_000),
    mediaProcessingTimeoutMs: intFromEnv(env, 'X_MCP_MEDIA_PROCESSING_TIMEOUT_MS', 120_000, 0, 1_800_000),
  };
}

/** Every configured secret value, used to scrub diagnostics and error text. */
export function secretValues(credentials: XCredentials, oauth?: OAuthConfig): string[] {
  const values = [credentials.oauth2UserToken, credentials.bearerToken, oauth?.clientSecret];
  if (credentials.oauth1) values.push(...Object.values(credentials.oauth1));
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
