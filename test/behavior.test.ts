import { describe, expect, it } from 'vitest';
import { connectHarness, queued } from './harness.js';
import { TEST_SECRETS } from './helpers.js';

function text(result: { content: unknown }): string {
  return ((result.content as { text: string }[])[0]?.text) ?? '';
}

describe('tool discovery', () => {
  it('lists every registered tool with annotations and strict input schemas', async () => {
    const h = await connectHarness(queued([]));
    try {
      const { tools } = await h.mcp.listTools();
      const create = tools.find((t) => t.name === 'TWITTER_CREATION_OF_A_POST')!;
      expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
      expect(create.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const del = tools.find((t) => t.name === 'TWITTER_POST_DELETE_BY_POST_ID')!;
      expect(del.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
      const get = tools.find((t) => t.name === 'TWITTER_POST_LOOKUP_BY_POST_ID')!;
      expect(get.annotations).toMatchObject({ readOnlyHint: true });
    } finally {
      await h.close();
    }
  });
});

describe('argument validation', () => {
  it('rejects malformed ids, unknown keys and out-of-range values before any HTTP call', async () => {
    const h = await connectHarness(queued([]));
    try {
      const bad = [
        { name: 'TWITTER_POST_LOOKUP_BY_POST_ID', arguments: { id: '12ab' } },
        { name: 'TWITTER_POST_LOOKUP_BY_POST_ID', arguments: { id: '1', 'tweet.fields': ['x'] } },
        { name: 'TWITTER_RECENT_SEARCH', arguments: { query: 'x', max_results: 101 } },
        { name: 'TWITTER_RECENT_SEARCH', arguments: { query: '' } },
        { name: 'TWITTER_USER_LOOKUP_BY_USERNAME', arguments: { username: '@XDevelopers' } },
        { name: 'TWITTER_RECENT_SEARCH', arguments: { query: 'x', start_time: 'yesterday' } },
        { name: 'TWITTER_POST_LOOKUP_BY_POST_IDS', arguments: { ids: [] } },
      ];
      for (const call of bad) {
        const result = await h.mcp.callTool(call);
        expect(result.isError, JSON.stringify(call)).toBe(true);
      }
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('enforces cross-field rules without calling X', async () => {
    const h = await connectHarness(queued([]));
    try {
      const cases = [
        { args: { query: 'x', start_time: '2026-11-01T00:00:00Z', since_id: '1' }, tool: 'TWITTER_RECENT_SEARCH', msg: /cannot be combined/ },
        { args: { text: 'x', poll_options: ['a', 'b'] }, tool: 'TWITTER_CREATION_OF_A_POST', msg: /provided together/ },
        { args: { text: 'x', poll_options: ['a', 'b'], poll_duration_minutes: 10, quote_tweet_id: '1' }, tool: 'TWITTER_CREATION_OF_A_POST', msg: /Only one of/ },
        { args: {}, tool: 'TWITTER_CREATION_OF_A_POST', msg: /text is required/ },
        { args: { text: 'x', media_tagged_user_ids: ['1'] }, tool: 'TWITTER_CREATION_OF_A_POST', msg: /requires media_media_ids/ },
      ];
      for (const c of cases) {
        const result = await h.mcp.callTool({ name: c.tool, arguments: c.args });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
        expect(text(result)).toMatch(c.msg);
      }
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

describe('X failures surface as redacted result-level errors', () => {
  it('reports missing credentials without calling X', async () => {
    const h = await connectHarness(queued([]), { env: { X_BEARER_TOKEN: TEST_SECRETS.X_BEARER_TOKEN } });
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'hi' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
      expect(text(result)).toMatch(/X_OAUTH2_ACCESS_TOKEN/);
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('reports 401 from X and never leaks credentials into results or logs', async () => {
    const h = await connectHarness(
      queued([{ status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: `bad token ${TEST_SECRETS.X_OAUTH2_ACCESS_TOKEN}` } }]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_USER_LOOKUP_ME', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { type: 'http_error', status: 401, title: 'Unauthorized' } });
      const everything = text(result) + JSON.stringify(result.structuredContent) + h.logs.join('\n');
      for (const secret of Object.values(TEST_SECRETS)) expect(everything).not.toContain(secret);
    } finally {
      await h.close();
    }
  });

  it('reports 429 with rate-limit details and does not retry a write', async () => {
    const h = await connectHarness(
      queued([{ status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-limit': '100', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(1_800_000_000 + 900) } }]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'hi' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { type: 'rate_limited', status: 429, retry_after_seconds: 900, rate_limit: { limit: 100, remaining: 0, reset: 1_800_000_900 } },
      });
      expect(h.requests).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('retries a read after a short 429 and returns rate-limit metadata', async () => {
    const h = await connectHarness(
      queued([
        { status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-reset': String(1_800_000_000 + 1) } },
        { body: { data: { id: '1' } }, headers: { 'x-rate-limit-limit': '900', 'x-rate-limit-remaining': '899', 'x-rate-limit-reset': '1800000900' } },
      ]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_GET_USER_BY_ID', arguments: { id: '1' } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ data: { data: { id: '1' } }, rate_limit: { remaining: 899 } });
      expect(h.sleeps).toEqual([1000]);
    } finally {
      await h.close();
    }
  });

  it('reports X partial errors inside a 200 response as data, not failure', async () => {
    const body = { data: [{ id: '1', text: 'ok' }], errors: [{ value: '2', detail: 'Could not find tweet with ids: [2].', title: 'Not Found Error', resource_type: 'tweet', parameter: 'ids' }] };
    const h = await connectHarness(queued([{ body }]));
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_POST_LOOKUP_BY_POST_IDS', arguments: { ids: ['1', '2'] } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ data: body });
    } finally {
      await h.close();
    }
  });

  it('logs tool outcomes to the diagnostics sink without arguments', async () => {
    const h = await connectHarness(queued([{ status: 201, body: { data: { id: '9', text: 'private words' } } }]));
    try {
      await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'private words' } });
      expect(h.logs.join('\n')).toMatch(/TWITTER_CREATION_OF_A_POST ok/);
      expect(h.logs.join('\n')).not.toContain('private words');
    } finally {
      await h.close();
    }
  });
});
