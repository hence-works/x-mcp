import type { ServerConfig } from '../config.js';
import { XApiError, type RateLimitInfo } from './errors.js';
import { oauth1Header } from './oauth1.js';

export type AuthKind = 'oauth2_user' | 'oauth1_user' | 'app_bearer';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RequestBody = { kind: 'json'; value: unknown } | { kind: 'multipart'; value: FormData };

export interface XRequest {
  method: HttpMethod;
  /** Path beginning with `/2/`, with path parameters already substituted and encoded. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: RequestBody;
  /**
   * Auth types the endpoint accepts (from the official spec). Empty means unauthenticated.
   * The client picks the first configured credential in its own preference order.
   */
  auth: readonly AuthKind[];
  /** Overrides the default retry eligibility (GET only). Writes are never retried by default. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

export interface XResponse<T = unknown> {
  status: number;
  data: T;
  rateLimit?: RateLimitInfo;
  /** Auth type actually used. */
  auth?: AuthKind;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Connected-account credentials (implemented by the AccountManager). */
export interface ManagedCredentialSource {
  activeCredential(): Promise<{ token: string; userId: string; scopes: readonly string[] } | undefined>;
  refresh(userId: string): Promise<{ accessToken: string }>;
}

export interface XClientDeps {
  fetch?: FetchLike;
  /** OAuth 2.0 connected accounts; used before X_OAUTH2_ACCESS_TOKEN when an account is active. */
  accounts?: ManagedCredentialSource;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Deterministic OAuth 1.0a nonce/timestamp for tests. */
  oauth1Nonce?: () => string;
}

/** User context first: it unlocks user-scoped endpoints and per-user rate limits. */
const AUTH_PREFERENCE: readonly AuthKind[] = ['oauth2_user', 'oauth1_user', 'app_bearer'];

const AUTH_ENV: Record<AuthKind, string> = {
  oauth2_user: 'X_OAUTH2_ACCESS_TOKEN',
  oauth1_user: 'X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_TOKEN_SECRET',
  app_bearer: 'X_BEARER_TOKEN',
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function parseRateLimit(headers: Headers): RateLimitInfo | undefined {
  const num = (name: string) => {
    const raw = headers.get(name);
    if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
    return Number(raw.trim());
  };
  const info: RateLimitInfo = {
    limit: num('x-rate-limit-limit'),
    remaining: num('x-rate-limit-remaining'),
    reset: num('x-rate-limit-reset'),
  };
  return info.limit === undefined && info.remaining === undefined && info.reset === undefined ? undefined : info;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || /^[\s]*[{[]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Converts an X error body (problem+json or v2 `errors` array) into an XApiError. */
export function errorFromResponse(status: number, body: unknown, rateLimit: RateLimitInfo | undefined, now: number): XApiError {
  let title: string | undefined;
  let detail: string | undefined;
  let type: string | undefined;
  let errors: unknown[] | undefined;
  if (isRecord(body)) {
    title = str(body.title);
    detail = str(body.detail) ?? str(body.error_description) ?? str(body.reason);
    type = str(body.type);
    if (Array.isArray(body.errors)) {
      errors = body.errors;
      const first = body.errors[0];
      if (isRecord(first)) {
        title ??= str(first.title);
        detail ??= str(first.detail) ?? str(first.message);
        type ??= str(first.type) ?? (typeof first.code === 'number' ? String(first.code) : undefined);
      }
    }
  } else if (typeof body === 'string') {
    detail = body.slice(0, 500);
  }
  const kind = status === 429 ? 'rate_limited' : 'http_error';
  const retryAfterSeconds =
    status === 429 && rateLimit?.reset !== undefined ? Math.max(0, rateLimit.reset - Math.floor(now / 1000)) : undefined;
  const summary = [title, detail].filter(Boolean).join(': ') || `HTTP ${status}`;
  return new XApiError(kind, `X API returned ${status}: ${summary}`, {
    status,
    title,
    detail,
    type,
    errors,
    rateLimit,
    retryAfterSeconds,
  });
}

export class XClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private meId?: Promise<string>;

  constructor(
    readonly config: ServerConfig,
    private readonly deps: XClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Waits using the injected clock (tests run without real delays). */
  wait(ms: number): Promise<void> {
    return this.sleep(ms);
  }

  /** Picks the credential to use, or throws a configuration error naming the env vars to set. */
  selectAuth(accepted: readonly AuthKind[], managedAccount = false): AuthKind | undefined {
    if (accepted.length === 0) return undefined;
    const creds = this.config.credentials;
    const available: Record<AuthKind, boolean> = {
      oauth2_user: managedAccount || Boolean(creds.oauth2UserToken),
      oauth1_user: Boolean(creds.oauth1),
      app_bearer: Boolean(creds.bearerToken),
    };
    const chosen = AUTH_PREFERENCE.find((kind) => accepted.includes(kind) && available[kind]);
    if (!chosen) {
      const needs = AUTH_PREFERENCE.filter((k) => accepted.includes(k))
        .map((k) => `${k} (${AUTH_ENV[k]})`)
        .join(' or ');
      const connect = accepted.includes('oauth2_user') && this.deps.accounts ? ' Or connect an account with X_AUTH_CONNECT.' : '';
      throw new XApiError('auth_not_configured', `This tool requires credentials for ${needs}; none are configured.${connect}`);
    }
    return chosen;
  }

  buildUrl(path: string, query?: Record<string, string | undefined>): string {
    if (!path.startsWith('/2/')) throw new Error(`Refusing non-v2 path ${path}`);
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.append(k, v);
    }
    return url.toString();
  }

  /** The connected account whose token a request accepting `accepted` would use, if any. */
  async managedCredential(accepted: readonly AuthKind[]) {
    if (!accepted.includes('oauth2_user') || !this.deps.accounts) return undefined;
    return this.deps.accounts.activeCredential();
  }

  private authHeader(kind: AuthKind | undefined, method: string, url: string, managedToken?: string): string | undefined {
    const creds = this.config.credentials;
    switch (kind) {
      case undefined:
        return undefined;
      case 'oauth2_user':
        return `Bearer ${managedToken ?? creds.oauth2UserToken}`;
      case 'app_bearer':
        return `Bearer ${creds.bearerToken}`;
      case 'oauth1_user':
        return oauth1Header({
          method,
          url,
          credentials: creds.oauth1!,
          nonce: this.deps.oauth1Nonce?.(),
          timestamp: this.deps.now ? Math.floor(this.now() / 1000) : undefined,
        });
    }
  }

  /** Sends one request (plus bounded retries for idempotent requests) and returns the parsed body. */
  async request<T = unknown>(req: XRequest): Promise<XResponse<T>> {
    let managed = await this.managedCredential(req.auth);
    const auth = this.selectAuth(req.auth, managed !== undefined);
    if (auth !== 'oauth2_user') managed = undefined;
    const url = this.buildUrl(req.path, req.query);
    const idempotent = req.idempotent ?? req.method === 'GET';
    const maxAttempts = idempotent ? this.config.maxRetries + 1 : 1;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const res = await this.send(req, url, auth, managed?.token);
      if (res.kind === 'network') {
        if (attempt < maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        if (!idempotent) {
          throw new XApiError(
            res.error.kind,
            `${res.error.message}. The write may or may not have been applied; verify its effect before retrying.`,
          );
        }
        throw res.error;
      }
      const { response } = res;
      const rateLimit = parseRateLimit(response.headers);
      const body = await readBody(response);
      if (response.ok) return { status: response.status, data: body as T, rateLimit, auth };
      const error = errorFromResponse(response.status, body, rateLimit, this.now());
      // A 401 means X rejected the token before acting, so one retry after a refresh is safe even for writes.
      if (response.status === 401 && managed && !refreshed && this.deps.accounts) {
        refreshed = true;
        attempt--;
        const next = await this.deps.accounts.refresh(managed.userId);
        managed = { ...managed, token: next.accessToken };
        continue;
      }
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
        const wait =
          response.status === 429
            ? (error.details.retryAfterSeconds ?? Number.POSITIVE_INFINITY) * 1000
            : this.backoff(attempt);
        if (wait <= this.config.maxRetryWaitMs) {
          await this.sleep(wait);
          continue;
        }
      }
      throw error;
    }
  }

  /** Opens a streaming GET and returns the live response; the caller must cancel/abort it. */
  async openStream(req: XRequest & { signal: AbortSignal }): Promise<{ response: Response; auth?: AuthKind }> {
    const managed = await this.managedCredential(req.auth);
    const auth = this.selectAuth(req.auth, managed !== undefined);
    const url = this.buildUrl(req.path, req.query);
    const headers: Record<string, string> = { 'user-agent': 'x-mcp/0.1.0' };
    const authorization = this.authHeader(auth, req.method, url, auth === 'oauth2_user' ? managed?.token : undefined);
    if (authorization) headers.authorization = authorization;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: req.method, headers, signal: req.signal });
    } catch (cause) {
      throw this.networkError(cause, req.signal);
    }
    if (!response.ok) {
      const body = await readBody(response);
      throw errorFromResponse(response.status, body, parseRateLimit(response.headers), this.now());
    }
    return { response, auth };
  }

  /** Authenticated user's id, resolved once per process via GET /2/users/me. */
  async getMeId(): Promise<string> {
    // A connected account is bound to its verified id: no extra billable lookup needed.
    const managed = this.deps.accounts ? await this.deps.accounts.activeCredential() : undefined;
    if (managed) return managed.userId;
    if (!this.meId) {
      this.meId = this.request<{ data?: { id?: unknown } }>({
        method: 'GET',
        path: '/2/users/me',
        auth: ['oauth2_user', 'oauth1_user'],
      }).then((res) => {
        const id = res.data?.data?.id;
        if (typeof id !== 'string' || !/^\d{1,19}$/.test(id)) {
          throw new XApiError('unexpected_response', 'GET /2/users/me did not return a user id');
        }
        return id;
      });
      this.meId.catch(() => {
        this.meId = undefined;
      });
    }
    return this.meId;
  }

  private backoff(attempt: number): number {
    return Math.min(this.config.maxRetryWaitMs, 500 * 2 ** (attempt - 1));
  }

  private networkError(cause: unknown, signal?: AbortSignal): XApiError {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || (cause.name === 'AbortError' && !signal?.aborted));
    return timedOut
      ? new XApiError('timeout', `X API request timed out after ${this.config.requestTimeoutMs} ms`)
      : new XApiError('network_error', 'Could not reach the X API');
  }

  private async send(
    req: XRequest,
    url: string,
    auth: AuthKind | undefined,
    managedToken?: string,
  ): Promise<{ kind: 'ok'; response: Response } | { kind: 'network'; error: XApiError }> {
    const headers: Record<string, string> = { 'user-agent': 'x-mcp/0.1.0', accept: 'application/json' };
    const authorization = this.authHeader(auth, req.method, url, managedToken);
    if (authorization) headers.authorization = authorization;
    let body: string | FormData | undefined;
    if (req.body?.kind === 'json') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body.value);
    } else if (req.body?.kind === 'multipart') {
      body = req.body.value;
    }
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(url, { method: req.method, headers, body, signal });
      return { kind: 'ok', response };
    } catch (cause) {
      if (req.signal?.aborted) throw new XApiError('network_error', 'Request cancelled');
      return { kind: 'network', error: this.networkError(cause, req.signal) };
    }
  }
}
