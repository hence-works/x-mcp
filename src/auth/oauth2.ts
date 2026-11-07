import type { OAuthConfig } from '../config.js';
import type { FetchLike } from '../x/client.js';
import { XApiError } from '../x/errors.js';

export interface TokenSet {
  accessToken: string;
  /** Present only when offline.access was granted. Single-use: every refresh returns a new one. */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

/** OAuth error codes that mean the grant itself is unusable and the user must authorize again. */
const REAUTHORIZE = new Set(['invalid_grant', 'invalid_token', 'unauthorized_client', 'access_denied']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * OAuth 2.0 Authorization Code with PKCE client for X
 * (docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code). Token requests are never
 * retried: authorization codes and refresh tokens are single-use.
 */
export class OAuth2Client {
  constructor(
    readonly config: OAuthConfig,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  authorizeUrl(input: { scopes: readonly string[]; state: string; challenge: string }): string {
    const url = new URL(this.config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier,
    });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
    await this.post(this.config.revokeUrl, { token, token_type_hint: hint }, 'revoke');
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    const body = await this.post(this.config.tokenUrl, form, 'token');
    if (!isRecord(body) || typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new XApiError('oauth_error', 'X token endpoint returned no access token');
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 7200;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
      expiresAt: this.now() + expiresIn * 1000,
      scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean).sort() : [],
    };
  }

  private async post(url: string, form: Record<string, string>, what: 'token' | 'revoke'): Promise<unknown> {
    const params = new URLSearchParams(form);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'x-mcp/0.1.0',
    };
    if (this.config.clientSecret) {
      const basic = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
    } else {
      params.set('client_id', this.config.clientId);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body: params.toString(), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new XApiError('network_error', `Could not reach the X OAuth ${what} endpoint`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (res.ok) return body;
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
    const description = isRecord(body) && typeof body.error_description === 'string' ? body.error_description.slice(0, 300) : undefined;
    const kind = code && REAUTHORIZE.has(code) ? 'reauthorization_required' : 'oauth_error';
    throw new XApiError(kind, `X OAuth ${what} request failed (${res.status}${code ? ` ${code}` : ''})`, {
      status: res.status,
      title: code,
      detail: description,
    });
  }
}
