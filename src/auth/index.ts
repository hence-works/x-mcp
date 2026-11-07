import type { ServerConfig } from '../config.js';
import { errorFromResponse, type FetchLike } from '../x/client.js';
import { XApiError } from '../x/errors.js';
import { AccountManager } from './manager.js';
import type { TokenStore } from './store.js';

/** Account manager whose identity check calls GET /2/users/me with the newly issued token. */
export function createAccountManager(
  config: ServerConfig,
  deps: { fetch?: FetchLike; now?: () => number; store?: TokenStore } = {},
): AccountManager {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  return new AccountManager(config, {
    fetch: fetchImpl,
    now,
    store: deps.store,
    async identify(accessToken) {
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/2/users/me`, {
          method: 'GET',
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'x-mcp/0.1.0' },
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch {
        throw new XApiError('network_error', 'Could not reach the X API to verify the authorized account');
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (!res.ok) throw errorFromResponse(res.status, body, undefined, now());
      const data = (body as { data?: { id?: unknown; username?: unknown } } | undefined)?.data;
      if (typeof data?.id !== 'string' || typeof data.username !== 'string') {
        throw new XApiError('unexpected_response', 'GET /2/users/me did not identify the authorized account');
      }
      return { id: data.id, username: data.username };
    },
  });
}
