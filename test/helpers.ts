import { loadConfig, type ServerConfig } from '../src/config.js';
import { XClient, type FetchLike } from '../src/x/client.js';

export const TEST_SECRETS = {
  X_OAUTH2_ACCESS_TOKEN: 'oauth2-user-token-SECRET-aaaaaaaaaaaa',
  X_BEARER_TOKEN: 'app-bearer-token-SECRET-bbbbbbbbbbbbbbb',
  X_API_KEY: 'consumer-key-SECRET-cccccccc',
  X_API_SECRET: 'consumer-secret-SECRET-dddddddd',
  X_ACCESS_TOKEN: 'access-token-SECRET-eeeeeeee',
  X_ACCESS_TOKEN_SECRET: 'access-token-secret-SECRET-ffffffff',
};

export function testConfig(env: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadConfig({
    X_API_BASE_URL: 'https://api.x.test',
    X_MCP_MAX_RETRY_WAIT_MS: '5000',
    ...env,
  });
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: BodyInit | null;
}

export interface MockReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Fetch stub that records requests and answers from a queue or a handler. */
export function mockFetch(handler: (req: RecordedRequest) => MockReply | Promise<MockReply>) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof FormData) body = init.body;
    const req: RecordedRequest = { method: init.method ?? 'GET', url: new URL(input), headers, body, rawBody: init.body };
    requests.push(req);
    const reply = await handler(req);
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  };
  return { fetch, requests };
}

export function queueFetch(replies: MockReply[]) {
  const queue = [...replies];
  return mockFetch(() => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  });
}

export function testClient(fetch: FetchLike, env: NodeJS.ProcessEnv = TEST_SECRETS, sleeps: number[] = []) {
  return new XClient(testConfig(env), {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_800_000_000_000,
    oauth1Nonce: () => 'nonce',
  });
}
