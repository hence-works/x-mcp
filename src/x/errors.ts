export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Unix epoch seconds when the window resets. */
  reset?: number;
}

export type XErrorKind =
  /** No configured credential satisfies the endpoint's accepted auth types. */
  | 'auth_not_configured'
  /** Input that passed schema validation but is not acceptable (e.g. path outside media root). */
  | 'invalid_input'
  /** X answered with a non-2xx status. */
  | 'http_error'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  /** X answered 2xx with an unexpected body. */
  | 'unexpected_response'
  /** Media processing finished in a failed state or did not finish in time. */
  | 'media_processing';

export interface XErrorDetails {
  status?: number;
  title?: string;
  detail?: string;
  /** Problem type URI or X error code, when X supplies one. */
  type?: string;
  /** X `errors` array (validation and resource errors), when present. */
  errors?: unknown[];
  rateLimit?: RateLimitInfo;
  /** Seconds until a retry is sensible (429 reset). */
  retryAfterSeconds?: number;
}

/** Error raised by the X client. Never carries request headers, credentials or raw tool arguments. */
export class XApiError extends Error {
  override name = 'XApiError';
  constructor(
    readonly kind: XErrorKind,
    message: string,
    readonly details: XErrorDetails = {},
  ) {
    super(message);
  }
}

export function invalidInput(message: string): XApiError {
  return new XApiError('invalid_input', message);
}
