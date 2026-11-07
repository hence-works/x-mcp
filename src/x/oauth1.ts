import { createHmac, randomBytes } from 'node:crypto';
import type { OAuth1Credentials } from '../config.js';

/** RFC 3986 percent-encoding as required by OAuth 1.0a (RFC 5849 section 3.6). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface OAuth1SignInput {
  method: string;
  /** Full request URL; its query parameters are included in the signature base string. */
  url: string;
  credentials: OAuth1Credentials;
  /** Extra parameters to sign, e.g. `application/x-www-form-urlencoded` body fields. JSON and multipart bodies are not signed. */
  extraParams?: Array<[string, string]>;
  nonce?: string;
  timestamp?: number;
}

/** Builds an OAuth 1.0a HMAC-SHA1 `Authorization` header value. */
export function oauth1Header(input: OAuth1SignInput): string {
  const url = new URL(input.url);
  const oauthParams: Array<[string, string]> = [
    ['oauth_consumer_key', input.credentials.consumerKey],
    ['oauth_nonce', input.nonce ?? randomBytes(16).toString('hex')],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', String(input.timestamp ?? Math.floor(Date.now() / 1000))],
    ['oauth_token', input.credentials.accessToken],
    ['oauth_version', '1.0'],
  ];
  const all: Array<[string, string]> = [...oauthParams, ...(input.extraParams ?? [])];
  for (const [k, v] of url.searchParams) all.push([k, v]);
  const normalized = all
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const base = [input.method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join('&');
  const key = `${percentEncode(input.credentials.consumerSecret)}&${percentEncode(input.credentials.accessTokenSecret)}`;
  const signature = createHmac('sha1', key).update(base).digest('base64');
  return (
    'OAuth ' +
    [...oauthParams, ['oauth_signature', signature] as [string, string]]
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(', ')
  );
}
